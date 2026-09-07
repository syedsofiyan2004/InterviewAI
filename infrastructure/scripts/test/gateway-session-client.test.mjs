import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRpc, createClient } from '../gateway-session-client.mjs';

test('SSE decoding skips notifications and matches the requested RPC ID', () => {
  assert.deepEqual(decodeRpc('data: {"method":"notifications/progress"}\n\ndata: {"id":7,"result":{"ok":true}}\n', 7, false), { ok: true });
  assert.throws(() => decodeRpc('{"id":8,"result":{}}', 7, false), /Missing matching/);
  assert.throws(() => decodeRpc('{"id":7,"error":{"code":-1,"message":"bad"}}', 7, false), /MCP -1/);
});

test('deadline includes response-body consumption and logs a timeout', async () => {
  const oldFetch = globalThis.fetch;
  const oldAccess = process.env.AWS_ACCESS_KEY_ID;
  const oldSecret = process.env.AWS_SECRET_ACCESS_KEY;
  process.env.AWS_ACCESS_KEY_ID = 'diagnostic-test';
  process.env.AWS_SECRET_ACCESS_KEY = 'diagnostic-test';
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), text: () => new Promise(() => {}) });
  const records = [];
  try {
    const client = await createClient('gateway', { region: 'ap-south-1', gateway: { gatewayUrl: 'https://example.invalid/mcp' } }, { timeoutMs: 100, onCall: r => records.push(r) });
    await assert.rejects(client.rpc('tools/list', {}), /Timeout/);
    assert.equal(records.length, 1);
    assert.equal(records[0].timeout, true);
    assert.equal(records[0].success, false);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldAccess === undefined) delete process.env.AWS_ACCESS_KEY_ID; else process.env.AWS_ACCESS_KEY_ID = oldAccess;
    if (oldSecret === undefined) delete process.env.AWS_SECRET_ACCESS_KEY; else process.env.AWS_SECRET_ACCESS_KEY = oldSecret;
  }
});
