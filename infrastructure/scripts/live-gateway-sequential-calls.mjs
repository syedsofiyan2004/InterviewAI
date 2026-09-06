/**
 * Smallest possible live test for the Gateway hang.
 *
 * The agent runs showed a consistent shape: the FIRST Gateway tool call returns, the
 * SECOND never does — first with build_estimate, then with create_estimate, so it is not
 * about which tool or how slow it is. This makes N sequential tools/call requests through
 * the Gateway with an explicit per-call timeout, so the failure is attributable to a call
 * index rather than to a tool.
 *
 * Each call is timed and bounded. A hang shows up as a TIMEOUT line naming the call
 * number, which is the fact the diagnosis turns on.
 *
 *   node scripts/live-gateway-sequential-calls.mjs ap-south-1 [perCallTimeoutMs]
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { BedrockAgentCoreControlClient, ListGatewaysCommand, GetGatewayCommand } from '@aws-sdk/client-bedrock-agentcore-control';
import credentialProviderNode from '@aws-sdk/credential-provider-node';
const { defaultProvider } = credentialProviderNode;

const region = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'ap-south-1';
const PER_CALL_TIMEOUT_MS = Number(process.argv[3]) || 60_000;
const GATEWAY_MCP_PROTOCOL = '2025-03-26';

const control = new BedrockAgentCoreControlClient({ region });
const summary = ((await control.send(new ListGatewaysCommand({}))).items ?? [])
  .find((g) => /calculator/i.test(g.name ?? ''));
const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: summary.gatewayId }));

console.log(`gateway : ${gateway.name}`);
console.log(`url     : ${gateway.gatewayUrl}`);
console.log(`per-call timeout: ${PER_CALL_TIMEOUT_MS}ms`);
console.log('');

const credentials = await defaultProvider()();
const signer = new SignatureV4({ service: 'bedrock-agentcore', region, credentials, sha256: Sha256 });
const url = new URL(gateway.gatewayUrl);

let mcpSessionId;
let nextId = 1;

async function rpc(method, params, { notification = false } = {}) {
  const body = JSON.stringify(notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params });

  const request = new HttpRequest({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname,
    headers: {
      host: url.hostname,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': GATEWAY_MCP_PROTOCOL,
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body,
  });
  const signed = await signer.sign(request);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(gateway.gatewayUrl, {
      method: 'POST', headers: signed.headers, body, signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

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

const init = await rpc('initialize', {
  protocolVersion: GATEWAY_MCP_PROTOCOL, capabilities: {},
  clientInfo: { name: 'mimo-seq-probe', version: '1.0.0' },
});
console.log(`initialize   OK  session=${mcpSessionId ?? '(none)'}  server=${JSON.stringify(init.serverInfo)}`);
await rpc('notifications/initialized', {}, { notification: true }).catch(() => {});

const listed = await rpc('tools/list', {});
const tools = (listed.tools ?? []).map((t) => t.name);
const pick = (bare) => tools.find((t) => t.split('___').pop() === bare);
console.log(`tools/list   OK  ${tools.length} tools`);
console.log('');

const text = (result) => (result?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');

/**
 * A sequence of cheap, independent read-only calls plus the estimate primitives. All of
 * these return in about a second when called straight at the Runtime, so any hang here is
 * the Gateway hop and not the Calculator.
 */
let estimateId;
const plan = [
  ['get_server_info', () => ({ name: pick('get_server_info'), arguments: {} })],
  ['search_services', () => ({ name: pick('search_services'), arguments: { query: 'S3' } })],
  ['get_service_fields(amazonS3Standard)', () => ({ name: pick('get_service_fields'), arguments: { service: 'amazonS3Standard' } })],
  ['create_estimate', () => ({ name: pick('create_estimate'), arguments: { name: `MIMO seq probe ${Date.now()}` } })],
  ['add_service', () => ({
    name: pick('add_service'),
    arguments: {
      estimate_id: estimateId,
      services: JSON.stringify([{
        service: 'amazonS3Standard',
        config: { region: 'ap-south-1', description: 'seq probe 100 GB', s3StandardStorageSize: { value: '100', unit: 'gb|month' } },
      }]),
    },
  })],
  ['validate_estimate', () => ({ name: pick('validate_estimate'), arguments: { estimate_id: estimateId } })],
  ['export_estimate', () => ({ name: pick('export_estimate'), arguments: { estimate_id: estimateId } })],
];

let firstFailureAt;
for (let index = 0; index < plan.length; index++) {
  const [label, build] = plan[index];
  const args = build();
  if (!args.name) { console.log(`call ${index + 1}  ${label.padEnd(38)} SKIP (tool not advertised)`); continue; }

  const started = Date.now();
  try {
    const result = await rpc('tools/call', { name: args.name, arguments: args.arguments });
    const body = text(result);
    console.log(`call ${index + 1}  ${label.padEnd(38)} OK    ${Date.now() - started}ms`);
    if (label === 'create_estimate') {
      estimateId = JSON.parse(body.slice(body.indexOf('{'))).estimate_id;
      console.log(`        estimate_id=${estimateId}`);
    }
    if (label === 'export_estimate') {
      const shared = /https:\/\/calculator\.aws\/[^\s"'\\]+/.exec(body)?.[0];
      console.log(`        URL: ${shared ?? '(none)'}`);
    }
  } catch (error) {
    const kind = error.name === 'AbortError' || error.name === 'TimeoutError' ? 'TIMEOUT' : 'ERROR';
    console.log(`call ${index + 1}  ${label.padEnd(38)} ${kind} ${Date.now() - started}ms  ${error.message.slice(0, 200)}`);
    if (firstFailureAt === undefined) firstFailureAt = index + 1;
    break;
  }
}

console.log('');
if (firstFailureAt === undefined) {
  console.log('RESULT: all sequential Gateway tool calls succeeded. The Gateway hop is NOT the problem.');
} else {
  console.log(`RESULT: first failure at Gateway tool call #${firstFailureAt}.`);
  console.log(firstFailureAt === 2
    ? 'Consistent with "the second call in a Gateway MCP session hangs".'
    : 'Not a simple second-call failure — see the timings above.');
  process.exit(1);
}
