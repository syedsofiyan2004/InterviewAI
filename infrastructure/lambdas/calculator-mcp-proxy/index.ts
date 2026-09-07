/**
 * Thin MCP tool proxy for the AgentCore Harness action group.
 *
 * When Claude (via InvokeInlineAgent) wants to call an AWS Pricing Calculator
 * MCP tool, Bedrock invokes this Lambda. This function forwards the call to
 * the existing MCP sidecar Lambda and returns the result.
 *
 * This is NOT a custom agent loop — it is infrastructure glue only.
 * Bedrock owns the Claude conversation, tool selection and iteration.
 * This Lambda's only job is: forward tool call → return result.
 *
 * Tool name arrives in event.actionGroup + event.function (Bedrock Agents schema).
 * Parameters arrive in event.parameters or event.requestBody.
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const lambdaClient = new LambdaClient({ region: process.env.AWS_REGION || 'ap-south-1' });

const SIDECAR_FUNCTION_NAME = process.env.CALCULATOR_SIDECAR_FUNCTION_NAME!;

interface BedrockActionGroupEvent {
  actionGroup: string;
  function?: string;
  apiPath?: string;
  httpMethod?: string;
  parameters?: Array<{ name: string; type: string; value: string }>;
  requestBody?: { content?: Record<string, { properties: Array<{ name: string; type: string; value: string }> }> };
  sessionAttributes?: Record<string, string>;
  promptSessionAttributes?: Record<string, string>;
}

function extractArgs(event: BedrockActionGroupEvent): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (event.parameters) {
    for (const p of event.parameters) {
      args[p.name] = coerce(p.value, p.type);
    }
  }
  if (event.requestBody?.content) {
    for (const media of Object.values(event.requestBody.content)) {
      for (const p of media.properties || []) {
        args[p.name] = coerce(p.value, p.type);
      }
    }
  }
  return args;
}

function coerce(value: string, type: string): unknown {
  if (type === 'integer' || type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (type === 'boolean') return value === 'true';
  if (type === 'array' || type === 'object') {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

/**
 * Invoke the MCP sidecar with a JSON-RPC tools/call request.
 *
 * The sidecar runs behind Lambda Web Adapter, so we send a Function-URL-shaped
 * event exactly as McpSidecarClient does in the existing orchestrator path.
 */
async function callMcpTool(toolName: string, args: Record<string, unknown>): Promise<string> {
  const jsonRpc = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  });
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/mcp',
    rawQueryString: '',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    requestContext: { http: { method: 'POST', path: '/mcp', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1' } },
    body: jsonRpc,
    isBase64Encoded: false,
  };

  const response = await lambdaClient.send(new InvokeCommand({
    FunctionName: SIDECAR_FUNCTION_NAME,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify(event)),
  }));

  if (response.FunctionError) {
    throw new Error(`MCP sidecar error (${response.FunctionError}): ${new TextDecoder().decode(response.Payload).slice(0, 400)}`);
  }

  const envelope = JSON.parse(new TextDecoder().decode(response.Payload));
  const body = envelope.isBase64Encoded ? Buffer.from(envelope.body, 'base64').toString('utf8') : (envelope.body || '');

  // Parse SSE response
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const rpc = JSON.parse(line.slice(5).trim());
      if (rpc.result?.content) {
        return rpc.result.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
      }
    } catch { /* continue scanning */ }
  }
  return body;
}

export const handler = async (event: BedrockActionGroupEvent): Promise<unknown> => {
  const toolName = event.function || event.apiPath?.replace(/^\//, '') || '';
  if (!toolName) {
    return buildResponse(event, 'FAILED', JSON.stringify({ error: 'No tool name in event' }));
  }

  console.log(JSON.stringify({ event: 'mcp_proxy_call', tool: toolName, actionGroup: event.actionGroup }));

  try {
    const args = extractArgs(event);
    const result = await callMcpTool(toolName, args);
    return buildResponse(event, 'SUCCESS', result);
  } catch (error) {
    const message = (error as Error).message || 'Unknown error';
    console.error(JSON.stringify({ event: 'mcp_proxy_error', tool: toolName, error: message }));
    return buildResponse(event, 'FAILED', JSON.stringify({ error: message }));
  }
};

function buildResponse(event: BedrockActionGroupEvent, status: 'SUCCESS' | 'FAILED', body: string): unknown {
  // Bedrock Agents action group response format
  return {
    actionGroup: event.actionGroup,
    function: event.function,
    apiPath: event.apiPath,
    httpMethod: event.httpMethod,
    functionResponse: {
      responseState: status === 'SUCCESS' ? 'REPROMPT' : 'FAILURE',
      responseBody: {
        TEXT: { body },
      },
    },
  };
}
