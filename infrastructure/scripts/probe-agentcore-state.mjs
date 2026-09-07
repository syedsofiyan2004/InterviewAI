/**
 * Phase 0 / Phase 5 / Phase 6 probe: what is the LIVE state of the already-deployed
 * calculator AgentCore resources?
 *
 * Read-only. Prints the Runtime status + its MCP endpoint URL, and every Gateway
 * target with the target type it actually points at — which is how Phase 6
 * ("Gateway must target the Runtime MCP, not a Lambda") gets proven rather than
 * assumed from CDK source.
 *
 *   node scripts/probe-agentcore-state.mjs ap-south-1
 */
import {
  BedrockAgentCoreControlClient,
  ListAgentRuntimesCommand,
  GetAgentRuntimeCommand,
  ListAgentRuntimeEndpointsCommand,
  ListGatewaysCommand,
  GetGatewayCommand,
  ListGatewayTargetsCommand,
  GetGatewayTargetCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';

const region = process.argv[2] || 'ap-south-1';
const client = new BedrockAgentCoreControlClient({ region });

const show = (label, value) => console.log(`  ${label.padEnd(24)} ${value ?? '—'}`);

console.log(`=== AgentCore Runtimes (${region}) ===`);
const runtimes = (await client.send(new ListAgentRuntimesCommand({}))).agentRuntimes ?? [];
for (const summary of runtimes) {
  const runtime = (await client.send(new GetAgentRuntimeCommand({ agentRuntimeId: summary.agentRuntimeId })));
  console.log(`\n${runtime.agentRuntimeName} (${runtime.agentRuntimeId})`);
  show('status', runtime.status);
  show('arn', runtime.agentRuntimeArn);
  show('version', runtime.agentRuntimeVersion);
  show('protocol', JSON.stringify(runtime.protocolConfiguration ?? null));
  show('network', JSON.stringify(runtime.networkConfiguration ?? null));
  show('container', runtime.agentRuntimeArtifact?.containerConfiguration?.containerUri);
  show('env', JSON.stringify(runtime.environmentVariables ?? {}));
  if (runtime.status !== 'READY') show('statusReason', JSON.stringify(runtime.failureReason ?? runtime.statusReason ?? null));

  const endpoints = (await client.send(new ListAgentRuntimeEndpointsCommand({ agentRuntimeId: summary.agentRuntimeId }))).runtimeEndpoints ?? [];
  for (const endpoint of endpoints) {
    console.log(`  endpoint: ${endpoint.name}  status=${endpoint.status}  target=${endpoint.targetVersion}`);
    show('  endpoint arn', endpoint.agentRuntimeEndpointArn);
    if (endpoint.failureReason) show('  failureReason', endpoint.failureReason);
  }
}

console.log(`\n=== AgentCore Gateways (${region}) ===`);
const gateways = (await client.send(new ListGatewaysCommand({}))).items ?? [];
for (const summary of gateways) {
  const gateway = await client.send(new GetGatewayCommand({ gatewayIdentifier: summary.gatewayId }));
  console.log(`\n${gateway.name} (${gateway.gatewayId})`);
  show('status', gateway.status);
  show('statusReasons', JSON.stringify(gateway.statusReasons ?? []));
  show('gatewayUrl', gateway.gatewayUrl);
  show('protocolType', gateway.protocolType);
  show('authorizerType', gateway.authorizerType);
  show('roleArn', gateway.roleArn);

  const targets = (await client.send(new ListGatewayTargetsCommand({ gatewayIdentifier: summary.gatewayId }))).items ?? [];
  for (const targetSummary of targets) {
    const target = await client.send(new GetGatewayTargetCommand({
      gatewayIdentifier: summary.gatewayId,
      targetId: targetSummary.targetId,
    }));
    const mcp = target.targetConfiguration?.mcp ?? {};
    const kind = Object.keys(mcp)[0] ?? 'unknown';
    console.log(`  target: ${target.name} (${target.targetId})  status=${target.status}  kind=${kind}`);
    show('  statusReasons', JSON.stringify(target.statusReasons ?? []));
    if (kind === 'lambda') show('  lambdaArn', mcp.lambda?.lambdaArn);
    if (kind === 'mcpServer') show('  endpoint', mcp.mcpServer?.endpoint);
    const toolCount = mcp.lambda?.toolSchema?.inlinePayload?.length;
    if (toolCount !== undefined) show('  inline tool count', toolCount);
  }
}
