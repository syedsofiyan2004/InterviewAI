/**
 * Semantic preflight: the executor's mapper run without an estimate, so the gaps become typed
 * questions before anything is built. The fake MCP is the same shape as in the executor tests.
 */

import { preflightResources } from '../lambdas/aws-calculator-mcp-executor/preflight';
import type { SemanticResource } from '../lambdas/aws-calculator-mcp-executor/types';

const EC2_FIELDS = {
  serviceCode: 'ec2Enhancement',
  serviceName: 'Amazon EC2',
  fields: [
    { id: 'selectedOS', type: 'dropdown', label: 'Operating system', options: [{ id: 'linux', label: 'Linux' }, { id: 'windows', label: 'Windows Server' }] },
    { id: 'workload', type: 'workload', label: 'Advance workloads' },
    { id: 'instanceType', type: 'ec2InstanceSearch', label: 'Advance EC2 instance' },
    { id: 'pricingStrategy', type: 'ec2AdvPricingStrategyV2', label: 'Advance pricing strategy', options: [{ label: 'On-Demand', value: 'on-demand' }] },
  ],
  catalog: { required: [{ field: 'instanceType' }, { field: 'pricingStrategy' }], minimalConfig: { region: 'us-east-1', description: 'x', instanceType: 'm5.large', workload: 1, selectedOS: 'linux', pricingStrategy: 'ondemand' } },
};
const RDS_FIELDS = {
  serviceCode: 'amazonRDSPostgreSQL',
  serviceName: 'Amazon RDS for PostgreSQL',
  fields: [
    { id: 'columnFormIPM', type: 'columnFormIPM', label: 'Instances', row: [
      { label: 'Nodes', selectorId: 'Number of Nodes', type: 'textInput' },
      { label: 'Instance type', selectorId: 'Instance Type', type: 'autoSuggest' },
      { label: 'Deployment option', selectorId: 'Deployment Option', type: 'dropDown' },
      { label: 'Pricing model', selectorId: 'TermType', type: 'dropDown' },
    ], selectorValues: { 'Deployment Option': ['Single-AZ', 'Multi-AZ'], TermType: ['OnDemand', 'Reserved'], 'Instance Type': ['db.r6g.large', 'db.r6g.xlarge', 'db.t3.medium'] } },
  ],
};

function fakeGateway() {
  return {
    listTools: async () => ['search_services', 'get_service_fields', 'create_estimate', 'add_service', 'validate_estimate', 'export_estimate', 'import_estimate', 'get_server_info'].map((name) => ({ name })),
    callTool: async (name: string, args: Record<string, unknown>) => {
      const ok = (value: unknown) => ({ text: JSON.stringify(value), isError: false });
      if (name === 'get_server_info') return ok({ name: 'mcp', version: '1.3.0' });
      if (name === 'search_services') return ok(String(args.query).includes('EC2') ? [{ key: 'ec2Enhancement', name: 'Amazon EC2 ' }] : String(args.query).includes('RDS') ? [{ key: 'amazonRDSPostgreSQL', name: 'Amazon RDS for PostgreSQL' }] : []);
      if (name === 'get_service_fields') {
        const code = String(args.service);
        if (code === 'ec2Enhancement') return ok(EC2_FIELDS);
        if (code === 'amazonRDSPostgreSQL') return ok(RDS_FIELDS);
        return ok({ services: [], errors: [`Service "${code}" not found.`] });
      }
      return { text: `unexpected ${name} during preflight`, isError: true };
    },
  };
}

import { enrichPlanWithCalculatorPreflight, semanticKeyFor } from '../lambdas/api-handler/calculator-preflight';

describe('turning preflight gaps into Review questions', () => {
  it('names a field from the Calculator label when the vocabulary has no word for the input', () => {
    expect(semanticKeyFor('Number of models deployed')).toBe('numberOfModelsDeployed');
    expect(semanticKeyFor('Endpoint hour(s) per day')).toBe('endpointHourPerDay');
    expect(semanticKeyFor('SPICE capacity in gigabytes (GB)')).toBe('spiceCapacityInGigabytes');
  });

  it('adds a question for every Calculator-required input, mapped to a plan field the pipeline applies', async () => {
    const gateway = fakeGateway();
    const plan = {
      planId: 'p', workbookId: 'w', status: 'READY' as const, currentRevisionId: 'r',
      detectedDimensions: { regions: [], environments: [], scenarios: [], serviceFamilies: [], resourceCount: 1, mappedResourceCount: 1, excludedCount: 0, coveragePct: 100 },
      unresolved: [], recommendedScenarios: [],
      revisions: [{ revisionId: 'r', planId: 'p', createdAt: '2026-09-03T00:00:00.000Z', createdBy: 'system' as const, scenarios: [], requirements: [], decisions: [], hash: 'h'.repeat(16) }],
    };
    const resources = [{ raw: 'db', service: 'Amazon RDS PostgreSQL', size: 'db.r6g.large', quantity: '2', os: 'PostgreSQL' }];
    const enriched = await enrichPlanWithCalculatorPreflight(plan, resources, 'ap-south-1', gateway, [], 10_000);
    expect(enriched.added).toBe(1);
    expect(enriched.plan.status).toBe('NEEDS_INPUT');
    const [question] = enriched.plan.unresolved;
    // "Deployment option" has a vocabulary word, so the plan's own field is used and the
    // Calculator's choices become the dropdown; the scope is the parsed row's index.
    expect(question).toMatchObject({ field: 'database.multi_az', scope: ['resource:0'], options: ['Single-AZ', 'Multi-AZ'], impact: 'high' });
    expect(question.prompt).toMatch(/Amazon RDS for PostgreSQL: Deployment option/);
  });
});

describe('not asking twice', () => {
  const LAMBDA_FIELDS = {
    serviceCode: 'aWSLambda', serviceName: 'AWS Lambda',
    fields: [
      { id: 'numberOfRequests', type: 'frequency', label: 'Number of requests', options: [{ id: 'perMonth' }] },
      { id: 'durationOfEachRequest', type: 'numericInput', label: 'Duration of each request (in ms)' },
      { id: 'sizeOfMemoryAllocated', type: 'fileSize', label: 'Amount of memory allocated', validSizes: ['mb', 'gb'], defaultUnit: 'mb|NA' },
    ],
    // durationOfEachRequest and sizeOfMemoryAllocated are in catalog.required so the executor
    // asks for them when they are not in minimalConfig (here minimalConfig HAS them, so the
    // preflight would not raise questions — set required without minimalConfig to force asking).
    catalog: { required: [{ field: 'durationOfEachRequest' }, { field: 'sizeOfMemoryAllocated' }], minimalConfig: { region: 'us-east-1', description: 'x', numberOfRequests: { value: '1', unit: 'perMonth' } } },
  };
  const lambdaGateway = () => {
    const base = fakeGateway();
    return {
      ...base,
      callTool: async (name: string, args: Record<string, unknown>) => {
        if (name === 'search_services' && String(args.query).includes('Lambda')) return { text: JSON.stringify([{ key: 'aWSLambda', name: 'AWS Lambda' }]), isError: false };
        if (name === 'get_service_fields' && /lambda/i.test(String(args.service))) return { text: JSON.stringify(LAMBDA_FIELDS), isError: false };
        return base.callTool(name, args);
      },
    };
  };
  const basePlan = {
    planId: 'p', workbookId: 'w', status: 'NEEDS_INPUT' as const, currentRevisionId: 'r',
    detectedDimensions: { regions: [], environments: [], scenarios: [], serviceFamilies: [], resourceCount: 3, mappedResourceCount: 3, excludedCount: 0, coveragePct: 100 },
    recommendedScenarios: [],
    revisions: [{ revisionId: 'r', planId: 'p', createdAt: '2026-09-03T00:00:00.000Z', createdBy: 'system' as const, scenarios: [], requirements: [], decisions: [], hash: 'h'.repeat(16) }],
  };
  const lambdaRows = [
    { raw: 'a', service: 'AWS Lambda', scenario: '26-27', quantities: [{ unit: 'requests/month' as const, amount: 1000, basis: 'invocations', conversions: [] as string[] }] },
    { raw: 'b', service: 'AWS Lambda', scenario: '27-28', quantities: [{ unit: 'requests/month' as const, amount: 2000, basis: 'invocations', conversions: [] as string[] }] },
    { raw: 'c', service: 'AWS Lambda', scenario: '28-29', quantities: [{ unit: 'requests/month' as const, amount: 3000, basis: 'invocations', conversions: [] as string[] }] },
  ];

  it('does not re-ask for Lambda memory and duration when the plan already asks under lambda.execution_profile', async () => {
    const plan = { ...basePlan, unresolved: [{ id: 'q1', prompt: 'Provide the Lambda execution profile', field: 'lambda.execution_profile', scope: ['service:Lambda'], impact: 'high' as const, resolved: false }] };
    const enriched = await enrichPlanWithCalculatorPreflight(plan, lambdaRows, 'ap-south-1', lambdaGateway(), [], 10_000);
    expect(enriched.added).toBe(0);
    expect(enriched.plan.unresolved).toHaveLength(1);
  });

  it('asks once, scoped to every row that needs it, when nothing in the plan covers the input', async () => {
    const plan = { ...basePlan, unresolved: [] };
    const enriched = await enrichPlanWithCalculatorPreflight(plan, lambdaRows, 'ap-south-1', lambdaGateway(), [], 10_000);
    const fields = enriched.plan.unresolved.map((question) => question.field).sort();
    expect(fields).toEqual(['calculator.amountOfMemoryAllocated', 'calculator.durationOfEachRequest']);
    // Three fiscal-year rows, one question each, covering all three.
    for (const question of enriched.plan.unresolved) expect(question.scope.sort()).toEqual(['resource:0', 'resource:1', 'resource:2']);
  });
});

describe('semantic preflight', () => {
  it('uses the catalog minimalConfig instance type when none is stated, and never touches an estimate', async () => {
    // Autonomous assumption mode: instanceType is in catalog.required AND in minimalConfig
    // (m5.large). The executor uses the default rather than blocking with a question.
    // The preflight records this as a default-applied note, not a user-facing question.
    const gateway = fakeGateway();
    const calls: string[] = [];
    const original = gateway.callTool;
    gateway.callTool = async (name, args) => { calls.push(name); return original(name, args); };
    const report = await preflightResources([
      { resourceId: 'ec2-no-type', service: 'Amazon EC2', region: 'ap-south-1', configuration: { instanceCount: 3, operatingSystem: 'Linux' } },
      { resourceId: 'ec2-ok', service: 'Amazon EC2', region: 'ap-south-1', configuration: { instanceType: 'm6i.large', instanceCount: 1, operatingSystem: 'Linux' } },
    ], gateway, { fetchDefinition: async () => undefined });

    expect(report.resources.find((entry) => entry.resourceId === 'ec2-ok')).toMatchObject({ ready: true, mapping: 'deterministic', questions: [] });
    // no-type: minimalConfig provides m5.large, so no question is generated
    const noType = report.resources.find((entry) => entry.resourceId === 'ec2-no-type')!;
    expect(noType.questions.filter((q) => q.target === 'instanceType')).toHaveLength(0);
    expect(calls).not.toContain('create_estimate');
    expect(calls).not.toContain('add_service');
  });

  it('offers the schema\'s own choices for a column-form cell the resource left unstated', async () => {
    const report = await preflightResources([
      { resourceId: 'db', service: 'Amazon RDS for PostgreSQL', region: 'ap-south-1', configuration: { instanceType: 'db.r6g.large', nodeCount: 2, engine: 'PostgreSQL' } },
    ], fakeGateway(), { fetchDefinition: async () => undefined });
    const [question] = report.questions;
    expect(question).toMatchObject({ resourceId: 'db', label: 'Deployment option', control: 'dropdown', target: 'columnFormIPM.Deployment Option' });
    expect(question.options).toEqual([{ id: 'Single-AZ', label: 'Single-AZ' }, { id: 'Multi-AZ', label: 'Multi-AZ' }]);
    expect(question.recommended).toBeUndefined();
  });

  it('reports a resource whose service the Calculator does not list as blocked, with the reason', async () => {
    const report = await preflightResources([
      { resourceId: 'x', service: 'Amazon Nonexistent', region: 'ap-south-1', configuration: { instanceCount: 1 } },
    ], fakeGateway(), { fetchDefinition: async () => undefined });
    expect(report.resources[0]).toMatchObject({ ready: false, mapping: 'blocked' });
    expect(report.resources[0].notes.join(' ')).toMatch(/no service matching/);
  });
});
