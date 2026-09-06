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
import {
  BedrockAgentCoreClient,
  InvokeHarnessCommand,
  type HarnessMessage,
} from '@aws-sdk/client-bedrock-agentcore';
import { ddbDocClient, getFileBuffer, saveFileContent } from '../shared/aws.js';
import {
  evidenceIndexKey,
  evidenceFullKey,
  evidenceAccountingKey,
  reconcileEvidence,
  type WorkbookEvidence,
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
export const EXECUTION_MODE = 'agentcore-runtime';

/** One invocation's share of the wall clock. Step Functions re-enters for more. */
const STEP_TIMEOUT_SECONDS = Number(process.env.CALCULATOR_STEP_TIMEOUT_SECONDS) || 600;
/** Don't write a heartbeat on every token. */
const HEARTBEAT_INTERVAL_MS = 15_000;
/** Trace events retained per step before older detail is summarised away. */
const MAX_TRACE_EVENTS = 4_000;

const agentCore = new BedrockAgentCoreClient({});

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

// ─── Agent result contract ───────────────────────────────────────────────────

interface AgentCompleted {
  status: 'COMPLETED';
  estimateId?: string;
  calculatorUrl: string;
  monthly?: number | null;
  upfront?: number | null;
  total12Months?: number | null;
  servicesConfigured?: string[];
  assumptions?: string[];
  warnings?: string[];
  evidenceConsumed?: string[];
  evidenceExcluded?: string[];
  evidenceUnsupported?: string[];
  evidenceUnresolved?: string[];
  mcpToolsUsed?: string[];
}

interface AgentNeedsInput {
  status: 'NEEDS_INPUT';
  questions: Array<{ resource?: string; field?: string; question: string; reason?: string }>;
}

interface AgentFailed {
  status: 'FAILED';
  errorCategory?: string;
  message?: string;
}

type AgentResult = AgentCompleted | AgentNeedsInput | AgentFailed;

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
async function buildInitialMessage(record: CalculationRecord, calculationId: string): Promise<string> {
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
  if (index.detectedEnvironments.length) lines.push(`Environments seen: ${index.detectedEnvironments.join(', ')}`);
  if (index.detectedFiscalPeriods.length) lines.push(`Fiscal periods seen: ${index.detectedFiscalPeriods.join(', ')}`);
  if (index.serviceHints.length) lines.push(`Service hints (indicative only, confirm with the MCP): ${index.serviceHints.join(', ')}`);
  lines.push('');

  // A workbook small enough to inline is inlined whole; nothing is summarised away.
  let inlined = false;
  try {
    const raw = (await getFileBuffer(BUCKET_NAME, evidenceFullKey(owner, calculationId))).toString('utf8');
    if (Buffer.byteLength(raw, 'utf8') <= 200_000) {
      const evidence = JSON.parse(raw) as WorkbookEvidence;
      lines.push('Complete workbook evidence follows. It is the whole workbook, not a sample.');
      lines.push('');
      for (const sheet of evidence.sheets) {
        lines.push(`Sheet: ${sheet.name} (${sheet.rows.length} rows)`);
        for (const row of sheet.rows) {
          const cells = row.cells
            .filter((cell) => String(cell.formatted).trim() !== '')
            .map((cell) => {
              const label = cell.header || cell.inheritedHeader;
              return `${cell.address}${label ? ` [${label}]` : ''}=${JSON.stringify(cell.formatted)}`;
            })
            .join(' | ');
          if (cells) lines.push(`  ${row.rowId}: ${cells}`);
        }
        lines.push('');
      }
      inlined = true;
    }
  } catch { /* fall through to the chunked instruction */ }

  if (!inlined) {
    lines.push(`This workbook is too large to include in one message. It is split into ${index.accounting.totalChunks} chunks:`);
    for (const chunk of index.chunks) {
      const hints = [
        ...chunk.environmentHints,
        ...chunk.fiscalPeriodHints,
        ...chunk.serviceHints,
      ].join(', ');
      lines.push(`  chunk ${chunk.chunkId}: ${chunk.sheet} rows ${chunk.rowsFrom}-${chunk.rowsTo}`
        + ` (${chunk.costRelevantRowCount} billable-looking rows)${hints ? ` — ${hints}` : ''}`);
    }
    lines.push('');
    lines.push('Fetch every chunk you need with get_workbook_evidence before finalising.');
    lines.push('No rows have been discarded — everything listed above is retrievable.');
  }

  lines.push('');
  lines.push('Configure this workload through the Calculator MCP tools, validate it, export it,');
  lines.push('and finish with the COMPLETED JSON object including the real calculator.aws URL.');
  lines.push('Report the evidence row ids you used in evidenceConsumed, and account for every');
  lines.push('billable row as consumed, excluded, unsupported or unresolved.');

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
    const url = typeof parsed.calculatorUrl === 'string' ? parsed.calculatorUrl : '';
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
    };
  }
  if (parsed.status === 'NEEDS_INPUT') {
    const questions = Array.isArray(parsed.questions)
      ? (parsed.questions as Array<Record<string, unknown>>)
        .filter((entry) => typeof entry?.question === 'string')
        .map((entry) => ({
          resource: typeof entry.resource === 'string' ? entry.resource : undefined,
          field: typeof entry.field === 'string' ? entry.field : undefined,
          question: entry.question as string,
          reason: typeof entry.reason === 'string' ? entry.reason : undefined,
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

  const warnings = result.status === 'COMPLETED' ? [...(result.warnings ?? [])] : [];
  if (unresolvedCount > 0) {
    warnings.push(`${unresolvedCount} workbook row(s) that look billable were not reported as priced, excluded or unsupported. Open the Source Trace sheet to review them.`);
  }

  const calculationResult = CalculationResultSchema.parse({
    url: result.status === 'COMPLETED' ? result.calculatorUrl : null,
    currency: 'USD',
    // Never fabricated: a total the Calculator did not give us stays null and the UI
    // says so rather than printing a dash or a locally-computed number.
    monthlyTotal: result.status === 'COMPLETED' ? (result.monthly ?? null) : null,
    lineItems: [],
    environments: [],
    scenarios: [],
    assumptions: result.status === 'COMPLETED' ? (result.assumptions ?? []) : [],
    warnings,
    validationErrors: result.status === 'FAILED' ? [result.message || 'The agent did not complete.'] : [],
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
      tracePath: input.traceKey,
    },
  });

  const resultS3Key = calculationResultKey(owner, calculationId);
  await saveFileContent(BUCKET_NAME, resultS3Key, JSON.stringify(calculationResult), 'application/json');

  const status = result.status === 'COMPLETED' ? 'COMPLETED'
    : result.status === 'NEEDS_INPUT' ? 'REVIEW_REQUIRED'
      : 'FAILED';

  await patch(calculationId, {
    status,
    progress_stage: status === 'COMPLETED' ? 'COMPLETED' : status,
    progress_message: status === 'COMPLETED'
      ? 'Estimate ready'
      : status === 'REVIEW_REQUIRED'
        ? 'A workload question needs your answer'
        : 'We could not complete this AWS estimate automatically.',
    // Small summary only. The full result object lives in S3 (Phase 22).
    result: compactCalculationResult(calculationResult),
    result_s3_key: resultS3Key,
    calculator_url: result.status === 'COMPLETED' ? result.calculatorUrl : undefined,
    monthly_total: result.status === 'COMPLETED' ? (result.monthly ?? undefined) : undefined,
    upfront_total: result.status === 'COMPLETED' ? (result.upfront ?? undefined) : undefined,
    total_12_months: result.status === 'COMPLETED' ? (result.total12Months ?? undefined) : undefined,
    warning_count: warnings.length,
    question_count: result.status === 'NEEDS_INPUT' ? result.questions.length : 0,
    // Customer-facing copy only (Phase 20). Raw diagnostics stay in S3/CloudWatch.
    error_message: status === 'FAILED' ? "We couldn't complete this AWS estimate automatically." : undefined,
    agent_questions: result.status === 'NEEDS_INPUT' ? result.questions.slice(0, 20) : undefined,
    agent_last_activity_at: Date.now(),
    tool_call_count: input.toolCallCount,
    mcp_tools_used: mcpToolsUsed,
  });
}
