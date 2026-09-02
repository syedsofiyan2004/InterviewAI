import fs from 'fs';

import { analyseWorkbook } from '../lambdas/api-handler/calculator-workbook';
import { parseServiceCatalog, resolveConfigAgainstCatalog, validateConfigAgainstCatalog } from '../lambdas/calculator-orchestrator/calculator-catalog';
import { createExecutionManifest, parseSavedEstimateSnapshot, validateSavedEstimate } from '../lambdas/calculator-orchestrator/calculator-validation';
import { McpSidecarClient } from '../lambdas/calculator-orchestrator/mcp-client';
import { runEstimatePipeline } from '../lambdas/calculator-orchestrator/pipeline';
import type { ResourceGroup } from '../lambdas/calculator-orchestrator/prompt';
import { compileWithCalculatorAdapter } from '../lambdas/calculator-orchestrator/service-adapters';
import { materializePlanResources, planFromGroup } from '../lambdas/calculator-orchestrator/pipeline';
import { groupResources } from '../lambdas/calculator-orchestrator/prompt';

jest.setTimeout(600_000);

const client = new McpSidecarClient('iep-dev-calculator-mcp-sidecar-996122083346-ap-south-1');
const productionClient = new McpSidecarClient(
  'iep-dev-calculator-mcp-sidecar-996122083346-ap-south-1',
  'iep-dev-calculator-browser-validator-996122083346-ap-south-1',
);
const base = (overrides: Partial<ResourceGroup>): ResourceGroup => ({
  service: 'Unknown', hoursPerDay: 24, count: 1, rows: 1, diskGb: 0,
  names: [], members: [0], reportedMonthly: 0, ...overrides,
});

const contractTest = process.env.RUN_CALCULATOR_CONTRACTS === '1' ? test : test.skip;

contractTest('live golden adapter contracts save and import', async () => {
  const groups = [
    base({
      service: 'Amazon Cognito',
      quantities: [{ unit: 'units/month', amount: 50_000, basis: 'monthly active users (MAU)', conversions: [] }],
      details: ['cognito.tier: {"tier":"Essentials","monthlyTokenRequests":1000000}'],
    }),
    base({
      service: 'Amazon SageMaker', count: 4, names: ['vision model', 'reasoning model'],
      details: ['sagemaker.inference_configuration: {"workloadType":"real-time inference","instanceType":"ml.g5.xlarge"}'],
    }),
    base({
      service: 'Amazon Bedrock',
      quantities: [{ unit: 'requests/month', amount: 43_200, basis: 'Bedrock model calls', conversions: [] }],
      details: ['bedrock.model: Anthropic: Claude Sonnet 4', 'bedrock.tokens_per_call: {"inputTokens":2000,"outputTokens":500}'],
    }),
    base({ service: 'Elastic Load Balancing', size: 'ALB external', count: 2, details: ['load_balancer.capacity_profile: {"processedGbPerHour":5}'] }),
    base({ service: 'Elastic Load Balancing', size: 'Internal Network Load Balancer', count: 2, details: ['load_balancer.capacity_profile: {"processedGbPerHour":5,"protocol":"TCP"}'] }),
    base({ service: 'AWS WAF', details: ['waf.traffic_profile: {"webAclCount":2,"rulesPerAcl":8,"monthlyWebRequestsMillions":12.5}'] }),
  ];
  const services = [] as Array<{ service: string; group: string; config: Record<string, unknown> }>;
  for (const [index, group] of groups.entries()) {
    const plan = compileWithCalculatorAdapter(group, { defaultRegion: 'ap-south-1' });
    expect(plan?.calculatorKey).toBeTruthy();
    expect(plan?.calculatorConfig).toBeTruthy();
    const catalog = parseServiceCatalog(await client.getServiceCatalog(plan!.calculatorKey!));
    const config = resolveConfigAgainstCatalog(catalog, plan!.calculatorConfig!);
    expect(validateConfigAgainstCatalog(catalog, config)).toEqual([]);
    services.push({ service: plan!.calculatorKey!, group: `Golden ${index + 1}`, config });
  }
  const saved = await client.saveEstimate('MIMO golden adapter contract', services);
  console.log(`SAVE error=${saved.isError}\n${saved.text}`);
  expect(saved.isError).toBe(false);
  const url = /https:\/\/[^\s"'\\]*calculator\.aws[^\s"'\\]*/.exec(saved.text)?.[0];
  expect(url).toBeTruthy();
  const imported = await client.readEstimate(url!);
  console.log(`IMPORT error=${imported.isError}\n${imported.text}`);
  expect(imported.isError).toBe(false);
  const manifest = createExecutionManifest({
    scenarioId: 'contract', planRevisionId: 'contract', inputHash: 'contract', constraints: [],
    services: services.map((service, index) => ({
      resourceIds: [String(index)], serviceCode: service.service, calculatorService: service.service,
      group: service.group, description: String(service.config.description || service.group), config: service.config,
      fingerprintFields: Object.keys(service.config).filter((key) => !['region', 'description'].includes(key)),
      requestedPricing: 'on-demand', resolvedPricing: 'on-demand', pricingStatus: 'EXACT' as const,
    })),
  });
  const snapshot = parseSavedEstimateSnapshot(imported.text);
  snapshot.monthly = 1;
  snapshot.upfront = 0;
  snapshot.total12Months = 12;
  expect(validateSavedEstimate(manifest, snapshot).errors).toEqual([]);
});

contractTest('every Digital Assets period saves and structurally validates every specified group', async () => {
  const analysis = await analyseWorkbook(fs.readFileSync('../docs/Digital_Assets.xlsx'), 'arbitrary.xlsx');
  const resources = materializePlanResources(analysis.resources, {
    requirements: [
      { scope: ['service:SageMaker'], field: 'sagemaker.inference_configuration', expected: { workloadType: 'real-time inference', instanceType: 'ml.g5.xlarge' } },
      { scope: ['service:Bedrock'], field: 'bedrock.model', expected: 'Anthropic: Claude Sonnet 4' },
      { scope: ['service:Bedrock'], field: 'bedrock.tokens_per_call', expected: { inputTokens: 2000, outputTokens: 500 } },
      { scope: ['service:Cognito'], field: 'cognito.tier', expected: { tier: 'Essentials', monthlyTokenRequests: 1_000_000 } },
      { scope: ['service:SNS'], field: 'sns.delivery_type', expected: 'Mobile push' },
      { scope: ['service:NAT Gateway'], field: 'nat_gateway.configuration', expected: { mode: 'Regional NAT Gateway', availabilityZoneCount: 1 } },
      { scope: ['service:Aurora'], field: 'database.engine', expected: 'Aurora PostgreSQL' },
      { scope: ['service:QuickSight'], field: 'quicksight.subscription_profile', expected: { annualAuthorPercent: 100, monthlyAuthorPercent: 0, spiceGb: 10 } },
    ],
  } as any);
  const catalogs = new Map<string, ReturnType<typeof parseServiceCatalog>>();
  const links: Array<{ scenario: string; url: string; services: number }> = [];
  for (const band of analysis.insights.bands || []) {
    const groups = groupResources(resources.filter((row) => row.scenario === band.key), new Map(), 'baseline');
    const services = [] as Array<{ service: string; group: string; config: Record<string, unknown>; serviceCode: string; resourceIds: string[]; fingerprintFields?: string[] }>;
    for (const [index, group] of groups.entries()) {
      const plan = planFromGroup(group, 'ap-south-1');
      expect(plan?.calculatorKey).toBeTruthy();
      expect(plan?.calculatorConfig).toBeTruthy();
      let catalog = catalogs.get(plan!.calculatorKey!);
      if (!catalog) {
        catalog = parseServiceCatalog(await client.getServiceCatalog(plan!.calculatorKey!));
        catalogs.set(plan!.calculatorKey!, catalog);
      }
      const config = resolveConfigAgainstCatalog(catalog, plan!.calculatorConfig!);
      expect(validateConfigAgainstCatalog(catalog, config)).toEqual([]);
      services.push({
        service: plan!.calculatorKey!, serviceCode: plan!.serviceCode,
        group: `${band.label} ${String(index + 1).padStart(2, '0')} ${group.service}`,
        config, resourceIds: group.members.map(String), fingerprintFields: plan!.fingerprintFields,
      });
    }
    const saved = await client.saveEstimate(`MIMO Digital Assets ${band.label} compiler contract`, services);
    console.log(`DIGITAL ASSETS ${band.label} SAVE error=${saved.isError}\n${saved.text}`);
    expect(saved.isError).toBe(false);
    const url = /https:\/\/[^\s"'\\]*calculator\.aws[^\s"'\\]*/.exec(saved.text)?.[0];
    expect(url).toBeTruthy();
    const imported = await client.readEstimate(url!);
    expect(imported.isError).toBe(false);
    const manifest = createExecutionManifest({
      scenarioId: band.key, planRevisionId: 'contract', inputHash: 'contract', constraints: [],
      services: services.map((service) => ({
        resourceIds: service.resourceIds, serviceCode: service.serviceCode, calculatorService: service.service,
        group: service.group, description: String(service.config.description || service.group), config: service.config,
        fingerprintFields: service.fingerprintFields,
        requestedPricing: 'on-demand', resolvedPricing: 'on-demand', pricingStatus: 'EXACT' as const,
      })),
    });
    const snapshot = parseSavedEstimateSnapshot(imported.text);
    snapshot.monthly = 1;
    snapshot.upfront = 0;
    snapshot.total12Months = 12;
    expect(validateSavedEstimate(manifest, snapshot).errors).toEqual([]);
    links.push({ scenario: band.label, url: url!, services: services.length });
  }
  expect(links).toHaveLength(analysis.insights.bands?.length || 0);
  console.log(`DIGITAL_ASSETS_LINKS=${JSON.stringify(links)}`);
});

contractTest('the production pipeline saves and reads back the full Digital Assets workbook', async () => {
  const analysis = await analyseWorkbook(fs.readFileSync('../docs/Digital_Assets.xlsx'), 'production-path.xlsx');
  const resources = materializePlanResources(analysis.resources, {
    requirements: [
      { scope: ['service:SageMaker'], field: 'sagemaker.inference_configuration', expected: { workloadType: 'real-time inference', instanceType: 'ml.g5.xlarge' } },
      { scope: ['service:Bedrock'], field: 'bedrock.model', expected: 'Anthropic: Claude Sonnet 4' },
      { scope: ['service:Bedrock'], field: 'bedrock.tokens_per_call', expected: { inputTokens: 2000, outputTokens: 500 } },
      { scope: ['service:Cognito'], field: 'cognito.tier', expected: { tier: 'Essentials', monthlyTokenRequests: 1_000_000 } },
      { scope: ['service:SNS'], field: 'sns.delivery_type', expected: 'Mobile push' },
      { scope: ['service:NAT Gateway'], field: 'nat_gateway.configuration', expected: { mode: 'Regional NAT Gateway', availabilityZoneCount: 1 } },
      { scope: ['service:Aurora'], field: 'database.engine', expected: 'Aurora PostgreSQL' },
      { scope: ['service:QuickSight'], field: 'quicksight.subscription_profile', expected: { annualAuthorPercent: 100, monthlyAuthorPercent: 0, spiceGb: 10 } },
    ],
  } as any);
  const revisionId = 'live-pipeline';
  const outcome = await runEstimatePipeline({
    calculation_id: `live-${Date.now()}`,
    owner_user_id: 'live-contract',
    name: 'MIMO Digital Assets production pipeline contract',
    prompt: '',
    region: 'ap-south-1',
    status: 'PROCESSING',
    environment_hours: [],
    resources: [],
    input_warnings: [],
    created_at: Date.now(),
    updated_at: Date.now(),
    workbook: analysis.insights,
    plan_v2: {
      version: 2,
      currentRevisionId: revisionId,
      revisions: [{
        revisionId,
        createdAt: new Date().toISOString(),
        source: 'user',
        requirements: [
          { scope: ['service:SageMaker'], field: 'sagemaker.inference_configuration', expected: { workloadType: 'real-time inference', instanceType: 'ml.g5.xlarge' } },
          { scope: ['service:Bedrock'], field: 'bedrock.model', expected: 'Anthropic: Claude Sonnet 4' },
          { scope: ['service:Bedrock'], field: 'bedrock.tokens_per_call', expected: { inputTokens: 2000, outputTokens: 500 } },
          { scope: ['service:Cognito'], field: 'cognito.tier', expected: { tier: 'Essentials', monthlyTokenRequests: 1_000_000 } },
          { scope: ['service:SNS'], field: 'sns.delivery_type', expected: 'Mobile push' },
          { scope: ['service:NAT Gateway'], field: 'nat_gateway.configuration', expected: { mode: 'Regional NAT Gateway', availabilityZoneCount: 1 } },
          { scope: ['service:Aurora'], field: 'database.engine', expected: 'Aurora PostgreSQL' },
          { scope: ['service:QuickSight'], field: 'quicksight.subscription_profile', expected: { annualAuthorPercent: 100, monthlyAuthorPercent: 0, spiceGb: 10 } },
        ],
        scenarios: [],
      }],
    },
    confirmed_plan_revision_id: revisionId,
  } as any, resources, productionClient as any);

  expect(outcome.status).toBe('COMPLETED');
  expect(outcome.result.url).toMatch(/^https:\/\/calculator\.aws\/#\/estimate\?id=/);
  expect(outcome.result.monthlyTotal).toEqual(expect.any(Number));
  expect(outcome.result.monthlyTotal).toBeGreaterThan(0);
  expect(outcome.result.validationErrors).toEqual([]);
  expect(outcome.result.scenarios.every((scenario) => scenario.status === 'COMPLETED')).toBe(true);
}, 600_000);
