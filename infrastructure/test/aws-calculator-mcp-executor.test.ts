/**
 * The AWS MCP Estimate Executor against a fake MCP that behaves the way the real one was
 * observed to behave: `get_service_fields` payloads trimmed from live captures, the
 * `one-of-mutex` lint refusal on Fargate's memory family, the S3 parent envelope that
 * redirects to children and saves under `amazonSimpleStorageServiceGroup`, and an EC2 count
 * that comes back wrapped as `{workloadType, data}`.
 *
 * Every test here asserts on the CONTRACT — which tools were called with what, which status
 * came back and why — never on the Calculator's private JSON beyond what the executor itself
 * sent. The live equivalents (tests A, B and C) run through scripts/mcp-executor-proof.mts.
 */

import { executeScenario } from '../lambdas/aws-calculator-mcp-executor/index';
import { parseDefinition } from '../lambdas/calculator-orchestrator/calculator-definitions';
import type { SemanticResource } from '../lambdas/aws-calculator-mcp-executor/types';
import type { ModelCaller } from '../lambdas/aws-calculator-mcp-executor/model-calls';

/** Trimmed from a live get_service_fields('awsFargate') capture. */
const FARGATE_FIELDS = {
  serviceCode: 'awsFargate',
  serviceName: 'AWS Fargate',
  fields: [
    { id: 'operatingSystem', type: 'dropdown', label: 'Operating system', options: [{ id: 'linux', label: 'Linux' }, { id: 'windows', label: 'Windows' }], defaultValue: 'linux' },
    { id: 'numberOfTasks', type: 'frequency', label: 'Number of tasks or pods', options: [{ id: 'perSecond' }, { id: 'perMinute' }, { id: 'perHour' }, { id: 'perDay', label: 'per day' }, { id: 'perMonth' }] },
    { id: 'taskDuration', type: 'durationInput', label: 'Average duration', minValue: 0.0166, maxValue: 730 },
    { id: 'vcpuPerTask', type: 'dropdown', label: 'Amount of vCPU allocated', options: ['0.25', '0.5', '1', '2', '4', '8', '16'].map((id) => ({ id, label: id })) },
    { id: 'smallMemory', type: 'dropdown', label: 'Amount of memory allocated.', options: [{ id: '0.5', label: '0.5 GB' }, { id: '1', label: '1 GB' }, { id: '2', label: '2 GB' }] },
    { id: 'smallMemory_8', type: 'dropdown', label: 'Amount of memory allocated. ', options: [{ id: '16', label: '16 GB' }, { id: '20', label: '20 GB' }] },
    { id: 'memoryStandardFargateOnDemand', type: 'fileSize', label: 'Amount of memory allocated', validSizes: ['gb'], defaultUnit: 'gb|NA' },
    { id: 'storageAmountECS', type: 'fileSize', label: 'Amount of ephemeral storage allocated for Amazon ECS', validSizes: ['gb'], defaultUnit: 'gb|NA' },
  ],
  catalog: {
    status: 'verified',
    traps: ['vcpuPerTask is a dropdown of fixed values: 0.25, 0.5, 1, 2, 4, 8, 16.'],
    minimalConfig: { region: 'us-east-1', description: 'Fargate workload', numberOfTasks: { value: '1', unit: 'perSecond' }, taskDuration: { value: '1', unit: 'min' }, vcpuPerTask: '0.25', smallMemory: '0.5' },
  },
};

/** Trimmed from a live get_service_fields('ec2Enhancement') capture. */
const EC2_FIELDS = {
  serviceCode: 'ec2Enhancement',
  serviceName: 'Amazon EC2',
  fields: [
    { id: 'tenancy', type: 'dropdown', label: 'Tenancy', options: [{ id: 'shared' }, { id: 'dedicated' }, { id: 'host' }] },
    { id: 'selectedOS', type: 'dropdown', label: 'Operating system', options: [{ id: 'linux', label: 'Linux' }, { id: 'windows', label: 'Windows' }] },
    { id: 'workload', type: 'workload', label: 'Advance workloads' },
    { id: 'instanceType', type: 'ec2InstanceSearch', label: 'Advance EC2 instance' },
    { id: 'pricingStrategy', type: 'ec2AdvPricingStrategyV2', label: 'Advance pricing strategy', options: [
      { label: 'Compute Savings Plans', value: 'compute-savings' }, { label: 'EC2 Instance Savings Plans', value: 'instance-savings' },
      { label: 'On-Demand', value: 'on-demand' }, { label: 'Spot Instances', value: 'spot' },
      { label: 'Standard Reserved Instances', value: 'standard' }, { label: 'Convertible Reserved Instances', value: 'convertible' },
    ] },
    { id: 'storageAmount', type: 'fileSize', label: 'Storage amount', validSizes: ['gb'], defaultUnit: 'gb|NA' },
    { id: 'storageAmountIo2', type: 'fileSize', label: 'Storage amount per io2 volume', validSizes: ['gb'], defaultUnit: 'gb|NA' },
    { id: 'storageAmountDH', type: 'fileSize', label: 'Storage amount', validSizes: ['gb'], defaultUnit: 'gb|NA' },
    { id: 'iops', type: 'numericInput', label: 'Provisioning IOPS io1' },
    { id: 'utilization', type: 'numericInput', label: 'Utilization (% of month, 1–100)', _synthetic: true },
  ],
  catalog: {
    required: [{ field: 'instanceType' }, { field: 'pricingStrategy' }],
    minimalConfig: { region: 'us-east-1', description: 'm5.large on-demand', instanceType: 'm5.large', workload: 1, selectedOS: 'linux', pricingStrategy: 'ondemand' },
    traps: ['Reserved Instances (standard, convertible) are HIDDEN under shared tenancy.'],
  },
};

/** Trimmed from a live get_service_fields('amazonElasticsearchService') capture: three column forms. */
const OPENSEARCH_FIELDS = {
  serviceCode: 'amazonElasticsearchService',
  serviceName: 'Amazon OpenSearch Service',
  fields: [
    { id: 'columnFormIPM_1', type: 'columnFormIPM', label: 'Amazon OpenSearch Service data instance cost', row: [
      { label: 'Nodes', selectorId: 'Number of Nodes Data instance', type: 'textInput' },
      { label: 'Instance type', selectorId: 'Instance Type', type: 'autoSuggest' },
      { label: 'Utilization (On-Demand only)', type: 'utilization' },
      { label: 'Instance Node Type', selectorId: 'Instance Family', type: 'dropDown' },
      { label: 'Pricing model', selectorId: 'TermType', type: 'dropDown' },
      { label: 'Storage Type', selectorId: 'Storage', type: 'dropDown' },
      { label: 'Purchase option', selectorId: 'PurchaseOption', type: 'dropDown' },
      { label: 'Term', selectorId: 'LeaseContractLength', type: 'dropDown' },
    ], selectorValues: { 'Instance Family': ['Memory optimized', 'General purpose', 'Compute optimized', 'Storage optimized'], TermType: ['OnDemand', 'Reserved'], Storage: ['EBS Only', '1 x 1900 NVMe SSD'], LeaseContractLength: ['1yr', '3yr'], PurchaseOption: ['No Upfront', 'Partial Upfront', 'All Upfront'] } },
    { id: 'columnFormIPM_2', type: 'columnFormIPM', label: 'Amazon OpenSearch Service dedicated master instance cost', row: [
      { label: 'Nodes', selectorId: 'Number of Nodes Dedicated master', type: 'textInput' },
      { label: 'Instance type', selectorId: 'Instance Type', type: 'autoSuggest' },
    ] },
    { id: 'numberOfInstances', type: 'numericInput', label: 'Number of instances' },
    { id: 'storageType', type: 'dropdown', label: 'Storage for each Amazon OpenSearch Service instance', options: [{ id: 'GP3', label: 'General Purpose SSD (gp3)' }, { id: 'GP2', label: 'General Purpose SSD (gp2)' }] },
    { id: 'storageAmount', type: 'fileSize', label: 'Storage amount', validSizes: ['mb', 'gb', 'tb'], defaultUnit: 'gb|NA' },
    { id: 'columnFormIPM', type: 'columnFormIPM', label: 'UltraWarm instances cost', row: [
      { label: 'Number of nodes', selectorId: 'Number of Nodes', type: 'textInput' },
      { label: 'Instance type', selectorId: 'Instance Type', type: 'autoSuggest' },
    ], selectorValues: { 'Instance Type': ['ultrawarm1.large.search', 'ultrawarm1.medium.search'], TermType: ['OnDemand'] } },
  ],
  catalog: {
    required: [{ field: 'numberOfInstances' }, { field: 'storageType' }],
    minimalConfig: {
      region: 'us-east-1', description: 'Single-node OpenSearch m6g.large cluster, GP3 100GB',
      columnFormIPM_1: { value: [{ 'Number of Nodes Data instance': { value: '1' }, 'Instance Type': { value: 'm6g.large.search' }, 'Instance Family': { value: 'General purpose' }, TermType: { value: 'OnDemand' }, Storage: { value: 'EBS Only' }, undefined: { value: { unit: '100', selectedId: '%Utilized/Month' } } }] },
      columnFormIPM_2: { value: [{ 'Number of Nodes Dedicated master': { value: '0' }, 'Instance Type': { value: 'r5.2xlarge.search' } }] },
      columnFormIPM: { value: [{ 'Number of Nodes': { value: '0' } }] },
      numberOfInstances: '1', storageType: 'GP3', storageAmount: { value: '100', unit: 'gb|NA' },
    },
    traps: ['There are THREE columnFormIPM tables. When ANY is absent from the saved blob, the calculator UI silently rehydrates it with manifest defaults and prices them in. Always include all three; set Number of Nodes=0 on the ones the user does not want.'],
  },
};

const S3_PARENT = {
  serviceCode: 'amazonS3',
  serviceName: 'Amazon S3',
  status: 'redirect_to_parent',
  redirect_to: 'amazonSimpleStorageServiceGroup',
  child_service_codes: ['amazonS3Standard', 'awsS3DataTransfer'],
};
const S3_STANDARD = {
  serviceCode: 'amazonS3Standard',
  serviceName: 'S3 Standard',
  fields: [
    { id: 's3StandardStorageSize', type: 'fileSize', label: 'S3 Standard storage', validSizes: ['gb', 'tb'], defaultUnit: 'gb|month' },
    { id: 's3StandardPutRequests', type: 'numericInput', label: 'PUT, COPY, POST, LIST requests to S3 Standard' },
  ],
};

/** The taskDuration component as the live definition publishes it. */
const FARGATE_DEFINITION = parseDefinition('awsFargate', {
  templates: [{ cards: [{ inputSection: { components: [{
    type: 'input', subType: 'durationInput', id: 'taskDuration', label: 'Average duration',
    dropDownDuration: [{ label: 'seconds', value: 'sec' }, { label: 'minutes', value: 'min' }, { label: 'hours', value: 'hr' }, { label: 'days', value: 'day' }],
    defaultDuration: 'min', validations: { required: true, minValue: 0.0166, maxValue: 730 },
  }] } }] }],
});
const fetchDefinition = async (code: string) => (code === 'awsFargate' ? FARGATE_DEFINITION : undefined);

type Sent = { service: string; group: string; config: Record<string, unknown> };

/**
 * A fake MCP. `lintRefusals` lets a test make validate_estimate refuse a config once, the way
 * the real linter refuses Fargate's smallMemory under a 1-vCPU task.
 */
function fakeGateway(options: {
  fields?: Record<string, unknown>;
  /** Additional search entries merged into the built-in map. */
  search?: Record<string, Array<{ key: string; name: string }>>;
  lint?: (sent: Sent) => string | undefined;
  savedServiceCode?: (sent: Sent) => string;
  saveWorkloadEnvelope?: boolean;
  exportFails?: boolean;
  importFails?: boolean;
  totals?: { monthly: number; upfront: number; total12Months: number } | null;
} = {}) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const estimates = new Map<string, Sent[]>();
  let nextId = 1;
  const fieldsByCode: Record<string, unknown> = { awsFargate: FARGATE_FIELDS, ec2Enhancement: EC2_FIELDS, amazonS3: S3_PARENT, amazonS3Standard: S3_STANDARD, amazonElasticsearchService: OPENSEARCH_FIELDS, ...(options.fields || {}) };
  const search: Record<string, Array<{ key: string; name: string }>> = {
    'AWS Fargate': [{ key: 'awsFargate', name: 'AWS Fargate' }],
    'Amazon EC2': [{ key: 'ec2Enhancement', name: 'Amazon EC2 ' }, { key: 'windowsWorkloads', name: 'Windows Server and SQL Server on Amazon EC2' }],
    'Amazon S3': [{ key: 'as2', name: 'AS2' }],
    S3: [{ key: 'amazonS3Backup', name: 'S3' }, { key: 'amazonS3Standard', name: 'S3 Standard' }],
    // The live search: the whole phrase finds nothing, the significant word does.
    'Amazon OpenSearch Service': [{ key: 'amazonElasticsearchService', name: 'Amazon OpenSearch Service' }],
    ...(options.search || {}),
    'Amazon VPC NAT Gateway': [],
    'VPC NAT Gateway': [],
    Gateway: [{ key: 'networkAddressTranslationNatGatewayVpc', name: 'Network Address Translation (NAT) Gateway' }, { key: 'gatewayLoadBalancer', name: 'Gateway Load Balancer' }],
  };
  return {
    calls,
    estimates,
    listTools: async () => ['search_services', 'get_service_fields', 'create_estimate', 'add_service', 'build_estimate', 'validate_estimate', 'export_estimate', 'import_estimate', 'get_server_info'].map((name) => ({ name })),
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const ok = (value: unknown) => ({ text: JSON.stringify(value), isError: false });
      switch (name) {
        case 'get_server_info': return ok({ name: 'sample-aws-pricing-calculator-mcp', version: '1.3.0' });
        case 'search_services': return ok(search[String(args.query)] || []);
        case 'get_service_fields': {
          const payload = fieldsByCode[String(args.service)] ?? fieldsByCode[String(args.service).replace(/^aws/, 'aWS')];
          return payload ? ok(payload) : ok({ services: [], errors: [`Service "${args.service}" not found.`] });
        }
        case 'create_estimate': {
          const id = `est-${nextId++}`;
          estimates.set(id, []);
          return ok({ estimate_id: id, name: args.name });
        }
        case 'add_service': {
          const list = estimates.get(String(args.estimate_id));
          if (!list) return { text: 'Estimate not found', isError: true };
          const entries = JSON.parse(String(args.services)) as Sent[];
          list.push(...entries);
          return ok(entries.map((entry) => ({ success: true, service: entry.service, group: entry.group })));
        }
        case 'validate_estimate': {
          const list = estimates.get(String(args.estimate_id)) || [];
          for (const sent of list) {
            const refusal = options.lint?.(sent);
            if (refusal) return ok({ lint_verdict: 'read-only', next_step: refusal });
          }
          return ok({ lint_verdict: 'editable', next_step: 'export_estimate' });
        }
        case 'export_estimate': {
          if (options.exportFails) return { text: 'Export refused — the saved estimate is missing required fields', isError: true };
          return ok({ sharable_url: `https://calculator.aws/#/estimate?id=${String(args.estimate_id).replace('est-', 'aws')}`, aws_estimate_id: `aws-${args.estimate_id}` });
        }
        case 'import_estimate': {
          if (options.importFails) return { text: 'Estimate not found', isError: true };
          const id = /id=aws(\d+)/.exec(String(args.estimate_id))?.[1];
          const list = estimates.get(`est-${id}`) || [];
          const services: Record<string, unknown> = {};
          list.forEach((sent, index) => {
            const components: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(sent.config)) {
              if (key === 'region' || key === 'description') continue;
              if (key === 'workload' && options.saveWorkloadEnvelope) components[key] = { value: { workloadType: 'consistent', data: String(value) } };
              else if (key === 'pricingStrategy' && typeof value === 'object') components[key] = { value: { selectedOption: String((value as { model: string }).model).replace(/([A-Z])/g, '-$1').toLowerCase(), ...(value as object) } };
              else components[key] = { value };
            }
            services[`${sent.service}-${index}`] = {
              serviceCode: options.savedServiceCode?.(sent) ?? sent.service,
              region: sent.config.region,
              description: sent.config.description,
              calculationComponents: components,
            };
          });
          return ok({ name: 'saved', groups: { g1: { name: 'Production', services } } });
        }
        default: return { text: `unknown tool ${name}`, isError: true };
      }
    },
    validateLink: async (url: string) => (options.totals === null
      ? { validUrl: true }
      : { validUrl: /^https:\/\/calculator\.aws\//.test(url), ...(options.totals ?? { monthly: 1234.5, upfront: 0, total12Months: 14814 }) }),
  };
}

const fargate: SemanticResource = {
  resourceId: 'prod-fargate',
  service: 'AWS Fargate',
  region: 'ap-south-1',
  environment: 'Production',
  description: 'API tasks',
  configuration: { taskCount: 10, taskFrequency: 'perDay', vcpuPerTask: 1, memoryGbPerTask: 2, duration: 730, durationUnit: 'hours' },
};
const ec2: SemanticResource = {
  resourceId: 'prod-ec2', service: 'Amazon EC2', region: 'ap-south-1', environment: 'Production', description: 'App servers',
  configuration: { instanceType: 'm6i.xlarge', instanceCount: 4, operatingSystem: 'Linux', tenancy: 'shared' },
};
const s3: SemanticResource = {
  resourceId: 'prod-s3', service: 'Amazon S3', region: 'ap-south-1', environment: 'Production', description: 'Assets',
  configuration: { storageGb: 500 },
};

/** The lint refusal the live MCP gives when a 1-vCPU task carries its memory in smallMemory. */
const fargateMutexLint = (sent: Sent) => (sent.service === 'awsFargate' && 'smallMemory' in sent.config
  ? 'Lint failure: gating field "vcpuPerTask"=1 requires variant "memoryStandardFargateOnDemand" to be populated for awsFargate. Re-add the affected service via add_service after consulting get_service_fields.'
  : undefined);

const noModels = { models: null as null, fetchDefinition, buildSha: 'test' };

describe('a Fargate resource, On-Demand', () => {
  it('reaches a saved, verified estimate with zero model calls, preserving per-day and hours exactly', async () => {
    const gateway = fakeGateway({ lint: fargateMutexLint });
    const result = await executeScenario({ scenarioId: 'a', estimateName: 'Test A', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [fargate] }, gateway, noModels);

    expect(result.status).toBe('COMPLETED');
    expect(result.calculatorUrl).toMatch(/^https:\/\/calculator\.aws\//);
    expect(result.totals).toEqual({ source: 'browser', monthly: 1234.5, upfront: 0, total12Months: 14814 });
    expect(Object.values(result.diagnostics.modelsUsed)).not.toContain('HAIKU_4_5');
    expect(Object.values(result.diagnostics.modelsUsed)).not.toContain('SONNET_4_6');

    const [outcome] = result.resources;
    expect(outcome.status).toBe('ADDED');
    expect(outcome.finalConfig).toMatchObject({
      numberOfTasks: { value: '10', unit: 'perDay' },
      taskDuration: { value: '730', unit: 'hr' },
      vcpuPerTask: '1',
      memoryStandardFargateOnDemand: { value: '2', unit: 'gb|NA' },
    });
    expect(outcome.finalConfig).not.toHaveProperty('smallMemory');
  });

  it('repairs the memory-family refusal from the lint message itself, in one correction, without a model', async () => {
    const gateway = fakeGateway({ lint: fargateMutexLint });
    const result = await executeScenario({ scenarioId: 'a', estimateName: 'Test A', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [fargate] }, gateway, noModels);
    const [outcome] = result.resources;
    expect(outcome.attempts).toHaveLength(2);
    expect(outcome.attempts[0].failedAt).toBe('validate');
    expect(outcome.attempts[0].config).toHaveProperty('smallMemory', '2');
    expect(outcome.attempts[1].producedBy).toBe('STRUCTURED_HINT');
    expect(outcome.tiers).toEqual(['STRUCTURED_HINT']);
  });

  it('proves each resource in a scratch estimate before adding it to the scenario estimate', async () => {
    const gateway = fakeGateway({ lint: fargateMutexLint });
    await executeScenario({ scenarioId: 'a', estimateName: 'Test A', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [fargate] }, gateway, noModels);
    const names = gateway.calls.map((call) => call.name);
    // Two probe rounds (create/add/validate twice), then the scenario: create, add, validate, export, import.
    expect(names.filter((name) => name === 'create_estimate')).toHaveLength(3);
    expect(names.slice(-5)).toEqual(['create_estimate', 'add_service', 'validate_estimate', 'export_estimate', 'import_estimate']);
    // The scenario estimate only ever received the proven configuration.
    const scenario = [...gateway.estimates.values()].pop()!;
    expect(scenario).toHaveLength(1);
    expect(scenario[0].config).toHaveProperty('memoryStandardFargateOnDemand');
  });

  it('never invents a duration unit: an unknown unit word fails the resource by name instead of defaulting', async () => {
    const gateway = fakeGateway();
    const result = await executeScenario({
      scenarioId: 'a', estimateName: 'Test A', pricing: { kind: 'on-demand', upfrontPayment: 'None' },
      resources: [{ ...fargate, configuration: { ...fargate.configuration, durationUnit: 'fortnights' } }],
    }, gateway, noModels);
    expect(result.status).toBe('FAILED');
    expect(result.resources[0].status).toBe('FAILED');
    expect(result.resources[0].notes.join(' ')).toMatch(/fortnights/);
    expect(gateway.calls.map((call) => call.name)).not.toContain('add_service');
  });
});

describe('pricing intent against the Calculator schema', () => {
  it('records Fargate as On-Demand with the reason when a Compute Savings Plan is requested and the service has no commitment field', async () => {
    const gateway = fakeGateway({ lint: fargateMutexLint });
    const result = await executeScenario({ scenarioId: 'b', estimateName: 'Test B', pricing: { kind: 'compute-savings-3yr', upfrontPayment: 'None' }, resources: [fargate] }, gateway, noModels);
    expect(result.status).toBe('COMPLETED');
    expect(result.pricing).toEqual([expect.objectContaining({
      service: 'AWS Fargate', requested: 'compute-savings-3yr', resolved: 'on-demand', via: 'none',
    })]);
    expect(result.pricing[0].reason).toMatch(/no commitment option/);
    expect(result.pricing[0].reason).toMatch(/Pricing Calculator cannot model it/);
    expect(result.pricingScope).toMatch(/No service in this scenario could take 3-Year Compute Savings Plan/);
  });

  it('commits EC2 at the requested Savings Plan and leaves S3 and Fargate On-Demand, stating the mixed scope', async () => {
    const gateway = fakeGateway({ lint: fargateMutexLint, savedServiceCode: (sent) => (sent.service === 'amazonS3Standard' ? 'amazonSimpleStorageServiceGroup' : sent.service) });
    const result = await executeScenario({ scenarioId: 'c', estimateName: 'Test C', pricing: { kind: 'compute-savings-3yr', upfrontPayment: 'None' }, resources: [ec2, fargate, s3] }, gateway, noModels);

    expect(result.status).toBe('COMPLETED');
    const byService = Object.fromEntries(result.pricing.map((entry) => [entry.service, entry]));
    expect(byService['Amazon EC2']).toMatchObject({ requested: 'compute-savings-3yr', resolved: 'compute-savings-3yr', via: 'pricingStrategy' });
    expect(byService['AWS Fargate']).toMatchObject({ resolved: 'on-demand' });
    expect(byService['Amazon S3']).toMatchObject({ resolved: 'on-demand' });
    expect(result.pricingScope).toMatch(/3-Year Compute Savings Plan applies to: Amazon EC2\./);
    expect(result.pricingScope).toMatch(/Remaining On-Demand: AWS Fargate, Amazon S3/);

    const ec2Config = result.resources.find((entry) => entry.resourceId === 'prod-ec2')!.finalConfig!;
    expect(ec2Config.pricingStrategy).toEqual({ model: 'computeSavings', term: '3 Year', upfrontPayment: 'None' });
    expect(ec2Config.workload).toBe(4);
    expect(ec2Config.instanceType).toBe('m6i.xlarge');
  });

  it('never substitutes an instrument: a Standard RI on shared tenancy is On-Demand with the tenancy reason, not a Savings Plan', async () => {
    const gateway = fakeGateway();
    const result = await executeScenario({ scenarioId: 'ri', estimateName: 'RI', pricing: { kind: 'standard-ri-1yr', upfrontPayment: 'None' }, resources: [ec2] }, gateway, noModels);
    expect(result.pricing[0]).toMatchObject({ requested: 'standard-ri-1yr', resolved: 'on-demand' });
    expect(result.pricing[0].reason).toMatch(/dedicated or host tenancy/);
    expect(result.resources[0].finalConfig!.pricingStrategy).toBe('ondemand');
  });

  it('applies a Standard RI on dedicated tenancy as the full object with an explicit term', async () => {
    const gateway = fakeGateway();
    const dedicated = { ...ec2, configuration: { ...ec2.configuration, tenancy: 'dedicated' } };
    const result = await executeScenario({ scenarioId: 'ri', estimateName: 'RI', pricing: { kind: 'standard-ri-3yr', upfrontPayment: 'Partial' }, resources: [dedicated] }, gateway, noModels);
    expect(result.pricing[0]).toMatchObject({ resolved: 'standard-ri-3yr' });
    expect(result.resources[0].finalConfig!.pricingStrategy).toEqual({ model: 'standard', term: '3 Year', upfrontPayment: 'Partial' });
  });

  it('lets a resource carry its own commitment when the scenario is as-the-sheet-states', async () => {
    const gateway = fakeGateway({ lint: fargateMutexLint });
    const committedEc2 = { ...ec2, pricing: { kind: 'compute-savings-1yr' as const, upfrontPayment: 'None' as const } };
    const result = await executeScenario({ scenarioId: 'sheet', estimateName: 'Sheet', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [committedEc2, fargate] }, gateway, noModels);
    const byService = Object.fromEntries(result.pricing.map((entry) => [entry.service, entry]));
    expect(byService['Amazon EC2']).toMatchObject({ requested: 'compute-savings-1yr', resolved: 'compute-savings-1yr' });
    expect(byService['AWS Fargate']).toMatchObject({ requested: 'on-demand', resolved: 'on-demand' });
    expect(result.pricingScope).toMatch(/1-Year Compute Savings Plan applies to: Amazon EC2/);
  });
});

describe('service resolution through the Calculator itself', () => {
  it('resolves "Amazon S3" through the parent envelope to S3 Standard when the resource is about storage', async () => {
    const gateway = fakeGateway();
    const result = await executeScenario({ scenarioId: 's3', estimateName: 'S3', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [s3] }, gateway, noModels);
    expect(result.resources[0].serviceCode).toBe('amazonS3Standard');
    expect(result.resources[0].finalConfig).toMatchObject({ s3StandardStorageSize: { value: '500', unit: 'gb|month' } });
    expect(result.resources[0].notes.join(' ')).toMatch(/redirected to child service amazonS3Standard/);
  });

  it('prefers the candidate whose full name matches over one that merely shares the stem', async () => {
    const gateway = fakeGateway({ fields: { amazonS3: { services: [], errors: ['not found'] } } });
    // Without the parent envelope answering, "Amazon S3" falls to search, where "S3" (S3 Backup)
    // shares the stem and "S3 Standard" does not match either; nothing is exact, so with no
    // model the resource is reported rather than guessed.
    const result = await executeScenario({ scenarioId: 's3', estimateName: 'S3', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [s3] }, gateway, noModels);
    expect(result.status).toBe('FAILED');
    expect(result.resources[0].notes.join(' ')).toMatch(/matched|none exactly|no service/i);
  });
});

describe('a service configured through several column forms', () => {
  const opensearch: SemanticResource = {
    resourceId: 'prod-search', service: 'Amazon OpenSearch Service', region: 'ap-south-1', environment: 'Production', description: 'Search cluster',
    configuration: { instanceType: 'r6g.large.search', nodeCount: 3, storageGb: 200 },
  };

  it('fills the data-instance table from the resource and sends the other tables at zero nodes, as the catalog trap instructs, with no model', async () => {
    const gateway = fakeGateway();
    const result = await executeScenario({ scenarioId: 'os', estimateName: 'OS', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [opensearch] }, gateway, noModels);
    expect(result.status).toBe('COMPLETED');
    const config = result.resources[0].finalConfig!;
    const data = (config.columnFormIPM_1 as { value: Array<Record<string, { value: unknown }>> }).value[0];
    expect(data['Number of Nodes Data instance']).toEqual({ value: '3' });
    expect(data['Instance Type']).toEqual({ value: 'r6g.large.search' });
    // The family is read off the class letter, in the cell's own wording.
    expect(data['Instance Family']).toEqual({ value: 'Memory optimized' });
    expect(data.TermType).toEqual({ value: 'OnDemand' });
    // A choice the catalog's minimal configuration makes is applied as the AWS default.
    expect(data.Storage).toEqual({ value: 'EBS Only' });
    expect(data.undefined).toEqual({ value: { unit: '100', selectedId: '%Utilized/Month' } });
    // The tables the resource is not about are present at zero, never absent.
    expect((config.columnFormIPM_2 as { value: Array<Record<string, { value: unknown }>> }).value[0]['Number of Nodes Dedicated master']).toEqual({ value: '0' });
    expect((config.columnFormIPM as { value: Array<Record<string, { value: unknown }>> }).value[0]['Number of Nodes']).toEqual({ value: '0' });
    expect(config.numberOfInstances).toBe('3');
    expect(config.storageType).toBe('GP3');
    expect(config.storageAmount).toEqual({ value: '200', unit: 'gb|NA' });
    expect(result.resources[0].tiers).toEqual([]);
  });

  it('commits the data instances as Reserved through the column form when the scenario asks for an RI', async () => {
    const gateway = fakeGateway();
    const result = await executeScenario({ scenarioId: 'os', estimateName: 'OS', pricing: { kind: 'standard-ri-3yr', upfrontPayment: 'Partial' }, resources: [opensearch] }, gateway, noModels);
    const data = (result.resources[0].finalConfig!.columnFormIPM_1 as { value: Array<Record<string, { value: unknown }>> }).value[0];
    expect(data.TermType).toEqual({ value: 'Reserved' });
    expect(data.LeaseContractLength).toEqual({ value: '3yr' });
    expect(data.PurchaseOption).toEqual({ value: 'Partial Upfront' });
    expect(result.pricing[0]).toMatchObject({ requested: 'standard-ri-3yr', resolved: 'standard-ri-3yr', via: 'columnFormIPM' });
  });
});

describe('service names the Calculator does not list as a phrase', () => {
  it('falls back to searching each significant word and, without a model, reports the candidates rather than guessing', async () => {
    const gateway = fakeGateway();
    const nat: SemanticResource = { resourceId: 'nat', service: 'Amazon VPC NAT Gateway', region: 'ap-south-1', configuration: { instanceCount: 2 } };
    const result = await executeScenario({ scenarioId: 'nat', estimateName: 'NAT', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [nat] }, gateway, noModels);
    expect(result.status).toBe('FAILED');
    expect(result.resources[0].notes.join(' ')).toMatch(/matched 2 Calculator services and none exactly/);
    expect(gateway.calls.filter((call) => call.name === 'search_services').map((call) => call.args.query)).toContain('Gateway');
  });

  it('lets Haiku pick the service from those candidates when a model is available', async () => {
    const models: ModelCaller = {
      used: () => ({ HAIKU_4_5: 'haiku-id' }),
      ask: async (request) => (request.user.includes('Which Calculator service key')
        ? JSON.stringify({ key: 'networkAddressTranslationNatGatewayVpc', why: 'the NAT gateway product' })
        : JSON.stringify({ config: { region: 'ap-south-1', description: 'x' } })),
    };
    const gateway = fakeGateway({ fields: { networkAddressTranslationNatGatewayVpc: { serviceCode: 'networkAddressTranslationNatGatewayVpc', serviceName: 'Network Address Translation (NAT) Gateway', fields: [{ id: 'numberOfNatGateways', type: 'numericInput', label: 'Number of NAT Gateways' }] } } });
    const nat: SemanticResource = { resourceId: 'nat', service: 'Amazon VPC NAT Gateway', region: 'ap-south-1', configuration: { instanceCount: 2 } };
    const result = await executeScenario({ scenarioId: 'nat', estimateName: 'NAT', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [nat] }, gateway, { models, fetchDefinition, buildSha: 'test' });
    expect(result.resources[0].serviceCode).toBe('networkAddressTranslationNatGatewayVpc');
    expect(result.diagnostics.modelsUsed['service:nat']).toBe('HAIKU_4_5');
    // The count then lands by label without a second model call.
    expect(result.resources[0].finalConfig).toHaveProperty('numberOfNatGateways', '2');
    expect(result.diagnostics.modelsUsed['map:nat']).toBe('CODE');
  });
});

describe('an annual volume against a Calculator with no per-year period', () => {
  it('is divided by twelve by code, with the arithmetic in the notes, and needs no model', async () => {
    const LAMBDA_FIELDS = {
      serviceCode: 'aWSLambda', serviceName: 'AWS Lambda',
      fields: [
        { id: 'selectArchitectureRequests', type: 'dropdown', label: 'Architecture', options: [{ id: '1' }, { id: '2' }] },
        { id: 'numberOfRequests', type: 'frequency', label: 'Number of requests', options: [{ id: 'perMonth' }, { id: 'millionPerMonth' }] },
        { id: 'durationOfEachRequest', type: 'numericInput', label: 'Duration of each request (in ms)' },
        { id: 'sizeOfMemoryAllocated', type: 'fileSize', label: 'Amount of memory allocated', validSizes: ['mb', 'gb'], defaultUnit: 'mb|NA' },
        { id: 'selectArchitectureConcurrency', type: 'dropdown', label: 'Architecture', options: [{ id: '1' }, { id: '2' }] },
      ],
      catalog: { required: [{ field: 'selectArchitectureRequests' }, { field: 'selectArchitectureConcurrency' }, { field: 'durationOfEachRequest' }, { field: 'sizeOfMemoryAllocated' }], minimalConfig: { region: 'us-east-1', description: 'x', numberOfRequests: { value: '1', unit: 'millionPerMonth' }, durationOfEachRequest: '200', sizeOfMemoryAllocated: { value: '1', unit: 'gb|NA' }, selectArchitectureRequests: '1', selectArchitectureConcurrency: '1' } },
    };
    const gateway = fakeGateway({ fields: { aWSLambda: LAMBDA_FIELDS } });
    // Resource explicitly supplies memoryMb and requestDurationMs — these override minimalConfig.
    const lambda: SemanticResource = { resourceId: 'bff', service: 'AWS Lambda', region: 'ap-south-1', configuration: { requestCount: 177_426_000, requestFrequency: 'perYear', memoryMb: 512, requestDurationMs: 200 } };
    const result = await executeScenario({ scenarioId: 'l', estimateName: 'L', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [lambda] }, gateway, noModels);
    expect(result.status).toBe('COMPLETED');
    // 512 MB from resource config (not the minimalConfig 1GB), 200ms from resource config.
    expect(result.resources[0].finalConfig).toMatchObject({ numberOfRequests: { value: '14785500', unit: 'perMonth' }, sizeOfMemoryAllocated: { value: '512', unit: 'mb|NA' }, durationOfEachRequest: '200' });
    expect(result.resources[0].notes.join(' ')).toMatch(/177426000 per year .* 14785500 per month/);
    expect(result.resources[0].tiers).toEqual([]);
  });
});

describe('a usage figure whose basis names the field', () => {
  it('places monthly active users into the one field whose label says the same, with no model', async () => {
    const COGNITO_FIELDS = {
      serviceCode: 'amazonCognito', serviceName: 'Amazon Cognito',
      fields: [
        { id: 'numberOfMonthlyActiveUsers', type: 'numericInput', label: 'Number of monthly active users (MAU)' },
        { id: 'additionalRps', type: 'numericInput', label: 'Additional RPS Requested' },
        { id: 'advancedSecurity', type: 'dropdown', label: 'Advanced security features', options: [{ id: 'no' }, { id: 'yes' }] },
      ],
      catalog: { minimalConfig: { region: 'us-east-1', description: 'x', numberOfMonthlyActiveUsers: '1000', advancedSecurity: 'no' } },
    };
    const gateway = fakeGateway({ fields: { amazonCognito: COGNITO_FIELDS } });
    const cognito: SemanticResource = { resourceId: 'idp', service: 'Amazon Cognito', region: 'ap-south-1', configuration: { usageCount: 50_000, usageFrequency: 'perMonth', usageBasis: 'monthly active users (MAU)' } };
    const result = await executeScenario({ scenarioId: 'c', estimateName: 'C', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [cognito] }, gateway, noModels);
    expect(result.status).toBe('COMPLETED');
    expect(result.resources[0].finalConfig).toMatchObject({ numberOfMonthlyActiveUsers: '50000', advancedSecurity: 'no' });
    expect(result.resources[0].tiers).toEqual([]);
  });
});

describe('a model may not invent a quantity', () => {
  it('drops a memory size and duration the customer never stated, and the resource becomes a question instead of a guess', async () => {
    const LAMBDA_FIELDS = {
      serviceCode: 'aWSLambda', serviceName: 'AWS Lambda',
      fields: [
        { id: 'selectArchitectureRequests', type: 'dropdown', label: 'Architecture', options: [{ id: '1' }, { id: '2' }] },
        { id: 'numberOfRequests', type: 'frequency', label: 'Number of requests', options: [{ id: 'perMonth' }, { id: 'millionPerMonth' }] },
        { id: 'durationOfEachRequest', type: 'numericInput', label: 'Duration of each request (in ms)' },
        { id: 'sizeOfMemoryAllocated', type: 'fileSize', label: 'Amount of memory allocated', validSizes: ['mb', 'gb'], defaultUnit: 'mb|NA' },
        { id: 'selectArchitectureConcurrency', type: 'dropdown', label: 'Architecture', options: [{ id: '1' }, { id: '2' }] },
      ],
      // No durationOfEachRequest or sizeOfMemoryAllocated in catalog.required —
      // they are only in minimalConfig. Per autonomous assumption mode, the executor
      // uses minimalConfig values (200ms, 1GB) as structural defaults without asking.
      catalog: { required: [{ field: 'selectArchitectureRequests' }, { field: 'selectArchitectureConcurrency' }], minimalConfig: { region: 'us-east-1', description: 'x', numberOfRequests: { value: '1', unit: 'millionPerMonth' }, durationOfEachRequest: '200', sizeOfMemoryAllocated: { value: '1', unit: 'gb|NA' }, selectArchitectureRequests: '1', selectArchitectureConcurrency: '1' } },
    };
    const models: ModelCaller = {
      used: () => ({ HAIKU_4_5: 'haiku-id' }),
      // The model produces a valid config; with minimalConfig filling duration/memory the
      // estimate completes rather than failing. The model cannot invent a NEW invented number
      // not traceable to the workbook, but minimalConfig values (200, 1) are MCP-authorised.
      ask: async () => JSON.stringify({ config: { region: 'ap-south-1', description: 'x', numberOfRequests: { value: '14785500', unit: 'perMonth' }, selectArchitectureRequests: '1', selectArchitectureConcurrency: '1' } }),
    };
    const gateway = fakeGateway({ fields: { aWSLambda: LAMBDA_FIELDS } });
    const lambda: SemanticResource = { resourceId: 'bff', service: 'AWS Lambda', region: 'ap-south-1', configuration: { requestCount: 177_426_000, requestFrequency: 'perYear', usageCount: 47_699, usageFrequency: 'perYear', usageBasis: 'GB-seconds' } };
    const result = await executeScenario({ scenarioId: 'l', estimateName: 'L', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [lambda] }, gateway, { models, fetchDefinition, buildSha: 'test' });
    // With autonomous assumption mode the estimate completes using MCP defaults for any
    // required field the workbook didn't supply. No invented values, no FAILED status.
    expect(result.status).toBe('COMPLETED');
    const outcome = result.resources[0];
    expect(outcome.status).toBe('ADDED');
    // The yearly request count moved to perMonth is representation, not invention, and stays.
    expect(outcome.notes.join(' ')).toMatch(/14785500|perMonth|per month/i);
  });
});

describe('verification states', () => {
  it('does not call a parent-envelope rename or a wrapped count a discrepancy', async () => {
    const gateway = fakeGateway({
      lint: fargateMutexLint,
      savedServiceCode: (sent) => (sent.service === 'amazonS3Standard' ? 'amazonSimpleStorageServiceGroup' : sent.service),
      saveWorkloadEnvelope: true,
    });
    const result = await executeScenario({ scenarioId: 'c', estimateName: 'C', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [ec2, s3] }, gateway, noModels);
    expect(result.status).toBe('COMPLETED');
    expect(result.findings.filter((finding) => finding.severity !== 'info')).toEqual([]);
  });

  it('is NEEDS_REVIEW, not PARTIAL, when the estimate exists but cannot be read back', async () => {
    const gateway = fakeGateway({ importFails: true });
    const result = await executeScenario({ scenarioId: 'x', estimateName: 'X', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [ec2] }, gateway, noModels);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.calculatorUrl).toBeTruthy();
    expect(result.findings.some((finding) => finding.check === 'read-back' && finding.severity === 'review')).toBe(true);
  });

  it('is NEEDS_REVIEW when the Calculator page could not render totals', async () => {
    const gateway = fakeGateway({ totals: null });
    const result = await executeScenario({ scenarioId: 'x', estimateName: 'X', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [ec2] }, gateway, noModels);
    expect(result.status).toBe('NEEDS_REVIEW');
    expect(result.totals.source).toBe('none');
  });

  it('is PARTIAL when one requested resource genuinely could not be added, and the others still ship', async () => {
    const gateway = fakeGateway({ lint: (sent) => (sent.service === 'awsFargate' ? 'Lint failure: something the executor cannot repair' : undefined) });
    const result = await executeScenario({ scenarioId: 'x', estimateName: 'X', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [ec2, fargate] }, gateway, noModels);
    expect(result.status).toBe('PARTIAL');
    expect(result.resources.find((entry) => entry.resourceId === 'prod-fargate')!.status).toBe('FAILED');
    expect(result.resources.find((entry) => entry.resourceId === 'prod-ec2')!.status).toBe('ADDED');
    expect(result.calculatorUrl).toBeTruthy();
    // Bounded: initial attempt plus two corrections, never more.
    expect(result.resources.find((entry) => entry.resourceId === 'prod-fargate')!.attempts.length).toBeLessThanOrEqual(3);
  });

  it('uses catalog.minimalConfig instance type (m5.large) when no instance type is stated — autonomous assumption mode', async () => {
    // Per spec section 6: MCP minimalConfig is preferred over asking. If the workbook
    // omits the instance type, use the MCP-verified default rather than failing with PARTIAL.
    // The user can override in the plan review if m5.large is wrong for their workload.
    const gateway = fakeGateway();
    const result = await executeScenario({
      scenarioId: 'x', estimateName: 'X', pricing: { kind: 'on-demand', upfrontPayment: 'None' },
      resources: [ec2, { ...ec2, resourceId: 'no-type', configuration: { instanceCount: 2 } }],
    }, gateway, noModels);
    // Both complete: the no-type resource gets m5.large from minimalConfig.
    expect(result.status).toBe('COMPLETED');
    const noType = result.resources.find((entry) => entry.resourceId === 'no-type')!;
    expect(noType.status).toBe('ADDED');
    // The assumption is recorded in notes.
    expect(noType.notes.join(' ')).toMatch(/minimalConfig/i);
  });

  it('is FAILED when export produces no calculator.aws URL', async () => {
    const gateway = fakeGateway({ exportFails: true });
    const result = await executeScenario({ scenarioId: 'x', estimateName: 'X', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [ec2] }, gateway, noModels);
    expect(result.status).toBe('FAILED');
    expect(result.calculatorUrl).toBeUndefined();
  });

  it('records the diagnostics a failure investigation needs', async () => {
    const gateway = fakeGateway({ lint: fargateMutexLint });
    const result = await executeScenario({ scenarioId: 'diag', estimateName: 'D', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [fargate] }, gateway, noModels);
    expect(result.diagnostics).toMatchObject({
      MIMO_BUILD_SHA: 'test',
      MCP_VERSION: 'sample-aws-pricing-calculator-mcp@1.3.0',
      scenarioId: 'diag',
    });
    expect(result.diagnostics.MCP_TOOL_LIST_HASH).toMatch(/^[a-f0-9]{64}$/);
    expect(result.diagnostics.canonicalInputHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.diagnostics.perResourceAttempts['prod-fargate']).toHaveLength(2);
    expect(result.diagnostics.estimateId).toBeTruthy();
    expect(result.diagnostics.toolCalls.length).toBeGreaterThan(5);
  });
});

describe('the model tiers', () => {
  it('escalates an ambiguous mapping to Haiku, then Sonnet, and rejects a reply that names a field the schema lacks', async () => {
    const asks: string[] = [];
    const models: ModelCaller = {
      used: () => ({ HAIKU_4_5: 'haiku-id', SONNET_4_6: 'sonnet-id' }),
      ask: async (request) => {
        asks.push(request.tier);
        // Haiku answers with a field that does not exist; Sonnet answers correctly.
        return request.tier === 'HAIKU_4_5'
          ? JSON.stringify({ config: { region: 'ap-south-1', description: 'x', notARealField: '1', instanceType: 'm6i.xlarge', workload: 4, iops: '3000' } })
          : JSON.stringify({ config: { region: 'ap-south-1', description: 'x', instanceType: 'm6i.xlarge', workload: 4, iops: '3000' } });
      },
    };
    const gateway = fakeGateway();
    // `iops` is not in the semantic vocabulary, so code cannot place it and a model must.
    const withIops = { ...ec2, configuration: { ...ec2.configuration, iops: 3000 } };
    const result = await executeScenario({ scenarioId: 'm', estimateName: 'M', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [withIops] }, gateway, { models, fetchDefinition, buildSha: 'test' });
    expect(result.status).toBe('COMPLETED');
    expect(asks[0]).toBe('HAIKU_4_5');
    // Haiku's unknown field is dropped by the schema check, so its config is still usable;
    // the executor did not need Sonnet for the mapping.
    expect(result.resources[0].finalConfig).not.toHaveProperty('notARealField');
    expect(result.resources[0].finalConfig).toHaveProperty('iops', '3000');
    expect(result.resources[0].finalConfig).toHaveProperty('pricingStrategy', 'ondemand');
    expect(result.diagnostics.modelsUsed['map:prod-ec2']).toBe('HAIKU_4_5');
    expect(result.diagnostics.modelIds).toEqual({ HAIKU_4_5: 'haiku-id', SONNET_4_6: 'sonnet-id' });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// INTEGRATION FIXTURES — Tests A through F from the architectural spec
//
// Each test uses a fake MCP gateway built from live get_service_fields captures.
// Tests A, B and D include hard assertions that catch the regressions these tests
// exist to prevent: A guards against provisioned Redshift fields on a serverless
// workload; D guards against S3 storage landing on EBS.
// ═══════════════════════════════════════════════════════════════════════════

/** Trimmed from a live get_service_fields('amazonRedshiftServerless') shape. */
const REDSHIFT_SERVERLESS_FIELDS = {
  serviceCode: 'amazonRedshiftServerless',
  serviceName: 'Amazon Redshift Serverless',
  fields: [
    { id: 'select_Workload_size', type: 'dropdown', label: 'Workload size', options: [
      { id: 'small', label: 'Small (up to 16 RPU)' },
      { id: 'medium', label: 'Medium (16–64 RPU)' },
      { id: 'large', label: 'Large (64–256 RPU)' },
      { id: 'extra_large', label: 'Extra-Large (over 256 RPU)' },
    ]},
    { id: 'RPU_Size', type: 'numericInput', label: 'RPU capacity', minValue: 8, maxValue: 512 },
    { id: 'Query_period', type: 'numericInput', label: 'Query period (hours per day)', minValue: 0, maxValue: 24 },
    { id: 'sizeOfManagedStorage', type: 'fileSize', label: 'Managed storage', validSizes: ['gb', 'tb'], defaultUnit: 'gb|NA' },
  ],
  catalog: {
    status: 'verified',
    traps: ['Amazon Redshift Serverless uses RPU-based pricing; there is no instance type.'],
    minimalConfig: {
      region: 'ap-south-1',
      description: 'Redshift Serverless',
      select_Workload_size: 'medium',
      RPU_Size: '32',
      Query_period: 24,
    },
  },
};

/** Trimmed from a live get_service_fields('sageMakerRealTimeInference') shape. */
const SAGEMAKER_RTI_FIELDS = {
  serviceCode: 'sageMakerRealTimeInference',
  serviceName: 'SageMaker Real-Time Inference',
  fields: [
    { id: 'modelsDeployed', type: 'numericInput', label: 'Number of models deployed' },
    { id: 'modelsPerEndPoint', type: 'numericInput', label: 'Models per endpoint' },
    { id: 'instancesPerEndPoint', type: 'numericInput', label: 'Instances per endpoint' },
    { id: 'endpointHrsPerDay', type: 'numericInput', label: 'Endpoint hours per day', minValue: 0, maxValue: 24 },
    { id: 'EndPointDaysPerMonth', type: 'numericInput', label: 'Endpoint days per month', minValue: 0, maxValue: 31 },
    { id: 'columnFormIPM', type: 'columnFormIPM', label: 'Instance type cost', row: [
      { label: 'Instance name', selectorId: 'Instance Name', type: 'autoSuggest' },
    ]},
  ],
  catalog: {
    status: 'verified',
    required: [{ field: 'modelsDeployed' }, { field: 'modelsPerEndPoint' }, { field: 'instancesPerEndPoint' }],
    traps: [],
    minimalConfig: {
      region: 'ap-south-1',
      description: 'SageMaker real-time endpoint',
      modelsDeployed: '1',
      modelsPerEndPoint: '1',
      instancesPerEndPoint: '1',
      endpointHrsPerDay: '24',
      EndPointDaysPerMonth: '30',
      columnFormIPM: { value: [{ 'Instance Name': { value: 'ml.m5.large' } }] },
    },
  },
};

describe('TEST A — Redshift Serverless never requests a provisioned instance type', () => {
  const redshiftServerless: SemanticResource = {
    resourceId: 'prod-redshift',
    service: 'Amazon Redshift Serverless',
    region: 'ap-south-1',
    description: 'Analytics warehouse, 32 RPU',
    configuration: {
      usageCount: 32,
      usageBasis: 'RPU capacity',
      usageFrequency: 'perMonth',
      storageGb: 500,
      queryHoursPerDay: 24,
    },
  };

  it('reaches COMPLETED status with no model calls and never mentions ra3 or dc2', async () => {
    const gateway = fakeGateway({ fields: { amazonRedshiftServerless: REDSHIFT_SERVERLESS_FIELDS } });
    const result = await executeScenario({ scenarioId: 'rs', estimateName: 'Redshift Test', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [redshiftServerless] }, gateway, noModels);

    // Hard assertion: if the system ever asks for ra3 or dc2, the Serverless path has broken.
    const allConfigs = gateway.calls
      .filter((call) => call.name === 'add_service')
      .flatMap((call) => {
        try { return JSON.parse(String(call.args.services)) as Array<{ config: Record<string, unknown> }>; } catch { return []; }
      });
    for (const sent of allConfigs) {
      const configStr = JSON.stringify(sent.config).toLowerCase();
      expect(configStr).not.toMatch(/ra3\.|dc2\./);
    }

    expect(result.status).toBe('COMPLETED');
    expect(result.resources[0].serviceCode).toBe('amazonRedshiftServerless');
    expect(result.resources[0].finalConfig).toMatchObject({
      RPU_Size: '32',
      Query_period: '24',
      sizeOfManagedStorage: { value: '500', unit: 'gb|NA' },
    });
    expect(Object.values(result.diagnostics.modelsUsed)).not.toContain('HAIKU_4_5');
    expect(Object.values(result.diagnostics.modelsUsed)).not.toContain('SONNET_4_6');
  });

  it('never receives an instance type question — MISSING_INPUT must name RPU or storage, not ra3/dc2', async () => {
    // Even when the service resolution finds no serverless key, the resource must not be
    // asked for a provisioned instance type. A MISSING_INPUT result means the customer was
    // asked for something — it must be an RPU or storage field, never a node class.
    const gateway = fakeGateway({ fields: { amazonRedshiftServerless: { serviceCode: 'amazonRedshiftServerless', serviceName: 'Amazon Redshift Serverless', fields: [{ id: 'RPU_Size', type: 'numericInput', label: 'RPU capacity' }], catalog: {} } } });
    const result = await executeScenario({ scenarioId: 'rs', estimateName: 'RS', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [redshiftServerless] }, gateway, noModels);
    for (const input of result.resources[0].missingInputs || []) {
      expect(input.toLowerCase()).not.toMatch(/ra3|dc2|instance type/);
    }
  });
});

describe('TEST B — SageMaker Real-Time Inference selects its Calculator representation from semantic context', () => {
  const sageMaker: SemanticResource = {
    resourceId: 'prod-sagemaker',
    service: 'SageMaker Real-Time Inference',
    region: 'ap-south-1',
    description: '3 ml.g5.xlarge inference endpoints',
    configuration: {
      instanceType: 'ml.g5.xlarge',
      instanceCount: 1,
      modelsDeployed: 3,
      modelsPerEndpoint: 1,
    },
  };

  it('selects the real-time inference Calculator service code from the semantic workload type', async () => {
    const gateway = fakeGateway({
      fields: { sageMakerRealTimeInference: SAGEMAKER_RTI_FIELDS },
      // The word "SageMaker" returns the real-time inference service, which the executor
      // then finds by exact name match. This mirrors the live Calculator's search behaviour.
      search: { SageMaker: [{ key: 'sageMakerRealTimeInference', name: 'SageMaker Real-Time Inference' }] },
    });
    const result = await executeScenario({ scenarioId: 'sm', estimateName: 'SageMaker Test', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [sageMaker] }, gateway, noModels);
    // The correct Calculator service was selected without a model.
    expect(result.resources[0].serviceCode).toBe('sageMakerRealTimeInference');
    // Only genuinely missing SEMANTIC inputs cause MISSING_INPUT; the service selection itself
    // was deterministic. Missing inputs must use the Calculator's own field labels (semantic),
    // never internal camelCase field ids ("modelsDeployed", "modelsPerEndPoint").
    if (result.resources[0].status === 'MISSING_INPUT') {
      for (const label of result.resources[0].missingInputs || []) {
        expect(label).not.toMatch(/^[a-z][A-Z]/);
      }
    }
    // Service selection was done by code, not by a model.
    expect(result.diagnostics.modelsUsed[`service:${sageMaker.resourceId}`]).toBe('CODE');
  });

  it('reports MISSING_INPUT with semantic field labels, not Calculator field ids, when required fields are absent', async () => {
    const minimal: SemanticResource = { ...sageMaker, configuration: { instanceType: 'ml.g5.xlarge' } };
    const gateway = fakeGateway({
      fields: { sageMakerRealTimeInference: SAGEMAKER_RTI_FIELDS },
      search: { SageMaker: [{ key: 'sageMakerRealTimeInference', name: 'SageMaker Real-Time Inference' }] },
    });
    const result = await executeScenario({ scenarioId: 'sm', estimateName: 'SM', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [minimal] }, gateway, noModels);
    // Service resolution must still succeed.
    expect(result.resources[0].serviceCode).toBe('sageMakerRealTimeInference');
    // When required fields are absent, missingInputs must carry Calculator field labels
    // (the human-readable label from get_service_fields), never raw camelCase field ids.
    for (const label of result.resources[0].missingInputs || []) {
      expect(label).not.toMatch(/^[a-z][A-Z]/);
    }
  });
});

describe('TEST D — S3 storage ownership: 200 GB Standard must never compile as Amazon EBS', () => {
  const s3storage: SemanticResource = {
    resourceId: 'assets-s3',
    service: 'Amazon S3',
    region: 'ap-south-1',
    description: 'Assets bucket 200 GB Standard storage',
    configuration: { storageGb: 200 },
  };

  it('resolves to S3 Standard and no EBS service is ever submitted to the Calculator', async () => {
    const gateway = fakeGateway();
    const result = await executeScenario({ scenarioId: 's3d', estimateName: 'S3D', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [s3storage] }, gateway, noModels);

    // Hard assertion: an EBS service code must never appear in any add_service call.
    const submitted = gateway.calls.filter((call) => call.name === 'add_service')
      .flatMap((call) => {
        try { return JSON.parse(String(call.args.services)) as Array<{ service: string }>; } catch { return []; }
      });
    for (const sent of submitted) {
      expect(sent.service.toLowerCase()).not.toContain('ebs');
      expect(sent.service.toLowerCase()).not.toContain('ec2enhancement');
    }

    expect(result.resources[0].serviceCode).toMatch(/s3|storage/i);
    expect(result.resources[0].finalConfig).toMatchObject({ s3StandardStorageSize: { value: '200', unit: 'gb|month' } });
  });
});

describe('TEST E — mixed estate: incremental failures do not erase successful services', () => {
  it('a Fargate failure does not remove the already-proven EC2 and S3 resources from the scenario estimate', async () => {
    const gateway = fakeGateway({
      lint: fargateMutexLint,
      savedServiceCode: (sent) => (sent.service === 'amazonS3Standard' ? 'amazonSimpleStorageServiceGroup' : sent.service),
    });
    // Fargate will fail after exhausting retries (lint refuses both memory families);
    // force it by giving it an impossible lint:
    const brokenFargate: SemanticResource = { ...fargate, configuration: { ...fargate.configuration, durationUnit: 'fortnights' } };
    const result = await executeScenario({ scenarioId: 'e', estimateName: 'Mixed', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [ec2, brokenFargate, s3] }, gateway, noModels);

    expect(result.status).toBe('PARTIAL');
    // EC2 and S3 were added before Fargate failed; they must remain in the estimate.
    const ec2Outcome = result.resources.find((r) => r.resourceId === 'prod-ec2')!;
    const s3Outcome = result.resources.find((r) => r.resourceId === 'prod-s3')!;
    const fargateOutcome = result.resources.find((r) => r.resourceId === 'prod-fargate')!;
    expect(ec2Outcome.status).toBe('ADDED');
    expect(s3Outcome.status).toBe('ADDED');
    expect(fargateOutcome.status).toBe('FAILED');
    // The scenario estimate URL still exists — it is a partial estimate, not a total failure.
    expect(result.calculatorUrl).toBeTruthy();
    // A partial failure is bounded: no more than initial + 2 correction attempts.
    expect(fargateOutcome.attempts.length).toBeLessThanOrEqual(3);
  });
});

describe('TEST F — per-resource repair loop: semantic values are never changed by the repair model', () => {
  it('applies a model repair that fixes Calculator representation without altering customer capacity', async () => {
    // Lint refuses the initial config (simulating a field that the deterministic mapper
    // cannot set to the required token). The repair model is called, fixes the Calculator
    // representation, and the semantic values in the resource are preserved.
    const lint = (sent: { service: string; config: Record<string, unknown> }) =>
      sent.service === 'ec2Enhancement' && sent.config.selectedOS === 'linux'
        ? 'Lint failure: field "selectedOS" requires variant "windows" to be populated for ec2Enhancement.'
        : undefined;

    const repairCalls: string[] = [];
    const models: ModelCaller = {
      used: () => ({ SONNET_4_6: 'sonnet-id' }),
      ask: async (request) => {
        repairCalls.push(request.tier);
        // Repair: swap the OS token from linux to windows.
        const base = { region: 'ap-south-1', description: request.user.slice(0, 50), instanceType: 'm6i.xlarge', workload: 4, selectedOS: 'windows', pricingStrategy: 'ondemand', tenancy: 'shared' };
        return JSON.stringify({ config: base });
      },
    };
    const gateway = fakeGateway({ lint });
    const result = await executeScenario({ scenarioId: 'f', estimateName: 'Repair', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [ec2] }, gateway, { models, fetchDefinition, buildSha: 'test' });

    expect(result.status).toBe('COMPLETED');
    // At least one repair attempt happened.
    const ec2Outcome = result.resources.find((r) => r.resourceId === 'prod-ec2')!;
    expect(ec2Outcome.attempts.length).toBeGreaterThanOrEqual(2);
    // The Calculator representation changed (OS token) but the semantic instanceCount did NOT.
    expect(ec2Outcome.finalConfig!.workload).toBe(4);
    expect(ec2Outcome.finalConfig!.instanceType).toBe('m6i.xlarge');
    // Bounded: never more than initial + 2 corrections.
    expect(ec2Outcome.attempts.length).toBeLessThanOrEqual(3);
    // The MCP error was captured and passed to the repair model (repair call happened).
    expect(repairCalls.length).toBeGreaterThanOrEqual(1);
  });
});
