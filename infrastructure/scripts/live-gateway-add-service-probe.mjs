/**
 * Narrows WHY add_service hangs through the AgentCore Gateway.
 *
 * Established already (scripts/live-gateway-sequential-calls.mjs): get_server_info,
 * search_services, get_service_fields and create_estimate all return through the Gateway
 * in under 1.1s, and add_service times out. Directly against the Runtime, add_service
 * returns in ~496ms. So the tool is fine and the Gateway is fine for four other tools.
 *
 * add_service is also the only one of those called with a large nested-JSON string
 * argument (`services`). This tries progressively simpler arguments to separate
 * "add_service is broken through the Gateway" from "this argument shape is".
 *
 *   node scripts/live-gateway-add-service-probe.mjs ap-south-1 [timeoutMs]
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { BedrockAgentCoreControlClient, ListGatewaysCommand, GetGatewayCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import credentialProviderNode from '@aws-sdk/credential-provider-node';
const { defaultProvider } = credentialProviderNode;

const region = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'ap-south-1';
const TIMEOUT_MS = Number(process.argv[3]) || 90_000;
const GATEWAY_MCP_PROTOCOL = '2025-03-26';

const control = new BedrockAgentCoreControlClient({ region });
const summary = ((await control.send(new ListGatewaysCommand({}))).items ?? [])
  .find((g) => /calculator/i.test(g.name ?? ''));
const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: summary.gatewayId }));
const credentials = await defaultProvider()();
const signer = new SignatureV4({ service: 'bedrock-agentcore', region, credentials, sha256: Sha256 });
const url = new URL(gateway.gatewayUrl);

let mcpSessionId;
let nextId = 1;

async function rpc(method, params, { notification = false, timeoutMs = TIMEOUT_MS } = {}) {
  const body = JSON.stringify(notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params });
  const request = new HttpRequest({
    method: 'POST', protocol: url.protocol, hostname: url.hostname, path: url.pathname,
    headers: {
      host: url.hostname, 'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': GATEWAY_MCP_PROTOCOL,
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body,
  });
  const signed = await signer.sign(request);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(gateway.gatewayUrl, { method: 'POST', headers: signed.headers, body, signal: controller.signal });
  } finally { clearTimeout(timer); }
  const sessionHeader = response.headers.get('mcp-session-id');
  if (sessionHeader) mcpSessionId = sessionHeader;
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const parsed = JSON.parse(line.slice(5).trim());
    if (parsed.error) throw new Error(`MCP ${parsed.error.code}: ${parsed.error.message}`);
    return parsed.result;
  }
  const parsed = JSON.parse(text);
  if (parsed.error) throw new Error(`MCP: ${parsed.error.message}`);
  return parsed.result ?? parsed;
}

await rpc('initialize', {
  protocolVersion: GATEWAY_MCP_PROTOCOL, capabilities: {},
  clientInfo: { name: 'mimo-add-service-probe', version: '1.0.0' },
});
await rpc('notifications/initialized', {}, { notification: true }).catch(() => {});
const listed = await rpc('tools/list', {});
const tools = (listed.tools ?? []).map((t) => t.name);
const pick = (bare) => tools.find((t) => t.split('___').pop() === bare);

// The advertised schema for add_service, as the Gateway relays it. If the Gateway has
// altered the argument types this is where it shows.
const addServiceTool = (listed.tools ?? []).find((t) => t.name === pick('add_service'));
console.log('add_service inputSchema as advertised by the Gateway:');
console.log(JSON.stringify(addServiceTool?.inputSchema, null, 1));
console.log('');

const text = (r) => (r?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');

const created = await rpc('tools/call', { name: pick('create_estimate'), arguments: { name: `add_service probe ${Date.now()}` } });
const estimateId = JSON.parse(text(created).slice(text(created).indexOf('{'))).estimate_id;
console.log(`create_estimate OK  estimate_id=${estimateId}\n`);

const attempts = [
  // Deliberately invalid and tiny: if the Gateway can carry ANY add_service call, the MCP
  // should reject this in milliseconds. A hang here means the call never completes at all.
  ['empty services array (expect a fast MCP error)', { estimate_id: estimateId, services: '[]' }],
  ['missing services (expect a fast schema error)', { estimate_id: estimateId }],
  ['minimal valid single service', {
    estimate_id: estimateId,
    services: JSON.stringify([{ service: 'amazonS3Standard', config: { region: 'ap-south-1', description: 'probe', s3StandardStorageSize: { value: '100', unit: 'gb|month' } } }]),
  }],
];

for (const [label, args] of attempts) {
  const started = Date.now();
  try {
    const result = await rpc('tools/call', { name: pick('add_service'), arguments: args });
    console.log(`${label.padEnd(46)} OK      ${Date.now() - started}ms`);
    console.log(`   -> ${text(result).slice(0, 300).replace(/\n/g, ' ')}`);
  } catch (error) {
    const kind = error.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';
    console.log(`${label.padEnd(46)} ${kind} ${Date.now() - started}ms`);
    console.log(`   -> ${error.message.slice(0, 300)}`);
  }
}
