/**
 * Phase 6 — LIVE test that the AgentCore Gateway reaches the Pricing Calculator MCP
 * on the AgentCore Runtime.
 *
 * The Gateway is authorizerType AWS_IAM, so it is spoken to as plain streamable-HTTP
 * MCP over HTTPS with a SigV4 signature for service `bedrock-agentcore`. There is no
 * InvokeGateway SDK operation.
 *
 * What this proves that inspecting CDK cannot: the tools the Gateway advertises are
 * the tools the *Runtime* advertises, discovered by the Gateway rather than declared
 * by MIMO. The previous design hand-wrote nine tool definitions into CloudFormation;
 * if this script lists tools the repo never names, the discovery path is real.
 *
 *   node scripts/live-gateway-mcp-smoke.mjs ap-south-1
 */
import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import { BedrockAgentCoreControlClient, ListGatewaysCommand, GetGatewayCommand, ListGatewayTargetsCommand, GetGatewayTargetCommand } from '@aws-sdk/client-bedrock-agentcore-control';
// CommonJS package: under a native ESM loader its factories sit on the default
// export rather than being named exports. The exported factory is `defaultProvider`
// (fromNodeProviderChain lives in @aws-sdk/credential-providers, which is not a
// dependency here).
import credentialProviderNode from '@aws-sdk/credential-provider-node';
const { defaultProvider } = credentialProviderNode;

const region = process.argv[2] || 'ap-south-1';

// The Gateway fronts its targets with its own MCP implementation and negotiates its
// own protocol version, which is NOT the version the upstream Runtime speaks. It
// rejects 2025-06-18 with
//   -32600 Unsupported protocol version {"supported":["2025-03-26"]}
// so this is pinned to what the Gateway advertises rather than to the newest version.
const GATEWAY_MCP_PROTOCOL = '2025-03-26';

const control = new BedrockAgentCoreControlClient({ region });

const summary = ((await control.send(new ListGatewaysCommand({}))).items ?? [])
  .find((g) => /calculator/i.test(g.name ?? ''));
if (!summary) { console.error('No calculator Gateway found.'); process.exit(1); }

const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: summary.gatewayId }));
console.log(`gateway     : ${gateway.name}`);
console.log(`status      : ${gateway.status}`);
console.log(`url         : ${gateway.gatewayUrl}`);
console.log(`authorizer  : ${gateway.authorizerType}`);

console.log('\ntargets:');
let sawRuntimeTarget = false;
let sawLambdaTarget = false;
for (const t of (await control.send(new ListGatewayTargetsCommand({ gatewayIdentifier: summary.gatewayId }))).items ?? []) {
  const detail = await control.send(new GetGatewayTargetCommand({ gatewayIdentifier: summary.gatewayId, targetId: t.targetId }));
  const kind = Object.keys(detail.targetConfiguration?.mcp ?? {})[0] ?? 'unknown';
  console.log(`  ${detail.name}  status=${detail.status}  kind=${kind}`);
  if (kind === 'mcpServer') {
    sawRuntimeTarget = true;
    console.log(`    endpoint: ${detail.targetConfiguration.mcp.mcpServer.endpoint}`);
  }
  if (kind === 'lambda') {
    sawLambdaTarget = true;
    console.log(`    lambdaArn: ${detail.targetConfiguration.mcp.lambda?.lambdaArn}`);
  }
}

// ─── SigV4-signed MCP over the Gateway URL ────────────────────────────────────

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
      // The upstream server frames replies as SSE, so both types must be accepted.
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': GATEWAY_MCP_PROTOCOL,
      ...(mcpSessionId ? { 'mcp-session-id': mcpSessionId } : {}),
    },
    body,
  });

  const signed = await signer.sign(request);
  const response = await fetch(gateway.gatewayUrl, {
    method: 'POST',
    headers: signed.headers,
    body,
  });

  const sessionHeader = response.headers.get('mcp-session-id');
  if (sessionHeader) mcpSessionId = sessionHeader;

  const text = await response.text();
  if (!response.ok) throw new Error(`${method} → HTTP ${response.status}: ${text.slice(0, 500)}`);

  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const rpcBody = JSON.parse(line.slice(5).trim());
      if (rpcBody.error) throw new Error(`${method} → MCP error ${rpcBody.error.code}: ${rpcBody.error.message}`);
      return rpcBody.result;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(method)) throw error;
    }
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed.error) throw new Error(`${method} → MCP error: ${parsed.error.message}`);
    return parsed.result ?? parsed;
  } catch { return { raw: text }; }
}

const failures = [];
const step = async (label, fn) => {
  try { const value = await fn(); console.log(`PASS  ${label}`); return value; }
  catch (error) { failures.push(`${label}: ${error.message}`); console.log(`FAIL  ${label}\n      ${error.message}`); }
};

console.log('\n--- MCP through the Gateway (SigV4) ---');

const init = await step('initialize', () => rpc('initialize', {
  protocolVersion: GATEWAY_MCP_PROTOCOL,
  capabilities: {},
  clientInfo: { name: 'mimo-phase6-gateway-smoke', version: '1.0.0' },
}));
if (init) {
  console.log(`      serverInfo: ${JSON.stringify(init.serverInfo ?? null)}`);
  await rpc('notifications/initialized', {}, { notification: true }).catch(() => {});
}

const listed = await step('tools/list', () => rpc('tools/list', {}));
const tools = (listed?.tools ?? []).map((t) => t.name);
console.log(`      ${tools.length} tools via Gateway: ${tools.join(', ')}`);

await step('tools/call get_server_info', async () => {
  const result = await rpc('tools/call', { name: tools.find((t) => t.endsWith('get_server_info')) ?? 'get_server_info', arguments: {} });
  const text = (result?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
  console.log(`      ${text.slice(0, 300)}`);
});

console.log('');
console.log(`Gateway target is the Runtime MCP : ${sawRuntimeTarget ? 'YES' : 'NO'}`);
console.log(`Legacy Lambda target still present: ${sawLambdaTarget ? 'YES' : 'NO'}`);

if (failures.length || !sawRuntimeTarget) {
  console.log(`\nRESULT: FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nRESULT: PASSED — Claude → AgentCore Gateway → AgentCore Runtime MCP is live.');
