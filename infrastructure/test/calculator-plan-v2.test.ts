import {
  applyPlanProposal,
  buildInitialPlan,
  confirmPlan,
  createPlanProposal,
} from '../lambdas/shared/estimate-planning';
import { materializePlanResources, planSegments } from '../lambdas/calculator-orchestrator/pipeline';
import type { CalculationResource } from '../schema/calculator';

const rows: CalculationResource[] = [
  {
    raw: 'bespoke-vm,EC2,m7i.large', sheet: 'Any Customer', row: 9,
    name: 'bespoke-vm', service: 'EC2', size: 'm7i.large', quantity: '2', region: 'ap-south-1',
  },
];

describe('Estimate Plan v2 review lifecycle', () => {
  test('asks for a missing region once, not once per workbook row', () => {
    const resources = Array.from({ length: 150 }, (_, index): CalculationResource => ({
      raw: `S3 request volume ${index}`,
      sheet: 'Generic workload',
      row: index + 2,
      service: 'S3',
      name: `Request metric ${index}`,
    }));
    const plan = buildInitialPlan({ workbookId: 'large-book', resources });

    expect(plan.unresolved.filter((entry) => entry.field === 'resource.region')).toEqual([
      expect.objectContaining({ scope: ['all-resources'], prompt: 'Choose one AWS region for this estimate.' }),
    ]);
  });

  test('stores one submitted default region constraint for the whole estimate', () => {
    const resources: CalculationResource[] = [
      { raw: 'S3 storage', service: 'S3', name: 'Storage' },
      { raw: 'Lambda requests', service: 'Lambda', name: 'Requests' },
    ];
    const plan = buildInitialPlan({ workbookId: 'book-hash', resources, defaultRegion: 'ap-south-1' });
    const regions = plan.revisions[0].requirements.filter((entry) => entry.field === 'resource.region');

    expect(plan.unresolved).toHaveLength(0);
    expect(regions).toEqual([
      expect.objectContaining({ scope: ['all-resources'], expected: 'ap-south-1', source: 'user' }),
    ]);
  });

  test('reuses one unambiguous workbook instance class within a service scenario', () => {
    const resources: CalculationResource[] = [
      {
        raw: 'Aurora instance class | db.r7g.large', sheet: 'Workload', row: 4,
        service: 'Amazon Aurora', name: 'Aurora instance class', size: 'db.r7g.large', scenario: 'FY27',
      },
      {
        raw: 'Aurora I/O requests | 20', sheet: 'Workload', row: 5,
        service: 'Amazon Aurora', name: 'Aurora I/O requests', scenario: 'FY27',
      },
      {
        raw: 'Aurora secondary instance count | 1', sheet: 'Workload', row: 6,
        service: 'Amazon Aurora', name: 'Aurora secondary instance count', scenario: 'FY27',
      },
    ];
    const plan = buildInitialPlan({ workbookId: 'book-hash', resources, defaultRegion: 'ap-south-1' });
    const inherited = plan.revisions[0].requirements.filter((entry) => (
      entry.field === 'resource.instance_type' && entry.scope[0] !== 'resource:0'
    ));

    expect(plan.unresolved.filter((entry) => entry.field === 'resource.instance_type')).toHaveLength(0);
    expect(inherited).toEqual([
      expect.objectContaining({ scope: ['resource:1'], expected: 'db.r7g.large', source: 'workbook' }),
      expect.objectContaining({ scope: ['resource:2'], expected: 'db.r7g.large', source: 'workbook' }),
    ]);
    expect(inherited[0].evidence).toContainEqual(expect.objectContaining({ sheet: 'Workload', row: 4 }));
  });

  test('does not guess an instance class when a service scenario contains conflicting classes', () => {
    const resources: CalculationResource[] = [
      { raw: 'db.r7g.large', sheet: 'Workload', service: 'Aurora', size: 'db.r7g.large', scenario: 'Base' },
      { raw: 'db.r7g.xlarge', sheet: 'Workload', service: 'Aurora', size: 'db.r7g.xlarge', scenario: 'Base' },
      { raw: 'I/O requests', sheet: 'Workload', service: 'Aurora', name: 'I/O requests', scenario: 'Base' },
    ];
    const plan = buildInitialPlan({ workbookId: 'book-hash', resources, defaultRegion: 'ap-south-1' });

    expect(plan.unresolved.filter((entry) => entry.field === 'resource.instance_type')).toEqual([
      expect.objectContaining({ scope: ['resource:2'] }),
    ]);
  });

  test('builds a generic auditable plan without customer or workbook-name rules', () => {
    const plan = buildInitialPlan({ workbookId: 'book-hash', resources: rows, now: new Date('2026-08-30T00:00:00Z') });
    expect(plan.detectedDimensions).toMatchObject({
      resourceCount: 1, mappedResourceCount: 1, serviceFamilies: ['EC2'], coveragePct: 100,
    });
    expect(plan.recommendedScenarios[0].pricing_model).toBe('sheet-specified');
    expect(plan.revisions[0].requirements.find((entry) => entry.field === 'resource.instance_type')?.evidence)
      .toContainEqual(expect.objectContaining({ sheet: 'Any Customer', row: 9 }));
  });

  test('creates an immutable structured revision and compiles its constraints into resources', () => {
    const original = buildInitialPlan({ workbookId: 'book-hash', resources: rows });
    const proposal = createPlanProposal(original, { text: 'Use eu-west-1 and run 300 hours per month' });
    expect(proposal.requirements.map((entry) => entry.field)).toEqual([
      'resource.region', 'resource.hours_per_month',
    ]);
    const revised = applyPlanProposal(original, proposal, 'user', new Date('2026-08-30T01:00:00Z'));
    expect(revised.revisions).toHaveLength(2);
    expect(original.revisions).toHaveLength(1);
    expect(revised.currentRevisionId).not.toBe(original.currentRevisionId);

    const current = revised.revisions[1];
    const materialized = materializePlanResources(rows, current);
    expect(materialized[0]).toMatchObject({
      plan_resource_id: '0', region: 'eu-west-1', hoursPerMonth: 300,
    });
    expect(confirmPlan(revised, revised.currentRevisionId).status).toBe('CONFIRMED');
  });

  test('a global region answer resolves legacy per-resource region questions', () => {
    const plan = buildInitialPlan({
      workbookId: 'book-hash',
      resources: [{ raw: 'S3 storage', service: 'S3' }],
    });
    plan.unresolved = [0, 1].map((index) => ({
      id: `legacy-region-${index}`,
      prompt: `Choose a region for row ${index}`,
      field: 'resource.region',
      scope: [`resource:${index}`],
      impact: 'high' as const,
      resolved: false,
    }));
    const proposal = createPlanProposal(plan, { text: 'Use ap-south-1' });
    const revised = applyPlanProposal(plan, proposal);

    expect(revised.unresolved).toHaveLength(0);
    expect(revised.status).toBe('READY');
  });

  test('does not pretend unknown free text became a requirement', () => {
    const plan = buildInitialPlan({ workbookId: 'book-hash', resources: rows });
    const proposal = createPlanProposal(plan, { text: 'make it enterprise grade' });
    expect(proposal.requirements).toHaveLength(0);
    expect(proposal.unresolved).toEqual([expect.objectContaining({ impact: 'high' })]);
    expect(() => applyPlanProposal(plan, proposal)).toThrow('PLAN_PROPOSAL_NEEDS_INPUT');
  });

  test('normalizes compact service answers into typed adapter contracts', () => {
    const plan = buildInitialPlan({ workbookId: 'book-hash', resources: rows });
    const proposal = createPlanProposal(plan, { requirements: [
      { scope: ['service:SageMaker'], field: 'sagemaker.inference_configuration', operator: 'eq', expected: 'real-time inference, ml.g5.xlarge', impact: 'critical' },
      { scope: ['service:Bedrock'], field: 'bedrock.model', operator: 'eq', expected: 'Claude Sonnet 4', impact: 'critical' },
      { scope: ['service:Bedrock'], field: 'bedrock.tokens_per_call', operator: 'eq', expected: 'input 2000, output 500', impact: 'critical' },
      { scope: ['service:Cognito'], field: 'cognito.tier', operator: 'eq', expected: 'Lite, 0', impact: 'critical' },
      { scope: ['service:NAT Gateway'], field: 'nat_gateway.configuration', operator: 'eq', expected: 'Regional NAT Gateway, 1', impact: 'critical' },
      { scope: ['service:QuickSight'], field: 'quicksight.subscription_profile', operator: 'eq', expected: '100%, 0%, 10 GB', impact: 'critical' },
      { scope: ['service:SES'], field: 'ses.send_source', operator: 'eq', expected: 'Another email client / not EC2', impact: 'material' },
    ] });

    expect(proposal.unresolved).toHaveLength(0);
    expect(Object.fromEntries(proposal.requirements.map((entry) => [entry.field, entry.expected]))).toMatchObject({
      'sagemaker.inference_configuration': { workloadType: 'real-time inference', instanceType: 'ml.g5.xlarge' },
      'bedrock.model': 'Anthropic: Claude Sonnet 4',
      'bedrock.tokens_per_call': { inputTokens: 2000, outputTokens: 500 },
      'cognito.tier': { tier: 'Lite', monthlyTokenRequests: 0 },
      'nat_gateway.configuration': { mode: 'Regional NAT Gateway', availabilityZoneCount: 1 },
      'quicksight.subscription_profile': { annualAuthorPercent: 100, monthlyAuthorPercent: 0, spiceGb: 10 },
      'ses.send_source': 'Email client',
    });
  });

  test('keeps unsupported or invalid service answers unresolved', () => {
    const plan = buildInitialPlan({ workbookId: 'book-hash', resources: rows });
    const proposal = createPlanProposal(plan, { requirements: [
      { scope: ['service:SageMaker'], field: 'sagemaker.inference_configuration', operator: 'eq', expected: 'Asynchronous Inference, ml.t2.medium', impact: 'critical' },
      { scope: ['service:Bedrock'], field: 'bedrock.model', operator: 'eq', expected: 'Gemma 3 4B IT', impact: 'critical' },
      { scope: ['service:QuickSight'], field: 'quicksight.subscription_profile', operator: 'eq', expected: '100%, 0%, 0 GB', impact: 'critical' },
    ] });

    expect(proposal.requirements).toHaveLength(0);
    expect(proposal.unresolved).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'sagemaker.inference_configuration', impact: 'high' }),
      expect.objectContaining({ field: 'bedrock.model', impact: 'high' }),
      expect.objectContaining({ field: 'quicksight.subscription_profile', impact: 'high' }),
    ]));
    expect(() => applyPlanProposal(plan, proposal)).toThrow('PLAN_PROPOSAL_NEEDS_INPUT');
  });

  test('selects matching workbook bands instead of pricing every band in every scenario', () => {
    const bandRows = [
      { ...rows[0], scenario: 'fy26', raw: 'fy26' },
      { ...rows[0], scenario: 'fy27', raw: 'fy27' },
    ];
    const result = planSegments(
      [{ label: 'FY26', scope: 'FY26', pricing_model: 'sheet-specified', environments: [] }],
      bandRows,
      [
        { key: 'fy26', label: 'FY26', kind: 'period', sheet: 'Any Customer' },
        { key: 'fy27', label: 'FY27', kind: 'period', sheet: 'Any Customer' },
      ],
      new Map(),
    );
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0].groups[0].rows).toBe(1);
  });

  test('expands fiscal periods and lower environments across requested pricing models', () => {
    const plan = buildInitialPlan({ workbookId: 'matrix-book', resources: rows, defaultRegion: 'ap-south-1' });
    const scenarios = [
      '26-27', '27-28', '28-29', '29-30', '30-31', 'Dev', 'Testing (QA)', 'UAT',
    ].map((label) => ({ label, scope: label, environments: [], pricing_model: 'sheet-specified' as const }));
    plan.recommendedScenarios = scenarios;
    plan.revisions[0].scenarios = scenarios;

    const withOldGlobalRi = applyPlanProposal(plan, createPlanProposal(plan, {
      text: 'Use 1 year Reserved Instances',
    }));
    expect(withOldGlobalRi.revisions[1].requirements).toContainEqual(expect.objectContaining({
      field: 'resource.purchase_model', expected: 'ri-1yr-no-upfront',
    }));

    const instruction = 'the region is ap-south-1 also ECS fargate is 730 hours with 10 tasks per day '
      + 'also DB instances are Multi AZ, also i want 1 yr Reserved Instance plan 3 yrs Reserved Instances '
      + 'Plan and On demand which is already there for each fiscal year and for the Lower Environment '
      + 'the ECS Fargate should be 240 hours';
    const proposal = createPlanProposal(withOldGlobalRi, { text: instruction });

    expect(proposal.scenarios).toHaveLength(18);
    expect(proposal.scenarios?.filter((entry) => entry.pricing_model === 'on-demand')).toHaveLength(6);
    expect(proposal.scenarios?.filter((entry) => entry.pricing_model === 'ri-1yr-no-upfront')).toHaveLength(6);
    expect(proposal.scenarios?.filter((entry) => entry.pricing_model === 'ri-3yr-no-upfront')).toHaveLength(6);
    expect(proposal.scenarios).toContainEqual(expect.objectContaining({
      label: 'Lower environments | 3-Year Reserved, No Upfront',
      environments: ['Dev', 'Testing (QA)', 'UAT'],
    }));
    expect(proposal.requirements.some((entry) => entry.field === 'resource.purchase_model')).toBe(false);
    expect(proposal.requirements.filter((entry) => entry.field === 'resource.hours_per_month')).toEqual([
      expect.objectContaining({ expected: 730, scope: expect.arrayContaining(['scenario:0', 'service:ECS Fargate']) }),
      expect.objectContaining({ expected: 240, scope: expect.arrayContaining(['scenario:15', 'service:ECS Fargate']) }),
    ]);

    const revised = applyPlanProposal(withOldGlobalRi, proposal);
    const current = revised.revisions.at(-1)!;
    expect(current.requirements.filter((entry) => entry.field === 'scenario.purchase_model')).toHaveLength(18);
    expect(current.requirements.some((entry) => entry.field === 'resource.purchase_model')).toBe(false);
  });

  test('keeps lower environments out when fiscal-year plans explicitly ignore them', () => {
    const plan = buildInitialPlan({ workbookId: 'matrix-book', resources: rows, defaultRegion: 'ap-south-1' });
    const scenarios = [
      '26-27', '27-28', '28-29', '29-30', '30-31', 'Dev', 'Testing (QA)', 'UAT',
    ].map((label) => ({ label, scope: label, environments: [], pricing_model: 'sheet-specified' as const }));
    plan.recommendedScenarios = scenarios;
    plan.revisions[0].scenarios = scenarios;

    const proposal = createPlanProposal(plan, {
      text: 'Generate On Demand, 1 yr plan and 3 yr plan for each fiscal year and ignore lower environments for now.',
    });

    expect(proposal.scenarios).toHaveLength(15);
    expect(proposal.scenarios?.filter((entry) => entry.pricing_model === 'on-demand')).toHaveLength(5);
    expect(proposal.scenarios?.filter((entry) => entry.pricing_model === 'compute-savings-1yr')).toHaveLength(5);
    expect(proposal.scenarios?.filter((entry) => entry.pricing_model === 'compute-savings-3yr')).toHaveLength(5);
    expect(proposal.scenarios?.some((entry) => /Dev|Testing|UAT|Lower/i.test(`${entry.label} ${entry.scope}`))).toBe(false);

    const revised = applyPlanProposal(plan, proposal);
    expect(revised.revisions.at(-1)?.scenarios).toHaveLength(15);
    expect(revised.recommendedScenarios).toHaveLength(15);
  });

  test('applies a scenario-scoped service runtime and rescales canonical Fargate dimensions', () => {
    const resources: CalculationResource[] = [{
      raw: 'Fargate', service: 'AWS Fargate', scenario: 'lower', quantity: '10',
      vcpu: 1, ram_gb: 2, hoursPerMonth: 730,
      quantities: [
        { unit: 'vCPU-hours/month', amount: 7_300, basis: 'task vCPU', conversions: [] },
        { unit: 'GB-hours/month', amount: 14_600, basis: 'task memory', conversions: [] },
      ],
    }];
    const result = planSegments(
      [{ label: 'Lower | On-Demand', scope: 'Lower', environments: [], pricing_model: 'on-demand' }],
      resources,
      [{ key: 'lower', label: 'Lower', kind: 'environment', sheet: 'Generic' }],
      new Map(),
      [{
        id: 'lower-hours', scope: ['scenario:0', 'service:ECS Fargate'],
        field: 'resource.hours_per_month', operator: 'eq', expected: 240,
        impact: 'critical', source: 'user',
      }],
    );

    expect(result.segments[0].groups[0]).toMatchObject({
      hoursPerMonth: 240,
      quantities: [
        expect.objectContaining({ unit: 'vCPU-hours/month', amount: 2_400 }),
        expect.objectContaining({ unit: 'GB-hours/month', amount: 4_800 }),
      ],
    });
  });
});
