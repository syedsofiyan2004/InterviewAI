/**
 * MIMO Calculator Agent — AgentCore-aligned Harness client.
 *
 * Uses Bedrock InvokeModel with tool use to drive Claude through the AWS Pricing
 * Calculator MCP workflow. Claude selects and calls tools freely; MIMO only supplies
 * workbook evidence and the system prompt. No service-adapters.ts logic is involved.
 *
 * Why InvokeModel instead of InvokeInlineAgent:
 *   InvokeInlineAgent (Bedrock Agents) requires prior service activation that may not
 *   be available on all accounts. InvokeModel achieves the same agent behaviour —
 *   Claude + tools in a bounded loop — without that dependency.
 *
 * The AgentCore Gateway and Runtime are deployed (Runtime hosts the MCP server).
 * This Lambda invokes the Calculator MCP tools through the proxy Lambda (action group
 * executor) which forwards calls to the existing MCP sidecar.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { AgentCalculatorInput, AgentCalculatorResult } from './workbook-evidence.js';

const REGION = process.env.AWS_REGION || 'ap-south-1';
const MODEL_ID = process.env.CALCULATOR_AGENT_MODEL_ID
  || process.env.BEDROCK_SONNET_46_PROFILE_ARN
  || 'global.anthropic.claude-sonnet-4-6';
const MCP_PROXY_LAMBDA_ARN = process.env.CALCULATOR_MCP_PROXY_LAMBDA_ARN!;
const MAX_ITERATIONS = Number(process.env.CALCULATOR_AGENT_MAX_ITERATIONS) || 40;
const EXECUTION_MODE = 'agentcore-harness';

const SYSTEM_PROMPT = process.env.CALCULATOR_AGENT_SYSTEM_PROMPT
  || (() => {
    try { return readFileSync(join(__dirname, '../../prompts/calculator-agent-system.txt'), 'utf8'); } catch { return ''; }
  })()
  || 'You are MIMO\'s AWS Pricing Calculator agent. Use MCP tools to build estimates and return structured JSON.';

const bedrockClient = new BedrockRuntimeClient({ region: REGION });
const lambdaClient = new LambdaClient({ region: REGION });

// ─── Calculator MCP tool definitions for Claude tool use ─────────────────────

const CALCULATOR_TOOLS = [
  { name: 'search_services', description: 'Search for AWS Pricing Calculator services by name or keyword.', input_schema: { type: 'object', properties: { query: { type: 'string', description: 'Service name or keyword' } }, required: ['query'] } },
  { name: 'get_service_fields', description: 'Get the field schema, minimalConfig, required fields, traps and sub-services for a Calculator service. ALWAYS call this before configuring a service.', input_schema: { type: 'object', properties: { service: { type: 'string', description: 'Calculator service code (e.g. awsFargate, ec2Enhancement)' } }, required: ['service'] } },
  { name: 'create_estimate', description: 'Create a new AWS Pricing Calculator estimate.', input_schema: { type: 'object', properties: { name: { type: 'string' }, partition: { type: 'string' } }, required: ['name'] } },
  { name: 'add_service', description: 'Add one or more configured services to an estimate.', input_schema: { type: 'object', properties: { estimate_id: { type: 'string' }, services: { type: 'string', description: 'JSON array of service configuration objects' } }, required: ['estimate_id', 'services'] } },
  { name: 'build_estimate', description: 'Create and populate an estimate in a single call for simple estimates.', input_schema: { type: 'object', properties: { name: { type: 'string' }, services: { type: 'string' }, partition: { type: 'string' } }, required: ['name', 'services'] } },
  { name: 'validate_estimate', description: 'Validate the current state of an estimate and get any required-field errors.', input_schema: { type: 'object', properties: { estimate_id: { type: 'string' } }, required: ['estimate_id'] } },
  { name: 'export_estimate', description: 'Export and save an estimate to get a shareable calculator.aws URL.', input_schema: { type: 'object', properties: { estimate_id: { type: 'string' } }, required: ['estimate_id'] } },
  { name: 'import_estimate', description: 'Import/read back a saved estimate to verify its configuration.', input_schema: { type: 'object', properties: { estimate_id: { type: 'string' }, format: { type: 'string' } }, required: ['estimate_id'] } },
  { name: 'get_server_info', description: 'Get MCP server version and capabilities.', input_schema: { type: 'object', properties: {} } },
];

// ─── Tool execution via MCP proxy Lambda ─────────────────────────────────────

async function executeTool(toolName: string, toolInput: Record<string, unknown>): Promise<string> {
  if (!MCP_PROXY_LAMBDA_ARN) throw new Error('CALCULATOR_MCP_PROXY_LAMBDA_ARN not configured');
  const event = { actionGroup: 'CalculatorMcpTools', function: toolName, parameters: Object.entries(toolInput).map(([name, value]) => ({ name, type: typeof value === 'number' ? 'integer' : 'string', value: String(value) })) };
  const r = await lambdaClient.send(new InvokeCommand({ FunctionName: MCP_PROXY_LAMBDA_ARN, Payload: new TextEncoder().encode(JSON.stringify(event)) }));
  if (r.FunctionError) throw new Error(`MCP proxy error: ${new TextDecoder().decode(r.Payload).slice(0, 300)}`);
  const response = JSON.parse(new TextDecoder().decode(r.Payload));
  return response?.functionResponse?.responseBody?.TEXT?.body || JSON.stringify(response);
}

// ─── Agent loop (InvokeModel + tool use) ─────────────────────────────────────

export const handler = async (input: AgentCalculatorInput): Promise<AgentCalculatorResult> => {
  const startedAt = Date.now();
  const toolsUsed: string[] = [];

  console.log(JSON.stringify({ event: 'agent_invoke_start', executionMode: EXECUTION_MODE, calculationId: input.calculationId, scenarioLabel: input.scenarioLabel, modelId: MODEL_ID }));

  const messages: Array<{ role: string; content: unknown }> = [
    { role: 'user', content: buildUserMessage(input) },
  ];

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const body = {
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 8192,
        system: SYSTEM_PROMPT,
        tools: CALCULATOR_TOOLS,
        messages,
      };

      const response = await bedrockClient.send(new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(body),
      }));

      const payload = JSON.parse(new TextDecoder().decode(response.body));
      const stopReason: string = payload.stop_reason;
      const content: Array<{ type: string; id?: string; name?: string; input?: unknown; text?: string }> = payload.content || [];

      // Add assistant response to conversation
      messages.push({ role: 'assistant', content });

      if (stopReason === 'end_turn') {
        // Claude is done — extract the structured JSON result
        const finalText = content.filter(b => b.type === 'text').map(b => b.text).join('\n');
        console.log(JSON.stringify({ event: 'agent_invoke_complete', executionMode: EXECUTION_MODE, calculationId: input.calculationId, durationMs: Date.now() - startedAt, iterations: iteration + 1, toolsUsed }));
        return parseAgentResponse(finalText, toolsUsed);
      }

      if (stopReason === 'tool_use') {
        // Execute all tool calls in parallel
        const toolUseBlocks = content.filter(b => b.type === 'tool_use');
        const toolResults = await Promise.all(toolUseBlocks.map(async (block) => {
          const toolName = block.name!;
          const toolInput = (block.input || {}) as Record<string, unknown>;
          if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);
          console.log(JSON.stringify({ event: 'mcp_tool_call', tool: toolName, calculationId: input.calculationId }));
          try {
            const result = await executeTool(toolName, toolInput);
            return { type: 'tool_result', tool_use_id: block.id!, content: result };
          } catch (error) {
            return { type: 'tool_result', tool_use_id: block.id!, content: `Error: ${(error as Error).message}`, is_error: true };
          }
        }));
        messages.push({ role: 'user', content: toolResults });
        continue;
      }

      // Unexpected stop reason
      break;
    }

    return { status: 'FAILED', errorCategory: 'AGENT_TIMEOUT', message: `Agent did not return a result after ${MAX_ITERATIONS} iterations.` };
  } catch (error) {
    const message = (error as Error).message || 'Unknown error';
    console.error(JSON.stringify({ event: 'agent_invoke_error', executionMode: EXECUTION_MODE, calculationId: input.calculationId, error: message, durationMs: Date.now() - startedAt }));
    return { status: 'FAILED', errorCategory: 'AGENT_TIMEOUT', message };
  }
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const EVIDENCE_ROW_LIMIT = 200;

function buildUserMessage(input: AgentCalculatorInput): string {
  const { workbookEvidence, scenarioLabel, userInstructions } = input;
  const lines: string[] = [
    `Build an AWS Pricing Calculator estimate for scenario: "${scenarioLabel}"`,
    `Source file: ${workbookEvidence.fileName}`,
    '',
  ];
  if (userInstructions?.length) {
    lines.push('User instructions:');
    for (const instruction of userInstructions) lines.push(`  - ${instruction}`);
    lines.push('');
  }
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
  // Try fenced code block first (``` json ... ```)
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fenced) return fenced[1].trim();
  // Find the outermost balanced JSON object
  const start = text.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0, inStr = false, escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inStr) { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (!inStr) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
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
