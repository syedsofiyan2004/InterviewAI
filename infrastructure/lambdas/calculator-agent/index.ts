/**
 * MIMO Calculator Agent — AgentCore Harness client.
 *
 * This Lambda is MIMO's entry point for the new AgentCore architecture.
 * It:
 *   1. Receives a WorkbookEvidence payload (no Calculator field IDs).
 *   2. Invokes Bedrock's InvokeInlineAgent API to run Claude with the
 *      Calculator MCP tools (via the action group proxy Lambda).
 *   3. Bedrock manages the entire Claude + tool-use loop.
 *   4. Parses the agent's final structured JSON response.
 *   5. Returns an AgentCalculatorResult to MIMO.
 *
 * What this Lambda does NOT do:
 *   - It does NOT manually call MCP tools.
 *   - It does NOT run a model → tool → model loop itself.
 *   - It does NOT use service-adapters.ts or compileWithCalculatorAdapter.
 *   - All Calculator knowledge stays inside Claude + the MCP tools.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BedrockAgentRuntimeClient,
  InvokeInlineAgentCommand,
  ParameterType,
  type ActionGroupExecutor,
} from '@aws-sdk/client-bedrock-agent-runtime';
import type { AgentCalculatorInput, AgentCalculatorResult } from './workbook-evidence.js';

const REGION = process.env.AWS_REGION || 'ap-south-1';
const MODEL_ID = process.env.CALCULATOR_AGENT_MODEL_ID
  || process.env.BEDROCK_SONNET_46_PROFILE_ARN
  || 'global.anthropic.claude-sonnet-4-6';
const MCP_PROXY_LAMBDA_ARN = process.env.CALCULATOR_MCP_PROXY_LAMBDA_ARN!;
const GATEWAY_ARN = process.env.CALCULATOR_GATEWAY_ARN || '';
const MAX_ITERATIONS = Number(process.env.CALCULATOR_AGENT_MAX_ITERATIONS) || 40;
const EXECUTION_MODE = 'agentcore-harness';

/**
 * System prompt — injected as CALCULATOR_AGENT_SYSTEM_PROMPT env var by CDK,
 * which reads it from the source-controlled prompts/calculator-agent-system.txt.
 * Falls back to a local file read for non-Lambda environments (local test runs).
 */
const SYSTEM_PROMPT = process.env.CALCULATOR_AGENT_SYSTEM_PROMPT
  || (() => {
    try { return readFileSync(join(__dirname, '../../prompts/calculator-agent-system.txt'), 'utf8'); } catch { return ''; }
  })()
  || 'You are MIMO\'s AWS Pricing Calculator agent. Use MCP tools to build estimates and return structured JSON.';

/**
 * OpenAPI-style tool schema for the Calculator MCP tools.
 *
 * The Gateway auto-discovers tools via the MCP server's tools/list. This schema
 * declares the action group surface — Bedrock validates requests against it before
 * invoking the proxy Lambda. It mirrors the upstream MCP server's tool surface.
 *
 * Using a single "pass-through" action group with a generic tool definition keeps
 * the schema stable across upstream MCP version bumps.
 */
const MCP_TOOLS_FUNCTION_SCHEMA = {
  functions: [
    { name: 'search_services', description: 'Search for AWS Pricing Calculator services by name or keyword.', parameters: { query: { type: 'string', description: 'Service name or keyword to search for.', required: true } } },
    { name: 'get_service_fields', description: 'Get the field schema, minimalConfig, required fields, traps and sub-services for a Calculator service.', parameters: { service: { type: 'string', description: 'Calculator service code (e.g. awsFargate, ec2Enhancement).', required: true } } },
    { name: 'create_estimate', description: 'Create a new AWS Pricing Calculator estimate.', parameters: { name: { type: 'string', description: 'Estimate name.', required: true }, partition: { type: 'string', description: 'AWS partition (default: aws).', required: false } } },
    { name: 'add_service', description: 'Add one or more configured services to an estimate.', parameters: { estimate_id: { type: 'string', description: 'Estimate ID from create_estimate.', required: true }, services: { type: 'string', description: 'JSON array of service configuration objects.', required: true } } },
    { name: 'build_estimate', description: 'Create and populate an estimate in a single call for simple estimates.', parameters: { name: { type: 'string', description: 'Estimate name.', required: true }, services: { type: 'string', description: 'JSON array of service configuration objects.', required: true }, partition: { type: 'string', description: 'AWS partition.', required: false } } },
    { name: 'validate_estimate', description: 'Validate the current state of an estimate.', parameters: { estimate_id: { type: 'string', description: 'Estimate ID.', required: true } } },
    { name: 'export_estimate', description: 'Export and save an estimate to get a shareable calculator.aws URL.', parameters: { estimate_id: { type: 'string', description: 'Estimate ID.', required: true } } },
    { name: 'import_estimate', description: 'Import/read back a saved estimate to verify its configuration.', parameters: { estimate_id: { type: 'string', description: 'Estimate ID or shareable URL.', required: true }, format: { type: 'string', description: 'Response format (json).', required: false } } },
    { name: 'get_server_info', description: 'Get MCP server version and capabilities.', parameters: {} },
  ],
};

const client = new BedrockAgentRuntimeClient({ region: REGION });

export const handler = async (input: AgentCalculatorInput): Promise<AgentCalculatorResult> => {
  const startedAt = Date.now();
  const sessionId = `calc-${input.calculationId}-${Date.now()}`;

  console.log(JSON.stringify({
    event: 'agent_invoke_start',
    executionMode: EXECUTION_MODE,
    calculationId: input.calculationId,
    scenarioLabel: input.scenarioLabel,
    modelId: MODEL_ID,
    sessionId,
  }));

  // Build the user message from WorkbookEvidence — no Calculator field IDs.
  const userMessage = buildUserMessage(input);

  const actionGroupExecutor: ActionGroupExecutor = MCP_PROXY_LAMBDA_ARN
    ? { lambda: MCP_PROXY_LAMBDA_ARN }
    : { customControl: 'RETURN_CONTROL' };

  try {
    const command = new InvokeInlineAgentCommand({
      sessionId,
      inputText: userMessage,
      foundationModel: MODEL_ID,
      instruction: SYSTEM_PROMPT,
      enableTrace: true,
      endSession: false,
      actionGroups: [
        {
          actionGroupName: 'CalculatorMcpTools',
          description: 'AWS Pricing Calculator MCP tools. Use these to discover services, get field schemas, create and save estimates.',
          actionGroupExecutor,
          functionSchema: {
            functions: MCP_TOOLS_FUNCTION_SCHEMA.functions.map((fn) => ({
              name: fn.name,
              description: fn.description,
              parameters: Object.fromEntries(
                Object.entries(fn.parameters || {}).map(([k, v]) => {
                  const vTyped = v as { type: string; description: string; required?: boolean };
                  // Map JSON schema type strings to ParameterType enum values.
                  const typeMap: Record<string, ParameterType> = {
                    string: ParameterType.STRING,
                    integer: ParameterType.INTEGER,
                    number: ParameterType.NUMBER,
                    boolean: ParameterType.BOOLEAN,
                    array: ParameterType.ARRAY,
                    object: ParameterType.STRING,  // objects pass as JSON string
                  };
                  return [k, {
                    type: typeMap[vTyped.type] ?? ParameterType.STRING,
                    description: vTyped.description,
                    required: vTyped.required ?? false,
                  }];
                }),
              ),
            })),
          },
        },
      ],
    });

    const response = await client.send(command);

    // Collect streamed event chunks and extract the final response.
    let finalText = '';
    const toolsUsed: string[] = [];
    let iterationCount = 0;

    for await (const event of response.completion!) {
      if (event.chunk?.bytes) {
        finalText += new TextDecoder().decode(event.chunk.bytes);
      }
      if (event.trace?.trace?.orchestrationTrace?.invocationInput?.actionGroupInvocationInput?.function) {
        const toolName = event.trace.trace.orchestrationTrace.invocationInput.actionGroupInvocationInput.function;
        if (!toolsUsed.includes(toolName)) toolsUsed.push(toolName);
        iterationCount++;
      }
    }

    console.log(JSON.stringify({
      event: 'agent_invoke_complete',
      executionMode: EXECUTION_MODE,
      calculationId: input.calculationId,
      durationMs: Date.now() - startedAt,
      iterationCount,
      toolsUsed,
    }));

    return parseAgentResponse(finalText, toolsUsed);
  } catch (error) {
    const message = (error as Error).message || 'Unknown agent error';
    console.error(JSON.stringify({
      event: 'agent_invoke_error',
      executionMode: EXECUTION_MODE,
      calculationId: input.calculationId,
      error: message,
      durationMs: Date.now() - startedAt,
    }));
    return { status: 'FAILED', errorCategory: 'AGENT_TIMEOUT', message };
  }
};

/**
 * Build a concise user message from WorkbookEvidence.
 *
 * For large workbooks, only the first EVIDENCE_ROW_LIMIT rows per sheet are
 * included inline. All sheets are summarised; the full evidence stays in S3.
 */
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
    const rows = sheet.rows.slice(0, EVIDENCE_ROW_LIMIT);
    for (const row of rows) {
      const cells = Object.entries(row.values)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ');
      if (cells) lines.push(`  Row ${row.rowNumber}: ${cells}`);
    }
    if (sheet.rows.length > EVIDENCE_ROW_LIMIT) {
      lines.push(`  ... and ${sheet.rows.length - EVIDENCE_ROW_LIMIT} more rows (summarised)`);
    }
  }

  lines.push('', 'Use the Calculator MCP tools to configure and save an accurate estimate. Return structured JSON when done.');
  return lines.join('\n');
}

/**
 * Parse the agent's final text response as an AgentCalculatorResult.
 *
 * The agent is instructed to return one of three JSON shapes.
 * If parsing fails we return FAILED so MIMO can surface a clean error.
 */
function parseAgentResponse(text: string, toolsUsed: string[]): AgentCalculatorResult {
  // Extract the last JSON block from the agent's response.
  const jsonMatch = [...text.matchAll(/\{[\s\S]*?\}/g)].at(-1);
  if (!jsonMatch) {
    return { status: 'FAILED', errorCategory: 'SCHEMA_ERROR', message: `Agent response contained no JSON: ${text.slice(0, 300)}` };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as Partial<AgentCalculatorResult & { mcpToolsUsed?: string[] }>;
    if (parsed.status === 'COMPLETED') {
      if (!parsed.calculatorUrl?.includes('calculator.aws')) {
        return { status: 'FAILED', errorCategory: 'SCHEMA_ERROR', message: 'Agent returned COMPLETED without a valid calculator.aws URL.' };
      }
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
        mcpToolsUsed: toolsUsed.length ? toolsUsed : (Array.isArray(parsed.mcpToolsUsed) ? parsed.mcpToolsUsed : []),
      };
    }
    if (parsed.status === 'NEEDS_INPUT') {
      return { status: 'NEEDS_INPUT', questions: Array.isArray((parsed as any).questions) ? (parsed as any).questions : [] };
    }
    if (parsed.status === 'FAILED') {
      return { status: 'FAILED', errorCategory: (parsed as any).errorCategory || 'UNKNOWN', message: (parsed as any).message || 'Agent reported failure.' };
    }
  } catch (parseError) {
    // fall through
  }
  return { status: 'FAILED', errorCategory: 'SCHEMA_ERROR', message: `Could not parse agent response: ${text.slice(0, 400)}` };
}
