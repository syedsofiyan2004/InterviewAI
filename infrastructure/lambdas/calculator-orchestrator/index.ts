import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient, getFileBuffer, saveFileContent } from '../shared/aws';
import {
  CalculationResultSchema,
  type CalculationRecord,
  type CalculationResource,
} from '../../schema/calculator';
import { appendProgress, type ProgressEvent } from '../shared/progress-eta';
import { calculationResultKey, compactCalculationResult } from '../shared/calculator-result-storage';
import { McpSidecarClient } from './mcp-client';
import { runEstimatePipeline } from './pipeline';

/**
 * Cost Calculator orchestrator.
 *
 * Invoked asynchronously (InvocationType 'Event') by POST /calculator. It owns the
 * whole long-running half of the feature: run the estimate pipeline against the MCP
 * sidecar and the AWS Price List API, then write the estimate — or a failure — back
 * onto the row the route already created. Nothing here is on an API Gateway request
 * path, so the 29s ceiling does not apply.
 *
 * This runs as its own Lambda rather than a self-invoke of api-handler (the pattern
 * used by intelligence-analysis) because it needs a different dependency set and a
 * different timeout, and keeping it separate leaves api-handler untouched.
 */

const CALCULATOR_TABLE_NAME = process.env.CALCULATOR_TABLE_NAME!;
const SIDECAR_FUNCTION_NAME = process.env.CALCULATOR_SIDECAR_FUNCTION_NAME!;
const BROWSER_VALIDATOR_FUNCTION_NAME = process.env.CALCULATOR_BROWSER_VALIDATOR_FUNCTION_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

interface OrchestratorEvent {
  calculationId?: string;
  planRevisionId?: string;
}

async function patch(calculationId: string, fields: Record<string, unknown>): Promise<void> {
  // Epoch ms, matching every other table — and what the shared progress UI
  // subtracts from the server clock to show elapsed time.
  const entries = Object.entries({ ...fields, updated_at: Date.now() });
  await ddbDocClient.send(new UpdateCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: calculationId },
    UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#f${i}`, k])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
  }));
}

/**
 * Reads the parsed resource rows, from S3 when the landscape was too big for the item.
 *
 * A DynamoDB item is capped at 400KB, so a few thousand machines do not fit on one and
 * the route writes them to S3 instead, leaving a bounded sample behind for the UI (see
 * resources_s3_key). Pricing the sample would quietly under-count the estimate by
 * however many rows did not fit, so a failure to read the full list fails the whole
 * calculation rather than falling back to it.
 */
async function loadResources(record: CalculationRecord): Promise<CalculationResource[]> {
  if (!record.resources_s3_key) return record.resources || [];

  const buffer = await getFileBuffer(BUCKET_NAME, record.resources_s3_key);
  const parsed = JSON.parse(buffer.toString('utf8'));
  if (!Array.isArray(parsed)) {
    throw new Error('PARSED_ROWS_UNREADABLE: the stored resource list is not a list of rows.');
  }
  return parsed as CalculationResource[];
}

export const handler = async (event: OrchestratorEvent): Promise<void> => {
  const calculationId = event.calculationId;
  if (!calculationId) {
    console.error('Orchestrator invoked without a calculationId; nothing to do.');
    return;
  }

  const existing = await ddbDocClient.send(new GetCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: calculationId },
  }));
  const record = existing.Item as CalculationRecord | undefined;
  if (!record) {
    console.error(`Calculation ${calculationId} not found; the row may have been deleted.`);
    return;
  }
  if (event.planRevisionId) {
    if (record.confirmed_plan_revision_id !== event.planRevisionId
      || record.plan_v2?.status !== 'CONFIRMED'
      || record.plan_v2.currentRevisionId !== event.planRevisionId) {
      await patch(calculationId, {
        status: 'FAILED',
        progress_stage: 'failed',
        progress_message: 'Confirmed plan changed before execution',
        error_message: 'PLAN_REVISION_CONFLICT: the worker was not given the currently confirmed plan revision.',
      });
      return;
    }
  }

  /**
   * The stage trail for this run, kept in memory rather than re-read on every stage.
   *
   * Re-reading the row before each append would cost a GetItem per stage to reconstruct
   * something this function already knows, and it would race: two writes deriving a new
   * trail from the same read would each drop the other's entry. This process is the only
   * writer of the trail for the life of the run, so holding it locally is both cheaper
   * and the more correct of the two.
   */
  let trail: ProgressEvent[] = [];

  /**
   * Records a stage and its timestamp together.
   *
   * Always through `appendProgress`, never by patching `progress_stage` alone: the time
   * estimate is derived from the gaps between these entries, so a stage change written
   * without its timestamp leaves the estimate quoting the previous stage's start and
   * reporting a run as slower than it is.
   */
  const recordStage = async (stage: string, message: string, extra: Record<string, unknown> = {}) => {
    const fields = appendProgress(trail, { stage, message, at: Date.now() });
    trail = fields.progress_history;
    await patch(calculationId, { ...fields, ...extra });
  };

  try {
    // `progress_started_at` is stamped here and only here — this is the instant the worker
    // began, which is later than `created_at` by however long the async invoke queued.
    // Charging that queue time to the first stage would make the stage a user is most
    // likely to suspect has hung look even slower than it is.
    await recordStage('connecting', 'Loading AWS service catalogue', { progress_started_at: Date.now() });

    // Inside the try: an unreadable spilled list must surface as a FAILED row with a
    // message, not as an invocation that ends with the record stuck on PROCESSING.
    const resources = await loadResources(record);
    console.log(`Calculation ${calculationId}: pricing ${resources.length} parsed row(s).`);

    const mcp = new McpSidecarClient(SIDECAR_FUNCTION_NAME, BROWSER_VALIDATOR_FUNCTION_NAME);
    // Warmup only, and deliberately non-fatal: the sidecar does not require an
    // initialize handshake (see mcp-client notes), so failing the whole estimate
    // because an unnecessary call was refused would be self-inflicted.
    try {
      await mcp.initialize();
    } catch (warmupError) {
      console.warn('MCP initialize handshake failed; continuing since dispatch does not require it:', warmupError);
    }

    const outcome = await runEstimatePipeline(record, resources, mcp, async update => {
      await recordStage(update.stage, update.message);
    });

    // Parsed rather than trusted: the pipeline builds this object itself, so validation
    // here is a guard against a future edit drifting from the stored contract.
    const parsed = CalculationResultSchema.parse(outcome.result);
    const resultS3Key = calculationResultKey(record.owner_user_id, calculationId);
    await saveFileContent(BUCKET_NAME, resultS3Key, JSON.stringify(parsed), 'application/json');
    const inlineResult = compactCalculationResult(parsed);

    // Terminal stages go on the trail too. The last entry's timestamp is what closes the
    // final stage's duration, so omitting it would leave the slowest stage of a finished
    // run looking open-ended to anything that later reads the trail to explain where the
    // time went.
    await recordStage(outcome.status === 'COMPLETED' ? 'done' : 'validation_failed',
      outcome.status === 'COMPLETED' ? 'Validated estimate ready' : 'Estimate did not pass saved-link validation', {
      status: outcome.status,
      result: inlineResult,
      result_s3_key: resultS3Key,
      iterations: outcome.iterations,
      tool_call_count: outcome.toolCalls.length,
    });
    console.log(`Calculation ${calculationId} finished as ${outcome.status} with ${outcome.iterations} model call(s), ${outcome.toolCalls.length} lookups.`);
  } catch (error) {
    const message = (error as Error).message || 'Unknown failure';
    console.error(`Calculation ${calculationId} failed:`, error);
    // Recorded through the same path as every other stage so a failed run still reports
    // which stage it died in and how long it had been there — the two things needed to
    // tell a timeout apart from a refusal after the fact.
    await recordStage('failed', 'Estimate failed', {
      status: 'FAILED',
      // Surfaced verbatim in the UI: upstream's refusals carry actionable text, and
      // a generic message would hide why the estimate could not be built.
      error_message: message.slice(0, 1000),
    });
  }
};
