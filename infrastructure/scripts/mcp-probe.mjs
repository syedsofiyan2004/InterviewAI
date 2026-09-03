/**
 * Diagnostic harness for the calculator MCP sidecar.
 *
 * Invokes the deployed sidecar Lambda directly with an LWA payload-format-2.0 event, the
 * way the orchestrator does, and prints the tool result. Exists because the sidecar speaks
 * MCP-over-HTTP inside the Lambda and there is no other way to exercise one tool call by
 * hand: `export_estimate` cannot be reached from a second invoke (the in-flight estimate is
 * per-invoke unless the DynamoDB store is configured), so a probe has to do create/add/save
 * in ONE call sequence within a single invocation, which is what `build_estimate` is for.
 *
 * Usage:
 *   node scripts/mcp-probe.mjs get_server_info '{}'
 *   node scripts/mcp-probe.mjs search_services '{"query":"fargate"}'
 *   node scripts/mcp-probe.mjs get_service_fields '{"service_codes":"awsFargate"}'
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

const FN = process.env.SIDECAR_FN
  || 'iep-dev-calculator-mcp-sidecar-996122083346-ap-south-1';
const REGION = process.env.AWS_REGION || 'ap-south-1';

const client = new LambdaClient({ region: REGION });
let nextId = 1;

/** The LWA event shape: dual Accept header, POST /mcp, body is the JSON-RPC frame. */
const lwaEvent = (body) => ({
  version: '2.0',
  routeKey: '$default',
  rawPath: '/mcp',
  rawQueryString: '',
  headers: {
    'content-type': 'application/json',
    // Both types, because the server answers SSE-framed even for a single result.
    accept: 'application/json, text/event-stream',
  },
  requestContext: {
    http: { method: 'POST', path: '/mcp', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1' },
  },
  body,
  isBase64Encoded: false,
});

export async function callTool(name, args) {
  const frame = JSON.stringify({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  const res = await client.send(new InvokeCommand({
    FunctionName: FN,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify(lwaEvent(frame))),
  }));
  const outer = JSON.parse(new TextDecoder().decode(res.Payload));
  if (outer.statusCode && outer.statusCode >= 400) {
    return { isError: true, text: `HTTP ${outer.statusCode}: ${String(outer.body).slice(0, 400)}` };
  }
  // SSE framing: the JSON-RPC response rides in a `data:` line inside the HTTP body.
  const line = String(outer.body || '').split('\n').find((l) => l.startsWith('data:'));
  if (!line) return { isError: true, text: `no data frame in body: ${String(outer.body).slice(0, 400)}` };
  const rpc = JSON.parse(line.slice(5).trim());
  if (rpc.error) return { isError: true, text: JSON.stringify(rpc.error) };
  const text = (rpc?.result?.content || []).map((c) => c.text).join('\n');
  return { isError: Boolean(rpc?.result?.isError), text };
}

/** The server's own tool list, for comparing a deployment against the upstream contract. */
export async function listTools() {
  const frame = JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list', params: {} });
  const res = await client.send(new InvokeCommand({
    FunctionName: FN,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify(lwaEvent(frame))),
  }));
  const outer = JSON.parse(new TextDecoder().decode(res.Payload));
  const line = String(outer.body || '').split('\n').find((l) => l.startsWith('data:'));
  const rpc = line ? JSON.parse(line.slice(5).trim()) : {};
  return (rpc?.result?.tools || []).map((t) => t.name);
}

if (process.argv[1] && process.argv[1].endsWith('mcp-probe.mjs')) {
  const [, , tool, argsJson] = process.argv;
  if (tool === 'tools/list') {
    console.log((await listTools()).join('\n'));
  } else {
    const result = await callTool(tool, JSON.parse(argsJson || '{}'));
    console.log(result.isError ? `ERROR: ${result.text}` : result.text);
  }
}
