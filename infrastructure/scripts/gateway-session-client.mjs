import { SignatureV4 } from '@smithy/signature-v4';
import { Sha256 } from '@aws-crypto/sha256-js';
import { HttpRequest } from '@smithy/protocol-http';
import credentialProviderNode from '@aws-sdk/credential-provider-node';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { BedrockAgentCoreControlClient, ListGatewaysCommand, GetGatewayCommand, ListGatewayTargetsCommand, GetGatewayTargetCommand, GetAgentRuntimeCommand, ListHarnessesCommand, GetHarnessCommand } from '@aws-sdk/client-bedrock-agentcore-control';

export const toolText = result => (result?.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
export function toolJson(result) {
  if (result?.structuredContent) return result.structuredContent;
  const text = toolText(result);
  // Some tools wrap their JSON in prose and append a 'Next step' instruction.
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0; let quoted = false; let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (quoted && ch === '\\') { escaped = true; continue; }
      if (ch === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (ch === '{') depth++;
      if (ch === '}' && --depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
      }
    }
  }
  throw new Error(`No JSON tool payload: ${text.slice(0, 300)}`);
}
export async function discoverDev(region = 'ap-south-1') {
  if (region !== 'ap-south-1') throw new Error('This diagnostic is restricted to ap-south-1 dev');
  const control = new BedrockAgentCoreControlClient({ region, maxAttempts: 1 });
  const summary = (await control.send(new ListGatewaysCommand({}))).items?.find(g => g.name === 'iep-dev-calculator-996122083346-ap-south-1');
  if (!summary) throw new Error('Exact dev Gateway not found');
  const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: summary.gatewayId }));
  const targets = (await control.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gateway.gatewayId }))).items;
  const target = targets.find(t => t.name === 'calcmcp');
  if (!target) throw new Error('calcmcp target absent');
  const detail = await control.send(new GetGatewayTargetCommand({ gatewayIdentifier: gateway.gatewayId, targetId: target.targetId }));
  const endpoint = detail.targetConfiguration.mcp.mcpServer.endpoint;
  const arn = decodeURIComponent(new URL(endpoint).pathname.split('/runtimes/')[1].split('/invocations')[0]);
  if (!arn.startsWith('arn:aws:bedrock-agentcore:ap-south-1:996122083346:runtime/mimoCalcMcp_dev-')) throw new Error('Unexpected target Runtime');
  const runtime = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: arn.split('/').pop() }));
  const harnessSummary = (await control.send(new ListHarnessesCommand({}))).harnesses?.find(h => h.harnessName === 'mimoCalc_dev');
  const harness = harnessSummary ? (await control.send(new GetHarnessCommand({ harnessId: harnessSummary.harnessId }))).harness : null;
  return { gateway, targets, target: detail, runtime, harness, region };
}
export function decodeRpc(text, id, notification) {
  if (!text.trim() && notification) return {};
  const candidates = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  if (!candidates.length) candidates.push(text);
  for (const candidate of candidates) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (parsed.id !== id && !notification) continue;
    if (parsed.error) throw Object.assign(new Error(`MCP ${parsed.error.code}: ${parsed.error.message}`), { mcpError: parsed.error });
    return parsed.result ?? {};
  }
  if (notification) return {};
  throw new Error(`Missing matching JSON-RPC response ${id}: ${text.slice(0, 300)}`);
}
export async function createClient(kind, deployed, { protocol = '2025-03-26', timeoutMs = 60000, onCall = () => {} } = {}) {
  const data = new BedrockAgentCoreClient({ region: deployed.region, maxAttempts: 1 });
  const signer = new SignatureV4({ service: 'bedrock-agentcore', region: deployed.region, credentials: credentialProviderNode.defaultProvider(), sha256: Sha256 });
  let sessionId;
  let nextId = 1;
  let negotiated = protocol;
  let calls = 0;
  const client = {
    kind,
    get sessionId() { return sessionId; },
    get protocol() { return negotiated; },
    async rpc(method, params, { notification = false, phase = 'setup' } = {}) {
      const id = notification ? undefined : nextId++;
      const body = JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params });
      const started = Date.now();
      const record = { kind, phase, call: ++calls, timestamp: new Date(started).toISOString(), method, tool: params?.name, sessionId: sessionId ?? null, protocol: negotiated };
      const controller = new AbortController();
      let timer;
      const expiry = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error(`Timeout after ${timeoutMs}ms`), { name: 'TimeoutError' }));
        }, timeoutMs);
      });
      try {
        const work = async () => {
          let text; let returnedSession;
          if (kind === 'gateway') {
            const url = new URL(deployed.gateway.gatewayUrl);
            const headers = { host: url.hostname, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': negotiated, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) };
            const signed = await signer.sign(new HttpRequest({ method: 'POST', protocol: url.protocol, hostname: url.hostname, path: url.pathname, headers, body }));
            const response = await fetch(url, { method: 'POST', headers: signed.headers, body, signal: controller.signal });
            record.httpStatus = response.status;
            record.requestId = response.headers.get('x-amzn-requestid') ?? response.headers.get('x-amz-request-id');
            record.traceId = response.headers.get('x-amzn-trace-id');
            returnedSession = response.headers.get('mcp-session-id');
            text = await response.text();
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 1000)}`);
          } else {
            const response = await data.send(new InvokeAgentRuntimeCommand({
              agentRuntimeArn: deployed.runtime.agentRuntimeArn, qualifier: 'DEFAULT',
              contentType: 'application/json', accept: 'application/json, text/event-stream',
              // The SDK auto-generates runtimeSessionId when omitted; retain it too.
              runtimeSessionId: sessionId, mcpSessionId: sessionId, mcpProtocolVersion: negotiated, mcpMethod: method,
              ...(params?.name ? { mcpName: params.name } : {}), payload: Buffer.from(body),
            }), { abortSignal: controller.signal });
            record.httpStatus = response.statusCode ?? response.$metadata?.httpStatusCode;
            record.requestId = response.$metadata?.requestId;
            record.runtimeSessionId = response.runtimeSessionId;
            returnedSession = response.mcpSessionId;
            const chunks = [];
            for await (const chunk of response.response) chunks.push(Buffer.from(chunk));
            text = Buffer.concat(chunks).toString('utf8');
            if (record.httpStatus >= 400) throw new Error(`HTTP ${record.httpStatus}: ${text.slice(0, 1000)}`);
          }
          controller.signal.throwIfAborted();
          if (sessionId && returnedSession && returnedSession !== sessionId) throw new Error(`Session unexpectedly changed from ${sessionId} to ${returnedSession}`);
          if (returnedSession) sessionId = returnedSession;
          record.sessionId = sessionId ?? null;
          record.responseSessionId = returnedSession ?? null;
          const result = decodeRpc(text, id, notification);
          if (result.isError) throw new Error(`Tool error: ${toolText(result).slice(0, 1000)}`);
          if (method === 'initialize') negotiated = result.protocolVersion ?? negotiated;
          return result;
        };
        const result = await Promise.race([work(), expiry]);
        record.success = true;
        return result;
      } catch (error) {
        record.success = false;
        record.timeout = controller.signal.aborted || ['AbortError', 'TimeoutError'].includes(error.name);
        record.error = error.message;
        record.mcpError = error.mcpError;
        throw error;
      } finally {
        clearTimeout(timer);
        record.latencyMs = Date.now() - started;
        onCall(record);
      }
    },
    async initialize({ requireSession = true } = {}) {
      const init = await client.rpc('initialize', { protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'mimo-session-diagnostic', version: '1.0.0' } });
      console.log(`${kind} initialize: Mcp-Session-Id=${sessionId ?? '(none)'} protocol=${negotiated}`);
      if (requireSession && !sessionId) throw new Error(`${kind}: initialize did not return Mcp-Session-Id`);
      await client.rpc('notifications/initialized', {}, { notification: true });
      client.tools = [];
      let cursor;
      do {
        const page = await client.rpc('tools/list', cursor ? { cursor } : {});
        client.tools.push(...(page.tools ?? []));
        cursor = page.nextCursor;
      } while (cursor);
      return init;
    },
    async call(bareName, args, phase = 'diagnostic') {
      const tool = client.tools.find(t => t.name.split('___').pop() === bareName);
      if (!tool) throw new Error(`Tool not advertised: ${bareName}`);
      return client.rpc('tools/call', { name: tool.name, arguments: args }, { phase });
    },
  };
  return client;
}
