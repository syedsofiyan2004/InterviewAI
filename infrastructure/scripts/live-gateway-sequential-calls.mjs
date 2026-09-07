import { discoverDev, createClient } from './gateway-session-client.mjs';
const region = process.argv[2] || 'ap-south-1';
const timeoutMs = Number(process.argv[3]) || 60000;
const deployed = await discoverDev(region);
const client = await createClient('gateway', deployed, { timeoutMs, protocol: process.env.MCP_PROTOCOL_VERSION || '2025-03-26', onCall: r => console.log(`${r.method} ${r.tool ?? ''} ${r.success ? 'OK' : 'FAIL'} ${r.latencyMs}ms`) });
await client.initialize({ requireSession: !process.argv.includes('--allow-no-session') });
// Session stability is asserted on every reply, including tools/list.
for (let i = 0; i < 3; i++) {
  await client.call('get_server_info', {});
  await client.call('search_services', { query: 'S3' });
  await client.call('get_service_fields', { service: 'amazonS3Standard' });
}
console.log(`PASS: nine sequential calls reused session ${client.sessionId}. Run live-gateway-session-soak.mjs for acceptance.`);
