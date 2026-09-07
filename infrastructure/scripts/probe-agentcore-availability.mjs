/**
 * Phase 0 / Phase 7 probe: does this AWS account + region actually expose the
 * AgentCore control-plane resources the calculator migration targets?
 *
 * Read-only. Creates nothing. Run it before assuming the target architecture is
 * reachable, and paste its output verbatim into the migration checklist — the
 * distinction between "Bedrock Agents Classic is in maintenance mode" and
 * "AgentCore is unavailable" is exactly what this proves.
 *
 *   node scripts/probe-agentcore-availability.mjs ap-south-1
 */
import {
  BedrockAgentCoreControlClient,
  ListHarnessesCommand,
  ListGatewaysCommand,
  ListAgentRuntimesCommand,
  ListMemoriesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';

const region = process.argv[2] || 'ap-south-1';

const sts = new STSClient({ region });
const who = await sts.send(new GetCallerIdentityCommand({}));
console.log(`principal : ${who.Arn}`);
console.log(`account   : ${who.Account}`);
console.log(`region    : ${region}`);
console.log('');

const client = new BedrockAgentCoreControlClient({ region });

const probes = [
  ['ListHarnesses', new ListHarnessesCommand({}), 'harnesses'],
  ['ListGateways', new ListGatewaysCommand({}), 'items'],
  ['ListAgentRuntimes', new ListAgentRuntimesCommand({}), 'agentRuntimes'],
  ['ListMemories', new ListMemoriesCommand({}), 'memories'],
];

let anyDenied = false;
for (const [label, command, listKey] of probes) {
  try {
    const response = await client.send(command);
    const list = response[listKey] ?? [];
    const names = list.map(
      (x) => x.harnessName || x.name || x.agentRuntimeName || x.id || x.harnessId || x.gatewayId || '?',
    );
    console.log(`${label.padEnd(20)} AVAILABLE  (${list.length} existing: ${names.join(', ') || 'none'})`);
  } catch (error) {
    anyDenied = true;
    console.log(
      `${label.padEnd(20)} ${error.name} http=${error.$metadata?.httpStatusCode ?? '?'} :: ${error.message}`,
    );
  }
}

console.log('');
console.log(anyDenied
  ? 'At least one AgentCore API was refused — record the exact error above in the checklist before changing architecture.'
  : 'All probed AgentCore control-plane APIs are reachable from this principal.');
