/**
 * The final acceptance test: the same semantic workload and the same pricing intent, built two
 * ways against the SAME deployed MCP, compared service by service.
 *
 *   Claude — a plain tool-use loop. Sonnet 4.6 on Bedrock is handed the MCP's own tool list
 *            (exactly as `tools/list` returns it), the canonical JSON and the pricing request,
 *            and drives the tools itself. No MIMO mapping code is involved.
 *   MIMO   — the executor, exactly as the pipeline runs it.
 *
 * Both saved estimates are read back with `import_estimate` and rendered in the browser
 * validator, then compared on: services present, sizing, usage dimensions, purchase model,
 * regions and totals. If Claude succeeds and MIMO does not on the same input and MCP version,
 * the defect is in the executor.
 *
 *   AWS_REGION=ap-south-1 npx tsx scripts/golden-claude-vs-mimo.mts [A|B|C]
 */
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';

import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const { McpSidecarClient } = await import('../lambdas/calculator-orchestrator/mcp-client.js');
const { executeScenario } = await import('../lambdas/aws-calculator-mcp-executor/index.js');
const { savedServices, normalizeSaved } = await import('../lambdas/aws-calculator-mcp-executor/verification.js');
const { calculatorModelId } = await import('../lambdas/calculator-orchestrator/model-router.js');
const { SCENARIO_LABELS } = await import('../schema/canonical-resource.js');
type SemanticResource = import('../lambdas/aws-calculator-mcp-executor/types.js').SemanticResource;
type PricingIntent = import('../lambdas/aws-calculator-mcp-executor/types.js').PricingIntent;

const SIDECAR = process.env.SIDECAR_FN || 'iep-dev-calculator-mcp-sidecar-996122083346-ap-south-1';
const BROWSER = process.env.BROWSER_FN || 'iep-dev-calculator-browser-validator-996122083346-ap-south-1';
const gateway = new McpSidecarClient(SIDECAR, BROWSER);
const bedrock = new BedrockRuntimeClient({ region: 'ap-south-1' });
const MAX_TURNS = 40;

// The same canonical inputs as tests A, B and C.
const fargate: SemanticResource = {
  resourceId: 'prod-fargate', service: 'AWS Fargate', region: 'ap-south-1', environment: 'Production', description: 'API tasks',
  configuration: { taskCount: 10, taskFrequency: 'perDay', vcpuPerTask: 1, memoryGbPerTask: 2, duration: 730, durationUnit: 'hours' },
};
const mixed: SemanticResource[] = [
  { resourceId: 'prod-ec2-app', service: 'Amazon EC2', region: 'ap-south-1', environment: 'Production', description: 'Application servers', configuration: { instanceType: 'm6i.xlarge', instanceCount: 4, operatingSystem: 'Linux', tenancy: 'shared' } },
  fargate,
  { resourceId: 'prod-lambda-api', service: 'AWS Lambda', region: 'ap-south-1', environment: 'Production', description: 'API handler functions', configuration: { requestCount: 2, requestFrequency: 'millionPerMonth', requestDurationMs: 200, memoryMb: 512 } },
  { resourceId: 'prod-s3-assets', service: 'Amazon S3', region: 'ap-south-1', environment: 'Production', description: 'Asset bucket', configuration: { storageGb: 500 } },
];
const CASES: Record<string, { resources: SemanticResource[]; pricing: PricingIntent }> = {
  A: { resources: [fargate], pricing: { kind: 'on-demand', upfrontPayment: 'None' } },
  B: { resources: [fargate], pricing: { kind: 'compute-savings-3yr', upfrontPayment: 'None' } },
  C: { resources: mixed, pricing: { kind: 'compute-savings-3yr', upfrontPayment: 'None' } },
};

/** Claude, unassisted: the MCP tools as Anthropic tools, the canonical JSON as the ask. */
async function claudeBuilds(name: string, resources: SemanticResource[], pricing: PricingIntent): Promise<{ url?: string; turns: number; toolCalls: string[]; transcript: string[] }> {
  const tools = (await gateway.listTools()).map((tool) => ({ name: tool.name, description: tool.description || '', input_schema: tool.inputSchema }));
  const system = 'You are an AWS solutions architect using the AWS Pricing Calculator MCP tools. Build ONE saved estimate for the workload described, then stop. '
    + 'Use the tools to discover service keys and field schemas rather than guessing. Preserve every value, unit and period exactly as given (a per-day count stays per day). '
    + 'Apply the requested pricing model only to services the Calculator lets you commit; leave the others On-Demand and say which. '
    + 'When export_estimate returns a shareable URL, reply with exactly: DONE <url>';
  const user = `Estimate name: ${name}\nRegion: ap-south-1\nRequested pricing model: ${SCENARIO_LABELS[pricing.kind]} (${pricing.kind}), upfront payment ${pricing.upfrontPayment}.\n\nWorkload (canonical, semantic):\n${JSON.stringify(resources, null, 2)}`;
  const messages: Array<Record<string, unknown>> = [{ role: 'user', content: [{ type: 'text', text: user }] }];
  const toolCalls: string[] = [];
  const transcript: string[] = [];
  const modelId = calculatorModelId('SONNET_4_6');
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const response = await bedrock.send(new InvokeModelCommand({
      modelId, contentType: 'application/json', accept: 'application/json',
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 4000, system, tools, messages }),
    }));
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const content = payload.content || [];
    messages.push({ role: 'assistant', content });
    const text = content.filter((block: { type: string }) => block.type === 'text').map((block: { text: string }) => block.text).join('\n');
    if (text) transcript.push(text.slice(0, 300));
    const uses = content.filter((block: { type: string }) => block.type === 'tool_use');
    if (!uses.length) {
      const url = /https:\/\/[^\s"'\\]*calculator\.aws[^\s"'\\]*/.exec(text)?.[0];
      return { url, turns: turn, toolCalls, transcript };
    }
    const results = [];
    for (const use of uses) {
      toolCalls.push(use.name);
      const result = await gateway.callTool(use.name, use.input || {}, 180_000);
      results.push({ type: 'tool_result', tool_use_id: use.id, content: result.text.slice(0, 60_000), is_error: result.isError });
    }
    messages.push({ role: 'user', content: results });
  }
  return { turns: MAX_TURNS, toolCalls, transcript };
}

/** What a saved estimate says, reduced to the facts worth comparing. */
async function summarise(url: string) {
  const imported = await gateway.callTool('import_estimate', { estimate_id: url, format: 'json' }, 180_000);
  const start = imported.text.indexOf('{');
  const estimate = start >= 0 ? JSON.parse(imported.text.slice(start)) : undefined;
  const services = savedServices(estimate).map((service) => {
    const components = normalizeSaved(service.components) as Record<string, unknown>;
    const pricing = components.pricingStrategy as Record<string, unknown> | string | undefined;
    const form = Object.values(components).find((value) => Array.isArray((value as { value?: unknown })?.value) || Array.isArray(value)) as unknown;
    return {
      serviceCode: service.serviceCode,
      region: (estimate && Object.values((estimate as { groups?: Record<string, { services?: Record<string, { region?: string }> }> }).groups || {}).flatMap((group) => Object.values(group.services || {})).find((entry) => entry)?.region) || undefined,
      pricing: typeof pricing === 'object' && pricing ? `${pricing.model ?? pricing.selectedOption}/${pricing.term ?? ''}` : pricing ?? 'none',
      dimensions: Object.fromEntries(Object.entries(components).filter(([key]) => !['pricingStrategy', 'tenancy', 'workloadSelection', 'dataTransferForEC2', 'detailedMonitoringCheckbox', 'ec2AdvancedPricingMetrics'].includes(key))),
      columnForm: form,
    };
  });
  const totals = await gateway.validateLink(url);
  return { services, totals: { monthly: totals.monthly, upfront: totals.upfront, total12Months: totals.total12Months } };
}

const which = (process.argv[2] || 'C').toUpperCase();
const testCase = CASES[which];
if (!testCase) throw new Error(`unknown case ${which}`);

console.log(`\n=== GOLDEN ${which}: ${SCENARIO_LABELS[testCase.pricing.kind]} over ${testCase.resources.map((r) => r.service).join(', ')} ===`);
console.log('MCP:', JSON.stringify(JSON.parse((await gateway.callTool('get_server_info', {})).text).version));

console.log('\n--- Claude, unassisted ---');
const claude = await claudeBuilds(`Golden ${which} - Claude`, testCase.resources, testCase.pricing);
console.log(`turns ${claude.turns}, tool calls: ${claude.toolCalls.join(' → ')}`);
console.log('url:', claude.url || '(none)');

console.log('\n--- MIMO executor ---');
const mimo = await executeScenario({ scenarioId: `golden-${which}`, estimateName: `Golden ${which} - MIMO`, pricing: testCase.pricing, resources: testCase.resources }, gateway, { buildSha: 'golden' });
console.log(`status ${mimo.status}, ${mimo.diagnostics.toolCalls.length} tool calls, models ${JSON.stringify(mimo.diagnostics.modelIds)}`);
console.log('url:', mimo.calculatorUrl || '(none)');

if (!claude.url || !mimo.calculatorUrl) {
  console.log('\nCOMPARISON NOT POSSIBLE:', !claude.url ? 'Claude produced no URL.' : '', !mimo.calculatorUrl ? 'MIMO produced no URL.' : '');
  if (!claude.url) console.log('Claude transcript tail:', claude.transcript.slice(-3));
  process.exit(1);
}

const [left, right] = await Promise.all([summarise(claude.url), summarise(mimo.calculatorUrl)]);
console.log('\n--- Services ---');
const codes = (side: typeof left) => side.services.map((service) => service.serviceCode).sort();
console.log('Claude:', codes(left).join(', '));
console.log('MIMO  :', codes(right).join(', '));
console.log('\n--- Per service ---');
for (const service of left.services) {
  const twin = right.services.find((entry) => entry.serviceCode === service.serviceCode);
  console.log(`\n${service.serviceCode}`);
  console.log('  Claude pricing:', service.pricing, '| MIMO pricing:', twin?.pricing ?? '(absent)');
  console.log('  Claude dims  :', JSON.stringify(service.dimensions).slice(0, 400));
  console.log('  MIMO dims    :', JSON.stringify(twin?.dimensions).slice(0, 400));
}
console.log('\n--- Totals (browser-rendered) ---');
console.log('Claude:', JSON.stringify(left.totals));
console.log('MIMO  :', JSON.stringify(right.totals));
const gap = left.totals.monthly && right.totals.monthly ? Math.abs(left.totals.monthly - right.totals.monthly) / left.totals.monthly : undefined;
console.log('monthly gap:', gap === undefined ? 'n/a' : `${(gap * 100).toFixed(2)}%`);
const sameServices = JSON.stringify(codes(left)) === JSON.stringify(codes(right));
const samePricing = left.services.every((service) => right.services.find((entry) => entry.serviceCode === service.serviceCode)?.pricing === service.pricing);
console.log(`\nVERDICT: services ${sameServices ? 'match' : 'DIFFER'}, purchase models ${samePricing ? 'match' : 'DIFFER'}, totals ${gap !== undefined && gap < 0.02 ? 'match within 2%' : 'DIFFER'}`);
