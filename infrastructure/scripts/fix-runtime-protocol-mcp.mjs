/**
 * Phase 4 repair probe: declare the calculator MCP Runtime's server protocol as MCP.
 *
 * Why this exists: the deployed Runtime was created without protocolConfiguration,
 * so AgentCore applied the *HTTP* service contract and probed `GET /ping`, which
 * sample-aws-pricing-calculator-mcp does not implement. The Runtime therefore
 * reported READY while every MCP call died with
 *   "Runtime health check failed or timed out"
 *
 * This script applies the same change that `protocolConfiguration: 'MCP'` in
 * calculator-agentcore.ts now makes permanent, so the hypothesis can be proven
 * against the live service without spending a full stack deploy on a guess.
 * It re-sends the Runtime's existing artifact and role unchanged — only the
 * protocol is added.
 *
 *   node scripts/fix-runtime-protocol-mcp.mjs ap-south-1
 */
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
  GetAgentRuntimeCommand,
  UpdateAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const region = process.argv[2] || 'ap-south-1';
const client = new BedrockAgentCoreControlClient({ region });

const runtimes = (await client.send(new ListAgentRuntimesCommand({}))).agentRuntimes ?? [];
const summary = runtimes.find((r) => /calc/i.test(r.agentRuntimeName ?? ''));
if (!summary) {
  console.error(`No calculator MCP Runtime in ${region}.`);
  process.exit(1);
}

const before = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: summary.agentRuntimeId }));
console.log(`runtime  : ${before.agentRuntimeName} (${before.agentRuntimeId})`);
console.log(`status   : ${before.status}`);
console.log(`protocol : ${JSON.stringify(before.protocolConfiguration ?? null)}`);

if (before.protocolConfiguration?.serverProtocol === 'MCP') {
  console.log('\nAlready declared MCP — nothing to do.');
  process.exit(0);
}

console.log('\nUpdating protocolConfiguration → { serverProtocol: "MCP" } …');
const updated = await client.send(new UpdateAgentRuntimeCommand({
  agentRuntimeId: before.agentRuntimeId,
  // Re-sent unchanged: UpdateAgentRuntime requires both, and omitting them would
  // replace the container image and execution role with nothing.
  agentRuntimeArtifact: before.agentRuntimeArtifact,
  roleArn: before.roleArn,
  networkConfiguration: before.networkConfiguration,
  environmentVariables: before.environmentVariables,
  description: before.description,
  protocolConfiguration: { serverProtocol: 'MCP' },
}));
console.log(`status   : ${updated.status}  version=${updated.agentRuntimeVersion}`);

// Creating a new Runtime version restarts the container; wait for READY before
// any caller tries to speak MCP to it.
for (let attempt = 0; attempt < 40; attempt++) {
  await new Promise((r) => setTimeout(r, 5000));
  const now = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: before.agentRuntimeId }));
  process.stdout.write(`\r  waiting… status=${now.status} protocol=${now.protocolConfiguration?.serverProtocol ?? 'null'}   `);
  if (now.status === 'READY') {
    console.log(`\nREADY. protocol=${JSON.stringify(now.protocolConfiguration)} version=${now.agentRuntimeVersion}`);
    process.exit(0);
  }
  if (String(now.status).includes('FAILED')) {
    console.log(`\nFAILED: ${JSON.stringify(now.failureReason ?? now.statusReason ?? null)}`);
    process.exit(1);
  }
}
console.log('\nTimed out waiting for READY.');
process.exit(1);
