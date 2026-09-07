/**
 * Dev-only Gateway/Runtime comparison. No retries; 50 cheap sequential calls per
 * connection by default, then (only after a clean soak) five fresh S3 estimates.
 * node scripts/live-gateway-session-soak.mjs --output=.scratch-defs/sessions-after.json
 * Baseline: --allow-no-session --estimates=0 --output=.scratch-defs/sessions-before.json
 * Version comparison: --protocol=2025-06-18 --estimates=0
 */
import fs from 'node:fs';
import path from 'node:path';
import { discoverDev, createClient, toolJson, toolText } from './gateway-session-client.mjs';
const option = (key, fallback) => process.argv.find(a => a.startsWith(`--${key}=`))?.split('=').slice(1).join('=') ?? fallback;
const count = Number(option('calls', '50'));
const estimateCount = Number(option('estimates', '5'));
const timeoutMs = Number(option('timeout-ms', '60000'));
if (!Number.isInteger(count) || count < 0 || !Number.isInteger(estimateCount) || estimateCount < 0 || timeoutMs < 1000 || timeoutMs > 60000) throw new Error('Invalid diagnostic bounds');
const estimatePath = option('estimate-path', 'gateway');
const output = option('output', '.scratch-defs/gateway-session-soak.json');
const deployed = await discoverDev();
const protocol = option('protocol', '2025-03-26');
const requireSession = !process.argv.includes('--allow-no-session');
const kinds = option('paths', 'runtime,gateway').split(',');
if (kinds.some(k => !['runtime', 'gateway'].includes(k))) throw new Error('Invalid paths');
const report = { startedAt: new Date().toISOString(), protocol, count, estimateCount, timeoutMs, deployed, calls: [], estimates: [], summaries: {} };
fs.mkdirSync(path.dirname(output), { recursive: true });
const save = () => fs.writeFileSync(output, JSON.stringify(report, null, 2));
save();
console.log(JSON.stringify({ gatewayId: deployed.gateway.gatewayId, protocolConfiguration: deployed.gateway.protocolConfiguration ?? null, gatewayStatus: deployed.gateway.status, targets: deployed.targets.map(t => ({ name: t.name, status: t.status })), runtimeStatus: deployed.runtime.status, harnessStatus: deployed.harness?.status }, null, 2));
const onCall = record => {
  report.calls.push(record); save();
  console.log(`${record.kind.padEnd(7)} ${record.phase.padEnd(10)} #${record.call} ${record.tool ?? record.method} ${record.success ? 'OK' : record.timeout ? 'TIMEOUT' : 'ERROR'} ${record.latencyMs}ms${record.error ? ` ${record.error.slice(0, 220)}` : ''}`);
};
const clients = {};
function summary(kind) {
  const rows = report.calls.filter(r => r.kind === kind && r.phase === 'diagnostic');
  const times = rows.filter(r => r.success).map(r => r.latencyMs).sort((a, b) => a - b);
  const percentile = p => times.length ? times[Math.max(0, Math.ceil(times.length * p) - 1)] : null;
  return { success: rows.filter(r => r.success).length, failure: rows.filter(r => !r.success).length, timeout: rows.filter(r => r.timeout).length, p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: times.at(-1) ?? null, maxAll: Math.max(0, ...rows.map(r => r.latencyMs)) };
}
async function soak(kind) {
  try {
    const client = await createClient(kind, deployed, { protocol, timeoutMs, onCall });
    clients[kind] = client;
    await client.initialize({ requireSession: kind === 'runtime' || requireSession });
    const plan = [['get_server_info', {}], ['search_services', { query: 'S3' }], ['get_service_fields', { service: 'amazonS3Standard' }]];
    for (let i = 0; i < count; i++) {
      const [tool, args] = plan[i % plan.length];
      try { await client.call(tool, args); } catch { /* record every failure; do not reset session or retry */ }
    }
  } catch (error) {
    report[`${kind}SetupError`] = error.message;
    console.error(`${kind}: ${error.message}`);
  } finally {
    report.summaries[kind] = summary(kind); save();
  }
}
// Independent clients; calls within each connection are strictly sequential.
await Promise.all(kinds.map(soak));
console.table(report.summaries);
const healthy = kinds.every(kind => !report[`${kind}SetupError`] && report.summaries[kind].success === count && report.summaries[kind].failure === 0);
if (estimateCount && healthy && clients[estimatePath]) {
  const gateway = clients[estimatePath];
  for (let i = 0; i < estimateCount; i++) {
    const start = Date.now();
    const run = { run: i + 1, startedAt: new Date(start).toISOString(), sessionId: gateway.sessionId };
    report.estimates.push(run);
    try {
      const fields = toolJson(await gateway.call('get_service_fields', { service: 'amazonS3Standard' }, `estimate-${i + 1}`));
      const storage = fields.fields?.find(f => f.id === 's3StandardStorageSize');
      if (!storage) throw new Error('S3 storage field absent from discovered schema');
      const created = toolJson(await gateway.call('create_estimate', { name: `MIMO session acceptance ${i + 1} ${new Date().toISOString()}` }, `estimate-${i + 1}`));
      run.estimateId = created.estimate_id;
      if (!run.estimateId) throw new Error('create_estimate returned no ID');
      // Exactly one append per fresh estimate. Never retry an ambiguous mutation.
      run.add = toolJson(await gateway.call('add_service', {
        estimate_id: run.estimateId,
        services: JSON.stringify([{ service: 'amazonS3Standard', config: { region: 'ap-south-1', description: 'Session acceptance: 100 GB S3 Standard', [storage.id]: { value: '100', unit: storage.defaultUnit ?? 'gb|month' } } }]),
      }, `estimate-${i + 1}`));
      run.validation = toolJson(await gateway.call('validate_estimate', { estimate_id: run.estimateId }, `estimate-${i + 1}`));
      if (run.validation.valid === false || run.validation.status === 'invalid' || run.validation.errors?.length) throw new Error(`Validation failed: ${JSON.stringify(run.validation)}`);
      const exported = await gateway.call('export_estimate', { estimate_id: run.estimateId }, `estimate-${i + 1}`);
      run.export = toolJson(exported);
      run.url = /https:\/\/calculator\.aws\/[^\s"'\\]+/.exec(toolText(exported))?.[0];
      if (!run.url) throw new Error('No calculator.aws URL');
      run.success = true;
      console.log(`ESTIMATE ${i + 1}: ${run.estimateId} ${run.url}`);
    } catch (error) { run.success = false; run.error = error.message; }
    finally { run.elapsedMs = Date.now() - start; save(); }
  }
}
report.finishedAt = new Date().toISOString();
report.passed = healthy && report.estimates.filter(e => e.success).length === estimateCount;
save();
console.log(`RESULT ${report.passed ? 'PASS' : 'FAIL'}; evidence: ${output}`);
if (!report.passed) process.exitCode = 1;
