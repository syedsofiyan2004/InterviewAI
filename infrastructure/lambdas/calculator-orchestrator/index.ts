import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient } from '../shared/aws';
import { CalculationResultSchema, type CalculationRecord } from '../../schema/calculator';
import { McpSidecarClient } from './mcp-client';
import { runEstimateLoop } from './tool-loop';

/**
 * Cost Calculator orchestrator.
 *
 * Invoked asynchronously (InvocationType 'Event') by POST /calculator. It owns the
 * whole long-running half of the feature: drive the Bedrock tool-use loop against
 * the MCP sidecar, then write the estimate — or a failure — back onto the row the
 * route already created. Nothing here is on an API Gateway request path, so the
 * 29s ceiling does not apply.
 *
 * This runs as its own Lambda rather than a self-invoke of api-handler (the pattern
 * used by intelligence-analysis) because it needs a different dependency set and a
 * different timeout, and keeping it separate leaves api-handler untouched.
 */

const CALCULATOR_TABLE_NAME = process.env.CALCULATOR_TABLE_NAME!;
const SIDECAR_FUNCTION_NAME = process.env.CALCULATOR_SIDECAR_FUNCTION_NAME!;

interface OrchestratorEvent {
  calculationId?: string;
}

/**
 * Pulls JSON out of <calculation_json>...</calculation_json>, falling back to the
 * first balanced object in the text. Same tagged-output convention as the rest of
 * the repo (parseTaggedJson in api-handler/index.ts), reimplemented here because
 * that helper is module-local to index.ts.
 */
function parseTaggedJson(text: string, tag: string): unknown {
  const tagged = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  const candidate = tagged?.[1]?.trim();
  if (candidate) return JSON.parse(candidate);

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) return JSON.parse(text.slice(start, end + 1));

  throw new Error('AI_EMPTY_RESPONSE: no estimate JSON found in the model reply.');
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
 * Assembles what the model is asked to price.
 *
 * The environment table comes first because it governs every later decision, and
 * each resource row carries its own resolved hours so the model never has to do the
 * default-vs-override lookup itself — a row's own Hours/Day wins, otherwise its
 * environment's value, otherwise 24.
 *
 * Rows are sent as a table rather than prose: the sheet's structure is the reason
 * the user uploaded it instead of typing, and flattening it to a sentence would
 * throw that away.
 */
function buildPrompt(record: CalculationRecord): string {
  const parts: string[] = [];
  const environments = record.environment_hours || [];
  const hoursFor = new Map(environments.map((entry) => [entry.name.trim().toLowerCase(), entry.hoursPerDay]));

  if (environments.length) {
    parts.push(
      'Runtime hours per environment (apply these as the utilization for time-billed resources):',
      ...environments.map((entry) => `- ${entry.name}: ${entry.hoursPerDay} hours/day`),
    );
  }

  if (record.prompt) {
    parts.push('', 'Workload description:', record.prompt);
  }

  const resources = record.resources || [];
  if (resources.length) {
    parts.push('', `Resource list (${resources.length} rows, from an uploaded sheet):`);
    resources.forEach((resource, index) => {
      // A row that never matched any known column arrives with raw only; pass it
      // through verbatim so the model can still interpret it.
      if (!resource.service) {
        parts.push(`${index + 1}. ${resource.raw}`);
        return;
      }
      const hours = resource.hoursPerDay
        ?? hoursFor.get(String(resource.environment || '').trim().toLowerCase())
        ?? 24;
      const fields = [
        `environment=${resource.environment || 'unspecified'}`,
        `service=${resource.service}`,
        resource.size ? `size=${resource.size}` : '',
        resource.quantity ? `quantity=${resource.quantity}` : '',
        resource.region ? `region=${resource.region}` : '',
        `hoursPerDay=${hours}`,
        resource.notes ? `notes=${resource.notes}` : '',
      ].filter(Boolean);
      parts.push(`${index + 1}. ${fields.join('; ')}`);
    });
    parts.push('', 'Price every row above. Group each into a folder named after its environment, and set the utilization field to that row\'s hoursPerDay whenever it is below 24.');
  }

  if (record.region) {
    parts.push('', `Default region where a row does not state one: ${record.region}.`);
  }

  return parts.join('\n');
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

  const prompt = buildPrompt(record);

  try {
    await patch(calculationId, { progress_stage: 'connecting', progress_message: 'Loading AWS service catalogue' });

    const mcp = new McpSidecarClient(SIDECAR_FUNCTION_NAME);
    // Warmup only, and deliberately non-fatal: the sidecar does not require an
    // initialize handshake (see mcp-client notes), so failing the whole estimate
    // because an unnecessary call was refused would be self-inflicted. listTools()
    // inside the loop is the real readiness check and it is mandatory.
    try {
      await mcp.initialize();
    } catch (warmupError) {
      console.warn('MCP initialize handshake failed; continuing since dispatch does not require it:', warmupError);
    }

    const outcome = await runEstimateLoop(prompt, mcp, async update => {
      await patch(calculationId, {
        progress_stage: update.stage,
        progress_message: `Turn ${update.iteration}: ${update.message}`,
      });
    });

    const parsed = CalculationResultSchema.parse(parseTaggedJson(outcome.finalText, 'calculation_json'));

    await patch(calculationId, {
      status: 'COMPLETED',
      result: parsed,
      iterations: outcome.iterations,
      tool_call_count: outcome.toolCalls.length,
      progress_stage: 'done',
      progress_message: 'Estimate ready',
    });
    console.log(`Calculation ${calculationId} completed in ${outcome.iterations} turns, ${outcome.toolCalls.length} tool calls.`);
  } catch (error) {
    const message = (error as Error).message || 'Unknown failure';
    console.error(`Calculation ${calculationId} failed:`, error);
    await patch(calculationId, {
      status: 'FAILED',
      // Surfaced verbatim in the UI: upstream's refusals carry actionable text, and
      // a generic message would hide why the estimate could not be built.
      error_message: message.slice(0, 1000),
      progress_stage: 'failed',
      progress_message: 'Estimate failed',
    });
  }
};
