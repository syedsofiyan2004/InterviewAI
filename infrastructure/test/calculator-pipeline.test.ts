import { mockClient } from 'aws-sdk-client-mock';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';

import { runEstimatePipeline, calculatorGroupName } from '../lambdas/calculator-orchestrator/pipeline';
import { resetPriceCache } from '../lambdas/calculator-orchestrator/aws-pricing';
import {
  CalculationResultSchema,
  type CalculationRecord,
  type CalculationResource,
} from '../schema/calculator';

/**
 * The estimate pipeline, end to end, with Bedrock, the Price List and the MCP sidecar
 * all mocked.
 *
 * These tests exist because four consecutive live runs of the real 110-machine workbook
 * failed, and every failure was structural rather than a typo: out of turns, out of
 * clock, a second estimate created at turn 20 that orphaned the first, and a single
 * generation that blew past 16k output tokens and took the whole run with it. The
 * pipeline's claim is that each of those is now impossible by construction, so what is
 * pinned here is the construction:
 *
 *  - exactly one build_estimate call, issued by code, so there is no window in which a
 *    second estimate can exist;
 *  - the model is not called at all for a row that names an instance type;
 *  - and every model call is optional — a Bedrock fault costs prose, never the priced
 *    estimate, because the figures are arithmetic that has already happened.
 */

const bedrockMock = mockClient(BedrockRuntimeClient);
const pricingMock = mockClient(PricingClient);

/** A Bedrock reply carrying one text block, in the shape InvokeModel returns. */
function reply(text: string) {
  return { body: new TextEncoder().encode(JSON.stringify({ content: [{ type: 'text', text }] })) };
}

/** Which of the two prompts a call carries. The pipeline has exactly two. */
function promptKind(input: any): 'classify' | 'narrate' {
  const system = String(JSON.parse(String(input.body)).system || '');
  return system.startsWith('You map rows') ? 'classify' : 'narrate';
}

const NARRATIVE = JSON.stringify({
  assumptions: ['Priced in eu-central-1 as the workbook states.'],
  warnings: ['The client model is 6 months old.'],
});

/** A Price List product with an hourly on-demand dimension. */
function hourlyProduct(rate: number) {
  return JSON.stringify({
    product: { sku: 'COMPUTE' },
    terms: {
      OnDemand: {
        OFFER: {
          priceDimensions: {
            'OFFER.DIM': {
              unit: 'Hrs',
              pricePerUnit: { USD: String(rate) },
              description: `$${rate} per On Demand Instance Hour`,
            },
          },
        },
      },
    },
  });
}

/** A Price List product with a GB-month dimension, as EBS and S3 publish. */
function gbMonthProduct(rate: number) {
  return JSON.stringify({
    product: { sku: 'STORAGE' },
    terms: {
      OnDemand: {
        OFFER: {
          priceDimensions: {
            'OFFER.DIM': {
              unit: 'GB-Mo',
              pricePerUnit: { USD: String(rate) },
              description: `$${rate} per GB-month of General Purpose SSD (gp3)`,
            },
          },
        },
      },
    },
  });
}

function fargateProduct(rate: number, unit: 'vCPU-Hours' | 'GB-Hours', usagetype: string) {
  return JSON.stringify({
    product: { sku: usagetype, attributes: { usagetype } },
    terms: {
      OnDemand: {
        OFFER: {
          priceDimensions: {
            'OFFER.DIM': {
              unit,
              pricePerUnit: { USD: String(rate) },
              description: `$${rate} per ${unit}`,
            },
          },
        },
      },
    },
  });
}

/**
 * Answers compute and storage lookups separately, since the pipeline issues both.
 * A null rate means "AWS publishes nothing matching", which is a case the report has
 * to survive rather than an error.
 */
function priceAs(rates: { compute?: number | null; storage?: number | null }) {
  pricingMock.on(GetProductsCommand).callsFake((input: any) => {
    const filters: Record<string, string> = Object.fromEntries(
      (input.Filters || []).map((filter: any) => [filter.Field, filter.Value]),
    );
    if (filters.volumeApiName) {
      const rate = rates.storage;
      return { PriceList: rate === undefined || rate === null ? [] : [gbMonthProduct(rate)] };
    }
    const rate = rates.compute;
    return { PriceList: rate === undefined || rate === null ? [] : [hourlyProduct(rate)] };
  });
}

function resource(overrides: Partial<CalculationResource> = {}): CalculationResource {
  return {
    raw: 'srv-01,m6a.xlarge,Linux',
    service: 'Amazon EC2',
    size: 'm6a.xlarge',
    os: 'Linux',
    ...overrides,
  };
}

function record(overrides: Partial<CalculationRecord> = {}): CalculationRecord {
  return {
    calculation_id: 'calc-1',
    owner_user_id: 'user-1',
    name: 'COSEC AWS TCO',
    prompt: '',
    region: 'eu-central-1',
    status: 'PROCESSING',
    environment_hours: [],
    resources: [],
    input_warnings: [],
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

/**
 * Stands in for McpSidecarClient, recording what the pipeline asked it to do.
 *
 * `import_estimate` echoes back the services `build_estimate` was given, because that is
 * what the real calculator does — except when it doesn't, which is the whole reason the
 * read-back exists. `drop` makes it discard the first N services silently, exactly as a
 * live estimate does for a group name containing a slash or two services sharing a
 * description.
 */
function fakeMcp(behaviour: { text?: string; isError?: boolean; throws?: string; drop?: number } = {}) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  let sent: any[] = [];
  return {
    calls,
    callTool: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (behaviour.throws) throw new Error(behaviour.throws);

      if (name !== 'build_estimate') {
        const kept = sent.slice(behaviour.drop ?? 0);
        const groups: Record<string, any> = {};
        let monthly = 0;
        kept.forEach((entry, at) => {
          groups[entry.group] = groups[entry.group] || { name: entry.group, services: {} };
          groups[entry.group].services[`svc-${at}`] = {
            service: entry.service,
            config: entry.config,
            description: entry.config.description,
          };
          const workload = Number(entry.config.workload || 0);
          const utilization = Number(entry.config.utilization || 100) / 100;
          monthly += workload * utilization * 730 * 0.2064;
          monthly += workload * Number(entry.config.storageAmount?.value || 0) * 0.0952;
        });
        return {
          text: JSON.stringify({
            groups,
            monthly,
            upfront: 0,
            total12Months: monthly * 12,
          }),
          isError: false,
        };
      }

      sent = JSON.parse(String(args.services));
      return {
        text: behaviour.text
          ?? '{"sharable_url":"https://calculator.aws/#/estimate?id=abc123","aws_estimate_id":"abc123"}',
        isError: !!behaviour.isError,
      };
    },
    getServiceCatalog: async (serviceCode: string) => ({
      text: JSON.stringify({
        serviceCode,
        serviceName: serviceCode,
        fields: [
          'tenancy', 'instanceType', 'selectedOS', 'workload', 'storageType', 'storageAmount',
          'edition', 'columnFormIPM', 'columnFormIPM_1', 'numberOfInstances',
        ].map((id) => ({ id, type: id.startsWith('columnFormIPM') ? 'columnFormIPM' : id === 'storageAmount' ? 'fileSize' : 'numericInput' })),
      }),
      isError: false,
    }),
    saveEstimate: async (name: string, services: any[]) => {
      return (await (async () => {
        calls.push({ name: 'build_estimate', args: { name, services: JSON.stringify(services) } });
        if (behaviour.throws) throw new Error(behaviour.throws);
        sent = services;
        return {
          text: behaviour.text
            ?? '{"sharable_url":"https://calculator.aws/#/estimate?id=abc123","aws_estimate_id":"abc123"}',
          isError: !!behaviour.isError,
        };
      })());
    },
    readEstimate: async (savedKeyOrUrl: string) => {
      calls.push({ name: 'import_estimate', args: { estimate_id: savedKeyOrUrl, format: 'json' } });
      if (behaviour.throws) throw new Error(behaviour.throws);
      const kept = sent.slice(behaviour.drop ?? 0);
      const groups: Record<string, any> = {};
      let monthly = 0;
      kept.forEach((entry, at) => {
        groups[entry.group] = groups[entry.group] || { name: entry.group, services: {} };
        groups[entry.group].services[`svc-${at}`] = { service: entry.service, config: entry.config };
        const workload = Number(entry.config.workload || 0);
        const utilization = Number(entry.config.utilization || 100) / 100;
        monthly += workload * utilization * 730 * 0.2064;
        monthly += workload * Number(entry.config.storageAmount?.value || 0) * 0.0952;
      });
      return { text: JSON.stringify({ groups, monthly, upfront: 0, total12Months: monthly * 12 }), isError: false };
    },
    validateLink: async (url: string) => {
      const kept = sent.slice(behaviour.drop ?? 0);
      let monthly = 0;
      kept.forEach((entry) => {
        const workload = Number(entry.config.workload || 0);
        const utilization = Number(entry.config.utilization || 100) / 100;
        monthly += workload * utilization * 730 * 0.2064;
        monthly += workload * Number(entry.config.storageAmount?.value || 0) * 0.0952;
      });
      return {
        validUrl: /^https:\/\/calculator\.aws\//.test(url),
        monthly,
        upfront: 0,
        total12Months: monthly * 12,
      };
    },
  };
}

const run = (rows: CalculationResource[], overrides: Partial<CalculationRecord> = {}, mcp = fakeMcp()) =>
  runEstimatePipeline(record(overrides), rows, mcp as any, undefined);

beforeEach(() => {
  bedrockMock.reset();
  pricingMock.reset();
  resetPriceCache();
  // The narrative is the only call the happy path makes; a test that needs the
  // classifier overrides this.
  bedrockMock.on(InvokeModelCommand).callsFake((input: any) => (
    promptKind(input) === 'narrate' ? reply(NARRATIVE) : reply('[]')
  ));
  priceAs({ compute: 0.2064, storage: 0.0952 });
});

describe('the happy path', () => {
  const rows = [
    resource({ name: 'srv-app-01', quantity: '4', environment: 'Production' }),
    resource({ name: 'srv-web-01', quantity: '2', environment: 'Staging', os: 'Windows Server 2019' }),
  ];
  const hours = [
    { name: 'Production', hoursPerDay: 24 },
    { name: 'Staging', hoursPerDay: 12 },
  ];

  test('prices every group from live rates and shows its arithmetic', async () => {
    const outcome = await run(rows, { environment_hours: hours });

    // 4 machines for a whole 730-hour month, plus 2 for half of one.
    expect(outcome.result.monthlyTotal).toBeCloseTo(0.2064 * 730 * 4 + 0.2064 * 365 * 2, 2);
    expect(outcome.result.lineItems).toHaveLength(2);
    // The workings are the difference between a cost document and an assertion.
    expect(outcome.result.lineItems[0].workings).toContain('$0.2064/Hrs');
    expect(outcome.result.lineItems[0].workings).toContain('730 hrs/month x 4');
    expect(outcome.result.lineItems[1].workings).toContain('365 hrs/month x 2');
    expect(outcome.result.environments).toEqual([
      { name: 'Production', hoursPerDay: 24, monthly: 602.69 },
      { name: 'Staging', hoursPerDay: 12, monthly: 150.67 },
    ]);
  });

  test('the model is never asked to classify a row that names an instance type', async () => {
    const outcome = await run(rows, { environment_hours: hours });

    // The whole reason the pipeline is fast: 25 groups of named instance types cost
    // zero classifier calls, and the only generation left is the prose.
    const calls = bedrockMock.commandCalls(InvokeModelCommand);
    expect(calls).toHaveLength(1);
    expect(promptKind(calls[0].args[0].input)).toBe('narrate');
    expect(outcome.iterations).toBe(1);
  });

  test('exactly one estimate is built, and its services carry the machine counts', async () => {
    const mcp = fakeMcp();
    const outcome = await run(rows, { environment_hours: hours }, mcp);

    // A live run created a SECOND estimate at turn 20 and exported a link covering a
    // fraction of the workload. One code-issued call removes the window entirely.
    expect(mcp.calls.map((call) => call.name)).toEqual(['build_estimate', 'import_estimate']);
    expect(outcome.result.url).toBe('https://calculator.aws/#/estimate?id=abc123');

    const services = JSON.parse(String(mcp.calls[0].args.services));
    expect(services).toHaveLength(2);
    expect(services[0].service).toBe('ec2Enhancement');
    expect(services.map((service: any) => service.config.workload)).toEqual([4, 2]);
    expect(services.map((service: any) => service.config.utilization)).toEqual(['100', '50']);
    expect(services[1].config.selectedOS).toBe('windows');
    // The estimate is foldered by environment, so the calculator's own subtotals line
    // up with the report's.
    expect(services.map((service: any) => service.group)).toEqual(['Production', 'Staging']);
  });

  test('non-EC2 Calculator services do not receive EC2-only compiler fields', async () => {
    const mcp = fakeMcp();
    mcp.getServiceCatalog = async (serviceCode: string) => ({
      text: JSON.stringify({
        serviceCode,
        serviceName: serviceCode,
        fields: [
          { id: 'operatingSystem', type: 'dropdown', options: [{ id: 'linux' }, { id: 'windows' }] },
          { id: 'selectArchitecture', type: 'dropdown', options: [{ id: 'x86' }, { id: 'arm' }] },
          { id: 'numberOfTasks', type: 'frequency' },
          { id: 'taskDuration', type: 'durationInput' },
          { id: 'vcpuPerTask', type: 'numericInput' },
          { id: 'memoryStandardFargateOnDemand', type: 'fileSize' },
          { id: 'storageAmountECS', type: 'fileSize' },
        ],
      }),
      isError: false,
    });
    pricingMock.on(GetProductsCommand).callsFake((input: any) => {
      return {
        PriceList: [
          fargateProduct(0.04, 'vCPU-Hours', 'APS3-Fargate-vCPU-Hours:perCPU'),
          fargateProduct(0.004, 'GB-Hours', 'APS3-Fargate-GB-Hours'),
        ],
      };
    });

    await run([resource({
      service: 'AWS Fargate', size: 'Fargate task', quantity: '2', vcpu: 1, ram_gb: 2,
    })], {}, mcp);

    const [service] = JSON.parse(String(mcp.calls[0].args.services));
    expect(service.service).toBe('awsFargate');
    expect(service.config).not.toHaveProperty('pricingStrategy');
    expect(service.config).not.toHaveProperty('utilization');
  });

  test('the assembled result satisfies the stored contract', async () => {
    const outcome = await run(rows, { environment_hours: hours });

    expect(() => CalculationResultSchema.parse(outcome.result)).not.toThrow();
    expect(outcome.result.assumptions).toContain('Priced in eu-central-1 as the workbook states.');
    // Always present, model or no model: which rates, and which region.
    expect(outcome.result.assumptions.some((note) => note.includes('AWS Price List Query API'))).toBe(true);
    expect(outcome.result.assumptions).toContain('All resources are priced in eu-central-1.');
  });

  test('progress is reported stage by stage, with no turn numbers', async () => {
    const stages: string[] = [];
    await runEstimatePipeline(
      record({ environment_hours: hours }),
      rows,
      fakeMcp() as any,
      async (update) => { stages.push(update.stage); },
    );

    // No "classifying": nothing needed the model. That absence is the feature.
    expect(stages).toEqual(['grouping', 'pricing', 'saving', 'narrating']);
  });
});

describe('attached storage', () => {
  test('is a separate line, priced per GB-month and billed for the whole month', async () => {
    const outcome = await run(
      [resource({ name: 'srv-db-01', disk_gb: 100, hoursPerDay: 8 })],
    );

    expect(outcome.result.lineItems).toHaveLength(2);
    const [compute, storage] = outcome.result.lineItems;

    expect(compute.timeBilled).toBe(true);
    // 33% of 730, not 730/3. The calculator's utilization field takes a whole percentage
    // and nothing finer, so 8h/day is 33% there whatever the report does; deriving the
    // report's hours from that same 33% is what keeps the PDF and the shareable link on
    // the same figure instead of ~1% apart on every scheduled machine.
    expect(compute.monthly).toBeCloseTo(0.2064 * 730 * 0.33, 2);

    // A disk costs the same whether the machine is running or not, so it must never
    // inherit the compute schedule — 8h/day here, and the storage is still 100%.
    expect(storage.service).toBe('Amazon EBS');
    expect(storage.timeBilled).toBe(false);
    expect(storage.monthly).toBeCloseTo(9.52, 2);
    expect(storage.workings).toContain('$0.0952/GB-month x 100 GB');
  });
});

describe('a model or sidecar fault costs detail, never the figures', () => {
  test('a save failure keeps diagnostic line prices but cannot publish an authoritative total', async () => {
    const outcome = await run([resource({ quantity: '3' })], {}, fakeMcp({ throws: 'sidecar unreachable' }));

    expect(outcome.result.url).toBeNull();
    expect(outcome.result.monthlyTotal).toBeNull();
    expect(outcome.result.lineItems[0].monthly).toBeCloseTo(0.2064 * 730 * 3, 2);
    expect(outcome.result.validationErrors?.some((note) => note.includes('could not be created'))).toBe(true);
    expect(outcome.status).toBe('FAILED');
    expect(() => CalculationResultSchema.parse(outcome.result)).not.toThrow();
  });

  test('a sidecar error reply is reported rather than swallowed', async () => {
    const outcome = await run([resource()], {}, fakeMcp({ isError: true, text: 'region not in manifest' }));

    expect(outcome.result.url).toBeNull();
    expect(outcome.result.validationErrors?.some((note) => note.includes('region not in manifest'))).toBe(true);
  });

  test('a Bedrock failure loses the prose and keeps the derived notes', async () => {
    bedrockMock.reset();
    bedrockMock.on(InvokeModelCommand).rejects(new Error('Bedrock throttled'));

    const outcome = await run([resource({ quantity: '2' })]);

    expect(outcome.result.monthlyTotal).toBeCloseTo(0.2064 * 730 * 2, 2);
    // The facts a client needs to read the figures are derived from the estimate, so
    // they survive a model outage.
    expect(outcome.result.assumptions).toContain('All resources are priced in eu-central-1.');
    expect(outcome.result.warnings.some((note) => note.includes('written commentary could not be generated'))).toBe(true);
  });

  test('an unpriced group stays visibly unpriced and is named in a warning', async () => {
    priceAs({ compute: null });

    const outcome = await run([resource({ size: 'm6a.xlarge', name: 'srv-odd-01' })]);

    // A plausible invented number in a cost document is worse than a visible gap.
    expect(outcome.result.lineItems[0].monthly).toBeNull();
    expect(outcome.result.lineItems[0].workings).toContain('Not priced');
    const named = outcome.result.warnings.find((note) => note.startsWith('Not priced —'));
    expect(named).toContain('m6a.xlarge');
    // The saved Calculator estimate is the authoritative total even when the local
    // Price List diagnostic lookup could not resolve a matching dimension.
    expect(outcome.result.monthlyTotal).toBeCloseTo(0.2064 * 730, 2);
  });
});

describe('the load put on the Price List API', () => {
  test('groups sharing a spec ask AWS once, not once each', async () => {
    const rows = ['Prod', 'UAT', 'Dev', 'DR'].map((environment, at) => resource({
      environment,
      name: `srv-0${at}`,
      disk_gb: 100 * (at + 1),
    }));

    const outcome = await run(rows);

    // Four compute groups and four disks, but only two distinct questions: the rate for
    // m6a.xlarge/Linux in eu-central-1, and the rate for gp3 there. The live 110-machine
    // run made 105 calls for 43 lines and one of them was throttled out of the estimate.
    expect(pricingMock.commandCalls(GetProductsCommand)).toHaveLength(2);
    expect(outcome.result.lineItems).toHaveLength(8);
    expect(outcome.result.lineItems.every((item) => typeof item.monthly === 'number')).toBe(true);
  });

  test('a throttled lookup is retried, so no machine falls out of the total', async () => {
    let calls = 0;
    pricingMock.on(GetProductsCommand).callsFake(() => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
      return { PriceList: [hourlyProduct(0.2064)] };
    });

    const outcome = await run([resource({ quantity: '5' })]);

    expect(outcome.result.lineItems[0].monthly).toBeCloseTo(0.2064 * 730 * 5, 2);
    expect(outcome.result.warnings.some((note) => note.startsWith('Not priced'))).toBe(false);
  });
});

/**
 * The report and the shareable link have to agree.
 *
 * A client opens both. When the PDF says one monthly total and calculator.aws says a
 * smaller one, the estimate stops being usable however correct its arithmetic is — the
 * first question is which number is real, and there is no good answer to it.
 *
 * Two causes, both pinned here: resources the link simply did not carry, and the same
 * schedule read to different precision on each side.
 */
describe('the report and the shareable link agree', () => {
  test('a disk is saved onto the EC2 service, so the link prices the storage too', async () => {
    const mcp = fakeMcp();
    const outcome = await run([resource({ quantity: '4', disk_gb: 100 })], {}, mcp);

    const [service] = JSON.parse(String(mcp.calls[0].args.services));
    // "Storage for each EC2 instance": the calculator multiplies this by workload, so it
    // is the per-machine disk, not the group total. Passing the total would bill 4 x 400GB.
    expect(service.config.storageType).toBe('Storage General Purpose gp3 GB Mo');
    // { value, unit }, verified against the live sidecar: a bare number is rejected with
    // 'expected { value, unit } object', which would have cost the whole link.
    expect(service.config.storageAmount).toEqual({ value: 100, unit: 'gb|NA' });
    expect(service.config.workload).toBe(4);
    // The lint reports tenancy as missing when it is absent, and Shared is the tenancy the
    // Price List rate was read for, so the two sides agree on that too.
    expect(service.config.tenancy).toBe('shared');

    // And the report's storage line is that same 100 x 4, so the two totals match.
    const storage = outcome.result.lineItems.find((item) => item.service === 'Amazon EBS');
    expect(storage!.workings).toContain('x 400 GB');
    expect(storage!.monthly).toBeCloseTo(0.0952 * 400, 2);
  });

  test('a group with no disk sends no storage fields at all', async () => {
    const mcp = fakeMcp();
    await run([resource()], {}, mcp);

    const [service] = JSON.parse(String(mcp.calls[0].args.services));
    // An unasked-for default disk would put the link ABOVE the report, which is the same
    // failure in the other direction.
    expect(service.config).not.toHaveProperty('storageType');
    expect(service.config).not.toHaveProperty('storageAmount');
  });

  test('the hours billed are the whole percentage the calculator will use', async () => {
    const mcp = fakeMcp();
    const outcome = await run([resource({ hoursPerDay: 8 })], {}, mcp);

    const [service] = JSON.parse(String(mcp.calls[0].args.services));
    expect(service.config.utilization).toBe('33');
    // 33% of 730 = 240.9 hours, which is what the calculator bills for utilization 33.
    expect(outcome.result.lineItems[0].workings).toContain('240.9 hrs/month');
    expect(outcome.result.lineItems[0].monthly).toBeCloseTo(0.2064 * 730 * 0.33, 2);
  });

  test('plain RDS is compiled into the same complete link as EC2', async () => {
    const mcp = fakeMcp();
    const outcome = await run([
      resource({ name: 'srv-app-01' }),
      resource({ name: 'db-01', service: 'Amazon RDS PostgreSQL', size: 'db.r6g.large' }),
    ], {}, mcp);

    expect(JSON.parse(String(mcp.calls[0].args.services))).toHaveLength(2);
    expect(outcome.status).toBe('COMPLETED');
  });

  test('a committed group says why the link names a Savings Plan for the same rate', async () => {
    const outcome = await run([resource({ purchase_model: '3-Yr No Upfront' })]);

    expect(outcome.result.assumptions.some((note) => (
      note.includes('Standard Reserved Instances') && note.includes('EC2 Instance Savings Plan')
    ))).toBe(true);
  });
});

/**
 * The two rate mistakes that are invisible in the output.
 *
 * Both produce a plausible figure from a real AWS rate, so neither shows up as an error
 * anywhere — they are simply the wrong quotation, and only a reader who already knew the
 * answer would catch them.
 */
describe('what makes a rate the right rate', () => {
  test('a bundled SQL Server licence is priced, not dropped', async () => {
    const mcp = fakeMcp();
    await run([resource({ os: 'Windows Server 2019 with SQL Server Standard' })], {}, mcp);

    // preInstalledSw is a different SKU, not a surcharge on plain Windows. Left at the
    // 'NA' default, a SQL machine prices as bare Windows — roughly half its real rate.
    const filters: Record<string, string> = Object.fromEntries(
      (pricingMock.commandCalls(GetProductsCommand)[0].args[0].input.Filters || [])
        .map((filter: any) => [filter.Field, filter.Value]),
    );
    expect(filters.operatingSystem).toBe('Windows');
    expect(filters.preInstalledSw).toBe('SQL Std');

    // And the link has to carry the same licence, or the two documents price different machines.
    const [service] = JSON.parse(String(mcp.calls[0].args.services));
    expect(service.config.selectedOS).toBe('windows-std');
  });

  test('the SQL edition is read when the sheet names one', async () => {
    const mcp = fakeMcp();
    await run([resource({ os: 'Windows', service: 'EC2 with SQL Server Enterprise' })], {}, mcp);

    const filters: Record<string, string> = Object.fromEntries(
      (pricingMock.commandCalls(GetProductsCommand)[0].args[0].input.Filters || [])
        .map((filter: any) => [filter.Field, filter.Value]),
    );
    // Enterprise is several times Standard per vCPU, so guessing Standard here would
    // understate a large machine by thousands a month.
    expect(filters.preInstalledSw).toBe('SQL Ent');
    expect(JSON.parse(String(mcp.calls[0].args.services))[0].config.selectedOS).toBe('windows-enterprise');
  });

  test('a licence the client already owns is not billed for a second time', async () => {
    const mcp = fakeMcp();
    const outcome = await run(
      [resource({ os: 'Windows Server 2019 with SQL Server Standard (BYOL)', quantity: '2' })],
      {},
      mcp,
    );

    const filters: Record<string, string> = Object.fromEntries(
      (pricingMock.commandCalls(GetProductsCommand)[0].args[0].input.Filters || [])
        .map((filter: any) => [filter.Field, filter.Value]),
    );
    // The mirror image of the test above, and the same size of error: a bundled licence
    // billed per vCPU roughly doubles this machine, and the sheet has already said the
    // client holds the licence. So the rate is plain Windows, on both documents.
    expect(filters.operatingSystem).toBe('Windows');
    expect(filters.preInstalledSw).toBe('NA');
    expect(JSON.parse(String(mcp.calls[0].args.services))[0].config.selectedOS).toBe('windows');
    expect(outcome.result.lineItems[0].monthly).toBeCloseTo(0.2064 * 730 * 2, 2);

    // Said out loud, because a reader comparing this against a licence-inclusive quote
    // needs to know which of the two they are holding.
    expect(outcome.result.assumptions.some((note) => (
      note.includes('name SQL Server') && note.includes('BYOL')
    ))).toBe(true);
    expect(outcome.result.assumptions.some((note) => note.includes('bundled SQL Server licence'))).toBe(false);
  });

  test('SQL Server Express is free, so no licence is billed for it', async () => {
    const outcome = await run([resource({ os: 'Windows + SQL Server Express' })]);

    const filters: Record<string, string> = Object.fromEntries(
      (pricingMock.commandCalls(GetProductsCommand)[0].args[0].input.Filters || [])
        .map((filter: any) => [filter.Field, filter.Value]),
    );
    expect(filters.preInstalledSw).toBe('NA');
    expect(outcome.result.assumptions.some((note) => note.includes('Express'))).toBe(true);
  });

  test('MySQL on Linux is not charged a Windows SQL Server licence', async () => {
    // "MySQL" contains the letters "sql". Matching on those alone put a per-vCPU Windows
    // database licence on a Linux machine -- the largest overstatement the licence rules
    // are capable of.
    const mcp = fakeMcp();
    await run([resource({ os: 'Linux', service: 'Amazon EC2 - MySQL 8.0' })], {}, mcp);

    const filters: Record<string, string> = Object.fromEntries(
      (pricingMock.commandCalls(GetProductsCommand)[0].args[0].input.Filters || [])
        .map((filter: any) => [filter.Field, filter.Value]),
    );
    expect(filters.operatingSystem).toBe('Linux');
    expect(filters.preInstalledSw).toBe('NA');
    expect(JSON.parse(String(mcp.calls[0].args.services))[0].config.selectedOS).toBe('linux');
  });

  test('plain Windows stays plain, with no licence filter invented', async () => {
    await run([resource({ os: 'Windows Server 2019' })]);

    const filters: Record<string, string> = Object.fromEntries(
      (pricingMock.commandCalls(GetProductsCommand)[0].args[0].input.Filters || [])
        .map((filter: any) => [filter.Field, filter.Value]),
    );
    // The defaults already say 'NA'; adding a licence nobody asked for would double the rate.
    expect(filters.preInstalledSw).toBe('NA');
  });

  test('a commitment is billed for the whole month even on a part-time schedule', async () => {
    const mcp = fakeMcp();
    const outcome = await run(
      [resource({ purchase_model: '3-Yr No Upfront', hoursPerDay: 8, quantity: '2' })],
      {},
      mcp,
    );

    // An RI or Savings Plan is paid for whether the instance runs or not. Billing it at
    // 8h/day would understate what the client is actually invoiced by two thirds.
    expect(outcome.result.lineItems[0].monthly).toBeCloseTo(0.2064 * 730 * 2, 2);
    expect(outcome.result.lineItems[0].workings).toContain('730 hrs/month x 2');
    expect(mcp.calls).toHaveLength(0);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.result.validationErrors?.join(' ')).toMatch(/Reserved Instance configuration/);

    // And the contradiction in the sheet is surfaced rather than quietly resolved.
    expect(outcome.result.warnings.some((note) => (
      note.includes('both a commitment and a part-time schedule')
    ))).toBe(true);
  });

  test('an on-demand part-time group is still billed only for the hours it runs', async () => {
    const outcome = await run([resource({ hoursPerDay: 12 })]);

    // The commitment rule must not leak into the on-demand path — that is the whole
    // point of asking for runtime hours in the first place.
    expect(outcome.result.lineItems[0].monthly).toBeCloseTo(0.2064 * 365, 2);
  });
});

describe('the rows code cannot map', () => {
  const rows = [
    resource({ name: 'srv-app-01' }),
    resource({ name: 'legacy-01', size: 'Standard_D4s_v3', vcpu: 4, ram_gb: 16 }),
  ];

  test('only the unmapped group reaches the classifier, and it is priced from the answer', async () => {
    bedrockMock.reset();
    bedrockMock.on(InvokeModelCommand).callsFake((input: any) => (
      promptKind(input) === 'classify'
        ? reply(JSON.stringify([{
          group: 1,
          serviceCode: 'AmazonEC2',
          filters: { instanceType: 'm5.xlarge', operatingSystem: 'Linux' },
          note: '4 vCPU / 16 GB maps to m5.xlarge',
        }]))
        : reply(NARRATIVE)
    ));

    const stages: string[] = [];
    const outcome = await runEstimatePipeline(record(), rows, fakeMcp() as any, (update) => {
      stages.push(update.stage);
    });

    // One chunk, not one call per group, and the Azure SKU is the only thing in it.
    const classifyCalls = bedrockMock.commandCalls(InvokeModelCommand)
      .filter((call) => promptKind(call.args[0].input) === 'classify');
    expect(classifyCalls).toHaveLength(1);
    expect(String(JSON.parse(String(classifyCalls[0].args[0].input.body)).messages[0].content[0].text))
      .toContain('Map these 1 group(s)');

    expect(stages).toContain('classifying');
    expect(outcome.result.lineItems.every((item) => typeof item.monthly === 'number')).toBe(true);
    // A semantic classifier result is not Calculator readiness. The compiler refuses a
    // partial link until a deterministic adapter can encode the second resource.
    expect(outcome.result.monthlyTotal).toBeNull();
    expect(outcome.status).toBe('FAILED');
    expect(outcome.result.validationErrors?.join(' ')).toMatch(/preflight failed/);
  });

  test('a classifier failure leaves that group unpriced rather than failing the run', async () => {
    bedrockMock.reset();
    bedrockMock.on(InvokeModelCommand).callsFake((input: any) => {
      if (promptKind(input) === 'classify') throw new Error('Bedrock throttled');
      return reply(NARRATIVE);
    });

    const outcome = await run(rows);

    // Diagnostic line arithmetic remains visible, but no partial Calculator total/link is published.
    expect(outcome.result.monthlyTotal).toBeNull();
    expect(outcome.result.lineItems[1].monthly).toBeNull();
    expect(outcome.result.warnings.some((note) => note.includes('classifier returned no mapping'))).toBe(true);
    expect(outcome.status).toBe('FAILED');
  });
});

describe('the two scenarios', () => {
  test('a right-sized scenario appears only when the file recommends different sizes', async () => {
    const withoutRecommendation = await run([resource()]);
    expect(withoutRecommendation.result.scenarios).toEqual([]);

    const mcp = fakeMcp();
    const outcome = await run(
      [resource({ quantity: '4', right_sized_size: 'm6a.large', right_sized_vcpu: 2, right_sized_ram_gb: 8 })],
      {},
      mcp,
    );

    expect(outcome.result.scenarios.map((scenario) => scenario.key)).toEqual(['baseline', 'rightsized']);
    // The headline total is populated only when the saved Calculator estimate validates.
    expect(outcome.result.monthlyTotal).toBeNull();
    expect(outcome.result.lineItems).toHaveLength(1);
    // And only the agreed configuration is saved to the shareable link.
    expect(JSON.parse(String(mcp.calls[0].args.services))).toHaveLength(1);
  });

  test('the client\'s own modelled total is carried through for comparison, never used as a price', async () => {
    const outcome = await run([resource({ reported_monthly: 900 })], {
      workbook: {
        sheets: [], regions: [], facts: [], rate_card: [], reported: [], excerpts: [],
        server_count: 1, total_disk_gb: 0, dr_eligible_count: 0,
        reported_monthly_total: 900,
      },
    });

    expect(outcome.result.reportedMonthlyTotal).toBe(900);
    expect(outcome.result.monthlyTotal).toBeCloseTo(0.2064 * 730, 2);
  });
});

describe('nothing to price', () => {
  test('a file with no priceable rows fails loudly instead of returning an empty estimate', async () => {
    await expect(run([resource({ service: undefined, size: undefined, os: undefined, raw: 'Notes: TBC' })]))
      .rejects.toThrow(/NO_PRICEABLE_ROWS/);
    await expect(run([])).rejects.toThrow(/NO_PRICEABLE_ROWS/);
  });
});

/**
 * The link and the report describing the same resources.
 *
 * Both failures below were found by saving the real 110-machine workbook, reading the
 * saved estimate back with import_estimate, and diffing it against the report's own line
 * items: 25 groups were sent, 21 came back, and $4,601.75/month of the $26,772.57 total
 * was in the PDF and not in the link. Neither failure produced an error anywhere —
 * build_estimate returned success for every service and handed back a working URL.
 */
describe('nothing is lost between the report and the link', () => {
  test('a group name with a slash is renamed, because the calculator drops the whole group', async () => {
    // Verified live: "Prod/UAT/Dev" is accepted, reports success, and is then absent from
    // the saved estimate. On the worked example that was 2 groups and $4,313.37/month.
    const mcp = fakeMcp();
    await run([resource({ quantity: '19', environment: 'Prod/UAT/Dev' })], {}, mcp);

    const [service] = JSON.parse(String(mcp.calls[0].args.services));
    expect(service.group).toBe('Prod-UAT-Dev');
  });

  test('the renaming keeps the characters a group name is allowed to have', () => {
    // Established by probing eight candidate names against the live calculator: only the
    // slash is fatal, and "&" is silently stripped, so it is spelled out here instead.
    expect(calculatorGroupName('Prod (shared)')).toBe('Prod (shared)');
    expect(calculatorGroupName('Prod_UAT.Dev')).toBe('Prod_UAT.Dev');
    expect(calculatorGroupName('Prod, UAT')).toBe('Prod, UAT');
    expect(calculatorGroupName('Prod & UAT')).toBe('Prod and UAT');
    expect(calculatorGroupName('Prod/UAT/Dev')).toBe('Prod-UAT-Dev');
    expect(calculatorGroupName('Prod\\UAT')).toBe('Prod-UAT');
    // A blank environment would group everything under an empty heading, which reads to a
    // client as a broken estimate rather than as an unlabelled one.
    expect(calculatorGroupName(undefined)).toBe('Estimate');
    expect(calculatorGroupName('   ')).toBe('Estimate');
  });

  test('two groups of the same shape get distinguishable descriptions', async () => {
    // The worked example really does contain two "2 x m6a.large Windows" groups in UAT,
    // one with 1,406 GB attached and one with 512 GB. Sent under one description the
    // calculator keeps only the last, so the report showed a machine the link did not.
    const mcp = fakeMcp();
    // Same instance type, same OS, same environment, so the same description -- but the
    // sheet states different vCPU/RAM for the two pairs, which is what keeps them two
    // groups. That is the situation on the real workbook.
    const rows = [
      resource({ name: 'SAddFiles-Tst', environment: 'UAT', size: 'm6a.large', disk_gb: 703, vcpu: 2, ram_gb: 8 }),
      resource({ name: 'SEdoc01-test', environment: 'UAT', size: 'm6a.large', disk_gb: 703, vcpu: 2, ram_gb: 8 }),
      resource({ name: 'PT-03-VM', environment: 'UAT', size: 'm6a.large', disk_gb: 256, vcpu: 4, ram_gb: 16 }),
      resource({ name: 'PT-04-VM', environment: 'UAT', size: 'm6a.large', disk_gb: 256, vcpu: 4, ram_gb: 16 }),
    ];
    const outcome = await run(rows, {}, mcp);

    const services = JSON.parse(String(mcp.calls[0].args.services));
    const descriptions = services.map((service: any) => service.config.description);
    expect(new Set(descriptions).size).toBe(descriptions.length);
    // A machine name, not a counter: it is what a client can look up in their own sheet.
    expect(descriptions.some((text: string) => /PT-03-VM|SAddFiles-Tst/.test(text))).toBe(true);
    // And the estimate is whole, so no warning about a shortfall.
    expect(outcome.result.warnings.join(' ')).not.toMatch(/missing/i);
  });

  test('a group the calculator silently discards is reported in dollars', async () => {
    // The read-back is the guarantee. If a third variant of this bug ever appears, the
    // client is told the link understates the report and by how much, rather than being
    // handed two documents that disagree.
    const mcp = fakeMcp({ drop: 1 });
    const outcome = await run(
      [
        resource({ name: 'srv-a', quantity: '4', environment: 'Prod' }),
        resource({ name: 'srv-b', quantity: '2', environment: 'UAT' }),
      ],
      {},
      mcp,
    );

    expect(mcp.calls.map((call) => call.name)).toEqual(['build_estimate', 'import_estimate']);
    const warning = outcome.result.validationErrors?.find((text) => /missing .*Prod|contains 1 service/i.test(text));
    expect(warning).toBeDefined();
    // 4 x m6a.xlarge for a full month is the group that was dropped.
    expect(outcome.status).toBe('PARTIAL');
    // A partial read-back cannot masquerade as a final client-ready total.
    expect(outcome.result.monthlyTotal).toBeNull();
  });

  test('a browser validator failure does not discard a generated calculator link', async () => {
    const mcp = fakeMcp({ text: '{"sharable_url":"https://calculator.aws/#/estimate?id=abc123"}' });
    mcp.validateLink = async () => ({
      validUrl: false,
      reason: 'The isolated Calculator browser validator is not configured.',
      monthly: 0,
      upfront: 0,
      total12Months: 0,
    });

    const outcome = await run([resource({ quantity: '4' })], {}, mcp);

    expect(mcp.calls.map((call) => call.name)).toEqual(['build_estimate', 'import_estimate']);
    expect(outcome.result.url).toBe('https://calculator.aws/#/estimate?id=abc123');
    expect(outcome.result.monthlyTotal).toBeNull();
    expect(outcome.result.validationErrors?.join(' ')).toMatch(/browser validator is not configured/);
    expect(outcome.status).toBe('PARTIAL');
  });

  test('a read-back that fails leaves the estimate priced and says it is unverified', async () => {
    const mcp = fakeMcp({ text: '{"sharable_url":"https://calculator.aws/#/estimate?id=abc123"}' });
    // A read-back returning nothing is a failure of the check, never evidence that the
    // estimate is empty — reporting it as a total loss would be its own wrong answer.
    mcp.readEstimate = async () => { throw new Error('import timed out'); };

    const outcome = await run([resource({ quantity: '4' })], {}, mcp);

    expect(outcome.result.url).toBe('https://calculator.aws/#/estimate?id=abc123');
    expect(outcome.result.monthlyTotal).toBeNull();
    expect(outcome.result.validationErrors?.join(' ')).toMatch(/could not be read back/);
    expect(outcome.status).toBe('PARTIAL');
  });
});

describe('a scenario that states its own pricing model', () => {
  test("prices the request at the requested term, not the sheet cell's", async () => {
    // The sheet's own cell says 3-Yr; the scenario asks for 1-year RI. The term is
    // matched client-side against the offer's own termAttributes, so the mock publishes
    // ONLY a 1-year No Upfront offer: had the pipeline asked for the cell's 3-year term,
    // no offer would match and the line would come back unpriced.
    const reserved1yr = (rate: number) => JSON.stringify({
      product: { sku: 'COMPUTE' },
      terms: {
        Reserved: {
          OFFER: {
            termAttributes: { LeaseContractLength: '1yr', PurchaseOption: 'No Upfront' },
            priceDimensions: {
              'OFFER.DIM': {
                unit: 'Hrs',
                pricePerUnit: { USD: String(rate) },
                description: `$${rate} per Reserved Instance Hour`,
              },
            },
          },
        },
      },
    });
    pricingMock.on(GetProductsCommand).callsFake((input: any) => {
      const filters: Record<string, string> = Object.fromEntries(
        (input.Filters || []).map((filter: any) => [filter.Field, filter.Value]),
      );
      if (filters.volumeApiName) return { PriceList: [gbMonthProduct(0.0952)] };
      return { PriceList: [reserved1yr(0.12)] };
    });

    const mcp = fakeMcp();
    const outcome = await runEstimatePipeline(
      record({
        requested_plan: {
          scenarios: [{
            label: 'One-year reserved',
            pricing_model: 'ri-1yr-no-upfront',
            environments: [],
          }],
        },
      }),
      [resource({ purchase_model: '3-Yr No Upfront', quantity: '1' })],
      mcp as any,
      undefined,
    );

    // Priced at the 1-year rate, over the whole month a commitment is billed for.
    expect(outcome.result.lineItems[0].monthly).toBeCloseTo(0.12 * 730, 2);

    // EC2 RI cannot be represented by the current versioned Calculator adapter and
    // must not be substituted with an Instance Savings Plan.
    expect(mcp.calls).toHaveLength(0);
    expect(outcome.status).toBe('FAILED');
    expect(outcome.result.validationErrors?.join(' ')).toMatch(/Reserved Instance configuration/);
  });

  test('an on-demand scenario\'s link does not carry a reserved strategy', async () => {
    const mcp = fakeMcp();
    await runEstimatePipeline(
      record({
        requested_plan: {
          scenarios: [{
            label: 'Plain on-demand',
            pricing_model: 'on-demand',
            environments: [],
          }],
        },
      }),
      [resource({ purchase_model: '3-Yr No Upfront', quantity: '1' })],
      mcp as any,
      undefined,
    );

    const link = JSON.parse(String(mcp.calls[0].args.services))[0].config;
    expect(link.pricingStrategy).toBe('ondemand');
  });
});
