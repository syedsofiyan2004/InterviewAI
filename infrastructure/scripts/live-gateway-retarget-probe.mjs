/**
 * Phase 6 probe: can the AgentCore Gateway target the AgentCore Runtime MCP
 * endpoint (targetConfiguration.mcp.mcpServer) instead of the legacy sidecar
 * Lambda?
 *
 * Additive and reversible: it creates a *second* target on the existing Gateway
 * and leaves the legacy Lambda target untouched, so nothing that works today
 * stops working. Pass --delete to remove the probe target again.
 *
 * The point is to learn the accepted `endpoint` URL form and the required
 * credentialProviderConfigurations before those are frozen into CDK — guessing
 * them in CloudFormation costs a full deploy per attempt.
 *
 *   node scripts/live-gateway-retarget-probe.mjs ap-south-1
 *   node scripts/live-gateway-retarget-probe.mjs ap-south-1 --delete
 */
import {
  BedrockAgentCoreControlClient,
  ListGatewaysCommand,
  ListGatewayTargetsCommand,
  GetGatewayTargetCommand,
  CreateGatewayTargetCommand,
  DeleteGatewayTargetCommand,
  ListAgentRuntimesCommand,
  GetAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const region = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'ap-south-1';
const doDelete = process.argv.includes('--delete');
const PROBE_TARGET_NAME = 'mimo-probe-runtime-mcp';

const client = new BedrockAgentCoreControlClient({ region });

const gateway = ((await client.send(new ListGatewaysCommand({}))).items ?? [])
  .find((g) => /calculator/i.test(g.name ?? ''));
if (!gateway) { console.error('No calculator Gateway found.'); process.exit(1); }
console.log(`gateway : ${gateway.name} (${gateway.gatewayId})`);

const runtimeSummary = ((await client.send(new ListAgentRuntimesCommand({}))).agentRuntimes ?? [])
  .find((r) => /calc/i.test(r.agentRuntimeName ?? ''));
const runtime = await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeSummary.agentRuntimeId }));
console.log(`runtime : ${runtime.agentRuntimeName}  protocol=${runtime.protocolConfiguration?.serverProtocol}`);

const existing = ((await client.send(new ListGatewayTargetsCommand({ gatewayIdentifier: gateway.gatewayId }))).items ?? []);
console.log(`targets : ${existing.map((t) => t.name).join(', ') || 'none'}`);

const probe = existing.find((t) => t.name === PROBE_TARGET_NAME);

if (doDelete) {
  if (!probe) { console.log('\nProbe target not present — nothing to delete.'); process.exit(0); }
  await client.send(new DeleteGatewayTargetCommand({ gatewayIdentifier: gateway.gatewayId, targetId: probe.targetId }));
  console.log(`\nDeleted probe target ${probe.targetId}.`);
  process.exit(0);
}

if (probe) {
  const detail = await client.send(new GetGatewayTargetCommand({ gatewayIdentifier: gateway.gatewayId, targetId: probe.targetId }));
  console.log(`\nProbe target already exists: status=${detail.status} reasons=${JSON.stringify(detail.statusReasons ?? [])}`);
  console.log(`endpoint: ${detail.targetConfiguration?.mcp?.mcpServer?.endpoint}`);
  process.exit(0);
}

/**
 * Candidate endpoint URL forms for an AgentCore Runtime MCP endpoint. Tried in
 * order; the first the control plane accepts is the one CDK should encode.
 */
const arn = runtime.agentRuntimeArn;
const candidates = [
  ['arn path, url-encoded, qualifier query',
    `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations?qualifier=DEFAULT`],
  ['arn path, url-encoded, no qualifier',
    `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${encodeURIComponent(arn)}/invocations`],
  ['raw arn path',
    `https://bedrock-agentcore.${region}.amazonaws.com/runtimes/${arn}/invocations?qualifier=DEFAULT`],
  ['bare runtime arn', arn],
];

for (const [label, endpoint] of candidates) {
  console.log(`\nTrying (${label}):\n  ${endpoint}`);
  try {
    const created = await client.send(new CreateGatewayTargetCommand({
      gatewayIdentifier: gateway.gatewayId,
      name: PROBE_TARGET_NAME,
      description: 'Phase 6 probe: Gateway → AgentCore Runtime MCP (delete me)',
      // mcpServer targets under IAM auth additionally require an explicit
      // iamCredentialProvider naming the service to SigV4-sign for — the Gateway
      // signs its calls to the Runtime as bedrock-agentcore.
      credentialProviderConfigurations: [{
        credentialProviderType: 'GATEWAY_IAM_ROLE',
        credentialProvider: {
          iamCredentialProvider: { service: 'bedrock-agentcore', region },
        },
      }],
      targetConfiguration: { mcp: { mcpServer: { endpoint } } },
    }));
    console.log(`  ACCEPTED  targetId=${created.targetId} status=${created.status}`);

    for (let attempt = 0; attempt < 24; attempt++) {
      await new Promise((r) => setTimeout(r, 5000));
      const detail = await client.send(new GetGatewayTargetCommand({ gatewayIdentifier: gateway.gatewayId, targetId: created.targetId }));
      process.stdout.write(`\r  waiting… status=${detail.status}   `);
      if (detail.status === 'READY') {
        console.log(`\n  READY. This is the endpoint form to encode in CDK:\n  ${endpoint}`);
        process.exit(0);
      }
      if (String(detail.status).includes('FAILED')) {
        console.log(`\n  ${detail.status}: ${JSON.stringify(detail.statusReasons ?? [])}`);
        await client.send(new DeleteGatewayTargetCommand({ gatewayIdentifier: gateway.gatewayId, targetId: created.targetId })).catch(() => {});
        break;
      }
    }
  } catch (error) {
    console.log(`  REJECTED  ${error.name}: ${error.message}`);
  }
}

console.log('\nNo candidate endpoint form was accepted — record the errors above in the checklist.');
process.exit(1);
