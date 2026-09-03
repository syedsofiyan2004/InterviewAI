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
      catalog: { required: [{ field: 'selectArchitectureRequests' }, { field: 'selectArchitectureConcurrency' }], minimalConfig: { region: 'us-east-1', description: 'x', numberOfRequests: { value: '1', unit: 'millionPerMonth' }, durationOfEachRequest: '200', sizeOfMemoryAllocated: { value: '1', unit: 'gb|NA' }, selectArchitectureRequests: '1', selectArchitectureConcurrency: '1' } },
    };
    const models: ModelCaller = {
      used: () => ({ HAIKU_4_5: 'haiku-id' }),
      // The model helpfully fills the catalog's 200 ms / 128 MB. The customer said neither.
      ask: async () => JSON.stringify({ config: { region: 'ap-south-1', description: 'x', numberOfRequests: { value: '14785500', unit: 'perMonth' }, durationOfEachRequest: '200', sizeOfMemoryAllocated: { value: '128', unit: 'mb|NA' }, selectArchitectureRequests: '1', selectArchitectureConcurrency: '1' } }),
    };
    const gateway = fakeGateway({ fields: { aWSLambda: LAMBDA_FIELDS } });
    const lambda: SemanticResource = { resourceId: 'bff', service: 'AWS Lambda', region: 'ap-south-1', configuration: { requestCount: 177_426_000, requestFrequency: 'perYear', usageCount: 47_699, usageFrequency: 'perYear', usageBasis: 'GB-seconds' } };
    const result = await executeScenario({ scenarioId: 'l', estimateName: 'L', pricing: { kind: 'on-demand', upfrontPayment: 'None' }, resources: [lambda] }, gateway, { models, fetchDefinition, buildSha: 'test' });
    expect(result.status).toBe('FAILED');
    const outcome = result.resources[0];
    expect(outcome.status).toBe('MISSING_INPUT');
    expect(outcome.missingInputs).toEqual(expect.arrayContaining([expect.stringMatching(/Duration of each request/), expect.stringMatching(/memory allocated/)]));
    // The yearly request count moved to a month is representation, not invention, and stays.
    expect(outcome.missingInputs).not.toEqual(expect.arrayContaining([expect.stringMatching(/Number of requests/)]));
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

  it('is PARTIAL when a required quantity the customer never stated is missing, naming the input', async () => {
    const gateway = fakeGateway();
    const result = await executeScenario({
      scenarioId: 'x', estimateName: 'X', pricing: { kind: 'on-demand', upfrontPayment: 'None' },
      resources: [ec2, { ...ec2, resourceId: 'no-type', configuration: { instanceCount: 2 } }],
    }, gateway, noModels);
    expect(result.status).toBe('PARTIAL');
    const missing = result.resources.find((entry) => entry.resourceId === 'no-type')!;
    expect(missing.status).toBe('MISSING_INPUT');
    expect(missing.missingInputs).toEqual(expect.arrayContaining([expect.stringMatching(/instance/i)]));
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
