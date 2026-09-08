/**
 * Harness driver — one short-lived step of an AgentCore calculator execution.
 *
 * This is NOT an agent loop. It sends one message to the AgentCore Harness and reads
 * the resulting event stream. Every model call, tool choice, MCP invocation, error
 * repair and retry happens inside AgentCore. The only decisions made here are
 * "did the agent finish?" and "what should the user see right now?".
 *
 * Why a Step Functions pump rather than one long-lived worker:
 *
 *   InvokeHarness is a synchronous streaming API, so somebody has to hold the stream.
 *   A Lambda holding it to completion reintroduces the 15-minute ceiling that this
 *   migration exists to remove, and the Harness's own managed runtime allows sessions
 *   up to maxLifetime 28800s (8 hours, measured). So each invocation is bounded, and if
 *   the agent has not finished, Step Functions re-enters this function with the SAME
 *   runtimeSessionId — which is how AgentCore continues a conversation. The agent's
 *   context lives in the AgentCore session, not in a Lambda that must stay alive.
 *
 * Every event read from the stream refreshes `agent_last_activity_at`. That is what
 * replaces the old staleness heuristic: liveness is now something observed, not
 * inferred from `updated_at`.
 */

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessMessage,
} from '@aws-sdk/client-bedrock-agentcore';
import { ddbDocClient, getFileBuffer, saveFileContent } from '../shared/aws.js';
import {
  evidenceIndexKey,
  evidenceAccountingKey,
  reconcileEvidence,
  type WorkbookEvidenceIndex,
} from '../shared/workbook-evidence.js';
import { calculationResultKey, compactCalculationResult } from '../shared/calculator-result-storage.js';
import { CalculationResultSchema, type CalculationRecord } from '../../schema/calculator.js';

const CALCULATOR_TABLE_NAME = process.env.CALCULATOR_TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const HARNESS_ARN = process.env.CALCULATOR_HARNESS_ARN!;
const MODEL_ID = process.env.CALCULATOR_AGENT_MODEL_ID || 'global.anthropic.claude-sonnet-4-6';
const GATEWAY_IDENTIFIER = process.env.CALCULATOR_GATEWAY_ARN || '';
const MCP_RUNTIME_IDENTIFIER = process.env.CALCULATOR_MCP_RUNTIME_ARN || '';
const BROWSER_VALIDATOR_FUNCTION_NAME = process.env.CALCULATOR_BROWSER_VALIDATOR_FUNCTION_NAME || '';
export const EXECUTION_MODE = 'agentcore-runtime';

/** One invocation's share of the wall clock. Step Functions re-enters for more. */
const STEP_TIMEOUT_SECONDS = Number(process.env.CALCULATOR_STEP_TIMEOUT_SECONDS) || 600;
/** Don't write a heartbeat on every token. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** Trace events retained per step before older detail is summarised away. */
const MAX_TRACE_EVENTS = 4_000;

const agentCore = new BedrockAgentCoreClient({});
const lambdaClient = new LambdaClient({});

// ─── Progress vocabulary (Phase 19) ──────────────────────────────────────────
//
// Customer-facing progress is derived from what the agent is ACTUALLY doing, read off
// the tool names in the stream. Nothing here is a timer or a guess.

type Stage = 'ANALYZING' | 'BUILDING' | 'VALIDATING';

const PROGRESS_BY_TOOL: Record<string, { stage: Stage; message: string }> = {
  get_workbook_evidence: { stage: 'ANALYZING', message: 'Reading your workbook...' },
  search_services: { stage: 'BUILDING', message: 'Resolving AWS services...' },
  get_service_fields: { stage: 'BUILDING', message: 'Resolving AWS services...' },
  create_estimate: { stage: 'BUILDING', message: 'Creating AWS Pricing Calculator estimate...' },
  add_service: { stage: 'BUILDING', message: 'Creating AWS Pricing Calculator estimate...' },
  build_estimate: { stage: 'BUILDING', message: 'Creating AWS Pricing Calculator estimate...' },
  validate_estimate: { stage: 'VALIDATING', message: 'Validating the AWS estimate...' },
  export_estimate: { stage: 'VALIDATING', message: 'Saving the AWS estimate...' },
  import_estimate: { stage: 'VALIDATING', message: 'Confirming the saved AWS estimate...' },
};

/** Gateway tool names arrive as `<target>___<tool>`. */
const bareToolName = (name: string) => String(name).split('___').pop()!;

const expectedScenarioCount = (record: CalculationRecord): number => {
  const plan = record.plan_v2;
  const currentRevision = plan?.revisions?.find((revision) => revision.revisionId === plan.currentRevisionId);
  const planned = currentRevision?.scenarios?.length || plan?.recommendedScenarios?.length || 0;
  return planned || record.requested_plan?.scenarios?.length || record.workbook?.bands?.length || 0;
};

// ─── Agent result contract ───────────────────────────────────────────────────

interface AgentCompleted {
  status: 'COMPLETED';
  estimateId?: string;
  calculatorUrl: string;
  calculatorUrls?: string[];
  monthly?: number | null;
  upfront?: number | null;
  total12Months?: number | null;
  servicesConfigured?: string[];
  assumptions?: string[];
  warnings?: string[];
  scenarios?: Array<Record<string, unknown>>;
  evidenceConsumed?: string[];
  evidenceExcluded?: string[];
  evidenceUnsupported?: string[];
  evidenceUnresolved?: string[];
  mcpToolsUsed?: string[];
}

type AgentQuestionType = 'CHOICE' | 'NUMBER' | 'BOOLEAN' | 'TEXT';

interface AgentQuestion {
  questionId?: string;
  resource?: string;
  semanticField?: string;
  field?: string;
  type: AgentQuestionType;
  title?: string;
  question: string;
  reason?: string;
  choices?: Array<{ value: string; label: string }>;
  recommended?: string | number | boolean | null;
  unit?: string;
  allowApplyToSimilarResources?: boolean;
}

interface AgentNeedsInput {
  status: 'NEEDS_INPUT';
  questions: AgentQuestion[];
}

interface AgentFailed {
  status: 'FAILED';
  errorCategory?: string;
  message?: string;
}

type AgentResult = AgentCompleted | AgentNeedsInput | AgentFailed;

interface RenderedTotals {
  validUrl: boolean;
  reason?: string;
  monthly?: number;
  upfront?: number;
  total12Months?: number;
  services?: Array<{ service?: string; monthly?: number | null; upfront?: number | null; configSummary?: string }>;
}

// ─── DynamoDB (small fields only — Phase 22) ─────────────────────────────────

async function patch(calculationId: string, fields: Record<string, unknown>): Promise<void> {
  const entries = Object.entries({ ...fields, updated_at: Date.now() })
    .filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  await ddbDocClient.send(new UpdateCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: calculationId },
    UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([key], i) => [`#f${i}`, key])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, value], i) => [`:v${i}`, value])),
  }));
}

// ─── Building the agent's message ────────────────────────────────────────────

/**
 * The first message: the task, the customer's instructions, and either the whole
 * evidence (small workbook) or the index plus how to fetch the rest (large workbook).
 *
 * Note what is absent: no Calculator service codes, no field IDs, no config shapes. The
 * agent is given the customer's workload and told to go and find out how the Calculator
 * expresses it.
 */
export async function buildInitialMessage(record: CalculationRecord, calculationId: string): Promise<string> {
  const owner = record.owner_user_id;
  const lines: string[] = [
    'Build an AWS Pricing Calculator estimate for this customer workload.',
    '',
    `calculationId: ${calculationId}`,
    `Scenario: ${record.name || 'AWS Cost Estimate'}`,
  ];
  if (record.region) lines.push(`Primary region: ${record.region}`);
  lines.push('');

  if (record.prompt) {
    lines.push('Customer instructions:');
    lines.push(`  ${record.prompt}`);
    lines.push('');
  }

  let index: WorkbookEvidenceIndex | undefined;
  try {
    index = JSON.parse((await getFileBuffer(BUCKET_NAME, evidenceIndexKey(owner, calculationId))).toString('utf8'));
  } catch {
    index = undefined;
  }

  if (!index) {
    lines.push('No workbook evidence index was found for this calculation.');
    lines.push('Call get_workbook_evidence with this calculationId to retrieve what exists.');
    return lines.join('\n');
  }

  lines.push(`Workbook: ${index.fileName}`);
  lines.push(`Sheets: ${index.sheets.map((sheet) => `${sheet.name} (${sheet.rowCount} rows)`).join(', ')}`);
  lines.push(`Total rows: ${index.accounting.totalRows}. Rows that look billable: ${index.accounting.costRelevantRows}.`);
  lines.push('');

  lines.push(`The workbook evidence is available through get_workbook_evidence in ${index.accounting.totalChunks} chunk(s):`);
  for (const chunk of index.chunks) {
    lines.push(`  chunk ${chunk.chunkId}: ${chunk.sheet} rows ${chunk.rowsFrom}-${chunk.rowsTo}`
      + ` (${chunk.costRelevantRowCount} billable-looking rows)`);
  }
  lines.push('');
  lines.push('Call get_workbook_evidence before creating any AWS Pricing Calculator estimate.');
  lines.push('No rows have been discarded; the evidence tool returns the uploaded workbook content.');

  lines.push('');
  lines.push('Use the connected AWS Pricing Calculator MCP to create, validate, export and read back the requested estimate.');

  return lines.join('\n');
}

// ─── JSON extraction ─────────────────────────────────────────────────────────

/** The last balanced JSON object in the text, which is where the contract puts it. */
export function lastJsonObject(text: string): unknown | undefined {
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}

/**
 * A COMPLETED claim is only accepted with a real calculator.aws URL (Phase 18).
 * Everything else is reported as it was returned; totals are never invented.
 */
export function parseAgentResult(text: string): AgentResult | undefined {
  // Typed as a loose bag rather than Partial<A & B & C>: intersecting the three result
  // shapes makes `status` be 'COMPLETED' & 'NEEDS_INPUT' & 'FAILED', i.e. never, which
  // silently collapses the whole object to never and every field access to an error.
  const parsed = lastJsonObject(text) as (Record<string, unknown> & { status?: string }) | undefined;
  if (!parsed?.status) return undefined;

  const strings = (value: unknown): string[] | undefined =>
    (Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined);
  const numberOrNull = (value: unknown): number | null =>
    (typeof value === 'number' && Number.isFinite(value) ? value : null);

  if (parsed.status === 'COMPLETED') {
    const calculatorUrls = Array.isArray(parsed.calculatorUrls)
      ? parsed.calculatorUrls.filter((url): url is string => typeof url === 'string' && url.includes('calculator.aws'))
      : [];
    const url = typeof parsed.calculatorUrl === 'string' && parsed.calculatorUrl
      ? parsed.calculatorUrl
      : calculatorUrls[0] || '';
    if (!url.includes('calculator.aws')) {
      return {
        status: 'FAILED',
        errorCategory: 'NO_CALCULATOR_URL',
        message: 'The agent reported COMPLETED without a real calculator.aws URL.',
      };
    }
    return {
      status: 'COMPLETED',
      estimateId: typeof parsed.estimateId === 'string' ? parsed.estimateId : undefined,
      calculatorUrl: url,
      calculatorUrls,
      monthly: numberOrNull(parsed.monthly),
      upfront: numberOrNull(parsed.upfront),
      total12Months: numberOrNull(parsed.total12Months),
      servicesConfigured: strings(parsed.servicesConfigured) ?? [],
      assumptions: strings(parsed.assumptions) ?? [],
      warnings: strings(parsed.warnings) ?? [],
      evidenceConsumed: strings(parsed.evidenceConsumed) ?? [],
      evidenceExcluded: strings(parsed.evidenceExcluded) ?? [],
      evidenceUnsupported: strings(parsed.evidenceUnsupported) ?? [],
      evidenceUnresolved: strings(parsed.evidenceUnresolved) ?? [],
      mcpToolsUsed: strings(parsed.mcpToolsUsed) ?? [],
      scenarios: Array.isArray(parsed.scenarios)
        ? (parsed.scenarios as Array<unknown>).filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
        : [],
    };
  }
  if (parsed.status === 'NEEDS_INPUT') {
    const questionType = (value: unknown): AgentQuestionType => {
      const normalised = typeof value === 'string' ? value.toUpperCase() : '';
      return ['CHOICE', 'NUMBER', 'BOOLEAN', 'TEXT'].includes(normalised)
        ? normalised as AgentQuestionType
        : 'TEXT';
    };
    const questions = Array.isArray(parsed.questions)
      ? (parsed.questions as Array<Record<string, unknown>>)
        .filter((entry) => typeof entry?.question === 'string')
        .map((entry) => ({
          questionId: typeof entry.questionId === 'string' ? entry.questionId : undefined,
          resource: typeof entry.resource === 'string' ? entry.resource : undefined,
          semanticField: typeof entry.semanticField === 'string' ? entry.semanticField : undefined,
          field: typeof entry.field === 'string' ? entry.field : undefined,
          type: questionType(entry.type),
          title: typeof entry.title === 'string' ? entry.title : undefined,
          question: entry.question as string,
          reason: typeof entry.reason === 'string' ? entry.reason : undefined,
          choices: Array.isArray(entry.choices)
            ? entry.choices
              .filter((choice): choice is Record<string, unknown> => !!choice && typeof choice === 'object')
              .map((choice) => ({
                value: String(choice.value ?? choice.label ?? ''),
                label: String(choice.label ?? choice.value ?? ''),
              }))
              .filter((choice) => choice.value && choice.label)
            : undefined,
          recommended: ['string', 'number', 'boolean'].includes(typeof entry.recommended) || entry.recommended === null
            ? entry.recommended as string | number | boolean | null
            : undefined,
          unit: typeof entry.unit === 'string' ? entry.unit : undefined,
          allowApplyToSimilarResources: typeof entry.allowApplyToSimilarResources === 'boolean'
            ? entry.allowApplyToSimilarResources
            : undefined,
        }))
      : [];
    return { status: 'NEEDS_INPUT', questions };
  }
  if (parsed.status === 'FAILED') {
    return {
      status: 'FAILED',
      errorCategory: typeof parsed.errorCategory === 'string' ? parsed.errorCategory : 'UNKNOWN',
      message: typeof parsed.message === 'string' ? parsed.message : 'The agent reported failure.',
    };
  }
  return undefined;
}

// ─── Step Functions contract ─────────────────────────────────────────────────

async function readRenderedTotals(url: string): Promise<RenderedTotals | undefined> {
  if (!BROWSER_VALIDATOR_FUNCTION_NAME) return undefined;
  const response = await lambdaClient.send(new InvokeCommand({
    FunctionName: BROWSER_VALIDATOR_FUNCTION_NAME,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify({ url })),
  }));
  const raw = new TextDecoder().decode(response.Payload);
  if (response.FunctionError) {
    return { validUrl: false, reason: `Browser validator failed: ${raw.slice(0, 500)}` };
  }
  try {
    return JSON.parse(raw) as RenderedTotals;
  } catch {
    return { validUrl: false, reason: `Browser validator returned non-JSON: ${raw.slice(0, 500)}` };
  }
}

export interface DriverStepInput {
  calculationId: string;
  /** AgentCore session id. Reused across steps so the conversation continues. */
  sessionId?: string;
  iteration?: number;
  /** Answer to a previous NEEDS_INPUT, for a continuation run (Phase 17). */
  userAnswer?: string;
  /**
   * 'fail' is the state machine's catch path. Without it a driver crash leaves the
   * record in BUILDING for ever and the UI shows a job that is neither running nor
   * finished — which is precisely the confusion the old staleness hack existed to paper
   * over.
   */
  mode?: 'run' | 'fail';
  errorInfo?: unknown;
}

export interface DriverStepOutput {
  calculationId: string;
  sessionId: string;
  iteration: number;
  done: boolean;
  status?: string;
}

export const handler = async (event: DriverStepInput): Promise<DriverStepOutput> => {
  const { calculationId } = event;

  if (event.mode === 'fail') {
    // Customer-facing copy only (Phase 20). The raw cause goes to CloudWatch and S3;
    // "Item size to update has exceeded the maximum allowed size" is not a sentence any
    // customer should read.
    console.error(JSON.stringify({
      event: 'harness_execution_failed',
      calculationId,
      errorInfo: JSON.stringify(event.errorInfo ?? null).slice(0, 4000),
    }));
    await patch(calculationId, {
      status: 'FAILED',
      progress_stage: 'FAILED',
      progress_message: "We couldn't complete this AWS estimate automatically.",
      error_message: "We couldn't complete this AWS estimate automatically.",
      agent_last_activity_at: Date.now(),
    });
    return { calculationId, sessionId: event.sessionId ?? '', iteration: event.iteration ?? 0, done: true, status: 'FAILED' };
  }

  const iteration = event.iteration ?? 0;
  // runtimeSessionId has a MINIMUM length of 33 characters, which is easy to miss when
  // calculationIds are short:
  //   "Value at 'runtimeSessionId' failed to satisfy constraint:
  //    Member must have length greater than or equal to 33"
  const sessionId = event.sessionId
    || `mimo-${calculationId}-${Date.now().toString(36)}`.padEnd(33, '0');

  const existing = await ddbDocClient.send(new GetCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: calculationId },
  }));
  const record = existing.Item as CalculationRecord | undefined;
  if (!record) throw new Error(`Calculation ${calculationId} not found`);

  const startedAt = Date.now();
  const trace: Array<Record<string, unknown>> = [];
  const toolCalls: string[] = [];
  let assistantText = '';
  let lastHeartbeat = 0;
  let lastStage: Stage = iteration === 0 ? 'ANALYZING' : 'BUILDING';
  let lastMessage = iteration === 0 ? 'Reading your workbook...' : 'Claude is configuring AWS Pricing Calculator...';
  const streamErrors: string[] = [];

  const heartbeat = async (force = false) => {
    const now = Date.now();
    if (!force && now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
    lastHeartbeat = now;
    await patch(calculationId, {
      status: lastStage === 'VALIDATING' ? 'VALIDATING' : 'BUILDING',
      progress_stage: lastStage,
      progress_message: lastMessage,
      agent_last_activity_at: now,
      agent_session_id: sessionId,
      tool_call_count: toolCalls.length,
    }).catch((error) => console.error('heartbeat failed', error));
  };

  if (iteration === 0) {
    await patch(calculationId, {
      status: 'ANALYZING',
      progress_stage: 'ANALYZING',
      progress_message: 'Reading your workbook...',
      execution_mode: EXECUTION_MODE,
      agent_model_id: MODEL_ID,
      agent_session_id: sessionId,
      agent_started_at: startedAt,
      agent_last_activity_at: startedAt,
      gateway_identifier: GATEWAY_IDENTIFIER || undefined,
      mcp_runtime_identifier: MCP_RUNTIME_IDENTIFIER || undefined,
    });
  }

  const messageText = iteration === 0
    ? await buildInitialMessage(record, calculationId)
    : (event.userAnswer
      ? `The customer answered: ${event.userAnswer}\n\nContinue building the estimate.`
      : 'Continue. If the estimate is finished, reply with the final JSON object only.');

  const messages: HarnessMessage[] = [{ role: 'user', content: [{ text: messageText }] }];

  console.log(JSON.stringify({
    event: 'harness_step_start',
    executionMode: EXECUTION_MODE,
    calculationId,
    iteration,
    sessionId,
    harnessArn: HARNESS_ARN,
    messageBytes: Buffer.byteLength(messageText, 'utf8'),
  }));

  const response = await agentCore.send(new InvokeHarnessCommand({
    harnessArn: HARNESS_ARN,
    runtimeSessionId: sessionId,
    messages,
    timeoutSeconds: STEP_TIMEOUT_SECONDS,
  }));

  for await (const chunk of response.stream ?? []) {
    const kind = Object.keys(chunk)[0];

    if (kind === 'contentBlockStart') {
      const toolUse = (chunk as any).contentBlockStart?.start?.toolUse;
      if (toolUse?.name) {
        const bare = bareToolName(toolUse.name);
        toolCalls.push(bare);
        const progress = PROGRESS_BY_TOOL[bare];
        if (progress) { lastStage = progress.stage; lastMessage = progress.message; }
        if (trace.length < MAX_TRACE_EVENTS) trace.push({ at: Date.now(), toolUse: toolUse.name });
        await heartbeat();
      }
    } else if (kind === 'contentBlockDelta') {
      const delta = (chunk as any).contentBlockDelta?.delta;
      if (delta?.text) assistantText += delta.text;
      await heartbeat();
    } else if (kind === 'metadata') {
      if (trace.length < MAX_TRACE_EVENTS) trace.push({ at: Date.now(), metadata: (chunk as any).metadata });
      await heartbeat();
    } else if (kind === 'internalServerException' || kind === 'validationException' || kind === 'runtimeClientError') {
      const detail = JSON.stringify((chunk as any)[kind]).slice(0, 1000);
      streamErrors.push(`${kind}: ${detail}`);
      if (trace.length < MAX_TRACE_EVENTS) trace.push({ at: Date.now(), error: kind, detail });
    }
  }

  const durationMs = Date.now() - startedAt;
  const mcpToolsUsed = [...new Set(toolCalls)];

  // Full trace to S3, never to DynamoDB (Phase 22 / Phase 24).
  const traceKey = `users/${record.owner_user_id}/calculator/${calculationId}/agent/traces/${sessionId}-${iteration}.json`;
  await saveFileContent(BUCKET_NAME, traceKey, JSON.stringify({
    executionMode: EXECUTION_MODE,
    calculationId,
    iteration,
    sessionId,
    harnessArn: HARNESS_ARN,
    agentModelId: MODEL_ID,
    gatewayIdentifier: GATEWAY_IDENTIFIER,
    mcpRuntimeIdentifier: MCP_RUNTIME_IDENTIFIER,
    durationMs,
    toolCallCount: toolCalls.length,
    mcpToolsUsed,
    streamErrors,
    assistantText,
    trace,
  }), 'application/json').catch((error) => console.error('trace write failed', error));

  console.log(JSON.stringify({
    event: 'harness_step_end',
    calculationId,
    iteration,
    durationMs,
    toolCallCount: toolCalls.length,
    mcpToolsUsed,
    streamErrors: streamErrors.length,
  }));

  const result = parseAgentResult(assistantText);
  if (!result) {
    // The agent has not produced a terminal object yet. Step Functions will re-enter
    // this function on the same session, which is how AgentCore continues a run.
    await patch(calculationId, {
      agent_last_activity_at: Date.now(),
      tool_call_count: toolCalls.length,
      progress_stage: lastStage,
      progress_message: lastMessage,
    });
    return { calculationId, sessionId, iteration: iteration + 1, done: false };
  }

  await finalise({ record, calculationId, sessionId, result, mcpToolsUsed, toolCallCount: toolCalls.length, durationMs, traceKey });
  return { calculationId, sessionId, iteration: iteration + 1, done: true, status: result.status };
};

// ─── Finalisation ────────────────────────────────────────────────────────────

async function finalise(input: {
  record: CalculationRecord;
  calculationId: string;
  sessionId: string;
  result: AgentResult;
  mcpToolsUsed: string[];
  toolCallCount: number;
  durationMs: number;
  traceKey: string;
}): Promise<void> {
  const { record, calculationId, result, mcpToolsUsed } = input;
  const owner = record.owner_user_id;

  // Evidence accounting (Phase 3): reconcile what the agent said against the workbook.
  let unresolvedCount = 0;
  if (result.status === 'COMPLETED') {
    try {
      const index = JSON.parse((await getFileBuffer(BUCKET_NAME, evidenceIndexKey(owner, calculationId))).toString('utf8')) as WorkbookEvidenceIndex;
      // The index carries counts; the row ids come from the chunks the agent cited plus
      // whatever it omitted, so an absent citation lands in `unresolved` rather than
      // vanishing.
      const accounting = reconcileEvidence({
        calculationId,
        costRelevantRows: result.evidenceConsumed?.length || result.evidenceExcluded?.length
          ? [...new Set([
            ...(result.evidenceConsumed ?? []),
            ...(result.evidenceExcluded ?? []),
            ...(result.evidenceUnsupported ?? []),
            ...(result.evidenceUnresolved ?? []),
          ])]
          : [],
        consumedByAgent: result.evidenceConsumed,
        explicitlyIgnored: result.evidenceExcluded,
        unsupported: result.evidenceUnsupported,
        unresolved: result.evidenceUnresolved,
      });
      accounting.counts.costRelevant = index.accounting.costRelevantRows;
      unresolvedCount = Math.max(0, index.accounting.costRelevantRows - accounting.counts.consumed
        - accounting.counts.ignored - accounting.counts.unsupported);
      await saveFileContent(BUCKET_NAME, evidenceAccountingKey(owner, calculationId), JSON.stringify(accounting), 'application/json');
    } catch (error) {
      console.error('evidence accounting failed', error);
    }
  }

  let renderedTotals: RenderedTotals | undefined;
  if (result.status === 'COMPLETED') {
    try {
      renderedTotals = await readRenderedTotals(result.calculatorUrl);
    } catch (error) {
      renderedTotals = { validUrl: false, reason: String((error as Error).message || error).slice(0, 500) };
    }
  }

  const monthlyTotal = result.status === 'COMPLETED'
    ? (result.monthly ?? (renderedTotals?.validUrl && typeof renderedTotals.monthly === 'number' ? renderedTotals.monthly : null))
    : null;
  const upfrontTotal = result.status === 'COMPLETED'
    ? (result.upfront ?? (renderedTotals?.validUrl && typeof renderedTotals.upfront === 'number' ? renderedTotals.upfront : null))
    : null;
  const total12Months = result.status === 'COMPLETED'
    ? (result.total12Months ?? (renderedTotals?.validUrl && typeof renderedTotals.total12Months === 'number' ? renderedTotals.total12Months : null))
    : null;

  const warnings = result.status === 'COMPLETED'
    ? [...(result.warnings ?? [])].filter((message) => (
      !(monthlyTotal !== null && /monthly cost not available/i.test(message))
    ))
    : [];
  if (result.status === 'COMPLETED' && renderedTotals && !renderedTotals.validUrl) {
    warnings.push(renderedTotals.reason || 'The calculator.aws page could not be rendered for total read-back.');
  }
  if (unresolvedCount > 0) {
    warnings.push(`${unresolvedCount} workbook row(s) that look billable were not reported as priced, excluded or unsupported. Open the Source Trace sheet to review them.`);
  }
  const requiredScenarioCount = expectedScenarioCount(record);
  const pricedScenarioCount = result.status === 'COMPLETED' ? ((result as AgentCompleted).scenarios?.length || 0) : 0;
  const scenarioCoveragePassed = result.status !== 'COMPLETED'
    || requiredScenarioCount <= 1
    || pricedScenarioCount >= requiredScenarioCount;
  if (!scenarioCoveragePassed) {
    warnings.push(`This workbook has ${requiredScenarioCount} scenario(s), but the agent returned ${pricedScenarioCount} priced scenario result(s). The estimate is not verified.`);
  }
  const readBackPassed = result.status === 'COMPLETED' && renderedTotals?.validUrl === true && monthlyTotal !== null;
  const coveragePassed = result.status === 'COMPLETED' && unresolvedCount === 0 && scenarioCoveragePassed;
  const costVerified = readBackPassed && coveragePassed;
  const completionBlocked = result.status === 'COMPLETED' && !costVerified;
  if (completionBlocked) {
    if (!readBackPassed) warnings.push('The saved AWS Pricing Calculator estimate could not be read back with a monthly total, so the cost is not verified.');
    if (!coveragePassed) warnings.push('The workbook coverage reconciliation did not pass, so the cost is not verified.');
  }
  const completedScenarios = result.status === 'COMPLETED'
    ? (result.scenarios ?? []).map((scenario, index) => ({
      label: String(scenario.label ?? scenario.name ?? `Scenario ${index + 1}`),
      url: typeof scenario.url === 'string' && scenario.url.includes('calculator.aws')
        ? scenario.url
        : typeof scenario.calculatorUrl === 'string' && scenario.calculatorUrl.includes('calculator.aws')
          ? scenario.calculatorUrl
          : null,
      monthly: typeof scenario.monthly === 'number' ? scenario.monthly : null,
      upfront: typeof scenario.upfront === 'number' ? scenario.upfront : null,
      total_12_months: typeof scenario.total12Months === 'number'
        ? scenario.total12Months
        : typeof scenario.total_12_months === 'number'
          ? scenario.total_12_months
          : null,
      status: 'COMPLETED' as const,
    }))
    : [];

  const calculationResult = CalculationResultSchema.parse({
    url: result.status === 'COMPLETED' ? result.calculatorUrl : null,
    currency: 'USD',
    // Never fabricated: prefer the agent's numeric total when the MCP returns one;
    // otherwise read the rendered calculator.aws page through the validator.
    monthlyTotal,
    lineItems: [],
    environments: [],
    scenarios: completedScenarios,
    assumptions: result.status === 'COMPLETED' ? (result.assumptions ?? []) : [],
    warnings,
    validationErrors: result.status === 'FAILED'
      ? [result.message || 'The agent did not complete.']
      : completionBlocked ? warnings : [],
    diagnostics: {
      MIMO_BUILD_SHA: process.env.MIMO_BUILD_SHA || 'unknown',
      EXECUTION_MODE,
      MCP_TOOLS_USED: mcpToolsUsed,
      SERVICES_CONFIGURED: result.status === 'COMPLETED' ? (result.servicesConfigured ?? []) : [],
      agentDurationMs: input.durationMs,
      agentSessionId: input.sessionId,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
      mcpRuntimeIdentifier: MCP_RUNTIME_IDENTIFIER,
      toolCallCount: input.toolCallCount,
      calculatorUrlCreated: result.status === 'COMPLETED',
      costVerified,
      renderedTotals: renderedTotals ?? null,
      tracePath: input.traceKey,
    },
  });

  const resultS3Key = calculationResultKey(owner, calculationId);
  await saveFileContent(BUCKET_NAME, resultS3Key, JSON.stringify(calculationResult), 'application/json');

  const status = result.status === 'COMPLETED' ? (costVerified ? 'COMPLETED' : 'NEEDS_REVIEW')
    : result.status === 'NEEDS_INPUT' ? 'WAITING_FOR_INPUT'
      : 'FAILED';

  await patch(calculationId, {
    status,
    progress_stage: status === 'COMPLETED' ? 'COMPLETED' : status,
    progress_message: status === 'COMPLETED'
      ? 'Estimate ready'
      : status === 'WAITING_FOR_INPUT'
        ? 'A workload question needs your answer'
        : status === 'NEEDS_REVIEW'
          ? 'Estimate needs review before it can be trusted'
        : 'We could not complete this AWS estimate automatically.',
    // Small summary only. The full result object lives in S3 (Phase 22).
    result: compactCalculationResult(calculationResult),
    result_s3_key: resultS3Key,
    calculator_url: result.status === 'COMPLETED' ? result.calculatorUrl : undefined,
    monthly_total: monthlyTotal ?? undefined,
    upfront_total: upfrontTotal ?? undefined,
    total_12_months: total12Months ?? undefined,
    warning_count: warnings.length,
    question_count: result.status === 'NEEDS_INPUT' ? result.questions.length : 0,
    cost_verified: costVerified,
    // Customer-facing copy only (Phase 20). Raw diagnostics stay in S3/CloudWatch.
    error_message: status === 'FAILED' ? "We couldn't complete this AWS estimate automatically." : undefined,
    agent_questions: result.status === 'NEEDS_INPUT' ? result.questions.slice(0, 20) : undefined,
    agent_last_activity_at: Date.now(),
    tool_call_count: input.toolCallCount,
    mcp_tools_used: mcpToolsUsed,
  });
}
