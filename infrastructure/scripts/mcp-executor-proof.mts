/**
 * Tests A, B and C from the rebuild brief, run through the real executor against the deployed
 * MCP sidecar and browser validator. Prints the link, the rendered totals, the per-service
 * pricing resolution and the verification status for each.
 *
 *   AWS_REGION=ap-south-1 npx tsx scripts/mcp-executor-proof.mts [A|B|C|all] [--models]
 *
 * `--models` enables the Haiku/Sonnet tiers (Bedrock). Without it the run must succeed on
 * deterministic code alone, which is the property the brief asks for on clean resources.
 */
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';

const { McpSidecarClient } = await import('../lambdas/calculator-orchestrator/mcp-client.js');
const { executeScenario } = await import('../lambdas/aws-calculator-mcp-executor/index.js');
type SemanticResource = import('../lambdas/aws-calculator-mcp-executor/types.js').SemanticResource;
type ExecutorResult = import('../lambdas/aws-calculator-mcp-executor/types.js').ExecutorResult;

const SIDECAR = process.env.SIDECAR_FN || 'iep-dev-calculator-mcp-sidecar-996122083346-ap-south-1';
const BROWSER = process.env.BROWSER_FN || 'iep-dev-calculator-browser-validator-996122083346-ap-south-1';
const which = (process.argv[2] || 'all').toUpperCase();
const useModels = process.argv.includes('--models');

const gateway = new McpSidecarClient(SIDECAR, BROWSER);

const fargate: SemanticResource = {
  resourceId: 'prod-fargate',
  service: 'AWS Fargate',
  region: 'ap-south-1',
  environment: 'Production',
  description: 'API tasks',
  configuration: {
    taskCount: 10,
    taskFrequency: 'perDay',
    vcpuPerTask: 1,
    memoryGbPerTask: 2,
    duration: 730,
    durationUnit: 'hours',
  },
};

const mixed: SemanticResource[] = [
  {
    resourceId: 'prod-ec2-app',
    service: 'Amazon EC2',
    region: 'ap-south-1',
    environment: 'Production',
    description: 'Application servers',
    configuration: { instanceType: 'm6i.xlarge', instanceCount: 4, operatingSystem: 'Linux', tenancy: 'shared' },
  },
  fargate,
  {
    resourceId: 'prod-lambda-api',
    service: 'AWS Lambda',
    region: 'ap-south-1',
    environment: 'Production',
    description: 'API handler functions',
    configuration: { requestCount: 2, requestFrequency: 'millionPerMonth', requestDurationMs: 200, memoryMb: 512 },
  },
  {
    resourceId: 'prod-s3-assets',
    service: 'Amazon S3',
    region: 'ap-south-1',
    environment: 'Production',
    description: 'Asset bucket',
    configuration: { storageGb: 500 },
  },
];

function report(label: string, result: ExecutorResult) {
  console.log(`\n=== ${label}: ${result.status} ===`);
  console.log(result.summary);
  console.log('link:', result.calculatorUrl);
  console.log('totals:', JSON.stringify(result.totals));
  console.log('mcp:', result.diagnostics.MCP_VERSION, 'tools hash', result.diagnostics.MCP_TOOL_LIST_HASH.slice(0, 12));
  console.log('models used:', JSON.stringify(result.diagnostics.modelsUsed));
  for (const outcome of result.resources) {
    console.log(`- ${outcome.resourceId} (${outcome.serviceCode}): ${outcome.status}, attempts ${outcome.attempts.length}, tiers [${outcome.tiers.join(', ') || 'CODE only'}]`);
    for (const attempt of outcome.attempts) if (attempt.error) console.log(`    attempt ${attempt.attempt} ${attempt.failedAt}: ${attempt.error.slice(0, 220).replace(/\n/g, ' ')}`);
    for (const note of outcome.notes) console.log(`    note: ${note.slice(0, 200)}`);
    if (outcome.finalConfig) console.log(`    config: ${JSON.stringify(outcome.finalConfig).slice(0, 400)}`);
  }
  for (const entry of result.pricing) console.log(`  pricing ${entry.service}: requested ${entry.requested} → resolved ${entry.resolved} (${entry.via}) — ${entry.reason}`);
  if (result.pricingScope) console.log('  scope:', result.pricingScope);
  for (const finding of result.findings) console.log(`  [${finding.severity}] ${finding.check}: ${finding.message.slice(0, 300)}`);
  console.log(`  ${result.diagnostics.toolCalls.length} MCP calls in ${Math.round(result.diagnostics.durationMs / 1000)}s`);
}

const options = { models: useModels ? undefined : null, buildSha: 'proof', onProgress: ({ stage, message }: { stage: string; message: string }) => console.log(`  [${stage}] ${message}`) };
const results: Record<string, string> = {};

if (which === 'A' || which === 'ALL') {
  const result = await executeScenario({
    scenarioId: 'test-a', estimateName: 'MIMO Test A - Fargate On-Demand',
    pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [fargate],
  }, gateway, options);
  report('TEST A — Fargate On-Demand', result);
  results.A = result.status;
}
if (which === 'B' || which === 'ALL') {
  const result = await executeScenario({
    scenarioId: 'test-b', estimateName: 'MIMO Test B - Fargate 3Y Compute Savings Plan',
    pricing: { kind: 'compute-savings-3yr', upfrontPayment: 'None' }, resources: [fargate],
  }, gateway, options);
  report('TEST B — Fargate, 3-Year Compute Savings Plan requested', result);
  results.B = result.status;
}
if (which === 'C' || which === 'ALL') {
  const result = await executeScenario({
    scenarioId: 'test-c', estimateName: 'MIMO Test C - Mixed 3Y Compute Savings Plan',
    pricing: { kind: 'compute-savings-3yr', upfrontPayment: 'None' }, resources: mixed,
  }, gateway, options);
  report('TEST C — EC2 + Fargate + Lambda + S3, 3-Year Compute Savings Plan', result);
  results.C = result.status;
}
console.log('\nSUMMARY', JSON.stringify(results));
