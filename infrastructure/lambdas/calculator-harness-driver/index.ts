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
  type HarnessContentBlock,
  type HarnessMessage,
} from '@aws-sdk/client-bedrock-agentcore';
import { ddbDocClient, getFileBuffer, saveFileContent } from '../shared/aws.js';
import type { DocumentType } from '@smithy/types';
import {
  evidenceIndexKey,
  evidenceAccountingKey,
  evidenceCostRelevantRowsKey,
  reconcileEvidence,
  type WorkbookEvidenceIndex,
  type EvidenceAccounting,
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

/**
 * Merge one step's bare-tool invocation list into the run's cumulative per-tool counts
 * (Parts 38-39). The record holds the PRIOR steps' histogram; this adds exactly the calls
 * observed in the present step once, at the step's end — never inside a heartbeat, which
 * would double count as the stream grows.
 */
const mergeToolCounts = (existing: Record<string, number> | undefined, stepCalls: string[]): Record<string, number> => {
  const merged = { ...(existing ?? {}) };
  for (const name of stepCalls) merged[name] = (merged[name] ?? 0) + 1;
  return merged;
};

// ─── request_user_input: the Harness inline function (Phase 24) ──────────────
//
// request_user_input is a first-class AgentCore `inline_function` declared on the
// Harness (NOT behind the Gateway). When Claude calls it the Harness pauses: the
// InvokeHarness stream ends with messageStop.stopReason == "tool_use", and MIMO owns
// the pause. The tool input follows a fixed semantic schema; it never carries
// Calculator implementation detail.

const REQUEST_USER_INPUT_TOOL = 'request_user_input';
const REQUEST_USER_INPUT_STAGE = 'ANALYZING';
const REQUEST_USER_INPUT_MESSAGE = 'A workload question needs your answer';

/** A request_user_input tool use captured from the stream, in stream order. */
interface CapturedToolUse {
  /** contentBlockIndex of the block that STARTED this tool use. */
  blockIndex: number;
  toolUseId: string;
  name: string;
  /** Concatenated contentBlockDelta.delta.toolUse.input fragments. */
  inputJson: string;
}

/** A fully-parsed pending tool use, persisted so the answer route can resume it. */
export interface PendingToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}

/** A structured customer answer, the shape the answer route already collects. */
export interface StructuredQuestionAnswer {
  questionId?: string;
  resource?: string;
  semanticField?: string;
  /**
   * A single value, or an array of values when the customer selected several options in a
   * selectionMode "multiple" question (the "Other" value, when supplied, is appended).
   */
  value: string | number | boolean | Array<string | number | boolean>;
  applyToSimilarResources?: boolean;
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined;

/**
 * Project a request_user_input tool input onto the frontend's agent_question shape.
 *
 * The modern tool input is the GENERIC semantic schema (questionId/title/question/reason +
 * scope/selectionMode/options/customInput/allowApplyToSimilarResources): there is no type,
 * so the projection passes those fields through and the UI renders an option picker rather
 * than guessing at an input control. The LEGACY typed schema (type/choices/unit/resource/
 * semanticField) is still accepted and projected to the same fields it always produced, so
 * an in-flight older caller keeps rendering until it is fully cut over. Nothing here
 * decides WHETHER to ask — that belongs to the agent — it only makes a question the UI can
 * render and the customer can answer.
 */
export function toolInputToAgentQuestion(input: Record<string, unknown>): AgentQuestion | undefined {
  const question = stringValue(input.question);
  if (!question) return undefined;

  const optionItems = (value: unknown): AgentOption[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    const items = value
      .map((item): AgentOption | undefined => {
        if (!item || typeof item !== 'object') return undefined;
        const entry = item as Record<string, unknown>;
        const optionValue = stringValue(entry.value) ?? stringValue(entry.label);
        const label = stringValue(entry.label) ?? stringValue(entry.value);
        if (!optionValue || !label) return undefined;
        const description = stringValue(entry.description);
        return { value: optionValue, label, ...(description ? { description } : {}) };
      })
      .filter((item): item is AgentOption => item !== undefined);
    return items.length ? items : undefined;
  };

  const parsedCustomInput = (value: unknown): AgentCustomInput | undefined => {
    if (!value || typeof value !== 'object') return undefined;
    const entry = value as Record<string, unknown>;
    const parsed: AgentCustomInput = {};
    if (typeof entry.enabled === 'boolean') parsed.enabled = entry.enabled;
    const label = stringValue(entry.label);
    if (label) parsed.label = label;
    const inputType = stringValue(entry.inputType)?.toLowerCase();
    if (inputType === 'text' || inputType === 'number') parsed.inputType = inputType;
    const unit = stringValue(entry.unit);
    if (unit) parsed.unit = unit;
    const placeholder = stringValue(entry.placeholder);
    if (placeholder) parsed.placeholder = placeholder;
    return parsed.enabled === undefined && !parsed.label && !parsed.inputType && !parsed.unit && !parsed.placeholder
      ? undefined
      : parsed;
  };

  const type = stringValue(input.type)?.toUpperCase();
  const isLegacyType = ['CHOICE', 'NUMBER', 'BOOLEAN', 'TEXT'].includes(type ?? '');
  const options = isLegacyType ? optionItems(input.choices) : optionItems(input.options ?? input.choices);
  const customInput = parsedCustomInput(input.customInput);
  const selectionMode = input.selectionMode === 'multiple' || input.selectionMode === 'single'
    ? input.selectionMode
    : undefined;

  return {
    questionId: stringValue(input.questionId),
    resource: stringValue(input.resource),
    semanticField: stringValue(input.semanticField),
    field: stringValue(input.semanticField),
    ...(isLegacyType ? { type: type as AgentQuestionType } : {}),
    title: stringValue(input.title),
    question,
    reason: stringValue(input.reason),
    ...(isLegacyType
      ? { choices: options }
      : options
        ? { options }
        : {}),
    unit: stringValue(input.unit),
    scope: stringValue(input.scope),
    ...(selectionMode ? { selectionMode } : {}),
    ...(customInput ? { customInput } : {}),
    allowApplyToSimilarResources: typeof input.allowApplyToSimilarResources === 'boolean'
      ? input.allowApplyToSimilarResources
      : undefined,
  };
}

/** Persisted inline-function pause state on the record (Phase 14). */
export interface PendingToolState {
  pending_tool_use_id?: string;
  pending_tool_name?: string;
  pending_tool_input?: Record<string, unknown>;
  pending_tool_uses?: PendingToolUse[];
}

export function readPendingToolUses(record: CalculationRecord): PendingToolUse[] {
  if (Array.isArray(record.pending_tool_uses) && record.pending_tool_uses.length) {
    return record.pending_tool_uses.filter((entry): entry is PendingToolUse =>
      !!entry && typeof entry === 'object' && typeof entry.toolUseId === 'string' && !!entry.toolUseId
      && typeof entry.input === 'object' && entry.input !== null);
  }
  if (record.pending_tool_use_id && record.pending_tool_input) {
    return [{
      toolUseId: record.pending_tool_use_id,
      name: record.pending_tool_name || REQUEST_USER_INPUT_TOOL,
      input: record.pending_tool_input,
    }];
  }
  return [];
}

/**
 * Build the messages that resume a paused request_user_input (Part 16).
 *
 * AgentCore does not persist the incomplete inline-function turn to session history,
 * so the continuation must replay the ORIGINAL assistant toolUse message and then
 * supply the customer's toolResult for the same toolUseId — never a bare
 * "The customer answered: ..." text message.
 *
 * The pause contract may include a small batch of request_user_input calls when the agent
 * has already identified several independent material decisions. The frontend answers the
 * visible batch together, so every paused tool use must have a customer answer.
 * If one is ever missing, this throws rather than building an error toolResult that
 * tells Claude to "continue without it" — an unanswered MATERIAL customer fact must
 * never be silently dropped. The tool result body is the exact JSON
 * { value, applyToSimilarResources } that the Harness hands back to Claude.
 */
export function buildResumeMessages(
  pending: PendingToolUse[],
  answers: StructuredQuestionAnswer[],
): HarnessMessage[] {
  const messages: HarnessMessage[] = [];
  const usedAnswerIndexes = new Set<number>();

  for (const toolUse of pending) {
    const input = toolUse.input ?? {};
    const inputQuestionId = typeof input.questionId === 'string' ? input.questionId : undefined;

    // Prefer the answer that names the same questionId; otherwise the first unused
    // answer, which keeps a single-question pause in order even when the frontend
    // omitted questionIds.
    const answerIndex = answers.findIndex((answer, index) => {
      if (usedAnswerIndexes.has(index)) return false;
      if (inputQuestionId && answer.questionId) return answer.questionId === inputQuestionId;
      return true;
    });

    if (answerIndex < 0) {
      throw new Error(
        `request_user_input ${toolUse.toolUseId} has no customer answer; `
        + 'refusing to resume by telling the agent to continue without it',
      );
    }
    const answer = answers[answerIndex];
    usedAnswerIndexes.add(answerIndex);

    const assistantBlock: HarnessContentBlock = {
      toolUse: {
        toolUseId: toolUse.toolUseId,
        name: toolUse.name || REQUEST_USER_INPUT_TOOL,
        input: input as DocumentType,
      },
    };
    messages.push({ role: 'assistant', content: [assistantBlock] });

    const userBlock: HarnessContentBlock = {
      toolResult: {
        toolUseId: toolUse.toolUseId,
        status: 'success',
        content: [{
          text: JSON.stringify({
            value: answer.value,
            applyToSimilarResources: answer.applyToSimilarResources ?? false,
          }),
        }],
      },
    };
    messages.push({ role: 'user', content: [userBlock] });
  }

  return messages;
}

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

/** One customer-facing choice offered by a generic request_user_input question. */
interface AgentOption {
  value: string;
  label: string;
  description?: string;
}

/** The "Other / give your own input" affordance of a generic question. */
interface AgentCustomInput {
  enabled?: boolean;
  label?: string;
  inputType?: 'text' | 'number';
  unit?: string;
  placeholder?: string;
}

/**
 * The shape the UI renders for a paused request_user_input question.
 *
 * A GENERIC question carries options (and optionally customInput / multiple selection) and
 * has no `type` — the UI renders an option picker. A LEGACY typed question (type + choices/
 * unit) is kept for older callers. Both are projected from the same tool input, so exactly
 * one representation is ever persisted per question.
 */
interface AgentQuestion {
  questionId?: string;
  resource?: string;
  semanticField?: string;
  field?: string;
  /** Present only for legacy typed questions; generic questions rely on options/customInput. */
  type?: AgentQuestionType;
  title?: string;
  question: string;
  reason?: string;
  choices?: AgentOption[];
  options?: AgentOption[];
  selectionMode?: 'single' | 'multiple';
  customInput?: AgentCustomInput;
  /** What the decision applies to (resource, group or broad scope). */
  scope?: string;
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
  lines.push('After reading the workbook, identify material customer decisions that affect price or architecture and are not already answered by the workbook or customer instructions.');
  lines.push('Before calling create_estimate, add_service, build_estimate, export_estimate, or import_estimate, ask unresolved material decisions with request_user_input. Ask exactly one question per pause; after the customer answers, continue the same runtime session and ask the next independent decision if needed.');
  lines.push('For compute-heavy workbooks, the pricing plan is material unless explicitly stated. Ask whether to use Compute Savings Plans, EC2 Instance Savings Plans, On-Demand, Spot where appropriate, or another customer-specified plan, and include an Other / give your own input path.');
  lines.push('For ECS/Fargate/Lambda and other usage-based services, ask for missing material usage facts such as per-day vs per-month period, frequency, duration, utilization, prod/non-prod scope, vCPU/memory, task/request count, storage, traffic, and region when the workbook does not define them.');
  lines.push('For EBS, RDS/Aurora, and other storage, ask before pricing when size, storage type, IOPS/throughput, retention, snapshot policy, or availability is missing. Do not use minimum-size, gp3, full-month, or other storage defaults unless the customer explicitly authorizes that assumption.');
  lines.push('Do not continue to pricing with guesses or silent defaults for any customer workload value. The final assumptions may contain only workbook/customer facts or assumptions explicitly authorized in an answer.');
  lines.push('If the workbook contains multiple scenarios, environments, pricing models, or comparison cases, ask whether the customer wants separate calculator.aws links for the named scenarios. Offer the workbook-derived scenarios as multi-select choices, plus one consolidated-link choice and Other / give your own input path, then honour the selection exactly.');
  lines.push('No rows have been discarded; the evidence tool returns the uploaded workbook content.');

  lines.push('');
  lines.push('Use the connected AWS Pricing Calculator MCP to create, validate, export and read back the requested estimate.');

  return lines.join('\n');
}

// ─── JSON extraction ─────────────────────────────────────────────────────────

/** The last balanced JSON object in the text, which is where the contract puts it. */
/**
 * The last TOP-LEVEL JSON object in `text`.
 *
 * A naive "scan back from the last `{`" breaks the moment the terminal object legitimately
 * ends with nested objects (e.g. a comparison estimate whose final JSON closes with
 * `"scenarios": [{...}, {...}]`): the innermost tail object is the last balanced object in
 * the text, so the parser would hand back `{label, url}` instead of the enclosing
 * `{status:"COMPLETED", ...}` and the agent would never be seen as finished. Instead we do
 * one brace/bracket-aware pass and keep the last object that opens at container depth 0 —
 * an object nested inside an array or another object never qualifies.
 */
export function lastJsonObject(text: string): unknown | undefined {
  let lastParsed: unknown;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') { if (depth === 0) start = i; depth += 1; }
    else if (ch === '[') { depth += 1; }
    else if (ch === ']') { depth = Math.max(0, depth - 1); }
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed = JSON.parse(text.slice(start, i + 1));
          if (parsed && typeof parsed === 'object') lastParsed = parsed;
        } catch { /* not a valid object; keep any earlier candidate */ }
        start = -1;
      } else if (depth < 0) {
        depth = 0;
        start = -1;
      }
    }
  }
  return lastParsed;
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
  /**
   * Legacy NEEDS_INPUT continuation answer. Kept so an already-in-flight run started
   * before the inline_function cutover still has a text continuation path; new runs
   * resume through `answers` instead (Part 16).
   */
  userAnswer?: string;
  /**
   * Structured answers to a paused request_user_input, in submission order. When the
   * record holds pending tool uses this drives the real inline-function resume: the
   * original assistant toolUse message is replayed followed by the customer's
   * toolResult for each answered tool use (Part 16).
   */
  answers?: StructuredQuestionAnswer[];
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
    // A resume execution can exhaust its retries while the record still holds an
    // unanswered request_user_input pause — InvokeHarness never accepted the continuation.
    // That is NOT an ordinary failure: the customer's answer was never taken, so the
    // calculation must stay WAITING_FOR_INPUT with the pending question intact and the SAME
    // agent_session_id, which lets the answer route retry the same answer. Only records with
    // no pending interrupt keep the FAILED terminal state.
    const failedRecord = (await ddbDocClient.send(new GetCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Key: { calculation_id: calculationId },
    }))).Item as CalculationRecord | undefined;

    if (failedRecord?.pending_tool_use_id) {
      await patch(calculationId, {
        status: 'WAITING_FOR_INPUT',
        progress_stage: 'WAITING_FOR_INPUT',
        progress_message: "We couldn't continue with that answer. Please try again.",
        agent_last_activity_at: Date.now(),
      });
      return {
        calculationId,
        sessionId: failedRecord.agent_session_id ?? '',
        iteration: event.iteration ?? 0,
        done: true,
        status: 'WAITING_FOR_INPUT',
      };
    }

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

  const pendingToolUses = readPendingToolUses(record);
  // Keep interruptions sequential. A model can emit several input tools in one
  // response; the customer resolves the first, then the same session continues.
  if (pendingToolUses.length > 1) pendingToolUses.splice(1);
  // The pause contract is exactly ONE request_user_input per pause — the answer UI
  // renders a single question. Only that single-pending case can be resumed by replaying
  // the original assistant toolUse and supplying the customer's toolResult.
  const resumingInlineFunction = iteration > 0
    && pendingToolUses.length === 1
    && !!event.answers?.length;

  if (iteration > 0 && pendingToolUses.length > 0 && !resumingInlineFunction) {
    // A continuation arrived while the record still holds a paused request_user_input
    // that cannot be resumed cleanly (no answers, or a stale multi-question pause). Never
    // skip it — that would silently drop a material customer fact or "continue without
    // it". Keep WAITING_FOR_INPUT and surface a diagnostic so the answer can be retried.
    console.log(JSON.stringify({
      event: 'request_user_input_unresumable_continuation',
      calculationId,
      iteration,
      sessionId,
      pendingToolUseCount: pendingToolUses.length,
      answerCount: event.answers?.length ?? 0,
    }));
    await patch(calculationId, {
      status: 'WAITING_FOR_INPUT',
      progress_stage: 'WAITING_FOR_INPUT',
      progress_message: REQUEST_USER_INPUT_MESSAGE,
      agent_session_id: sessionId,
      agent_last_activity_at: Date.now(),
    });
    return { calculationId, sessionId, iteration: iteration + 1, done: true, status: 'WAITING_FOR_INPUT' };
  }

  let messages: HarnessMessage[];
  // True once THIS step sends the single coverage-repair continuation. It drives the
  // post-send bookkeeping AND tells finalise a repair is already spent if the agent answers
  // with another COMPLETED claim inside the same step.
  let sentCoverageRepair = false;
  // True once THIS step sends the single material-clarification continuation. This catches
  // the bad final shape where the agent says a material customer value was missing, then
  // prices a guessed/defaulted value anyway.
  let sentMaterialClarificationRepair = false;

  if (resumingInlineFunction) {
    // Part 16: replay the original assistant toolUse and supply the customer's toolResult.
    // The pending fields are deliberately NOT cleared here: InvokeHarness can throw before
    // the continuation is accepted, and if it does the record must still say
    // WAITING_FOR_INPUT with the full pending state so the same answer can be retried.
    // Clearing happens only after agentCore.send resolves (below).
    messages = buildResumeMessages(pendingToolUses, event.answers!);
  } else if (iteration > 0 && record.material_clarification_requested === true) {
    messages = [{ role: 'user', content: [{ text: buildMaterialClarificationRepairMessage(record) }] }];
    sentMaterialClarificationRepair = true;
  } else if (iteration > 0 && record.coverage_repair_requested === true) {
    // Part 34: the record carries an outstanding coverage-repair request. Send the repair
    // instruction this step. It stays `coverage_repair_requested` until the Harness accepts
    // it (send returns) — a throw must leave the request pending so the retry re-sends.
    messages = [{ role: 'user', content: [{ text: await buildCoverageRepairMessage(record, calculationId) }] }];
    sentCoverageRepair = true;
  } else {
    const messageText = iteration === 0
      ? await buildInitialMessage(record, calculationId)
      : (event.userAnswer
        ? `The customer answered: ${event.userAnswer}\n\nContinue building the estimate.`
        : 'Continue. If the estimate is finished, reply with the final JSON object only.');
    messages = [{ role: 'user', content: [{ text: messageText }] }];
  }

  const logMessageBytes = messages.reduce((total, message) => {
    const blocks = message.content ?? [];
    return total + blocks.reduce((sum, block) => {
      const text = (block as { text?: string }).text;
      return sum + (typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0);
    }, 0);
  }, 0);

  console.log(JSON.stringify({
    event: 'harness_step_start',
    executionMode: EXECUTION_MODE,
    calculationId,
    iteration,
    sessionId,
    harnessArn: HARNESS_ARN,
    resumedInlineFunction: resumingInlineFunction,
    messageBytes: logMessageBytes,
  }));

  const response = await agentCore.send(new InvokeHarnessCommand({
    harnessArn: HARNESS_ARN,
    runtimeSessionId: sessionId,
    messages,
    timeoutSeconds: STEP_TIMEOUT_SECONDS,
  }));

  if (resumingInlineFunction) {
    // Part 17: the Harness accepted the continuation (send returned), so the wait state is
    // genuinely over. Now — and only now — clear the pending pause and return the run to
    // BUILDING. If send had thrown above, this block would not have run and the record
    // would still hold WAITING_FOR_INPUT plus the full pending state, so the customer's
    // answer can be retried safely rather than lost.
    await patch(calculationId, {
      status: 'BUILDING',
      progress_stage: 'BUILDING',
      progress_message: 'Continuing with your answer...',
      pending_tool_use_id: null,
      pending_tool_name: null,
      pending_tool_input: null,
      pending_tool_uses: null,
      agent_questions: null,
      question_count: null,
      agent_session_id: sessionId,
      agent_last_activity_at: Date.now(),
    });
  } else if (sentCoverageRepair) {
    // Part 35: the Harness accepted the coverage-repair continuation (send returned), so the
    // request is spent: mark the repair attempted and clear the outstanding request. If send
    // had thrown, this block would not have run and the record would still say
    // coverage_repair_requested, so the retry re-sends the same instruction rather than
    // skipping the repair. `coverage_repair_attempted` is what bounds the repair to ONE:
    // a later COMPLETED claim that is still uncovered is terminal NEEDS_REVIEW, never a
    // second repair.
    await patch(calculationId, {
      status: 'BUILDING',
      progress_stage: 'BUILDING',
      progress_message: 'Pricing the remaining workbook rows…',
      coverage_repair_requested: null,
      coverage_repair_attempted: true,
      agent_session_id: sessionId,
      agent_last_activity_at: Date.now(),
    });
  } else if (sentMaterialClarificationRepair) {
    // The Harness accepted the same-session correction turn, so the one allowed repair is
    // spent. If the agent still completes by guessing, finalise will mark the result
    // NEEDS_REVIEW rather than looping or trusting it.
    await patch(calculationId, {
      status: 'BUILDING',
      progress_stage: 'ANALYZING',
      progress_message: 'Asking the calculator agent to clarify missing workload details…',
      material_clarification_requested: null,
      material_clarification_attempted: true,
      agent_session_id: sessionId,
      agent_last_activity_at: Date.now(),
    });
  }

  let stopReason: string | undefined;
  // Part 13: inline-function tool use is captured per content block — the start event
  // carries toolUseId/name, the delta events carry the partial JSON input fragments.
  const capturedToolUses: CapturedToolUse[] = [];

  for await (const chunk of response.stream ?? []) {
    const kind = Object.keys(chunk)[0];

    if (kind === 'contentBlockStart') {
      const start = (chunk as any).contentBlockStart;
      const toolUse = start?.start?.toolUse;
      if (toolUse?.name) {
        const bare = bareToolName(toolUse.name);
        toolCalls.push(bare);
        const progress = PROGRESS_BY_TOOL[bare];
        if (progress) { lastStage = progress.stage; lastMessage = progress.message; }
        if (trace.length < MAX_TRACE_EVENTS) trace.push({ at: Date.now(), toolUse: toolUse.name, toolUseId: toolUse.toolUseId });
        if (bare === REQUEST_USER_INPUT_TOOL) {
          capturedToolUses.push({
            blockIndex: start?.contentBlockIndex ?? capturedToolUses.length,
            toolUseId: String(toolUse.toolUseId ?? ''),
            name: bare,
            inputJson: '',
          });
          lastStage = REQUEST_USER_INPUT_STAGE;
          lastMessage = REQUEST_USER_INPUT_MESSAGE;
        }
        await heartbeat();
      }
    } else if (kind === 'contentBlockDelta') {
      const deltaEvent = (chunk as any).contentBlockDelta;
      const delta = deltaEvent?.delta;
      if (delta?.text) assistantText += delta.text;
      if (delta?.toolUse?.input) {
        const target = capturedToolUses.find((use) => use.blockIndex === deltaEvent?.contentBlockIndex);
        if (target) target.inputJson += delta.toolUse.input;
      }
      await heartbeat();
    } else if (kind === 'contentBlockStop') {
      // A block finished. No per-block action needed for request_user_input: its JSON
      // input is only considered once messageStop confirms the pause.
      await heartbeat();
    } else if (kind === 'messageStop') {
      stopReason = (chunk as any).messageStop?.stopReason ?? stopReason;
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
  // Cumulative per-tool counts across the whole run (Parts 38-39): prior steps' histogram
  // from the record plus exactly this step's calls, merged once at the step's end.
  const toolCounts = mergeToolCounts(record.tool_call_counts, toolCalls);
  const stepNumber = iteration + 1;

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
    toolCounts,
    mcpToolsUsed,
    streamErrors,
    assistantText,
    stopReason,
    pendingToolUses: capturedToolUses.map(({ toolUseId, name, inputJson }) => ({ toolUseId, name, input: inputJson })),
    trace,
  }), 'application/json').catch((error) => console.error('trace write failed', error));

  console.log(JSON.stringify({
    event: 'harness_step_end',
    calculationId,
    iteration,
    durationMs,
    toolCallCount: toolCalls.length,
    mcpToolsUsed,
    stopReason,
    streamErrors: streamErrors.length,
  }));

  // ─── Part 14 — a real inline-function pause ─────────────────────────────────
  //
  // When Claude called request_user_input the Harness paused: the stream ended with
  // messageStop.stopReason == "tool_use" and the tool input came back to MIMO. That is
  // a first-class human-in-the-loop interruption, NOT a NEEDS_INPUT assistant-text
  // message and NOT a failure. Persist the wait state and stop pumping Step Functions:
  // the UI renders agent_questions and the answer route resumes the SAME session.
  const pausedToolUses: PendingToolUse[] = [];
  const agentQuestions: AgentQuestion[] = [];
  if (stopReason === 'tool_use') {
    for (const captured of capturedToolUses) {
      if (captured.name !== REQUEST_USER_INPUT_TOOL || !captured.toolUseId) continue;
      let input: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(captured.inputJson || '{}') as Record<string, unknown>;
        if (parsed && typeof parsed === 'object') input = parsed;
      } catch (error) {
        streamErrors.push(`request_user_input unparseable input for ${captured.toolUseId}: ${String((error as Error).message).slice(0, 500)}`);
      }
      if (!input) continue;
      const question = toolInputToAgentQuestion(input);
      // A request_user_input that cannot project to a customer question cannot be
      // answered (the UI renders only representable questions), so it must not hold the
      // pause. Pending entries and questions stay 1:1.
      if (!question) continue;
      pausedToolUses.push({ toolUseId: captured.toolUseId, name: captured.name, input });
      agentQuestions.push(question);
    }

    if (pausedToolUses.length > 1) {
      streamErrors.push(
        `request_user_input batch contained ${pausedToolUses.length} questions; keeping the first so decisions are answered one at a time.`,
      );
      pausedToolUses.length = 1;
      agentQuestions.length = 1;
    }
  }
  if (pausedToolUses.length) {
    console.log(JSON.stringify({
      event: 'harness_paused_for_user_input',
      calculationId,
      iteration,
      sessionId,
      stopReason,
      pendingToolUseCount: pausedToolUses.length,
      questionCount: agentQuestions.length,
    }));
    await patch(calculationId, {
      status: 'WAITING_FOR_INPUT',
      progress_stage: 'WAITING_FOR_INPUT',
      progress_message: REQUEST_USER_INPUT_MESSAGE,
      agent_session_id: sessionId,
      pending_tool_use_id: pausedToolUses[0].toolUseId,
      pending_tool_name: pausedToolUses[0].name,
      pending_tool_input: pausedToolUses[0].input,
      pending_tool_uses: pausedToolUses,
      agent_questions: agentQuestions.slice(0, 20),
      question_count: agentQuestions.length,
      agent_last_activity_at: Date.now(),
      tool_call_count: toolCalls.length,
      tool_call_counts: toolCounts,
      agent_iterations: stepNumber,
    });
    return { calculationId, sessionId, iteration: iteration + 1, done: true, status: 'WAITING_FOR_INPUT' };
  }

  const result = parseAgentResult(assistantText);
  if (!result) {
    const customerQuestion = assistantTextCustomerQuestion(assistantText);
    if (customerQuestion) {
      await patch(calculationId, {
        status: 'WAITING_FOR_INPUT',
        progress_stage: 'WAITING_FOR_INPUT',
        progress_message: REQUEST_USER_INPUT_MESSAGE,
        agent_session_id: sessionId,
        agent_questions: [customerQuestion],
        question_count: 1,
        agent_last_activity_at: Date.now(),
        tool_call_count: toolCalls.length,
        tool_call_counts: toolCounts,
        agent_iterations: stepNumber,
        mcp_tools_used: mcpToolsUsed,
      });
      return { calculationId, sessionId, iteration: iteration + 1, done: true, status: 'WAITING_FOR_INPUT' };
    }
    // The agent has not produced a terminal object yet. Step Functions will re-enter
    // this function on the same session, which is how AgentCore continues a run.
    await patch(calculationId, {
      agent_last_activity_at: Date.now(),
      tool_call_count: toolCalls.length,
      tool_call_counts: toolCounts,
      agent_iterations: stepNumber,
      progress_stage: lastStage,
      progress_message: lastMessage,
    });
    return { calculationId, sessionId, iteration: iteration + 1, done: false };
  }

  const outcome = await finalise({
    record, calculationId, sessionId, result, mcpToolsUsed,
    toolCallCount: toolCalls.length,
    toolCallCounts: toolCounts,
    durationMs, traceKey,
    agentIterations: stepNumber,
    launchedCoverageRepair: sentCoverageRepair,
    launchedMaterialClarificationRepair: sentMaterialClarificationRepair,
  });
  return outcome.terminal
    ? { calculationId, sessionId, iteration: iteration + 1, done: true, status: outcome.status }
    : { calculationId, sessionId, iteration: iteration + 1, done: false };
};

// ─── Coverage-repair continuation (Parts 34-36) ──────────────────────────────

/**
 * The ONE bounded coverage-repair turn.
 *
 * When the agent reports COMPLETED but the authoritative reconciliation still has
 * cost-relevant rows that are neither priced, excluded nor unsupported, MIMO does NOT
 * decide what those rows mean — that would be a hardcoded AWS decision tree, which is the
 * exact thing this migration removed. Instead it gives the agent one more bounded turn on
 * the SAME session: the list of uncovered rows plus an instruction to account for each of
 * them (price it, exclude it with a reason, or mark it unsupported with a reason), then
 * re-validate/export/import and read the total back. Whatever is still uncovered after that
 * single turn is surfaced as NEEDS_REVIEW rather than being silently trusted, so the agent
 * cannot loop by claiming completion again.
 */
async function buildCoverageRepairMessage(record: CalculationRecord, calculationId: string): Promise<string> {
  const owner = record.owner_user_id;
  let unresolvedRows: string[] = [];
  try {
    const accounting = JSON.parse(
      (await getFileBuffer(BUCKET_NAME, evidenceAccountingKey(owner, calculationId))).toString('utf8'),
    ) as EvidenceAccounting;
    unresolvedRows = Array.isArray(accounting.unresolved) ? accounting.unresolved : [];
  } catch (error) {
    console.error('coverage repair: could not read evidence accounting; sending a generic repair turn', error);
  }

  const listed = unresolvedRows.length
    ? `The reconciliation could not account for these cost-relevant workbook rows:\n${unresolvedRows.map((id) => ` - ${id}`).join('\n')}\n`
    : 'The reconciliation could not account for every cost-relevant workbook row.\n';

  return `${listed}
For each row above, either price it in the estimate, or report it in evidenceExcluded with the reason it is genuinely not billable here (for example it is already covered by a resource you priced), or report it in evidenceUnsupported with the reason AWS Pricing Calculator cannot express it. Every cost-relevant row must appear in exactly one of evidenceConsumed, evidenceExcluded or evidenceUnsupported.

Do not silently drop a row, and do not guess at a nearest-fit resource. If a row's mapping to an AWS service genuinely needs a customer decision, ask with request_user_input instead of assuming.

Once every row is accounted for, run validate_estimate, then export_estimate, then import_estimate one final time, read the imported estimate back to confirm it holds the totals, and reply with the final JSON object only.`;
}

// ─── Finalisation ────────────────────────────────────────────────────────────


function materialClarificationEvidence(result: AgentCompleted): string[] {
  const materialWords = [
    'material', 'cost', 'price', 'pricing', 'monthly', 'annual',
    'region', 'instance', 'node', 'count', 'storage', 'traffic', 'duration',
    'frequency', 'multi-az', 'single-az', 'availability', 'term', 'payment',
    'on-demand', 'savings plan', 'reserved',
  ];
  const missingWords = [
    'not specified', 'unspecified', 'missing', 'omitted', 'unknown',
    'not provided', 'not stated', 'ambiguous', 'unclear', 'minimum', 'nearest',
    'smallest', 'full-month', 'full month', 'fallback',
  ];
  const guessedWords = [
    'assumed', 'assumption', 'defaulted', 'default', 'chosen', 'selected',
    'used', 'set to', 'fallback', 'assigned', 'mapped',
  ];
  const source = [
    ...(result.assumptions ?? []).map((text) => `assumption: ${text}`),
    ...(result.warnings ?? []).map((text) => `warning: ${text}`),
  ];

  return source.filter((entry) => {
    const text = entry.toLowerCase();
    return materialWords.some((word) => text.includes(word))
      && missingWords.some((word) => text.includes(word))
      && guessedWords.some((word) => text.includes(word));
  }).slice(0, 8);
}

function buildMaterialClarificationRepairMessage(record: CalculationRecord): string {
  const priorEvidence = Array.isArray(record.material_clarification_evidence)
    ? record.material_clarification_evidence
      .filter((entry): entry is string => typeof entry === 'string' && !!entry)
      .slice(0, 8)
    : [];
  const listed = priorEvidence.length
    ? `Your previous final answer said these material customer workload values were missing or ambiguous, but then priced guessed/defaulted values anyway:\n${priorEvidence.map((entry) => ` - ${entry}`).join('\n')}\n`
    : 'Your previous final answer appears to have priced guessed/defaulted material customer workload values.\n';

  return `${listed}
That is not a safe completed estimate. Stay in this SAME AgentCore session.

Do not create a new estimate from the guessed values. Convert the first unresolved material customer workload decision into a request_user_input call now. The question must be contextual and structured, using the connected MCP guidance/options when appropriate, and it must ask for the customer value that materially changes the architecture or price.

Do not ask about Calculator implementation details such as field IDs, minimalConfig scaffolding, or internal selector values. Ask only for the missing customer workload fact. After the customer answers, continue in this same session and update/rebuild the estimate with the answered value.`;
}


function failedResultCustomerQuestion(result: AgentFailed): AgentQuestion | undefined {
  const message = result.message || '';
  const category = (result.errorCategory || '').toUpperCase();
  const text = `${category} ${message}`.toLowerCase();
  const needsCustomerInput = category.includes('MISSING_REQUIRED_INPUT')
    || (/(missing|required|unspecified|not specified|not provided|cannot continue|cannot safely proceed)/i.test(text)
      && /(customer|workload|instance|region|multi-az|single-az|availability|pricing|duration|frequency|traffic|storage|count)/i.test(text));
  if (!needsCustomerInput || !message) return undefined;

  return {
    questionId: `missing-input-${Date.now().toString(36)}`,
    type: 'TEXT',
    title: 'Workload details needed',
    question: `The calculator agent needs these details before it can produce an accurate estimate:\n\n${message}\n\nPlease provide the missing value(s).`,
    reason: 'The agent reported that the missing value(s) materially affect the AWS estimate and cannot be safely defaulted.',
    allowApplyToSimilarResources: true,
  };
}

function assistantTextCustomerQuestion(text: string): AgentQuestion | undefined {
  const cleaned = text.trim();
  if (!cleaned || !cleaned.includes('?')) return undefined;
  const lower = cleaned.toLowerCase();
  const asksForCustomerDecision =
    /(before i build|before proceeding|need to confirm|need your input|which|what|please provide)/i.test(cleaned)
    && /(pricing model|savings plan|reserved instance|on-demand|spot|reservation|commitment|payment|term|region|instance class|multi-az|single-az|availability|duration|frequency|utilization|storage|traffic|count)/i.test(cleaned);
  if (!asksForCustomerDecision) return undefined;

  const isPricingQuestion = /pricing model|pricing plan|savings plan|reserved instance|on-demand|spot|reservation|commitment|payment|term/i.test(cleaned);
  const optionMarker = [...cleaned.matchAll(/^\s*(?:\*\*)?Options(?:\*\*)?\s*:\s*$/gim)].pop();
  const optionSource = optionMarker ? cleaned.slice(optionMarker.index! + optionMarker[0].length) : (isPricingQuestion ? '' : cleaned);
  const options: AgentOption[] = [];
  const optionValues = new Set<string>();
  const addOption = (label: string, description?: string) => {
    const cleanLabel = label.replace(/\*\*/g, '').trim();
    const cleanDescription = description?.replace(/\*\*/g, '').trim();
    if (!cleanLabel) return;
    const rawValue = `${cleanLabel} ${cleanDescription ?? ''}`.toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || `option_${options.length + 1}`;
    let value = rawValue;
    let suffix = 2;
    while (optionValues.has(value)) {
      value = `${rawValue}_${suffix}`.slice(0, 96);
      suffix += 1;
    }
    optionValues.add(value);
    options.push({
      value,
      label: cleanLabel,
      ...(cleanDescription ? { description: cleanDescription } : {}),
    });
  };
  for (const line of optionSource.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[*-]\s*)?(?:\*\*)?Option\s+[A-Za-z0-9]+\s*(?:[\u2014\u2013:-]| - )\s*(.+?)(?:\*\*)?\s*(?::|\s+(?:[\u2014\u2013-])\s+)?(.*)$/i)
      || line.match(/^\s*\d+[\).]\s+(?:\*\*)?(.+?)(?:\*\*)?\s*(?:\s+(?:[\u2014\u2013-])\s+(.*))?$/)
      || line.match(/^\s*[-*]\s+(?:\*\*)?(.+?)(?:\*\*)?\s*(?:\s+(?:[\u2014\u2013-])\s+(.*))?$/);
    if (!match) continue;
    const label = match[1].replace(/\*\*/g, '').trim();
    const description = match[2]?.replace(/\*\*/g, '').trim();
    if (!label) continue;
    if (isPricingQuestion && !/(savings plan|reserved|reservation|\bri\b|on-demand|spot|other)/i.test(`${label} ${description ?? ''}`)) {
      continue;
    }
    addOption(label, description);
  }

  if (isPricingQuestion && options.length === 0) {
    if (/compute savings plan/i.test(cleaned)) addOption('Compute Savings Plans');
    if (/ec2 instance savings plan/i.test(cleaned)) addOption('EC2 Instance Savings Plans');
    if (/reserved instance|\bri\b/i.test(cleaned)) addOption('Reserved Instances');
    if (/on-demand/i.test(cleaned)) addOption('On-Demand');
    if (/spot/i.test(cleaned)) addOption('Spot Instances');
  }

  const questionLines = [...cleaned.split(/\r?\n/)]
    .map((line) => line.replace(/\*\*/g, '').trim())
    .filter((line) => line.includes('?') && line.length <= 500);
  const questionLine = isPricingQuestion
    ? questionLines.find((line) => /pricing model|pricing plan|savings plan|reserved instance|on-demand|spot|reservation|commitment|payment|term/i.test(line))
      ?? questionLines[0]
    : questionLines[questionLines.length - 1];

  return {
    questionId: `agent-text-question-${Date.now().toString(36)}`,
    title: /pricing model|savings plan|reserved instance|on-demand|spot/i.test(cleaned)
      ? 'Choose pricing plan'
      : 'Workload details needed',
    question: questionLine || cleaned.slice(0, 1200),
    reason: 'The calculator agent identified this as a customer decision that should be answered before the estimate is built.',
    ...(options.length ? { options: options.slice(0, 6), selectionMode: 'single' as const } : { type: 'TEXT' as const }),
    customInput: {
      enabled: true,
      label: 'Other / give your own input',
      inputType: 'text',
      placeholder: 'Describe the plan or value to use',
    },
    allowApplyToSimilarResources: true,
  };
}

async function finalise(input: {
  record: CalculationRecord;
  calculationId: string;
  sessionId: string;
  result: AgentResult;
  mcpToolsUsed: string[];
  toolCallCount: number;
  /** Cumulative per-tool counts across the whole run (prior steps + this step). */
  toolCallCounts: Record<string, number>;
  /** 1-based driver step this run is on (message rounds, including the repair turn). */
  agentIterations: number;
  durationMs: number;
  traceKey: string;
  /**
   * True when THIS step already sent the single coverage-repair continuation (the message
   * was accepted by the Harness). Guards against a second repair when the agent returns a
   * COMPLETED claim inside the same step it was asked to repair.
   */
  launchedCoverageRepair?: boolean;
  launchedMaterialClarificationRepair?: boolean;
}): Promise<{ terminal: boolean; status?: string }> {
  const { record, calculationId, result, mcpToolsUsed, toolCallCounts } = input;
  const owner = record.owner_user_id;

  if (result.status === 'FAILED') {
    const customerQuestion = failedResultCustomerQuestion(result);
    if (customerQuestion) {
      await patch(calculationId, {
        status: 'WAITING_FOR_INPUT',
        progress_stage: 'WAITING_FOR_INPUT',
        progress_message: REQUEST_USER_INPUT_MESSAGE,
        agent_session_id: input.sessionId,
        agent_questions: [customerQuestion],
        question_count: 1,
        agent_last_activity_at: Date.now(),
        agent_duration_ms: record.agent_started_at ? Date.now() - record.agent_started_at : input.durationMs,
        agent_iterations: input.agentIterations,
        tool_call_count: input.toolCallCount,
        tool_call_counts: toolCallCounts,
        mcp_tools_used: mcpToolsUsed,
      });
      return { terminal: true, status: 'WAITING_FOR_INPUT' };
    }
  }

  // Evidence accounting (Parts 32-36): coverage is reconciled against the ACTUAL workbook,
  // never against what the agent chose to report. The authoritative cost-relevant row set is
  // classified once at evidence-build time and persisted; rows the agent never mentions land
  // in `unresolved` rather than vanishing. Older runs without that persisted list fall back to
  // the index count so the unresolved COUNT stays honest even when the missing rows cannot be
  // named.
  let unresolvedCount = 0;
  if (result.status === 'COMPLETED') {
    try {
      const index = JSON.parse((await getFileBuffer(BUCKET_NAME, evidenceIndexKey(owner, calculationId))).toString('utf8')) as WorkbookEvidenceIndex;
      let authoritativeRows: string[] | undefined;
      try {
        const persisted = JSON.parse(
          (await getFileBuffer(BUCKET_NAME, evidenceCostRelevantRowsKey(owner, calculationId))).toString('utf8'),
        ) as { costRelevantRows?: unknown; count?: unknown };
        if (Array.isArray(persisted.costRelevantRows)) {
          authoritativeRows = persisted.costRelevantRows.filter((id): id is string => typeof id === 'string');
        }
      } catch (error) {
        console.warn('authoritative cost-relevant rows missing; counting against the index instead', String((error as Error).message));
      }
      const agentReported = [...new Set([
        ...(result.evidenceConsumed ?? []),
        ...(result.evidenceExcluded ?? []),
        ...(result.evidenceUnsupported ?? []),
        ...(result.evidenceUnresolved ?? []),
      ])];
      const accounting = reconcileEvidence({
        calculationId,
        // The authoritative set when present; otherwise the agent's own claims, whose count
        // the index total below still corrects so a silent remainder can never read as zero.
        costRelevantRows: authoritativeRows ?? agentReported,
        consumedByAgent: result.evidenceConsumed,
        explicitlyIgnored: result.evidenceExcluded,
        unsupported: result.evidenceUnsupported,
        unresolved: result.evidenceUnresolved,
      });
      accounting.counts.costRelevant = authoritativeRows?.length ?? index.accounting.costRelevantRows;
      if (!authoritativeRows) {
        accounting.counts.unresolved = Math.max(0, index.accounting.costRelevantRows
          - accounting.counts.consumed - accounting.counts.ignored - accounting.counts.unsupported);
        accounting.unresolved = [];
      }
      unresolvedCount = accounting.counts.unresolved;
      await saveFileContent(BUCKET_NAME, evidenceAccountingKey(owner, calculationId), JSON.stringify(accounting), 'application/json');
    } catch (error) {
      console.error('evidence accounting failed', error);
    }
  }

  // Parts 34-36: ONE bounded coverage-repair continuation. A COMPLETED claim that leaves
  // cost-relevant rows unaccounted for is not trusted and not handed to the customer as a
  // finished number: MIMO asks the agent to price or account for the remainder — it never
  // decides the pricing itself — and re-verifies. After that single repair turn, whatever
  // is still uncovered becomes NEEDS_REVIEW (unverified) rather than triggering a second
  // repair, so a stubborn agent cannot loop forever.
  const launchedRepair = input.launchedCoverageRepair === true;
  const repairAlreadyAttempted = record.coverage_repair_attempted === true;
  if (result.status === 'COMPLETED' && unresolvedCount > 0 && !repairAlreadyAttempted && !launchedRepair) {
    await patch(calculationId, {
      status: 'BUILDING',
      progress_stage: 'VALIDATING',
      progress_message: 'Checking that every billable workbook row is priced…',
      coverage_repair_requested: true,
      coverage_repair_requested_at: Date.now(),
      agent_last_activity_at: Date.now(),
      tool_call_count: input.toolCallCount,
      tool_call_counts: toolCallCounts,
      agent_iterations: input.agentIterations,
    });
    return { terminal: false };
  }

  const materialClarificationFindings = result.status === 'COMPLETED'
    ? materialClarificationEvidence(result)
    : [];
  const launchedMaterialClarificationRepair = input.launchedMaterialClarificationRepair === true;
  const materialClarificationAlreadyAttempted = record.material_clarification_attempted === true;
  if (
    result.status === 'COMPLETED'
    && materialClarificationFindings.length > 0
    && !materialClarificationAlreadyAttempted
    && !launchedMaterialClarificationRepair
  ) {
    await patch(calculationId, {
      status: 'BUILDING',
      progress_stage: 'ANALYZING',
      progress_message: 'Checking whether missing workload details need your input…',
      material_clarification_requested: true,
      material_clarification_requested_at: Date.now(),
      material_clarification_evidence: materialClarificationFindings,
      agent_last_activity_at: Date.now(),
      tool_call_count: input.toolCallCount,
      tool_call_counts: toolCallCounts,
      agent_iterations: input.agentIterations,
    });
    return { terminal: false };
  }

  // Cumulative run telemetry for the terminal write (Parts 38-39): wall-clock since the
  // run's first step started, the total message rounds, and the per-tool histogram.
  const agentDurationMs = record.agent_started_at ? Date.now() - record.agent_started_at : input.durationMs;
  const agentIterations = input.agentIterations;

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
  if (result.status === 'COMPLETED' && materialClarificationFindings.length > 0) {
    warnings.push('The agent completed after defaulting one or more missing material workload values, so the estimate is not verified.');
  }
  const readBackPassed = result.status === 'COMPLETED' && renderedTotals?.validUrl === true && monthlyTotal !== null;
  const coveragePassed = result.status === 'COMPLETED' && unresolvedCount === 0 && scenarioCoveragePassed;
  const materialClarificationPassed = result.status !== 'COMPLETED' || materialClarificationFindings.length === 0;
  const costVerified = readBackPassed && coveragePassed && materialClarificationPassed;
  const completionBlocked = result.status === 'COMPLETED' && !costVerified;
  if (completionBlocked) {
    if (!readBackPassed) warnings.push('The saved AWS Pricing Calculator estimate could not be read back with a monthly total, so the cost is not verified.');
    if (!coveragePassed) warnings.push('The workbook coverage reconciliation did not pass, so the cost is not verified.');
    if (!materialClarificationPassed) warnings.push('A missing material customer workload value was defaulted instead of clarified, so the cost is not verified.');
  }
  const completedScenarios = result.status === 'COMPLETED'
    ? (result.scenarios ?? []).map((scenario, index) => ({
      // The persisted scenario schema keys on a stable identifier, not an index or a
      // position, so the scenario's own key wins, then an id, then a deterministic slug.
      key: typeof scenario.key === 'string' && scenario.key
        ? scenario.key
        : typeof scenario.id === 'string' && scenario.id
          ? scenario.id
          : `scenario-${index + 1}`,
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
      agentTotalDurationMs: agentDurationMs,
      agentIterations,
      agentSessionId: input.sessionId,
      gatewayIdentifier: GATEWAY_IDENTIFIER,
      mcpRuntimeIdentifier: MCP_RUNTIME_IDENTIFIER,
      toolCallCount: input.toolCallCount,
      toolCallCounts,
      calculatorUrlCreated: result.status === 'COMPLETED',
      costVerified,
      coverageUnresolvedRows: unresolvedCount,
      coverageRepairAttempted: record.coverage_repair_attempted === true,
      materialClarificationRepairAttempted: record.material_clarification_attempted === true,
      materialClarificationFindings,
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
    agent_duration_ms: agentDurationMs,
    agent_iterations: agentIterations,
    tool_call_count: input.toolCallCount,
    tool_call_counts: toolCallCounts,
    mcp_tools_used: mcpToolsUsed,
  });
  return { terminal: true, status };
}
