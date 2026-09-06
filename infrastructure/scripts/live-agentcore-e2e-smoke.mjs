/**
 * Phase 29 — LIVE end-to-end smoke test of the new production path.
 *
 *   this script
 *     → InvokeHarness            (AgentCore-managed Claude agent loop)
 *       → AgentCore Gateway      (tool routing)
 *         → AgentCore Runtime    (sample-aws-pricing-calculator-mcp)
 *           → AWS Pricing Calculator
 *             → real calculator.aws URL
 *
 * Deliberately small: 100 GB of Amazon S3 in ap-south-1. The point is not to exercise a
 * complicated workbook, it is to prove the *path*, and to prove what is NOT in it.
 *
 * Nothing here touches:
 *   - the calculator-agent Lambda's custom InvokeModel loop
 *   - the calculator-mcp-proxy Lambda
 *   - the legacy calculator-mcp-sidecar Lambda
 *   - the MIMO calculator compiler (service-adapters / compileWithCalculatorAdapter)
 *
 * There is no tool loop in this file. It sends one message and reads a stream; every
 * model call, tool selection, tool result and retry happens inside AgentCore. The
 * tool-use events printed below are AgentCore's, observed rather than orchestrated.
 *
 *   node scripts/live-agentcore-e2e-smoke.mjs ap-south-1
 */
import {
  BedrockAgentCoreControlClient,
  ListHarnessesCommand,
  GetHarnessCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { BedrockAgentCoreClient, InvokeHarnessCommand } from '@aws-sdk/client-bedrock-agentcore';

const region = process.argv[2] || 'ap-south-1';
const control = new BedrockAgentCoreControlClient({ region });
const data = new BedrockAgentCoreClient({ region });

const summary = ((await control.send(new ListHarnessesCommand({}))).harnesses ?? [])
  .find((h) => /mimoCalc/i.test(h.harnessName ?? ''));
if (!summary) {
  console.error(`No MIMO calculator Harness in ${region}. Deploy the stack first.`);
  process.exit(1);
}

const harness = (await control.send(new GetHarnessCommand({ harnessId: summary.harnessId }))).harness;
console.log(`harness    : ${harness.harnessName} (${harness.harnessId})`);
console.log(`status     : ${harness.status}`);
console.log(`arn        : ${harness.arn}`);
console.log(`model      : ${JSON.stringify(harness.model)}`);
console.log(`tools      : ${JSON.stringify(harness.tools)}`);
console.log(`maxIters   : ${harness.maxIterations}   timeout=${harness.timeoutSeconds}s`);
console.log(`environment: ${JSON.stringify(harness.environment?.agentCoreRuntimeEnvironment?.lifecycleConfiguration ?? null)}`);
console.log('');

if (harness.status !== 'READY') {
  console.error(`Harness is ${harness.status}, not READY: ${harness.failureReason ?? ''}`);
  process.exit(1);
}

// The task carries workload evidence in MIMO's own semantic terms — a service, a size,
// a region. No Calculator service code, no Calculator field id, no config shape. What
// any of it means for the Calculator is for the agent and the MCP to work out.
const task = `Build an AWS Pricing Calculator estimate for this workload.

Scenario: MIMO AgentCore end-to-end smoke test
Region: ap-south-1

Workload evidence:
  Sheet: Smoke!2  Service: Amazon S3 (standard storage)   Amount: 100 GB stored per month

There are no other resources in this workload. Treat the evidence as complete.
Configure it through the Calculator MCP tools, validate it, export it, and return the
COMPLETED JSON object with the real calculator.aws URL.`;

// runtimeSessionId has a MINIMUM length of 33 characters:
//   "Value at 'runtimeSessionId' failed to satisfy constraint:
//    Member must have length greater than or equal to 33"
const sessionId = `mimo-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`.padEnd(33, '0');
console.log(`sessionId  : ${sessionId}`);
console.log('\n--- InvokeHarness (AgentCore owns the loop) ---\n');

const started = Date.now();
const toolCalls = [];
let assistantText = '';
let currentToolName;
const streamErrors = [];

const response = await data.send(new InvokeHarnessCommand({
  harnessArn: harness.arn,
  runtimeSessionId: sessionId,
  messages: [{ role: 'user', content: [{ text: task }] }],
}));

for await (const event of response.stream) {
  const kind = Object.keys(event)[0];

  if (kind === 'contentBlockStart') {
    const start = event.contentBlockStart?.start;
    if (start?.toolUse) {
      currentToolName = start.toolUse.name;
      toolCalls.push(currentToolName);
      console.log(`\n[tool] ${currentToolName}`);
    }
  } else if (kind === 'contentBlockDelta') {
    const delta = event.contentBlockDelta?.delta;
    if (delta?.text) { assistantText += delta.text; process.stdout.write(delta.text); }
  } else if (kind === 'messageStop') {
    console.log(`\n[messageStop ${JSON.stringify(event.messageStop ?? {})}]`);
  } else if (kind === 'metadata') {
    console.log(`\n[metadata ${JSON.stringify(event.metadata).slice(0, 500)}]`);
  } else if (kind === 'internalServerException' || kind === 'validationException' || kind === 'runtimeClientError') {
    streamErrors.push(`${kind}: ${JSON.stringify(event[kind])}`);
    console.log(`\n[${kind}] ${JSON.stringify(event[kind]).slice(0, 800)}`);
  }
}

const durationMs = Date.now() - started;
console.log('\n\n--- result ---');
console.log(`durationMs     : ${durationMs}`);
console.log(`toolCallCount  : ${toolCalls.length}`);
console.log(`mcpToolsUsed   : ${[...new Set(toolCalls.map((t) => String(t).split('___').pop()))].join(', ') || 'NONE'}`);
for (const error of streamErrors) console.log(`streamError    : ${error}`);

/** Last balanced JSON object in the text, which is where the contract puts the result. */
function lastJsonObject(text) {
  for (let start = text.lastIndexOf('{'); start >= 0; start = text.lastIndexOf('{', start - 1)) {
    let depth = 0; let inString = false; let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\' && inString) { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(text.slice(start, i + 1)); } catch { break; }
        }
      }
    }
  }
  return undefined;
}

const parsed = lastJsonObject(assistantText);
console.log(`parsedStatus   : ${parsed?.status ?? 'NONE'}`);

const url = parsed?.calculatorUrl
  || /https:\/\/calculator\.aws\/[^\s"'\\)]+/.exec(assistantText)?.[0];

console.log('');
const usedMcp = toolCalls.length > 0;
const gotUrl = Boolean(url && url.includes('calculator.aws'));

console.log(`AgentCore drove MCP tools        : ${usedMcp ? 'YES' : 'NO'}`);
console.log(`Real calculator.aws URL produced : ${gotUrl ? 'YES' : 'NO'}`);
if (gotUrl) console.log(`\nREAL calculator.aws URL: ${url}\n`);

if (!usedMcp || !gotUrl || parsed?.status !== 'COMPLETED') {
  console.log('RESULT: FAILED');
  if (!usedMcp) console.log('  - the agent never called an MCP tool');
  if (!gotUrl) console.log('  - no calculator.aws URL was produced');
  if (parsed?.status !== 'COMPLETED') console.log(`  - agent status was ${parsed?.status ?? 'unparseable'}`);
  process.exit(1);
}
console.log('RESULT: PASSED — MIMO evidence → AgentCore Harness → Gateway → Runtime MCP → calculator.aws');
