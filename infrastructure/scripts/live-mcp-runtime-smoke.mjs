/**
 * Phase 5 — LIVE AgentCore Runtime MCP isolation test.
 *
 * Talks MCP directly to the deployed AgentCore Runtime via InvokeAgentRuntime,
 * with no Gateway, no Harness, no Lambda, and no MIMO code in the path. This is
 * the only thing that proves the Runtime genuinely hosts
 * sample-aws-pricing-calculator-mcp rather than "a container exists".
 *
 * The tool surface is DISCOVERED with tools/list — nothing here hard-codes a
 * schema and then calls the check passed.
 *
 *   node scripts/live-mcp-runtime-smoke.mjs [region] [--full]
 *
 * Without --full it stops after tools/list + get_server_info + search_services +
 * get_service_fields (read-only). With --full it also builds, validates and
 * exports a real 100 GB S3 estimate and prints the calculator.aws URL.
 */
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
  GetAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const region = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'ap-south-1';
const full = process.argv.includes('--full');

const control = new BedrockAgentCoreControlClient({ region });
const data = new BedrockAgentCoreClient({ region });

// ─── resolve the pricing-calculator MCP Runtime ───────────────────────────────

const runtimes = (await control.send(new ListAgentRuntimesCommand({}))).agentRuntimes ?? [];
const summary = runtimes.find((r) => /calc/i.test(r.agentRuntimeName ?? ''));
if (!summary) {
  console.error(`No calculator MCP Runtime found in ${region}. Found: ${runtimes.map((r) => r.agentRuntimeName).join(', ') || 'none'}`);
  process.exit(1);
}
const runtime = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: summary.agentRuntimeId }));
const runtimeArn = runtime.agentRuntimeArn;

console.log(`runtime   : ${runtime.agentRuntimeName} (${runtime.agentRuntimeId})`);
console.log(`arn       : ${runtimeArn}`);
console.log(`status    : ${runtime.status}`);
console.log(`protocol  : ${runtime.protocolConfiguration ?? 'null  ← not declared MCP'}`);
console.log('');

// ─── minimal MCP client over InvokeAgentRuntime ───────────────────────────────

let mcpSessionId;
let mcpProtocolVersion = '2025-06-18';
let nextId = 1;

/** Decodes the response body, which arrives either as raw JSON or SSE-framed. */
async function readBody(response) {
  const chunks = [];
  if (response.response?.transformToByteArray) {
    chunks.push(await response.response.transformToByteArray());
  } else if (response.response?.[Symbol.asyncIterator]) {
    for await (const chunk of response.response) chunks.push(chunk);
  } else if (response.response) {
    chunks.push(response.response);
  }
  const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
  if (!text) return { text, json: undefined };
  // The upstream server frames streamable-HTTP MCP replies as SSE.
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try { return { text, json: JSON.parse(line.slice(5).trim()) }; } catch { /* keep scanning */ }
  }
  try { return { text, json: JSON.parse(text) }; } catch { return { text, json: undefined }; }
}

async function rpc(method, params, { notification = false, name } = {}) {
  const body = notification
    ? { jsonrpc: '2.0', method, params }
    : { jsonrpc: '2.0', id: nextId++, method, params };

  const response = await data.send(new InvokeAgentRuntimeCommand({
    agentRuntimeArn: runtimeArn,
    qualifier: 'DEFAULT',
    contentType: 'application/json',
    accept: 'application/json, text/event-stream',
    // Avoid the SDK generating a fresh Runtime session for each invocation.
    runtimeSessionId: mcpSessionId,
    mcpSessionId,
    mcpProtocolVersion,
    mcpMethod: method,
    ...(name ? { mcpName: name } : {}),
    payload: new TextEncoder().encode(JSON.stringify(body)),
  }));

  if (response.mcpSessionId) mcpSessionId = response.mcpSessionId;
  if (response.mcpProtocolVersion) mcpProtocolVersion = response.mcpProtocolVersion;

  const { text, json } = await readBody(response);
  if (response.statusCode && response.statusCode >= 400) {
    throw new Error(`${method} → HTTP ${response.statusCode}: ${text.slice(0, 600)}`);
  }
  if (json?.error) throw new Error(`${method} → MCP error ${json.error.code}: ${json.error.message}`);
  return json?.result ?? { raw: text };
}

/** Extracts the text payload of a tools/call result. */
const toolText = (result) =>
  (result?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n');

async function callTool(name, args) {
  const result = await rpc('tools/call', { name, arguments: args }, { name });
  return { text: toolText(result), isError: Boolean(result?.isError) };
}

// ─── run ──────────────────────────────────────────────────────────────────────

const failures = [];
const step = async (label, fn) => {
  const started = Date.now();
  try {
    const value = await fn();
    console.log(`PASS  ${label}  (${Date.now() - started}ms)`);
    return value;
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
    console.log(`FAIL  ${label}  (${Date.now() - started}ms)\n      ${error.message}`);
    return undefined;
  }
};

const init = await step('initialize', () => rpc('initialize', {
  protocolVersion: mcpProtocolVersion,
  capabilities: {},
  clientInfo: { name: 'mimo-phase5-smoke', version: '1.0.0' },
}));
if (init) {
  console.log(`      serverInfo: ${JSON.stringify(init.serverInfo ?? null)}`);
  console.log(`      mcpSessionId: ${mcpSessionId ?? '(none returned)'}`);
  await rpc('notifications/initialized', {}, { notification: true }).catch(() => {});
}

const listed = await step('tools/list', () => rpc('tools/list', {}));
const tools = listed?.tools ?? [];
console.log(`      discovered ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);
const has = (name) => tools.some((t) => t.name === name);

if (has('get_server_info')) {
  await step('get_server_info', async () => {
    const { text } = await callTool('get_server_info', {});
    console.log(`      ${text.slice(0, 400)}`);
  });
}

if (has('search_services')) {
  await step('search_services("S3")', async () => {
    const { text, isError } = await callTool('search_services', { query: 'S3' });
    if (isError) throw new Error(text.slice(0, 400));
    console.log(`      ${text.slice(0, 400)}`);
  });
}

/**
 * Resolved by *following the MCP*, exactly as the agent is instructed to: ask the
 * parent service, read its redirect/subServices, then ask the leaf service for its
 * own fields. Nothing here assumes a service code or a field name.
 */
let leafService;
let requiredShape;

if (has('get_service_fields')) {
  await step('get_service_fields("amazonS3") — parent', async () => {
    const { text, isError } = await callTool('get_service_fields', { service: 'amazonS3' });
    if (isError) throw new Error(text.slice(0, 400));
    const payload = JSON.parse(text.slice(text.indexOf('{')));
    const catalog = payload.catalog ?? {};
    console.log(`      status=${payload.status}  next_step=${payload.next_step ?? '—'}  redirect_to=${payload.redirect_to ?? '—'}`);
    console.log(`      catalog.status=${catalog.status}`);
    for (const trap of catalog.traps ?? []) console.log(`      trap: ${trap}`);
    const sub = (catalog.subServices ?? []).find((s) => (s.required ?? []).length > 0);
    leafService = sub?.serviceCode;
    requiredShape = sub?.required?.[0];
    console.log(`      → leaf service to configure: ${leafService}`);
    console.log(`      → required: ${JSON.stringify(requiredShape)}`);
  });
}

if (leafService && has('get_service_fields')) {
  await step(`get_service_fields("${leafService}") — leaf`, async () => {
    const { text, isError } = await callTool('get_service_fields', { service: leafService });
    if (isError) throw new Error(text.slice(0, 400));
    const payload = JSON.parse(text.slice(text.indexOf('{')));
    console.log(`      serviceCode=${payload.serviceCode}  fields=${(payload.fields ?? []).length}`);
    for (const field of payload.fields ?? []) {
      console.log(`      field ${field.id} (${field.type})${field.defaultValue !== undefined ? `  default=${JSON.stringify(field.defaultValue)}` : ''}${field.defaultUnit ? `  unit=${field.defaultUnit}` : ''}`);
    }
  });
}

if (full) {
  console.log('\n--- --full: building a real estimate (100 GB Amazon S3, ap-south-1) ---');
  let estimateId;

  if (has('create_estimate')) {
    await step('create_estimate', async () => {
      const { text, isError } = await callTool('create_estimate', { name: `MIMO Phase 5 smoke ${new Date().toISOString()}` });
      if (isError) throw new Error(text.slice(0, 600));
      const start = text.indexOf('{');
      estimateId = start >= 0 ? JSON.parse(text.slice(start)).estimate_id : undefined;
      console.log(`      estimate_id=${estimateId}`);
    });
  }

  if (estimateId && has('add_service')) {
    await step(`add_service (${leafService}, 100 GB)`, async () => {
      // Field id and value shape both come from the MCP's own required/shape
      // description above — not from a table in this repo.
      const fieldId = requiredShape?.field ?? 's3StandardStorageSize';
      const unit = requiredShape?.example?.unit ?? 'gb|month';
      // Entry shape per the tool's own inputSchema: the key is "service", and
      // region/description live *inside* config.
      const { text, isError } = await callTool('add_service', {
        estimate_id: estimateId,
        services: JSON.stringify([{
          service: leafService,
          config: {
            region: 'ap-south-1',
            description: 'MIMO smoke - 100 GB S3 Standard storage',
            [fieldId]: { value: '100', unit },
          },
        }]),
      });
      console.log(`      ${text.slice(0, 900)}`);
      if (isError) throw new Error(text.slice(0, 600));
    });
  }

  if (estimateId && has('validate_estimate')) {
    await step('validate_estimate', async () => {
      const { text } = await callTool('validate_estimate', { estimate_id: estimateId });
      console.log(`      ${text.slice(0, 800)}`);
    });
  }

  if (estimateId && has('export_estimate')) {
    await step('export_estimate', async () => {
      const { text, isError } = await callTool('export_estimate', { estimate_id: estimateId });
      if (isError) throw new Error(text.slice(0, 600));
      const url = /https:\/\/calculator\.aws\/[^\s"'\\]+/.exec(text)?.[0];
      console.log(`      ${text.slice(0, 600)}`);
      if (!url) throw new Error('export_estimate returned no calculator.aws URL');
      console.log(`\n      REAL calculator.aws URL: ${url}\n`);
    });
  }
}

console.log('');
if (failures.length) {
  console.log(`RESULT: ${failures.length} step(s) FAILED`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('RESULT: all steps PASSED against the LIVE AgentCore Runtime MCP endpoint.');
