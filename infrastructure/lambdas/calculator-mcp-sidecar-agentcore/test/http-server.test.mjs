import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpApp } from '../http-server.mjs';

const info = { name: 'fixture-mcp', version: '1.0.0' };
const request = (url, id, method, params) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-session-id': 'shared-runtime-session' },
  body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(5000),
}).then(async response => ({ status: response.status, body: await response.json() }));

async function serve(upstream, work) {
  const app = createHttpApp(upstream, { log: () => {} });
  const listener = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  try { await work(`http://127.0.0.1:${listener.address().port}/mcp`); }
  finally { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
}

test('an overlapping read/initialize cannot close a pending export response', async () => {
  let entered; let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const schema = { name: 'export_estimate', description: 'Discovered upstream tool', inputSchema: { type: 'object' } };
  const upstream = {
    getServerVersion: () => info, getInstructions: () => 'Upstream instructions',
    listTools: async () => ({ tools: [schema] }),
    callTool: async ({ name }) => {
      if (name === 'export_estimate') { entered(); await gate; }
      return { content: [{ type: 'text', text: name === 'export_estimate' ? 'saved' : 'info' }] };
    },
  };
  await serve(upstream, async url => {
    let finished = false;
    const pending = request(url, 1, 'tools/call', { name: 'export_estimate', arguments: {} }).then(result => { finished = true; return result; });
    await started;
    const read = await request(url, 2, 'tools/list', {});
    assert.deepEqual(read.body.result.tools, [schema]);
    const init = await request(url, 3, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
    assert.equal(init.body.result.serverInfo.name, info.name);
    assert.equal(finished, false, 'the export must remain open until its result exists');
    release();
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(result.body.id, 1);
    assert.equal(result.body.result.content[0].text, 'saved');
  });
});

test('upstream failure becomes an explicit MCP error and is not retried', async () => {
  let calls = 0;
  await serve({
    getServerVersion: () => info, getInstructions: () => undefined,
    listTools: async () => ({ tools: [] }),
    callTool: async () => { calls++; throw new Error('tool deadline exceeded'); },
  }, async url => {
    const result = await request(url, 8, 'tools/call', { name: 'add_service', arguments: {} });
    assert.equal(result.body.result.isError, true);
    assert.match(result.body.result.content[0].text, /Do not repeat add_service/);
    assert.equal(calls, 1);
  });
});
