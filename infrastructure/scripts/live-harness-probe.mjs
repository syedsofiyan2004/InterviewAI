/**
 * Phase 7 probe: validate the CreateHarness / CreateHarnessEndpoint / InvokeHarness
 * request shapes against the live service.
 *
 * Why probe instead of going straight to CloudFormation: aws-cdk-lib 2.250.0 has no
 * CfnHarness, so the Harness has to be provisioned by a Custom Resource. Guessing the
 * request shape inside a Custom Resource costs a full stack deploy and a rollback per
 * wrong guess — the Gateway retarget already burned one that way. This establishes
 * which fields are required, what the status transitions are, and whether an endpoint
 * must be created explicitly, before any of it is frozen into IaC.
 *
 * Creates a harness named MimoCalcProbe and, unless --keep is passed, deletes it again.
 *
 *   node scripts/live-harness-probe.mjs ap-south-1 [--keep] [--invoke]
 */
import {
  BedrockAgentCoreControlClient,
  CreateHarnessCommand,
  GetHarnessCommand,
  DeleteHarnessCommand,
  ListHarnessesCommand,
  ListHarnessEndpointsCommand,
  ListGatewaysCommand,
  GetGatewayCommand,
  ListAgentRuntimesCommand,
  GetAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';
import { IAMClient, GetRoleCommand } from '@aws-sdk/client-iam';

const region = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'ap-south-1';
const keep = process.argv.includes('--keep');
const doInvoke = process.argv.includes('--invoke');
const HARNESS_NAME = 'MimoCalcProbe';

const control = new BedrockAgentCoreControlClient({ region });
const data = new BedrockAgentCoreClient({ region });
const iam = new IAMClient({ region });

// ─── prerequisites ────────────────────────────────────────────────────────────

const gatewaySummary = ((await control.send(new ListGatewaysCommand({}))).items ?? [])
  .find((g) => /calculator/i.test(g.name ?? ''));
const gateway = await control.send(new GetGatewayCommand({ gatewayIdentifier: gatewaySummary.gatewayId }));
console.log(`gateway arn : ${gateway.gatewayArn}`);

const runtimeSummary = ((await control.send(new ListAgentRuntimesCommand({}))).agentRuntimes ?? [])
  .find((r) => /calc/i.test(r.agentRuntimeName ?? ''));
const runtime = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeSummary.agentRuntimeId }));

// Reuse the Runtime's execution role for the probe: its trust policy already names
// bedrock-agentcore.amazonaws.com, which is what a Harness needs to assume. It lacks
// Bedrock model and Gateway permissions, so a probe INVOKE may well be refused — that
// is fine and informative. The real harness gets its own least-privilege role in CDK.
const role = await iam.send(new GetRoleCommand({ RoleName: runtime.roleArn.split('/').pop() }));
console.log(`probe role  : ${role.Role.Arn}`);
console.log('');

// ─── clean any previous probe ─────────────────────────────────────────────────

const existing = ((await control.send(new ListHarnessesCommand({}))).harnesses ?? [])
  .find((h) => h.harnessName === HARNESS_NAME);
if (existing) {
  console.log(`Deleting leftover probe harness ${existing.harnessId} …`);
  await control.send(new DeleteHarnessCommand({ harnessId: existing.harnessId })).catch((e) => console.log(`  ${e.name}: ${e.message}`));
  await new Promise((r) => setTimeout(r, 5000));
}

// ─── create ───────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = 'You are a probe. Reply with the single word OK.';

const request = {
  harnessName: HARNESS_NAME,
  executionRoleArn: role.Role.Arn,
  model: {
    bedrockModelConfig: {
      modelId: process.env.CALCULATOR_AGENT_MODEL_ID || 'global.anthropic.claude-sonnet-4-6',
      maxTokens: 4096,
    },
  },
  systemPrompt: [{ text: SYSTEM_PROMPT }],
  tools: [{
    type: 'agentcore_gateway',
    name: 'calculator_mcp',
    config: { agentCoreGateway: { gatewayArn: gateway.gatewayArn } },
  }],
  maxIterations: 10,
  timeoutSeconds: 300,
  truncation: { strategy: 'summarization', config: { summarization: { summaryRatio: 0.5, preserveRecentMessages: 8 } } },
  tags: { 'mimo:component': 'calculator-harness-probe' },
};

console.log('CreateHarness request:');
console.log(JSON.stringify(request, null, 1));
console.log('');

let harness;
try {
  harness = (await control.send(new CreateHarnessCommand(request))).harness;
  console.log(`ACCEPTED  harnessId=${harness.harnessId} status=${harness.status}`);
  console.log(`          arn=${harness.arn}`);
} catch (error) {
  console.log(`REJECTED  ${error.name}: ${error.message}`);
  process.exit(1);
}

// ─── wait for READY ───────────────────────────────────────────────────────────

let current = harness;
for (let attempt = 0; attempt < 60; attempt++) {
  await new Promise((r) => setTimeout(r, 5000));
  current = (await control.send(new GetHarnessCommand({ harnessId: harness.harnessId }))).harness;
  process.stdout.write(`\r  waiting… status=${current.status}      `);
  if (current.status === 'READY' || String(current.status).includes('FAILED')) break;
}
console.log('');
console.log(`status      : ${current.status}`);
if (current.statusReasons) console.log(`reasons     : ${JSON.stringify(current.statusReasons)}`);
console.log(`version     : ${current.harnessVersion ?? '—'}`);
console.log(`environment : ${JSON.stringify(current.environment ?? null).slice(0, 400)}`);

const endpoints = (await control.send(new ListHarnessEndpointsCommand({ harnessId: harness.harnessId }))).endpoints ?? [];
console.log(`endpoints   : ${endpoints.map((e) => `${e.endpointName}(${e.status})`).join(', ') || 'none — must be created explicitly'}`);

// ─── optional invoke ──────────────────────────────────────────────────────────

if (doInvoke && current.status === 'READY') {
  console.log('\nInvokeHarness …');
  try {
    const response = await data.send(new InvokeHarnessCommand({
      harnessArn: current.arn,
      runtimeSessionId: `probe-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      messages: [{ role: 'user', content: [{ text: 'Call get_server_info and tell me the MCP server name and version.' }] }],
    }));
    for await (const event of response.stream) {
      const kind = Object.keys(event)[0];
      if (kind === 'contentBlockDelta') {
        const delta = event.contentBlockDelta?.delta;
        if (delta?.text) process.stdout.write(delta.text);
        if (delta?.toolUse) process.stdout.write(`[toolUse ${JSON.stringify(delta.toolUse).slice(0, 200)}]`);
      } else if (kind === 'contentBlockStart') {
        console.log(`\n[start ${JSON.stringify(event.contentBlockStart?.start ?? {}).slice(0, 300)}]`);
      } else if (kind === 'metadata') {
        console.log(`\n[metadata ${JSON.stringify(event.metadata).slice(0, 400)}]`);
      } else if (kind.endsWith('Exception') || kind === 'runtimeClientError') {
        console.log(`\n[${kind}] ${JSON.stringify(event[kind]).slice(0, 600)}`);
      }
    }
    console.log('\nInvoke stream ended.');
  } catch (error) {
    console.log(`InvokeHarness failed: ${error.name}: ${error.message}`);
  }
}

// ─── clean up ─────────────────────────────────────────────────────────────────

if (keep) {
  console.log(`\nLeaving ${HARNESS_NAME} in place (--keep).`);
} else {
  console.log(`\nDeleting probe harness ${harness.harnessId} …`);
  await control.send(new DeleteHarnessCommand({ harnessId: harness.harnessId }));
  console.log('Deleted.');
}
