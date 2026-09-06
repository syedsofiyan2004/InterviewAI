/**
 * Ad-hoc LIVE MCP probe against the AgentCore Runtime.
 *
 * A thin CLI over the same InvokeAgentRuntime MCP client the Phase 5 smoke test
 * uses, for answering "what does the MCP actually say about X" without editing a
 * test each time. Used while writing the agent system prompt, so the prompt
 * describes the real tool surface rather than a remembered one.
 *
 *   node scripts/live-mcp-probe.mjs fields amazonS3Standard
 *   node scripts/live-mcp-probe.mjs search "memorydb"
 *   node scripts/live-mcp-probe.mjs call add_service '{"estimate_id":"…","services":"[]"}'
 *   node scripts/live-mcp-probe.mjs tools
 */
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockAgentCoreControlClient, ListAgentRuntimesCommand, GetAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore-control';

const region = process.env.MCP_REGION || 'ap-south-1';
const [, , verb, arg1, arg2] = process.argv;

const control = new BedrockAgentCoreControlClient({ region });
const data = new BedrockAgentCoreClient({ region });

const runtimes = (await control.send(new ListAgentRuntimesCommand({}))).agentRuntimes ?? [];
const summary = runtimes.find((r) => /calc/i.test(r.agentRuntimeName ?? ''));
const runtime = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: summary.agentRuntimeId }));
const runtimeArn = runtime.agentRuntimeArn;

let mcpSessionId;
let mcpProtocolVersion = '2025-06-18';
let nextId = 1;

async function readBody(response) {
  const chunks = [];
  if (response.response?.transformToByteArray) chunks.push(await response.response.transformToByteArray());
  else if (response.response?.[Symbol.asyncIterator]) { for await (const c of response.response) chunks.push(c); }
  else if (response.response) chunks.push(response.response);
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { return JSON.parse(line.slice(5).trim()); } catch { /* keep scanning */ }
  }
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

async function rpc(method, params, { notification = false, name } = {}) {
  const body = notification ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: nextId++, method, params };
  const response = await data.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn, qualifier: 'DEFAULT',
    contentType: 'application/json', accept: 'application/json, text/event-stream',
    mcpSessionId, mcpProtocolVersion, mcpMethod: method, ...(name ? { mcpName: name } : {}),
    payload: new TextEncoder().encode(JSON.stringify(body)),
  }));
  if (response.mcpSessionId) mcpSessionId = response.mcpSessionId;
  const json = await readBody(response);
  if (json?.error) throw new Error(`${method}: ${json.error.message}`);
  return json?.result ?? json;
}

await rpc('initialize', { protocolVersion: mcpProtocolVersion, capabilities: {}, clientInfo: { name: 'mimo-probe', version: '1' } });
await rpc('notifications/initialized', {}, { notification: true }).catch(() => {});

const text = (r) => (r?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
const call = async (name, args) => text(await rpc('tools/call', { name, arguments: args }, { name }));

if (verb === 'tools') {
  const r = await rpc('tools/list', {});
  for (const t of r.tools ?? []) console.log(`${t.name}\n  ${t.description}\n  input: ${JSON.stringify(t.inputSchema)}\n`);
} else if (verb === 'fields') {
  console.log(await call('get_service_fields', { service: arg1 }));
} else if (verb === 'search') {
  console.log(await call('search_services', { query: arg1 }));
} else if (verb === 'call') {
  console.log(await call(arg1, JSON.parse(arg2 || '{}')));
} else {
  console.log('usage: tools | fields <service> | search <query> | call <tool> <jsonArgs>');
}
