/**
 * MIMO Calculator Agent — AgentCore path orchestrator.
 *
 * Invoked asynchronously (InvocationType 'Event') by the API route.
 * Owns the complete long-running estimate lifecycle:
 *   1. Load calculation record + workbook evidence from DynamoDB/S3.
 *   2. Run Claude through the Calculator MCP tools (InvokeModel + tool use).
 *   3. Write result back to S3 and update DynamoDB with COMPLETED/FAILED status.
 *
 * This mirrors the old calculator-orchestrator Lambda but replaces the
 * pipeline + service-adapters compiler with Claude + MCP tools.
 * Claude selects and calls tools freely; MIMO only supplies evidence.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { ddbDocClient, getFileBuffer, saveFileContent } from '../shared/aws.js';
import { appendProgress, type ProgressEvent } from '../shared/progress-eta.js';
import { calculationResultKey, compactCalculationResult } from '../shared/calculator-result-storage.js';
import { CalculationResultSchema, type CalculationRecord } from '../../schema/calculator.js';
import type { AgentCalculatorInput, AgentCalculatorResult, WorkbookEvidence } from './workbook-evidence.js';

const REGION = process.env.AWS_REGION || 'ap-south-1';
const CALCULATOR_TABLE_NAME = process.env.CALCULATOR_TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const MCP_PROXY_LAMBDA_ARN = process.env.CALCULATOR_MCP_PROXY_LAMBDA_ARN!;
const MODEL_ID = process.env.CALCULATOR_AGENT_MODEL_ID
  || process.env.BEDROCK_SONNET_46_PROFILE_ARN
  || 'global.anthropic.claude-sonnet-4-6';
const MAX_ITERATIONS = Number(process.env.CALCULATOR_AGENT_MAX_ITERATIONS) || 40;
const EXECUTION_MODE = 'agentcore-harness';

/**
 * Condensed prompt for the `legacy-invokemodel` rollback path only.
 *
 * The authoritative prompt is prompts/calculator-agent-system.txt and is delivered to
 * the AgentCore Harness by the CDK Custom Resource. It is NOT passed to this Lambda:
 * it used to arrive in CALCULATOR_AGENT_SYSTEM_PROMPT, and once the prompt grew, every
 * deploy failed with Lambda's 5120-byte configuration limit. An env var is the wrong
 * transport for a document.
 */
const SYSTEM_PROMPT = process.env.CALCULATOR_AGENT_SYSTEM_PROMPT
  || (() => { try { return readFileSync(join(__dirname, '../../prompts/calculator-agent-system.txt'), 'utf8'); } catch { return ''; } })()
  || [
    "You are MIMO's AWS Pricing Calculator agent (legacy rollback mode).",
    'MIMO supplies workload evidence; the AWS Pricing Calculator MCP supplies all',
    'Calculator knowledge. Call get_service_fields before configuring any service and',
    'start from catalog.minimalConfig; read catalog.traps and catalog.subServices.',
    'Repair and retry recoverable MCP errors rather than stopping. add_service always',
    'appends — never re-add to fix a mistake; create a fresh estimate instead.',
    'Validate, then export. Success requires a real calculator.aws URL.',
    'Finish with one JSON object: COMPLETED (with calculatorUrl), NEEDS_INPUT, or FAILED.',
  ].join(' ');

const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

// ─── DynamoDB helpers ────────────────────────────────────────────────────────

let trail: ProgressEvent[] = [];

async function patch(calculationId: string, fields: Record<string, unknown>): Promise<void> {
  const entries = Object.entries({ ...fields, updated_at: Date.now() });
  await ddbDocClient.send(new UpdateCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: calculationId },
    UpdateExpression: `SET ${entries.map((_, i) => `#f${i} = :v${i}`).join(', ')}`,
    ExpressionAttributeNames: Object.fromEntries(entries.map(([k], i) => [`#f${i}`, k])),
    ExpressionAttributeValues: Object.fromEntries(entries.map(([, v], i) => [`:v${i}`, v])),
  }));
}

async function recordStage(calculationId: string, stage: string, message: string, extra: Record<string, unknown> = {}): Promise<void> {
  const fields = appendProgress(trail, { stage, message, at: Date.now() });
  trail = fields.progress_history;
  await patch(calculationId, { ...fields, ...extra });
}

// ─── Build workbook evidence from the calculation record ─────────────────────

async function buildWorkbookEvidence(record: CalculationRecord): Promise<WorkbookEvidence> {
  // Workbook IR is stored in S3; fall back to raw resource rows if not available.
  if (record.workbook_ir_s3_key) {
    try {
      const ir = JSON.parse((await getFileBuffer(BUCKET_NAME, record.workbook_ir_s3_key)).toString('utf8'));
      const sheets = (ir.sheets || []).map((sheet: any) => ({
        name: sheet.name || 'Sheet',
        rows: (sheet.rows || []).slice(0, 300).map((row: any) => ({
          rowNumber: row.row || 0,
          values: row.cells ? Object.fromEntries((row.cells || []).map((c: any) => [c.address || c.col, c.formatted || c.raw])) : (row.values || {}),
        })),
      }));
      return { fileName: record.input_file_name || 'workbook', fileHash: record.workbook_hash || '', sheets, userInstructions: record.prompt ? [record.prompt] : [] };
    } catch { /* fall through to resource rows */ }
  }

  // Fall back: build evidence from the parsed resource rows.
  const resources = record.resources_s3_key
    ? JSON.parse((await getFileBuffer(BUCKET_NAME, record.resources_s3_key)).toString('utf8'))
    : (record.resources || []);

  const bySheet = new Map<string, Array<{ rowNumber: number; values: Record<string, unknown> }>>();
  for (const r of resources.slice(0, 300)) {
    const sheet = r.sheet || 'Resources';
    if (!bySheet.has(sheet)) bySheet.set(sheet, []);
    bySheet.get(sheet)!.push({ rowNumber: r.row || 0, values: { Service: r.service, Size: r.size, OS: r.os, Quantity: r.quantity, Region: r.region, 'Purchase model': r.purchase_model, Notes: r.notes, raw: r.raw } });
  }
  return {
    fileName: record.input_file_name || 'workbook',
    fileHash: record.workbook_hash || '',
    sheets: [...bySheet.entries()].map(([name, rows]) => ({ name, rows })),
    userInstructions: record.prompt ? [record.prompt] : [],
  };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const CALCULATOR_TOOLS = [
  { name: 'search_services', description: 'Search for AWS Pricing Calculator services by name or keyword.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'get_service_fields', description: 'Get the field schema, minimalConfig, required fields, traps and sub-services. Call this before configuring ANY service.', input_schema: { type: 'object', properties: { service: { type: 'string' } }, required: ['service'] } },
  { name: 'create_estimate', description: 'Create a new AWS Pricing Calculator estimate.', input_schema: { type: 'object', properties: { name: { type: 'string' }, partition: { type: 'string' } }, required: ['name'] } },
  { name: 'add_service', description: 'Add one or more configured services to an estimate.', input_schema: { type: 'object', properties: { estimate_id: { type: 'string' }, services: { type: 'string' } }, required: ['estimate_id', 'services'] } },
  { name: 'build_estimate', description: 'Create and populate an estimate in a single call.', input_schema: { type: 'object', properties: { name: { type: 'string' }, services: { type: 'string' }, partition: { type: 'string' } }, required: ['name', 'services'] } },
  { name: 'validate_estimate', description: 'Validate an estimate and get any required-field errors.', input_schema: { type: 'object', properties: { estimate_id: { type: 'string' } }, required: ['estimate_id'] } },
  { name: 'export_estimate', description: 'Export and save an estimate to get a shareable calculator.aws URL.', input_schema: { type: 'object', properties: { estimate_id: { type: 'string' } }, required: ['estimate_id'] } },
  { name: 'import_estimate', description: 'Read back a saved estimate to verify its configuration.', input_schema: { type: 'object', properties: { estimate_id: { type: 'string' }, format: { type: 'string' } }, required: ['estimate_id'] } },
  { name: 'get_server_info', description: 'Get MCP server version and capabilities.', input_schema: { type: 'object', properties: {} } },
];

// ─── Tool execution ───────────────────────────────────────────────────────────

async function executeTool(toolName: string, toolInput: Record<string, unknown>): Promise<string> {
  const event = { actionGroup: 'CalculatorMcpTools', function: toolName, parameters: Object.entries(toolInput).map(([name, value]) => ({ name, type: typeof value === 'number' ? 'integer' : 'string', value: String(value) })) };
  const r = await lambdaClient.send(new InvokeCommand({ FunctionName: MCP_PROXY_LAMBDA_ARN, Payload: new TextEncoder().encode(JSON.stringify(event)) }));
  if (r.FunctionError) throw new Error(`MCP proxy error: ${new TextDecoder().decode(r.Payload).slice(0, 300)}`);
  const response = JSON.parse(new TextDecoder().decode(r.Payload));
  return response?.functionResponse?.responseBody?.TEXT?.body || JSON.stringify(response);
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

async function runAgent(input: AgentCalculatorInput): Promise<AgentCalculatorResult> {
  const toolsUsed: string[] = [];
  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: buildUserMessage(input) },
  ];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await bedrockClient.send(new InvokeModelCommand({
      modelId: MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 8192, system: SYSTEM_PROMPT, tools: CALCULATOR_TOOLS, messages }),
    }));
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const stopReason: string = payload.stop_reason;
    const content: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string }> = payload.content || [];
    messages.push({ role: 'assistant', content });

    if (stopReason === 'end_turn') {
      const finalText = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return parseAgentResponse(finalText, toolsUsed);
    }

    if (stopReason === 'tool_use') {
      const toolResults = await Promise.all(
        content.filter(b => b.type === 'tool_use').map(async (block) => {
          const toolName = block.name!;
          if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);
          try {
            const result = await executeTool(toolName, (block.input || {}) as Record<string, unknown>);
            return { type: 'tool_result', tool_use_id: block.id!, content: result };
          } catch (error) {
            return { type: 'tool_result', tool_use_id: block.id!, content: `Error: ${(error as Error).message}`, is_error: true };
          }
        }),
      );
      messages.push({ role: 'user', content: toolResults });
      continue;
    }
    break;
  }
  return { status: 'FAILED', errorCategory: 'AGENT_TIMEOUT', message: `Agent did not return a result after ${MAX_ITERATIONS} iterations.` };
}

// ─── Main handler — orchestrator role ────────────────────────────────────────

interface OrchestratorEvent {
  calculationId?: string;
  planRevisionId?: string;
}

export const handler = async (event: OrchestratorEvent): Promise<void> => {
  const calculationId = event.calculationId;
  if (!calculationId) { console.error('Agent invoked without calculationId'); return; }

  trail = [];
  const startedAt = Date.now();

  const existing = await ddbDocClient.send(new GetCommand({ TableName: CALCULATOR_TABLE_NAME, Key: { calculation_id: calculationId } }));
  const record = existing.Item as CalculationRecord | undefined;
  if (!record) { console.error(`Calculation ${calculationId} not found`); return; }

  try {
    await recordStage(calculationId, 'connecting', 'Loading workbook evidence', { progress_started_at: Date.now() });

    const workbookEvidence = await buildWorkbookEvidence(record);
    const scenarioLabel = record.name || 'AWS Cost Estimate';
    const userInstructions: string[] = [];
    if (record.prompt) userInstructions.push(record.prompt);
    if (record.region) userInstructions.push(`Primary region: ${record.region}`);

    const input: AgentCalculatorInput = { calculationId, scenarioLabel, workbookEvidence, userInstructions };

    console.log(JSON.stringify({ event: 'agent_invoke_start', executionMode: EXECUTION_MODE, calculationId, modelId: MODEL_ID }));

    await recordStage(calculationId, 'saving', 'Building AWS Pricing Calculator estimate', { status: 'BUILDING' });

    const agentResult = await runAgent(input);

    console.log(JSON.stringify({ event: 'agent_invoke_complete', executionMode: EXECUTION_MODE, calculationId, status: agentResult.status, durationMs: Date.now() - startedAt }));

    // Convert agent result to MIMO CalculationResult format and persist.
    const calculationResult = CalculationResultSchema.parse({
      url: agentResult.status === 'COMPLETED' ? agentResult.calculatorUrl : null,
      currency: 'USD',
      monthlyTotal: agentResult.status === 'COMPLETED' ? (agentResult.monthly ?? null) : null,
      lineItems: [],
      environments: [],
      scenarios: [],
      assumptions: agentResult.status === 'COMPLETED' ? [
        `Execution mode: ${EXECUTION_MODE}. Claude used MCP tools to build this estimate directly from workbook evidence.`,
        ...agentResult.assumptions,
      ] : [],
      warnings: agentResult.status === 'COMPLETED' ? agentResult.warnings : [],
      validationErrors: agentResult.status !== 'COMPLETED' ? [(agentResult as any).message || 'Agent did not complete.'] : [],
      diagnostics: {
        MIMO_BUILD_SHA: process.env.MIMO_BUILD_SHA || 'unknown',
        MCP_TOOLS_USED: agentResult.status === 'COMPLETED' ? agentResult.mcpToolsUsed : [],
        SERVICES_CONFIGURED: agentResult.status === 'COMPLETED' ? agentResult.servicesConfigured : [],
        EXECUTION_MODE,
        agentDurationMs: Date.now() - startedAt,
      },
    });

    const resultS3Key = calculationResultKey(record.owner_user_id, calculationId);
    await saveFileContent(BUCKET_NAME, resultS3Key, JSON.stringify(calculationResult), 'application/json');
    const inlineResult = compactCalculationResult(calculationResult);

    const finalStatus = agentResult.status === 'COMPLETED' ? 'COMPLETED'
      : agentResult.status === 'NEEDS_INPUT' ? 'REVIEW_REQUIRED'
        : 'FAILED';

    await recordStage(calculationId,
      finalStatus === 'COMPLETED' ? 'done' : 'validation_failed',
      finalStatus === 'COMPLETED' ? 'Validated estimate ready' : 'Agent could not complete the estimate',
      {
        status: finalStatus,
        result: inlineResult,
        result_s3_key: resultS3Key,
        error_message: finalStatus === 'FAILED' ? (agentResult as any).message?.slice(0, 1000) : undefined,
        iterations: 0,
        tool_call_count: agentResult.status === 'COMPLETED' ? agentResult.mcpToolsUsed.length : 0,
      },
    );

    console.log(`Calculation ${calculationId} finished as ${finalStatus} via ${EXECUTION_MODE} in ${Date.now() - startedAt}ms`);
  } catch (error) {
    const message = (error as Error).message || 'Unknown failure';
    console.error(`Calculation ${calculationId} failed:`, error);
    await recordStage(calculationId, 'failed', 'Estimate failed', {
      status: 'FAILED',
      error_message: message.slice(0, 1000),
    });
  }
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const EVIDENCE_ROW_LIMIT = 200;

function buildUserMessage(input: AgentCalculatorInput): string {
  const { workbookEvidence, scenarioLabel, userInstructions } = input;
  const lines = [`Build an AWS Pricing Calculator estimate for: "${scenarioLabel}"`, `Source: ${workbookEvidence.fileName}`, ''];
  if (userInstructions?.length) { lines.push('Instructions:'); for (const i of userInstructions) lines.push(`  - ${i}`); lines.push(''); }
  lines.push('Workbook evidence:');
  for (const sheet of workbookEvidence.sheets) {
    lines.push(`\nSheet: ${sheet.name} (${sheet.rows.length} rows)`);
    for (const row of sheet.rows.slice(0, EVIDENCE_ROW_LIMIT)) {
      const cells = Object.entries(row.values).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
      if (cells) lines.push(`  Row ${row.rowNumber}: ${cells}`);
    }
    if (sheet.rows.length > EVIDENCE_ROW_LIMIT) lines.push(`  ... and ${sheet.rows.length - EVIDENCE_ROW_LIMIT} more rows`);
  }
  lines.push('', 'Use the Calculator MCP tools to configure and save an accurate estimate. Return structured JSON when done.');
  return lines.join('\n');
}

function extractJson(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1].trim();
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) { if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); } }
  }
  return undefined;
}

function parseAgentResponse(text: string, toolsUsed: string[]): AgentCalculatorResult {
  const jsonStr = extractJson(text);
  if (!jsonStr) return { status: 'FAILED', errorCategory: 'SCHEMA_ERROR', message: `Agent response contained no JSON: ${text.slice(0, 300)}` };
  try {
    const parsed = JSON.parse(jsonStr) as Partial<AgentCalculatorResult & { mcpToolsUsed?: string[] }>;
    if (parsed.status === 'COMPLETED') {
      if (!parsed.calculatorUrl?.includes('calculator.aws')) return { status: 'FAILED', errorCategory: 'SCHEMA_ERROR', message: 'Agent returned COMPLETED without a valid calculator.aws URL.' };
      return {
        status: 'COMPLETED',
        estimateId: String(parsed.estimateId || ''),
        calculatorUrl: parsed.calculatorUrl!,
        monthly: typeof parsed.monthly === 'number' ? parsed.monthly : null,
        upfront: typeof parsed.upfront === 'number' ? parsed.upfront : null,
        total12Months: typeof parsed.total12Months === 'number' ? parsed.total12Months : null,
        assumptions: Array.isArray(parsed.assumptions) ? parsed.assumptions : [],
        warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
        servicesConfigured: Array.isArray(parsed.servicesConfigured) ? parsed.servicesConfigured : [],
        mcpToolsUsed: toolsUsed.length ? toolsUsed : (Array.isArray((parsed as any).mcpToolsUsed) ? (parsed as any).mcpToolsUsed : []),
      };
    }
    if (parsed.status === 'NEEDS_INPUT') return { status: 'NEEDS_INPUT', questions: Array.isArray((parsed as any).questions) ? (parsed as any).questions : [] };
    if (parsed.status === 'FAILED') return { status: 'FAILED', errorCategory: (parsed as any).errorCategory || 'UNKNOWN', message: (parsed as any).message || 'Agent reported failure.' };
  } catch { /* fall through */ }
  return { status: 'FAILED', errorCategory: 'SCHEMA_ERROR', message: `Could not parse agent response: ${text.slice(0, 400)}` };
}
