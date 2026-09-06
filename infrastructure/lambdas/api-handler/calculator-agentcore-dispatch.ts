/**
 * Starting, observing and continuing an AgentCore calculator execution.
 *
 * This is the MIMO half of the cutover. The route's job in `agentcore-runtime` mode is
 * only to persist evidence, start a Step Functions execution and return the calculation
 * id — it must never invoke the legacy agent Lambda, the MCP proxy, the legacy sidecar or
 * the old compiler.
 *
 * Two things live here rather than in calculator-routes.ts because both are about the
 * managed execution rather than about HTTP:
 *
 *  - writing the complete WorkbookEvidence / index / chunks to S3 (nothing cost-relevant
 *    is dropped, and none of it goes near DynamoDB);
 *  - deciding whether a running calculation is actually alive, by asking Step Functions
 *    instead of guessing from `updated_at`.
 */

import { SFNClient, StartExecutionCommand, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { getFileBuffer, saveFileContent } from '../shared/aws.js';
import {
  buildWorkbookEvidence,
  chunkEvidence,
  buildEvidenceIndex,
  costRelevantRowIds,
  evidenceIndexKey,
  evidenceChunkKey,
  evidenceFullKey,
  fitsInline,
  type WorkbookEvidence,
} from '../shared/workbook-evidence.js';
import type { WorkbookIR } from '../shared/workbook.js';

const STATE_MACHINE_ARN = process.env.CALCULATOR_EXECUTION_STATE_MACHINE_ARN || '';
const BUCKET_NAME = process.env.BUCKET_NAME!;

/**
 * 'agentcore-runtime' is the production mode: Step Functions → AgentCore Harness →
 * Gateway → Runtime MCP. 'legacy-invokemodel' and 'legacy-compiler' are rollback only.
 */
export const EXECUTION_MODE = process.env.CALCULATOR_EXECUTION_MODE || 'agentcore-runtime';
export const isAgentCoreMode = (): boolean =>
  EXECUTION_MODE === 'agentcore-runtime' && Boolean(STATE_MACHINE_ARN);

const sfnClient = new SFNClient({});

// ─── Evidence persistence (Step 8) ───────────────────────────────────────────

export interface PersistedEvidence {
  indexKey: string;
  fullKey?: string;
  chunkCount: number;
  totalRows: number;
  costRelevantRows: number;
  inlined: boolean;
}

/**
 * Writes the complete evidence set for one calculation to S3.
 *
 * Built from the WorkbookIR the upload route already persists, which is itself lossless —
 * every non-empty cell with its address, raw value, formatted value, formula and merge
 * anchor. So this adds no parsing and loses nothing: it projects, chunks and indexes.
 *
 * Everything written here is an S3 object. None of it is eligible for DynamoDB, which is
 * how the 400 KB item-size failures stop happening rather than being made less likely.
 */
export async function persistWorkbookEvidence(input: {
  owner: string;
  calculationId: string;
  workbookIrS3Key?: string;
  userInstructions?: string[];
}): Promise<PersistedEvidence | undefined> {
  if (!input.workbookIrS3Key) return undefined;

  let ir: WorkbookIR;
  try {
    ir = JSON.parse((await getFileBuffer(BUCKET_NAME, input.workbookIrS3Key)).toString('utf8')) as WorkbookIR;
  } catch (error) {
    console.error(JSON.stringify({ event: 'evidence_ir_read_failed', key: input.workbookIrS3Key, error: (error as Error).message }));
    return undefined;
  }

  const evidence: WorkbookEvidence = buildWorkbookEvidence({ ir, userInstructions: input.userInstructions });
  const chunked = chunkEvidence(evidence);
  const index = buildEvidenceIndex(evidence, chunked, input.owner, input.calculationId);

  const writes: Array<Promise<unknown>> = [
    saveFileContent(BUCKET_NAME, evidenceIndexKey(input.owner, input.calculationId), JSON.stringify(index), 'application/json'),
  ];
  for (const chunk of chunked.chunks) {
    writes.push(saveFileContent(
      BUCKET_NAME,
      evidenceChunkKey(input.owner, input.calculationId, chunk.chunkId),
      JSON.stringify(chunk),
      'application/json',
    ));
  }

  // The whole-evidence object is written whenever it is small enough to be inlined into
  // the agent's first message. For a large workbook it is redundant with the chunks, and
  // writing a 50 MB object nobody reads is just cost.
  const inlined = fitsInline(evidence);
  const fullKey = evidenceFullKey(input.owner, input.calculationId);
  if (inlined) {
    writes.push(saveFileContent(BUCKET_NAME, fullKey, JSON.stringify(evidence), 'application/json'));
  }

  await Promise.all(writes);

  const costRelevant = costRelevantRowIds(evidence);
  console.log(JSON.stringify({
    event: 'evidence_persisted',
    calculationId: input.calculationId,
    sheets: evidence.sheets.length,
    totalRows: evidence.accounting.totalRows,
    totalNonEmptyCells: evidence.accounting.totalNonEmptyCells,
    chunkCount: chunked.chunks.length,
    costRelevantRows: costRelevant.length,
    inlined,
  }));

  return {
    indexKey: evidenceIndexKey(input.owner, input.calculationId),
    fullKey: inlined ? fullKey : undefined,
    chunkCount: chunked.chunks.length,
    totalRows: evidence.accounting.totalRows,
    costRelevantRows: costRelevant.length,
    inlined,
  };
}

// ─── Starting the execution (Step 6) ─────────────────────────────────────────

export interface StartedExecution {
  executionArn: string;
  sessionId: string;
}

/**
 * runtimeSessionId has a MINIMUM length of 33 characters — AgentCore rejects anything
 * shorter with "Member must have length greater than or equal to 33", which is easy to
 * trip because calculation ids alone are not always long enough.
 */
export const newRuntimeSessionId = (calculationId: string): string =>
  `mimo-${calculationId}-${Date.now().toString(36)}`.padEnd(33, '0').slice(0, 100);

export async function startAgentCoreExecution(input: {
  calculationId: string;
  sessionId: string;
}): Promise<StartedExecution> {
  if (!STATE_MACHINE_ARN) throw new Error('CALCULATOR_EXECUTION_STATE_MACHINE_ARN is not set');

  // Execution names must be unique per state machine and are limited to 80 characters,
  // so the calculation id is suffixed with a timestamp rather than used bare — a retry of
  // the same calculation would otherwise collide with its own previous execution.
  const executionName = `${input.calculationId}-${Date.now().toString(36)}`.slice(0, 80);

  const started = await sfnClient.send(new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: executionName,
    input: JSON.stringify({
      calculationId: input.calculationId,
      sessionId: input.sessionId,
      iteration: 0,
    }),
  }));

  console.log(JSON.stringify({
    event: 'agentcore_execution_started',
    executionMode: EXECUTION_MODE,
    calculationId: input.calculationId,
    executionArn: started.executionArn,
    sessionId: input.sessionId,
  }));

  return { executionArn: started.executionArn!, sessionId: input.sessionId };
}

/** Continues a NEEDS_INPUT calculation on its existing AgentCore session (Step 11). */
export async function continueAgentCoreExecution(input: {
  calculationId: string;
  sessionId: string;
  userAnswer: string;
}): Promise<StartedExecution> {
  if (!STATE_MACHINE_ARN) throw new Error('CALCULATOR_EXECUTION_STATE_MACHINE_ARN is not set');

  const started = await sfnClient.send(new StartExecutionCommand({
    stateMachineArn: STATE_MACHINE_ARN,
    name: `${input.calculationId}-cont-${Date.now().toString(36)}`.slice(0, 80),
    input: JSON.stringify({
      calculationId: input.calculationId,
      // Same session id: AgentCore continues the conversation, so the agent keeps its
      // estimate, its assumptions and everything it already learned from the workbook.
      // The workbook is not re-read and no plan is recompiled.
      sessionId: input.sessionId,
      iteration: 1,
      userAnswer: input.userAnswer,
    }),
  }));

  console.log(JSON.stringify({
    event: 'agentcore_execution_continued',
    calculationId: input.calculationId,
    executionArn: started.executionArn,
    sessionId: input.sessionId,
  }));

  return { executionArn: started.executionArn!, sessionId: input.sessionId };
}

// ─── Liveness (Step 7) ───────────────────────────────────────────────────────

export type ExecutionLiveness =
  | { verdict: 'running' }
  | { verdict: 'failed'; reason: string }
  | { verdict: 'succeeded' }
  | { verdict: 'unknown' };

/**
 * Asks Step Functions whether an execution is actually alive.
 *
 * This is what replaces `CALCULATION_STALE_AFTER_MS = 11 * 60 * 1000`. That rule compared
 * `updated_at` to eleven minutes and declared "The estimate worker stopped before
 * finishing" — a statement it had no evidence for. It was correct only by accident, when
 * the worker really was a Lambda that could not live past fifteen minutes.
 *
 * An AgentCore session may legitimately run for hours (the Harness's managed runtime
 * permits maxLifetime 28800s). Duration is therefore not evidence of anything. The
 * authoritative answer is the execution's own status:
 *
 *   RUNNING            → alive, regardless of how long it has been running
 *   SUCCEEDED          → the driver has already written the terminal record
 *   FAILED/TIMED_OUT/ABORTED → genuinely dead, and only now may MIMO say so
 */
export async function describeExecutionLiveness(executionArn: string): Promise<ExecutionLiveness> {
  try {
    const described = await sfnClient.send(new DescribeExecutionCommand({ executionArn }));
    switch (described.status) {
      case 'RUNNING':
        return { verdict: 'running' };
      case 'SUCCEEDED':
        return { verdict: 'succeeded' };
      case 'FAILED':
      case 'TIMED_OUT':
      case 'ABORTED':
        return { verdict: 'failed', reason: String(described.status) };
      default:
        return { verdict: 'unknown' };
    }
  } catch (error) {
    // A describe failure is not proof of death — an IAM or throttling error would
    // otherwise mark healthy calculations as failed, which is the exact bug being fixed.
    console.error(JSON.stringify({ event: 'describe_execution_failed', executionArn, error: (error as Error).message }));
    return { verdict: 'unknown' };
  }
}

/**
 * How long a calculation may show no activity at all before it is treated as abandoned,
 * used ONLY when there is no execution ARN to ask about (a legacy row, or a record whose
 * execution never started). Deliberately far longer than the Harness's own idle session
 * timeout of 900s, so it can never pre-empt a live agent.
 */
export const NO_EXECUTION_ARN_GRACE_MS = 30 * 60 * 1000;
