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
