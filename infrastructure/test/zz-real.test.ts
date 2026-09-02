import { readFileSync } from 'node:fs';
import { analyseWorkbook } from '../lambdas/api-handler/calculator-workbook';
import { createExecutionManifest } from '../lambdas/calculator-orchestrator/calculator-validation';
import { groupResources } from '../lambdas/calculator-orchestrator/prompt';
import { materializePlanResources, planFromGroup, resourcesFromCanonicalModel } from '../lambdas/calculator-orchestrator/pipeline';

jest.setTimeout(60_000);

const digitalAssetsRevision = {
  revisionId: 'trace-revision',
  planId: 'trace-plan',
  createdAt: new Date(0).toISOString(),
  createdBy: 'system',
  scenarios: [],
  decisions: [],
  hash: 'trace-hash',
  requirements: [
    { id: 'sm', scope: ['service:SageMaker'], field: 'sagemaker.inference_configuration', operator: 'eq', expected: { workloadType: 'real-time inference', instanceType: 'ml.g5.xlarge' }, impact: 'critical', source: 'user' },
    { id: 'lambda', scope: ['service:Lambda'], field: 'lambda.execution_profile', operator: 'eq', expected: { memoryMb: 128, durationMs: 25 }, impact: 'critical', source: 'user' },
    { id: 'bedrock-model', scope: ['service:Bedrock'], field: 'bedrock.model', operator: 'eq', expected: 'Anthropic: Claude Sonnet 4', impact: 'critical', source: 'user' },
    { id: 'bedrock-tokens', scope: ['service:Bedrock'], field: 'bedrock.tokens_per_call', operator: 'eq', expected: { inputTokens: 2000, outputTokens: 500 }, impact: 'critical', source: 'user' },
    { id: 'cognito', scope: ['service:Cognito'], field: 'cognito.tier', operator: 'eq', expected: { tier: 'Essentials', monthlyTokenRequests: 1_000_000 }, impact: 'critical', source: 'user' },
    { id: 'sns', scope: ['service:SNS'], field: 'sns.delivery_type', operator: 'eq', expected: 'Mobile push', impact: 'critical', source: 'user' },
    { id: 'nat', scope: ['service:NAT Gateway'], field: 'nat_gateway.configuration', operator: 'eq', expected: { mode: 'Regional NAT Gateway', availabilityZoneCount: 1 }, impact: 'critical', source: 'user' },
    { id: 'aurora', scope: ['service:Aurora'], field: 'database.engine', operator: 'eq', expected: 'Aurora PostgreSQL', impact: 'critical', source: 'user' },
    { id: 'quicksight', scope: ['service:QuickSight'], field: 'quicksight.subscription_profile', operator: 'eq', expected: { annualAuthorPercent: 100, monthlyAuthorPercent: 0, spiceGb: 10 }, impact: 'critical', source: 'user' },
  ],
} as any;

function traceWorkbook(out: any, label: string): string {
  const rows = resourcesFromCanonicalModel(out.canonicalModel);
  const firstScenario = out.insights.bands?.[0]?.key;
  const materialized = materializePlanResources(rows, label === 'Digital Assets' ? digitalAssetsRevision : undefined);
  const groups = groupResources(materialized.filter((row) => !firstScenario || row.scenario === firstScenario), new Map(), 'baseline');
  const pick = (pattern: RegExp) => groups.find((group) => pattern.test(group.service || '') || pattern.test(group.names.join(' ')));
  const lines = [`${label} canonical rows=${out.canonicalModel.rows.length} balanced=${out.canonicalModel.accounting.balanced}`];
  for (const [name, group] of [
    ['Fargate', pick(/Fargate/i)],
    ['Lambda', pick(/Lambda/i)],
    ['Aurora', pick(/Aurora/i)],
  ] as const) {
    if (!group) {
      lines.push(`${name}: not present`);
      continue;
    }
    const plan = planFromGroup(group, 'ap-south-1');
    const manifest = createExecutionManifest({
      scenarioId: firstScenario || 'baseline',
      planRevisionId: 'trace',
      inputHash: out.workbookIR.fileHash || 'trace',
      constraints: [],
      preflight: [{
        resourceId: group.members.join(','),
        label: group.names.join(', ') || name,
        service: plan?.serviceCode,
        region: group.region || 'ap-south-1',
        readiness: plan?.calculatorKey && plan?.calculatorConfig ? 'COMPILED' : 'NEEDS_INPUT',
        checks: [],
        blockers: plan?.calculatorUnsupported ? [plan.calculatorUnsupported] : [],
        sourceEvidence: group.sourceEvidence || [],
      }],
      services: [{
        resourceIds: group.members.map(String),
        serviceCode: plan?.serviceCode || '',
        calculatorService: plan?.calculatorKey || '',
        group: group.environment || 'Estimate',
        description: group.names.join(', ') || name,
        config: plan?.calculatorConfig,
        semanticIntent: group.configuration || {},
        requestedPricing: 'sheet-specified',
        resolvedPricing: 'on-demand',
        pricingStatus: plan?.calculatorUnsupported ? 'UNSUPPORTED' : 'EXACT',
      }],
    });
    lines.push(`${name} source cells: ${JSON.stringify(group.sourceEvidence || [])}`);
    lines.push(`${name} canonical: ${JSON.stringify({ service: group.service, count: group.count, vcpu: group.vcpu, ramGb: group.ramGb, hoursPerMonth: group.hoursPerMonth, quantities: group.quantities, configuration: group.configuration })}`);
    lines.push(`${name} MCP config: ${JSON.stringify(plan?.calculatorConfig || null)}`);
    lines.push(`${name} manifest: ${JSON.stringify(manifest.expectedResources[0])}`);
  }
  return lines.join('\n');
}

it('parses the real Digital_Assets.xlsx', async () => {
  const bytes = readFileSync(`${__dirname}/../../docs/Digital_Assets.xlsx`);
  const out: any = await analyseWorkbook(bytes, 'Digital_Assets.xlsx');
  const res: any[] = out.resources;
  const ins: any = out.insights;
  const priceable = res.filter((r) => r.service || r.size || r.vcpu !== undefined);
  const per = new Map<string, number>();
  for (const r of res) per.set(r.scenario ?? '(none)', (per.get(r.scenario ?? '(none)') ?? 0) + 1);

  const lines: string[] = [];
  lines.push(`resources: ${res.length}   priceable by pipeline filter: ${priceable.length}`);
  lines.push(`bands: ${JSON.stringify(ins.bands)}`);
  lines.push(`per scenario: ${JSON.stringify([...per])}`);
  lines.push(`server_count=${ins.server_count} total_disk_gb=${ins.total_disk_gb}`);
  lines.push(`conversions (${(ins.conversions ?? []).length}):`);
  for (const c of ins.conversions ?? []) lines.push(`   ${c}`);
  lines.push(`exclusions (${(ins.exclusions ?? []).length}):`);
  for (const e of ins.exclusions ?? []) lines.push(`   [${e.scenario ?? 'all'}] ${e.metric} -- ${e.reason}`);
  lines.push(`warnings (${out.warnings.length}):`);
  for (const w of out.warnings) lines.push(`   ${w}`);
  lines.push('first 10 rows:');
  for (const r of res.slice(0, 10)) {
    lines.push(`   ${JSON.stringify({
      sc: r.scenario, env: r.environment, s: r.service, size: r.size, q: r.quantity,
      vcpu: r.vcpu, ram: r.ram_gb, disk: r.disk_gb, use: r.usage_amount, unit: r.usage_unit, m: r.metric,
    })}`);
  }
  lines.push('band-2 (dev) rows:');
  for (const r of res.filter((x) => x.scenario === 'dev').slice(0, 8)) {
    lines.push(`   ${JSON.stringify({
      sc: r.scenario, s: r.service, size: r.size, q: r.quantity,
      vcpu: r.vcpu, ram: r.ram_gb, disk: r.disk_gb, use: r.usage_amount, unit: r.usage_unit, m: r.metric,
    })}`);
  }
  // eslint-disable-next-line no-console
  console.log(`${lines.join('\n')}\n${traceWorkbook(out, 'Digital Assets')}`);
  expect(priceable.length).toBeGreaterThan(0);
});

it('parses and compiles the real Core BOM workbook without fixture-specific naming', async () => {
  const bytes = readFileSync(`${__dirname}/../../docs/Core BOM.xlsx`);
  const out: any = await analyseWorkbook(bytes, 'customer-layout.xlsx');
  const rows = resourcesFromCanonicalModel(out.canonicalModel);
  const groups = groupResources(rows, new Map(), 'baseline');
  const plans = groups.map((group) => planFromGroup(group, 'ap-south-1')).filter(Boolean);
  const ebsFromServiceNative = groups
    .map((group) => ({ group, plan: planFromGroup(group, 'ap-south-1') }))
    .filter(({ group, plan }) => group.service !== 'Amazon EC2' && plan?.storageOwner === 'ec2-ebs');

  // eslint-disable-next-line no-console
  console.log(traceWorkbook(out, 'Core BOM'));
  expect(rows.length).toBeGreaterThan(0);
  expect(plans.length).toBeGreaterThan(0);
  expect(ebsFromServiceNative).toEqual([]);
});
