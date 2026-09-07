import { spawn } from 'node:child_process';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { decodeRpc, toolJson } from './gateway-session-client.mjs';
const runtimeDir = new URL('../lambdas/calculator-mcp-sidecar-agentcore/', import.meta.url);
let releaseSave; let saveStarted;
const entered = new Promise(resolve => { saveStarted = resolve; });
const release = new Promise(resolve => { releaseSave = resolve; });
const saveServer = http.createServer(async (req, res) => {
  req.resume(); saveStarted(); await release;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ body: JSON.stringify({ savedKey: 'a'.repeat(40) }) }));
});
await new Promise(resolve => saveServer.listen(0, '127.0.0.1', resolve));
const adapter = process.argv.includes('--adapter');
const entry = adapter ? 'http-server.mjs' : 'node_modules/sample-aws-pricing-calculator-mcp/dist/mcp-server.js';
const child = spawn(process.execPath, [entry], {
  cwd: runtimeDir,
  env: { ...process.env, MCP_TRANSPORT: 'http', PORT: '18108', HOST: '127.0.0.1', ESTIMATES_STORE: 'memory', TRACE: 'on', AWS_SAVE_URL: `http://127.0.0.1:${saveServer.address().port}/save` },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.on('data', chunk => { stderr += chunk; });
let id = 1;
async function rpc(method, params) {
  const requestId = id++;
  const response = await fetch('http://127.0.0.1:18108/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }), signal: AbortSignal.timeout(30000) });
  const text = await response.text();
  return { text, id: requestId, status: response.status };
}
async function tool(name, args) { const r = await rpc('tools/call', {name, arguments: args}); return toolJson(decodeRpc(r.text, r.id, false)); }
try {
  for (let i = 0; i < 50 && !stderr.includes('listening') && !stderr.includes('mcp_http_ready'); i++) await delay(100);
  await rpc('initialize', {protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'mimo-concurrency-repro',version:'1'}});
  const created = await tool('create_estimate', {name:'Local transport regression'});
  await tool('add_service', {estimate_id:created.estimate_id, services:JSON.stringify([{service:'amazonS3Standard',config:{region:'ap-south-1',s3StandardStorageSize:{value:'100',unit:'gb|month'}}}])});
  const exportPromise = rpc('tools/call', {name:'export_estimate',arguments:{estimate_id:created.estimate_id}});
  await Promise.race([entered, delay(20000).then(()=>{throw Error('Export never reached mocked save endpoint')})]);
  await rpc('tools/call', {name:'get_server_info',arguments:{}});
  if (adapter) releaseSave();
  const result = await exportPromise;
  console.log(JSON.stringify({ exportHttpStatus: result.status, exportBody: result.text, interruptedByConcurrentRequest: result.text.length === 0 }));
  if (adapter) {
    const decoded = decodeRpc(result.text, result.id, false);
    const exported = toolJson(decoded);
    if (exported.aws_estimate_id !== 'a'.repeat(40)) throw Error('Adapter did not preserve the export id');
    if (exported.sharable_url !== `https://calculator.aws/#/estimate?id=${'a'.repeat(40)}`) throw Error('Adapter did not preserve the export URL');
  } else if (result.text.length !== 0) throw Error('Expected the upstream shared-transport failure');
} finally {
  releaseSave(); child.kill(); saveServer.closeAllConnections(); saveServer.close();
}
