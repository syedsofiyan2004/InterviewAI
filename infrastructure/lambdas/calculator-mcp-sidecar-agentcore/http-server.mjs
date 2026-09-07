/**
 * AgentCore's stateless HTTP boundary for the upstream Calculator MCP.
 *
 * Upstream 1.3.0's HTTP entrypoint reuses one McpServer and closes its previous
 * transport on every POST. A concurrent health/read request can therefore end
 * an in-flight export with HTTP 200 and no JSON-RPC body. Keep the upstream on
 * its normal stdio transport and give each HTTP request its own SDK Server.
 * Tool schemas/results are discovered and forwarded unchanged; no Calculator
 * service mapping, field compilation, agent loop, or alternate auth path lives here.
 */
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function createHttpApp(upstream, { toolTimeoutMs = 60000, log = record => console.log(JSON.stringify(record)) } = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.post('/mcp', async (req, res) => {
    const started = performance.now();
    const record = {
      event: 'mcp_http_request', method: req.body?.method, rpcId: req.body?.id,
      tool: req.body?.params?.name, sessionId: req.get('mcp-session-id') ?? null,
    };
    // A separate server/transport per request is essential: probes and tool calls
    // can overlap in the same microVM even when the caller uses tools sequentially.
    const server = new Server(upstream.getServerVersion() ?? { name: 'calculator-mcp', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: upstream.getInstructions() });
    server.setRequestHandler(ListToolsRequestSchema, (request, extra) =>
      upstream.listTools(request.params, { signal: extra.signal, timeout: toolTimeoutMs }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        return await upstream.callTool(request.params, undefined, { signal: extra.signal, timeout: toolTimeoutMs });
      } catch (error) {
        // Surface a real tool error, not an empty successful HTTP response. An
        // interrupted append may have completed, so never replay it automatically.
        return { isError: true, content: [{ type: 'text', text: `MCP tool request failed: ${error.message}. A mutating operation may have completed. Do not repeat add_service on the same estimate after an uncertain outcome; use a fresh estimate if rebuilding is necessary.` }] };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.once('close', () => {
      void server.close().catch(error => log({ event: 'mcp_http_close_error', message: error.message }));
      log({ ...record, status: res.statusCode, completed: res.writableFinished, latencyMs: Math.round(performance.now() - started) });
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      log({ ...record, event: 'mcp_http_error', message: error.message });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: req.body?.id ?? null, error: { code: -32603, message: 'MCP request failed' } });
      else if (!res.writableEnded) res.end();
    }
  });
  app.get('/mcp', (_req, res) => res.status(405).end('Method Not Allowed'));
  app.delete('/mcp', (_req, res) => res.status(405).end('Method Not Allowed'));
  return app;
}

export async function start() {
  const toolTimeoutMs = Number(process.env.MCP_TOOL_TIMEOUT_MS ?? 60000);
  if (!Number.isFinite(toolTimeoutMs) || toolTimeoutMs < 1000 || toolTimeoutMs > 300000) throw new Error('MCP_TOOL_TIMEOUT_MS must be between 1000 and 300000');
  const upstream = new Client({ name: 'mimo-runtime-http', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('./node_modules/sample-aws-pricing-calculator-mcp/dist/mcp-server.js', import.meta.url))],
    // The same official MCP server and DynamoDB store, using its primary transport.
    env: { ...process.env, MCP_TRANSPORT: 'stdio' }, stderr: 'inherit',
  });
  await upstream.connect(transport);
  const app = createHttpApp(upstream, { toolTimeoutMs });
  const listener = app.listen(Number(process.env.PORT ?? 8000), process.env.HOST ?? '0.0.0.0', () => console.log(JSON.stringify({ event: 'mcp_http_ready', upstream: upstream.getServerVersion() })));
  const shutdown = () => {
    listener.close();
    void upstream.close().finally(() => process.exit(0));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch(error => { console.error(error); process.exitCode = 1; });
}
