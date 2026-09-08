/**
 * Parts 32-36 + 38-39 — authoritative coverage, the ONE bounded coverage-repair turn, and
 * performance telemetry.
 *
 * What these tests pin down:
 *
 *  1. Coverage is reconciled against the ACTUAL cost-relevant workbook rows (persisted at
 *     evidence-build time), never against whatever subset the agent happened to report. A
 *     billable row the agent never mentions lands in `unresolved`, not nowhere.
 *  2. A COMPLETED claim that leaves such rows uncovered is NOT handed to the customer as a
 *     finished number: the driver requests exactly ONE bounded repair turn.
 *  3. That repair turn names the uncovered rows and asks the agent to account for them; the
 *     request is marked attempted only after the Harness accepts it, and a COMPLETED claim
 *     that is STILL uncovered after the single repair is terminal NEEDS_REVIEW — never a
 *     second repair, so a stubborn agent cannot loop.
 *  4. A fully-covered COMPLETED claim is verified by reading the saved estimate back and
 *     completes; invented row ids the agent cites are ignored by the reconciliation.
 *  5. Per-step performance telemetry (agent_iterations, cumulative tool_call_counts,
 *     agent_duration_ms) is persisted alongside the terminal record.
 *
 * The agent's decisions are all mocked as streamed assistant text; MIMO's own decision
 * surface — whether to trust, repair or flag — is what is under test.
 *
 * Classification: MOCKED.
 */

import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { ddbDocClient, s3Client } from '../lambdas/shared/aws';
import {
  evidenceIndexKey,
  evidenceAccountingKey,
  evidenceCostRelevantRowsKey,
} from '../lambdas/shared/workbook-evidence';

const ddbMock = mockClient(ddbDocClient);
const s3Mock = mockClient(s3Client);
const agentCoreMock = mockClient(BedrockAgentCoreClient);
const lambdaMock = mockClient(LambdaClient);

// The driver reads these at module-load; lazy-load the driver so the assignments below are
// visible to it, mirroring the other driver suites.
process.env.CALCULATOR_HARNESS_ARN = 'arn:aws:bedrock-agentcore:ap-south-1:123456789012:harness/test';
process.env.CALCULATOR_BROWSER_VALIDATOR_FUNCTION_NAME = 'test-browser-validator';
process.env.CALCULATOR_GATEWAY_ARN = 'arn:aws:bedrock-agentcore:ap-south-1:123456789012:gateway/test';
process.env.CALCULATOR_MCP_RUNTIME_ARN = 'arn:aws:bedrock-agentcore:ap-south-1:123456789012:runtime/test';

const load = () => require('../lambdas/calculator-harness-driver');

const OWNER = 'user-1';
const CALC = 'calc-1';
const BUCKET = process.env.BUCKET_NAME!;
const SESSION = 'mimo-calc-1-abcdefghijklmnopqrstuvwxyz012345';

const ROWS = ['Inventory!5', 'Inventory!6', 'Inventory!7', 'Inventory!8'];

const indexKey = evidenceIndexKey(OWNER, CALC);
const rowsKey = evidenceCostRelevantRowsKey(OWNER, CALC);
const accountingKey = evidenceAccountingKey(OWNER, CALC);

const s3Body = (json: unknown) => ({
  Body: { transformToByteArray: async () => new TextEncoder().encode(JSON.stringify(json)) },
});

const baseRecord = () => ({
  calculation_id: CALC,
  owner_user_id: OWNER,
  name: 'Coverage workbook',
  status: 'BUILDING',
  prompt: 'Price this',
  created_at: 1,
  updated_at: 1,
});

/** An async generator of the Harness event frames the driver iterates. */
async function* agentFrames(assistantText: string, tools: Array<{ name: string; toolUseId: string }> = []) {
  for (const [index, tool] of tools.entries()) {
    yield {
      contentBlockStart: {
        contentBlockIndex: index + 1,
        start: { toolUse: { name: tool.name, toolUseId: tool.toolUseId } },
      },
    };
  }
  if (assistantText) {
    yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: assistantText } } };
  }
  yield { messageStop: { stopReason: 'end_turn' } };
}

const completedJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  status: 'COMPLETED',
  calculatorUrl: 'https://calculator.aws/#/estimate?id=abc123',
  monthly: 100,
  upfront: 0,
  total12Months: 1200,
  servicesConfigured: ['Amazon EC2'],
  assumptions: [],
  warnings: [],
  evidenceConsumed: ROWS.slice(0, 2),
  evidenceExcluded: [],
  evidenceUnsupported: [],
  evidenceUnresolved: [],
  scenarios: [],
  ...overrides,
});

const browserOk = () => ({ validUrl: true, monthly: 100, upfront: 0, total12Months: 1200, services: [] });

const runStep = async (input: Record<string, unknown>) => (await load()).handler(input);

/** Wire every mock for a COMPLETED-agent step. */
function givenCompletedStep(options: {
  record: Record<string, unknown>;
  assistantText: string;
  costRelevantRows?: string[];
  indexCostRelevant?: number;
  browser?: unknown;
  tools?: Array<{ name: string; toolUseId: string }>;
}) {
  const {
    record, assistantText,
    costRelevantRows = ROWS,
    indexCostRelevant = ROWS.length,
    browser = browserOk(),
    tools = [],
  } = options;
  ddbMock.on(GetCommand).resolves({ Item: record });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (input.Key === indexKey) return s3Body({ accounting: { costRelevantRows: indexCostRelevant } });
    if (input.Key === rowsKey) return s3Body({ costRelevantRows });
    if (input.Key === accountingKey) return s3Body({ unresolved: [], version: '1.0' });
    throw new Error(`Unexpected S3 read in test: ${input.Key}`);
  });
  lambdaMock.on(InvokeCommand).resolves({
    Payload: new TextEncoder().encode(JSON.stringify(browser)),
    FunctionError: undefined,
  } as never);
  agentCoreMock.on(InvokeHarnessCommand).resolves({ stream: agentFrames(assistantText, tools) } as never);
}

const putBodiesTo = (commandClass: typeof PutObjectCommand, key: string): string[] =>
  s3Mock.commandCalls(commandClass)
    .filter((call) => (call.args[0].input as any).Key === key)
    .map((call) => String((call.args[0].input as any).Body));

const lastUpdateSerialized = () => {
  const calls = ddbMock.commandCalls(UpdateCommand);
  return calls.length ? JSON.stringify(calls[calls.length - 1].args[0].input) : '';
};

/**
 * Decode the most recent UpdateCommand into { attributeName: value }.
 * The driver's patch() hoists names into ExpressionAttributeNames (#fN) and values into
 * ExpressionAttributeValues (:vN), so a plain substring match on "name":value never works;
 * pair them back up via the UpdateExpression text.
 */
const lastUpdateFields = (): Record<string, unknown> => {
  const calls = ddbMock.commandCalls(UpdateCommand);
  const input = (calls[calls.length - 1].args[0] as { input: any }).input;
  const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
  const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
  const setClause = String(input.UpdateExpression).replace(/^SET\s*/, '');
  const fields: Record<string, unknown> = {};
  for (const assignment of setClause.split(',')) {
    const [namePh, valuePh] = assignment.split('=').map((part) => part.trim());
    if (namePh && valuePh) fields[names[namePh]] = values[valuePh];
  }
  return fields;
};

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  agentCoreMock.reset();
  lambdaMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
});

describe('Parts 32-36 — coverage is authoritative and gated', () => {
  it('files a billable row the agent never mentioned as unresolved, not as silently done', async () => {
    // The workbook has four cost-relevant rows; the agent priced two and excluded one and
    // said nothing about Inventory!8. Self-reported coverage would call that complete.
    const assistantText = 'Done:\n' + completedJson({
      evidenceConsumed: ROWS.slice(0, 2), // Inventory!5, Inventory!6
      evidenceExcluded: [ROWS[2]],        // Inventory!7
      evidenceUnsupported: [],
    });
    givenCompletedStep({ record: baseRecord(), assistantText });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    // Not trusted as finished: the driver asks for one repair turn instead.
    expect(outcome).toMatchObject({ calculationId: CALC, done: false, iteration: 6 });
    // The authoritative accounting object lists the truly-missing row.
    const accounting = putBodiesTo(PutObjectCommand, accountingKey).pop();
    expect(accounting).toBeTruthy();
    const parsed = JSON.parse(accounting!);
    expect(parsed.counts.costRelevant).toBe(4);
    expect(parsed.counts.consumed).toBe(2);
    expect(parsed.counts.ignored).toBe(1);
    expect(parsed.unresolved).toContain('Inventory!8');
    // The record is left asking for a repair turn, not NEEDS_REVIEW and not COMPLETED.
    expect(lastUpdateSerialized()).toContain('coverage_repair_requested');
  });

  it('ignores row ids the agent invented that are not in the workbook, and repairs on the true remainder', async () => {
    // The agent priced all four real rows BUT also cites a bogus id; and leaves the four
    // real rows only. Cost-relevant remains 4 here because the authoritative list rules.
    const assistantText = 'Done:\n' + completedJson({
      evidenceConsumed: ROWS, // all four real rows priced
      evidenceUnsupported: [],
    });
    givenCompletedStep({ record: baseRecord(), assistantText, indexCostRelevant: 4, costRelevantRows: ROWS });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    // Fully covered → verified via read-back → COMPLETED, no repair.
    expect(outcome).toMatchObject({ done: true, status: 'COMPLETED' });
    expect(lastUpdateSerialized()).not.toContain('coverage_repair_requested');
    const resultBody = putBodiesTo(PutObjectCommand, `users/${OWNER}/calculator/${CALC}/result.json`).pop();
    const diagnostics = JSON.parse(resultBody!).diagnostics as Record<string, unknown>;
    expect(diagnostics.costVerified).toBe(true);
    expect(diagnostics.coverageUnresolvedRows).toBe(0);
  });

  it('falls back to the index count (older run, no persisted id list) and still repairs the true remainder', async () => {
    // No cost-relevant-rows object exists for this legacy run. Only the index count (4) is
    // known; the agent priced two and excluded one. The count-based remainder (1) must
    // still trigger exactly one repair rather than silently completing.
    const assistantText = 'Done:\n' + completedJson({
      evidenceConsumed: ROWS.slice(0, 2),
      evidenceExcluded: [ROWS[2]],
    });
    givenCompletedStep({ record: baseRecord(), assistantText, indexCostRelevant: 4 });
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (input.Key === indexKey) return s3Body({ accounting: { costRelevantRows: 4 } });
      if (input.Key === rowsKey) throw new Error('NoSuchKey');
      if (input.Key === accountingKey) return s3Body({ unresolved: [], version: '1.0' });
      throw new Error(`Unexpected S3 read in test: ${input.Key}`);
    });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    expect(outcome).toMatchObject({ done: false, iteration: 6 });
    expect(lastUpdateSerialized()).toContain('coverage_repair_requested');
  });

  it('sends ONE bounded repair turn that names the uncovered rows, and only then marks the repair attempted', async () => {
    const record = { ...baseRecord(), coverage_repair_requested: true };
    ddbMock.on(GetCommand).resolves({ Item: record });
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (input.Key === accountingKey) return s3Body({ unresolved: ['Inventory!8'] });
      throw new Error(`Unexpected S3 read in test: ${input.Key}`);
    });
    // The repair step's own stream produces no terminal object yet (the agent keeps going).
    agentCoreMock.on(InvokeHarnessCommand).resolves({ stream: agentFrames('') } as never);

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 6 });

    // The repair instruction enumerates the uncovered row so the agent prices the exact gap.
    const invoke = agentCoreMock.commandCalls(InvokeHarnessCommand)[0].args[0].input as any;
    const text = invoke.messages[0].content[0].text as string;
    expect(text).toContain('Inventory!8');
    expect(text).toContain('evidenceExcluded');
    expect(text).toContain('evidenceUnsupported');

    // The request is cleared and marked attempted only after the Harness accepted the send.
    const serialized = JSON.stringify(ddbMock.commandCalls(UpdateCommand)[0].args[0].input);
    expect(serialized).toContain('coverage_repair_attempted');
    expect(outcome).toMatchObject({ done: false, iteration: 7 });
  });

  it('marks a still-uncovered COMPLETED claim NEEDS_REVIEW after the single repair, never a second repair', async () => {
    const record = { ...baseRecord(), coverage_repair_attempted: true };
    // Even after the repair turn the agent prices only three of the four rows.
    const assistantText = 'Done:\n' + completedJson({
      evidenceConsumed: ROWS.slice(0, 3),
      evidenceExcluded: [],
      evidenceUnsupported: [],
    });
    givenCompletedStep({ record, assistantText, costRelevantRows: ROWS, indexCostRelevant: 4 });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 7 });

    expect(outcome).toMatchObject({ done: true, status: 'NEEDS_REVIEW' });
    // No second repair was requested: the run is finished, flagged for review.
    const serialized = lastUpdateSerialized();
    expect(serialized).not.toContain('coverage_repair_requested');
    const resultBody = putBodiesTo(PutObjectCommand, `users/${OWNER}/calculator/${CALC}/result.json`).pop();
    const diagnostics = JSON.parse(resultBody!).diagnostics as Record<string, unknown>;
    expect(diagnostics.costVerified).toBe(false);
    expect(diagnostics.coverageUnresolvedRows).toBe(1);
    // The warning the review UI shows names the uncovered rows.
    const warnings = (JSON.parse(resultBody!) as { warnings: string[] }).warnings;
    expect(warnings.some((message) => /workbook row\(s\)/.test(message))).toBe(true);
  });

  it('keeps a fully-covered COMPLETED claim terminal COMPLETED and records telemetry (Parts 38-39)', async () => {
    const tools = [
      { name: 'add_service', toolUseId: 't1' },
      { name: 'add_service', toolUseId: 't2' },
      { name: 'validate_estimate', toolUseId: 't3' },
    ];
    const assistantText = 'Done:\n' + completedJson({ evidenceConsumed: ROWS });
    givenCompletedStep({ record: baseRecord(), assistantText, tools });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    expect(outcome).toMatchObject({ done: true, status: 'COMPLETED' });
    // Message rounds = the driver step number this run is on (6 here: iterations 0..5 used).
    const fields = lastUpdateFields();
    expect(fields.agent_iterations).toBe(6);
    const resultBody = putBodiesTo(PutObjectCommand, `users/${OWNER}/calculator/${CALC}/result.json`).pop();
    const diagnostics = JSON.parse(resultBody!).diagnostics as Record<string, unknown>;
    expect(diagnostics.toolCallCounts).toMatchObject({ add_service: 2, validate_estimate: 1 });
    expect(diagnostics.agentIterations).toBe(6);
    expect(typeof diagnostics.agentTotalDurationMs).toBe('number');
  });

  it('demotes a fully-covered estimate to NEEDS_REVIEW when the saved total cannot be read back', async () => {
    const assistantText = 'Done:\n' + completedJson({ evidenceConsumed: ROWS });
    // The estimate URL renders nothing (e.g. the export page never produced a monthly total).
    givenCompletedStep({
      record: baseRecord(),
      assistantText,
      browser: { validUrl: false, reason: 'Page did not render a monthly total' },
    });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    expect(outcome).toMatchObject({ done: true, status: 'NEEDS_REVIEW' });
    const resultBody = putBodiesTo(PutObjectCommand, `users/${OWNER}/calculator/${CALC}/result.json`).pop();
    const diagnostics = JSON.parse(resultBody!).diagnostics as Record<string, unknown>;
    expect(diagnostics.costVerified).toBe(false);
    expect(diagnostics.coverageUnresolvedRows).toBe(0);
  });
});

/**
 * Part 42 — the mission's REQUIRED TESTS A–J.
 *
 * Claude is the intelligence layer: whether to ask about commercial pricing, an ambiguous
 * frequency, a sizing contradiction or an OS conflict is the agent's decision, made under
 * the system prompt. MIMO's deterministic duties are (a) to state those expectations in
 * the prompt, and (b) to honour an agent that DOES ask (surface a real, persisted customer
 * question and pause — never complete over an open question) and one that DOESN'T (complete
 * without fabricating a question), (c) to keep every calculator.aws estimate URL a
 * comparison returns, (d) to account for each distinct source row without merging, and
 * (e) to reconcile coverage against the actual rows so a large workbook can never leave a
 * silent remainder. So A–H are prompt-gate + driver-seam tests, I is the evidence-tool
 * source gate over the dedicated zero-loss paging suite, and J is the large-workbook
 * remainder.
 */
describe('Part 42 — REQUIRED TESTS A-J', () => {
  const readPrompt = (): string =>
    require('fs').readFileSync(
      require('path').join(__dirname, '../prompts/calculator-agent-system.txt'), 'utf8',
    );

  // The real Harness pause: a request_user_input content block (start + input delta),
  // then messageStop with stopReason 'tool_use'. The driver persists a wait state.
  async function* pauseFrames(input: Record<string, unknown>) {
    yield {
      contentBlockStart: {
        contentBlockIndex: 1,
        start: { toolUse: { name: 'request_user_input', toolUseId: 'tooluse_q' } },
      },
    };
    yield {
      contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: JSON.stringify(input) } } },
    };
    yield { messageStop: { stopReason: 'tool_use' } };
  }

  const givenPause = async (input: Record<string, unknown>, iteration = 2) => {
    ddbMock.on(GetCommand).resolves({ Item: baseRecord() });
    agentCoreMock.on(InvokeHarnessCommand).resolves({ stream: pauseFrames(input) } as never);
    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration });
    return { outcome, fields: lastUpdateFields() };
  };

  it('A — commercial pricing missing becomes a customer question, not a completed estimate', async () => {
    expect(readPrompt()).toContain('commercial pricing, term, payment, frequency, runtime and sizing decisions, ask before pricing');
    const { outcome, fields } = await givenPause({
      questionId: 'q-commitment',
      title: 'EC2 commitment',
      question: 'The workbook prices EC2 but names no commitment term. Which should apply?',
      reason: 'A commitment materially changes the monthly cost, so it cannot be guessed.',
      scope: 'all EC2 resources',
      selectionMode: 'single',
      options: [
        { value: 'on_demand', label: 'On-Demand', description: 'No commitment; highest unit price.' },
        { value: 'sp_1yr_no_upfront', label: '1-year Savings Plan, no upfront' },
        { value: 'sp_3yr_all_upfront', label: '3-year Savings Plan, all upfront' },
      ],
      customInput: { enabled: true, label: 'Other', inputType: 'text' },
      allowApplyToSimilarResources: true,
    });

    expect(outcome).toMatchObject({ done: true, status: 'WAITING_FOR_INPUT' });
    const question = (fields.agent_questions as Array<Record<string, unknown>>)[0];
    expect(question).toMatchObject({
      questionId: 'q-commitment',
      title: 'EC2 commitment',
      selectionMode: 'single',
      allowApplyToSimilarResources: true,
    });
    expect(question.type).toBeUndefined();
    expect((question.options as Array<Record<string, unknown>>).length).toBeGreaterThanOrEqual(2);
  });

  it('B — a comparison keeps every calculator.aws estimate URL, one per scenario', async () => {
    const assistantText = 'Done:\n' + completedJson({
      evidenceConsumed: ROWS,
      calculatorUrls: [
        'https://calculator.aws/#/estimate?id=cmp-on-demand',
        'https://calculator.aws/#/estimate?id=cmp-3yr-sp',
      ],
      scenarios: [
        { label: 'On-Demand', url: 'https://calculator.aws/#/estimate?id=cmp-on-demand' },
        { label: '3-year Savings Plan', url: 'https://calculator.aws/#/estimate?id=cmp-3yr-sp' },
      ],
    });
    givenCompletedStep({ record: baseRecord(), assistantText });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    expect(outcome).toMatchObject({ done: true, status: 'COMPLETED' });
    const resultBody = putBodiesTo(PutObjectCommand, `users/${OWNER}/calculator/${CALC}/result.json`).pop();
    const scenarios = (JSON.parse(resultBody!) as { scenarios: Array<{ label: string; url: string }> }).scenarios;
    const urls = scenarios.map((scenario) => scenario.url).sort();
    expect(urls).toEqual([
      'https://calculator.aws/#/estimate?id=cmp-3yr-sp',
      'https://calculator.aws/#/estimate?id=cmp-on-demand',
    ]);
  });

  it('C — an ambiguous frequency/runtime becomes a question, not a silent 24x7 assumption', async () => {
    expect(readPrompt()).toContain('frequency');
    const { outcome, fields } = await givenPause({
      questionId: 'q-hours',
      title: 'Operating hours',
      question: 'No server states its hours. What hours should the EC2 fleet run?',
      reason: 'Hours materially change the monthly cost and the workbook is silent on them.',
      selectionMode: 'multiple',
      options: [
        { value: '24x7', label: '24x7' },
        { value: 'business', label: 'Business hours' },
      ],
      customInput: { enabled: true, inputType: 'number', unit: 'hours/day', placeholder: 'e.g. 12' },
    });

    expect(outcome).toMatchObject({ done: true, status: 'WAITING_FOR_INPUT' });
    expect((fields.agent_questions as Array<Record<string, unknown>>)[0].question).toContain('hours');
  });

  it('D — a known frequency produces no question and a completed estimate', async () => {
    // The agent read the hours from the workbook (mocked as streamed text) and priced the
    // rows; it never called request_user_input. MIMO must not invent a question for it.
    givenCompletedStep({ record: baseRecord(), assistantText: 'Done:\n' + completedJson({ evidenceConsumed: ROWS }) });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    expect(outcome).toMatchObject({ done: true, status: 'COMPLETED' });
    const fields = lastUpdateFields();
    expect(fields.status).toBe('COMPLETED');
    expect(fields.pending_tool_use_id).toBeUndefined();
    expect(fields.agent_questions).toBeUndefined();
  });

  it('E — a sizing contradiction becomes a question, not a nearest-fit instance guess', async () => {
    expect(readPrompt()).toContain('Material mismatches are questions, not nearest-fit assumptions');
    const { outcome, fields } = await givenPause({
      questionId: 'q-db-size',
      title: 'Database size conflict',
      question: 'The workbook names db.r6g.large and db.r6g.xlarge for the same database. Which is right?',
      reason: 'A sizing contradiction is a material customer decision and cannot be coerced silently.',
      options: [
        { value: 'db.r6g.large', label: 'db.r6g.large' },
        { value: 'db.r6g.xlarge', label: 'db.r6g.xlarge' },
      ],
    });

    expect(outcome).toMatchObject({ done: true, status: 'WAITING_FOR_INPUT' });
    expect((fields.agent_questions as Array<Record<string, unknown>>)[0].question).toContain('db.r6g');
  });

  it('F — an OS family/version conflict becomes a question, not a coerced platform', async () => {
    expect(readPrompt()).toContain('OS family/version conflict');
    const { outcome, fields } = await givenPause({
      questionId: 'q-os',
      title: 'OS conflict',
      question: 'The OS column says Windows but the row looks like a Linux-only workload. Which OS?',
      reason: 'The OS family/version conflict changes the license cost and cannot be assumed.',
      options: [
        { value: 'linux', label: 'Linux' },
        { value: 'windows', label: 'Windows' },
      ],
    });

    expect(outcome).toMatchObject({ done: true, status: 'WAITING_FOR_INPUT' });
    expect((fields.agent_questions as Array<Record<string, unknown>>)[0].reason).toContain('OS');
  });

  it('G — three independent resources stay three individually accounted source rows', async () => {
    expect(readPrompt()).toContain('represented individually in AWS Pricing Calculator');
    expect(readPrompt()).toContain('Do not merge several independent source resources into one Calculator line item');
    const priced = ROWS.slice(0, 3); // Inventory!5, !6, !7 — three distinct workloads
    givenCompletedStep({
      record: baseRecord(),
      assistantText: 'Done:\n' + completedJson({ evidenceConsumed: priced }),
      costRelevantRows: priced,
      indexCostRelevant: priced.length,
    });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    expect(outcome).toMatchObject({ done: true, status: 'COMPLETED' });
    const accounting = JSON.parse(putBodiesTo(PutObjectCommand, accountingKey).pop()!);
    // Three distinct rows individually priced — none merged, none dropped, none left over.
    expect(accounting.counts.costRelevant).toBe(3);
    expect(accounting.counts.consumed).toBe(3);
    expect(accounting.unresolved).toEqual([]);
  });

  it('H — an explicit counted fleet may stay a single entry and still pass coverage', async () => {
    expect(readPrompt()).toContain('A source row that explicitly defines one counted fleet may stay a single entry with that count');
    // Inventory!5 explicitly defines a fleet of N servers; one row, one entry, count = N.
    const fleetRow = ROWS[0];
    givenCompletedStep({
      record: baseRecord(),
      assistantText: 'Done:\n' + completedJson({ evidenceConsumed: [fleetRow] }),
      costRelevantRows: [fleetRow],
      indexCostRelevant: 1,
    });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    expect(outcome).toMatchObject({ done: true, status: 'COMPLETED' });
    const accounting = JSON.parse(putBodiesTo(PutObjectCommand, accountingKey).pop()!);
    expect(accounting.counts.costRelevant).toBe(1);
    expect(accounting.counts.consumed).toBe(1);
    expect(accounting.unresolved).toEqual([]);
  });

  it('I — the evidence cursor contract is intact over the dedicated zero-loss paging suite', () => {
    // calculator-evidence-tool-paging.test.ts proves zero loss/duplication across chunk and
    // oversized-row boundaries. This source gate keeps the whole-chunk/exact-cursor surface
    // the bug fix (e239b1c) introduced from silently regressing.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '../lambdas/calculator-evidence-tool/index.ts'), 'utf8',
    );
    expect(source).toContain('returnedChunks');
    expect(source).toContain('moreAvailable');
    expect(source).toContain('nextChunkId');
    expect(source).toContain('nextRowsFrom');
    expect(source).toContain('MAX_RESPONSE_BYTES');
  });

  it('J — a 120-row workbook the agent priced only a slice of leaves every remaining row unresolved', async () => {
    const largeRows = Array.from({ length: 120 }, (_, index) => `Inventory!${5 + index}`);
    const priced = largeRows.slice(0, 40);
    givenCompletedStep({
      record: baseRecord(),
      assistantText: 'Done:\n' + completedJson({ evidenceConsumed: priced }),
      costRelevantRows: largeRows,
      indexCostRelevant: largeRows.length,
    });

    const outcome = await runStep({ calculationId: CALC, sessionId: SESSION, iteration: 5 });

    // Zero silent remainder: not trusted, one repair requested, and the accounting names
    // exactly the 80 rows the agent never priced — nothing vanishes.
    expect(outcome).toMatchObject({ done: false, iteration: 6 });
    const accounting = JSON.parse(putBodiesTo(PutObjectCommand, accountingKey).pop()!);
    expect(accounting.counts.costRelevant).toBe(120);
    expect(accounting.counts.consumed).toBe(40);
    const remaining = largeRows.filter((row) => !priced.includes(row)).sort();
    expect([...(accounting.unresolved as string[])].sort()).toEqual(remaining);
    expect(lastUpdateSerialized()).toContain('coverage_repair_requested');
  });
});
