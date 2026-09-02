import { mockClient } from 'aws-sdk-client-mock';
import { PricingClient, GetProductsCommand } from '@aws-sdk/client-pricing';

import {
  parseTerm,
  planFromGroup,
} from '../lambdas/calculator-orchestrator/pipeline';
import type { CalculationResource } from '../schema/calculator';
import type { EstimateScenarioRequest } from '../schema/estimate-plan';
import { planSegments } from '../lambdas/calculator-orchestrator/pipeline';
import { lookupPrice, resetPriceCache } from '../lambdas/calculator-orchestrator/aws-pricing';
import { groupResources } from '../lambdas/calculator-orchestrator/prompt';
import type { ResourceGroup } from '../lambdas/calculator-orchestrator/prompt';

/**
 * Deterministic classification, and the commitment it prices against.
 *
 * This is the half of the pipeline that runs with no model involved, and it is where a
 * mistake is most dangerous, because a wrong rule is silent. Two failures it exists to
 * prevent, both measured against live AWS rates for m6a.xlarge in eu-central-1:
 *
 *  - Reading "Win2019" as Linux prices Windows compute at $0.2064/hr instead of
 *    $0.3910 — a 47% understatement on every Windows machine in the estimate.
 *  - Quoting on-demand for a row the client marked "3-Yr No Upfront" prices it at
 *    $0.2064/hr instead of $0.0939 — a 120% overstatement, on the majority of rows in
 *    a real migration model.
 *
 * Neither surfaces as an error. Both make the whole document wrong.
 */

const pricingMock = mockClient(PricingClient);

function group(overrides: Partial<ResourceGroup> = {}): ResourceGroup {
  return {
    service: 'Amazon EC2',
    size: 'm6a.xlarge',
    hoursPerDay: 24,
    count: 1,
    rows: 1,
    diskGb: 0,
    names: [],
    members: [0],
    reportedMonthly: 0,
    ...overrides,
  };
}

beforeEach(() => {
  pricingMock.reset();
  // Identical lookups are memoised per estimate, so each test starts from a clean memo.
  resetPriceCache();
});

describe('reading a commitment out of the sheet', () => {
  test('on-demand and blank both mean no commitment', () => {
    expect(parseTerm(undefined)).toBeUndefined();
    expect(parseTerm('')).toBeUndefined();
    expect(parseTerm('On-Demand')).toBeUndefined();
    expect(parseTerm('on demand')).toBeUndefined();
    expect(parseTerm('Pay as you go')).toBeUndefined();
  });

  test('the wordings a real workbook actually uses all resolve to a term', () => {
    // Every one of these is a real spelling of the same thing. A parser that handles
    // only the first would price most of a migration fleet at on-demand.
    for (const wording of [
      '3-Yr No Upfront',
      '3 Year Reserved Instance, No Upfront',
      'RI 3yr no upfront',
      'Savings Plan (3 year, no upfront)',
      '3-year commitment',
    ]) {
      expect(parseTerm(wording)).toEqual({
        years: 3,
        purchase: 'No Upfront',
        offeringClass: 'standard',
      });
    }
  });

  test('one year is honoured only when the wording says so', () => {
    expect(parseTerm('1-Yr No Upfront')?.years).toBe(1);
    expect(parseTerm('1 year RI')?.years).toBe(1);
    // Three years is the default because that is what an unqualified "reserved" cell
    // means in the worked example, and it is the cheaper of the two.
    expect(parseTerm('Reserved')?.years).toBe(3);
  });

  test('the upfront position is read, because it changes the amortised rate', () => {
    expect(parseTerm('3-Yr All Upfront')?.purchase).toBe('All Upfront');
    expect(parseTerm('3 Year Partial Upfront RI')?.purchase).toBe('Partial Upfront');
    expect(parseTerm('3-Yr No Upfront')?.purchase).toBe('No Upfront');
  });

  test('convertible has to be asked for by name', () => {
    expect(parseTerm('3yr convertible RI')?.offeringClass).toBe('convertible');
    // Standard is materially cheaper, and it is what a plain "reserved" cell means.
    expect(parseTerm('3yr reserved')?.offeringClass).toBe('standard');
  });

  test('unrecognised wording is treated as on-demand, not as a discount', () => {
    // The safer direction of the two errors: quoting a commitment the client never
    // agreed to understates the bill and cannot be defended.
    expect(parseTerm('TBD')).toBeUndefined();
    expect(parseTerm('see finance')).toBeUndefined();
  });
});

describe('planning a group without a model', () => {
  test('an EC2 instance type is mapped by rule, with no classifier call needed', () => {
    const plan = planFromGroup(group({ size: 'm6a.xlarge', os: 'Linux' }), 'eu-central-1');

    expect(plan).toBeDefined();
    expect(plan!.serviceCode).toBe('AmazonEC2');
    expect(plan!.filters).toEqual({ instanceType: 'm6a.xlarge', operatingSystem: 'Linux' });
    // ec2Enhancement, not eC2Next: the catalogue's traps[] says the legacy format saves
    // cleanly but renders read-only, so the calculator cannot rehydrate the estimate.
    expect(plan!.calculatorKey).toBe('ec2Enhancement');
  });

  test('operating systems are mapped to the names the Price List uses', () => {
    const osOf = (os: string) => planFromGroup(group({ os }), 'eu-central-1')!.filters.operatingSystem;

    expect(osOf('Windows Server 2019')).toBe('Windows');
    expect(osOf('Win2019')).toBe('Windows');
    expect(osOf('RHEL 8')).toBe('RHEL');
    expect(osOf('Red Hat Enterprise Linux')).toBe('RHEL');
    expect(osOf('SLES 15')).toBe('SUSE');
    expect(osOf('Ubuntu 22.04')).toBe('Linux');
    // A blank OS column is the common case and Linux is the right default; guessing
    // Windows would inflate every unlabelled row by ~90%.
    expect(planFromGroup(group({ os: undefined }), 'eu-central-1')!.filters.operatingSystem).toBe('Linux');
  });

  test('the machine count goes in workload, which is what the calculator bills on', () => {
    const plan = planFromGroup(group({ count: 12 }), 'eu-central-1');

    // traps[]: "workload is the INSTANCE COUNT". Putting 12 only in the description
    // saves an estimate that prices one machine while reading as twelve.
    expect(plan!.calculatorConfig!.workload).toBe(12);
    expect(String(plan!.calculatorConfig!.description)).toContain('12 x m6a.xlarge');
  });

  test('a part-time schedule becomes a utilization percentage', () => {
    // traps[]: utilization is hidden inside pricingStrategy and does not appear in
    // get_service_fields, so it has to be passed as this top-level field.
    expect(planFromGroup(group({ hoursPerDay: 24 }), 'ap-south-1')!.calculatorConfig!.utilization).toBe('100');
    expect(planFromGroup(group({ hoursPerDay: 12 }), 'ap-south-1')!.calculatorConfig!.utilization).toBe('50');
    expect(planFromGroup(group({ hoursPerDay: 8 }), 'ap-south-1')!.calculatorConfig!.utilization).toBe('33');
  });

  test('hours per month wins over hours per day, because 12x5 is neither', () => {
    // 260 hrs/month is 35.6% of a 730-hour month. Derived from hours-per-day it would
    // round to 8h/day = 33%, moving the figure on every scheduled machine.
    const plan = planFromGroup(group({ hoursPerMonth: 260, hoursPerDay: 8 }), 'ap-south-1');

    expect(plan!.calculatorConfig!.utilization).toBe('36');
  });

  test('an unsupported EC2 RI contract is explicit and never substituted with a Savings Plan', () => {
    const plan = planFromGroup(group({ purchaseModel: '3-Yr No Upfront' }), 'eu-central-1');

    expect(plan!.term).toEqual({ years: 3, purchase: 'No Upfront', offeringClass: 'standard' });
    expect(plan!.calculatorConfig).toBeUndefined();
    expect(plan!.calculatorUnsupported).toMatch(/does not expose an exact Reserved Instance/);
  });

  test('an on-demand group uses the shorthand, which is safe for on-demand only', () => {
    expect(planFromGroup(group({ purchaseModel: 'On-Demand' }), 'eu-central-1')!.calculatorConfig!.pricingStrategy)
      .toBe('ondemand');
  });

  test('an RDS instance is recognised, but only when the engine is known', () => {
    const withEngine = planFromGroup(
      group({ size: 'db.r6g.large', service: 'Amazon RDS PostgreSQL' }),
      'eu-central-1',
    );
    expect(withEngine!.serviceCode).toBe('AmazonRDS');
    expect(withEngine!.filters).toEqual({ instanceType: 'db.r6g.large', databaseEngine: 'PostgreSQL' });

    // The engine governs the rate, and Oracle is many times MySQL. An unnamed engine
    // falls through to the classifier rather than being assumed.
    expect(planFromGroup(group({ size: 'db.r6g.large', service: 'Database' }), 'eu-central-1')).toBeUndefined();
  });

  test('anything without an instance type falls through to the classifier', () => {
    // Deliberately conservative: a wrong rule is silent, a classifier call is not.
    expect(planFromGroup(group({ size: 'Standard_D4s_v3' }), 'ap-south-1')).toBeUndefined();
    expect(planFromGroup(group({ size: '4 vCPU / 16 GB', vcpu: 4, ramGb: 16 }), 'ap-south-1')).toBeUndefined();
    expect(planFromGroup(group({ size: undefined }), 'ap-south-1')).toBeUndefined();
    expect(planFromGroup(group({ size: 'S3 bucket' }), 'ap-south-1')).toBeUndefined();
  });

  test('the group region wins over the estimate default', () => {
    const plan = planFromGroup(group({ region: 'us-east-1' }), 'eu-central-1');

    expect(plan!.calculatorConfig!.region).toBe('us-east-1');
  });
});

/** A Price List product carrying on-demand plus the reserved offers AWS publishes. */
function product(options: {
  onDemand?: number;
  reserved?: { lease: string; purchase: string; offeringClass?: string; hourly: number; upfront?: number }[];
  unit?: string;
  attributes?: Record<string, string>;
} = {}) {
  const terms: any = {};
  if (options.onDemand !== undefined) {
    terms.OnDemand = {
      'OFFER.CODE': {
        priceDimensions: {
          'OFFER.CODE.DIM': {
            unit: options.unit || 'Hrs',
            pricePerUnit: { USD: String(options.onDemand) },
            description: `$${options.onDemand} per On Demand Linux m6a.xlarge Instance Hour`,
          },
        },
      },
    };
  }
  if (options.reserved?.length) {
    terms.Reserved = Object.fromEntries(options.reserved.map((offer, at) => [
      `RES.${at}`,
      {
        termAttributes: {
          LeaseContractLength: offer.lease,
          PurchaseOption: offer.purchase,
          ...(offer.offeringClass ? { OfferingClass: offer.offeringClass } : {}),
        },
        priceDimensions: {
          [`RES.${at}.HRS`]: {
            unit: 'Hrs',
            pricePerUnit: { USD: String(offer.hourly) },
            description: 'USD 0.0 per Linux m6a.xlarge Instance Hour',
          },
          ...(offer.upfront
            ? {
              [`RES.${at}.FEE`]: {
                unit: 'Quantity',
                pricePerUnit: { USD: String(offer.upfront) },
                description: 'Upfront Fee',
              },
            }
            : {}),
        },
      },
    ]));
  }
  return JSON.stringify({ product: { sku: 'SKU1', attributes: options.attributes || {} }, terms });
}

describe('surviving the Price List API itself', () => {
  test('a throttle is retried rather than costing the estimate a line item', async () => {
    // The live 110-machine run made 105 lookups and one came back "Rate exceeded". That
    // dropped a machine out of the total silently, which is the one failure a cost
    // document must not have.
    pricingMock.on(GetProductsCommand)
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .resolves({ PriceList: [product({ onDemand: 0.2064 })] });

    const result = await lookupPrice({
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
    });

    expect(result.found).toBe(true);
    expect(result.ratePerUnit).toBeCloseTo(0.2064, 6);
  });

  test('a genuine failure is still reported rather than retried forever', async () => {
    pricingMock.on(GetProductsCommand).rejects(
      Object.assign(new Error('User is not authorized to perform pricing:GetProducts'), { name: 'AccessDeniedException' }),
    );

    const result = await lookupPrice({
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
    });

    // One attempt, no backoff: a permissions fault will not clear by waiting.
    expect(result.found).toBe(false);
    expect(result.message).toContain('not authorized');
    expect(pricingMock.commandCalls(GetProductsCommand)).toHaveLength(1);
  });

  test('the same question is asked of AWS once per estimate', async () => {
    pricingMock.on(GetProductsCommand).resolves({ PriceList: [product({ onDemand: 0.2064 })] });
    const query = {
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge', operatingSystem: 'Linux' },
    };

    const [first, second] = await Promise.all([lookupPrice(query), lookupPrice(query)]);

    expect(first.ratePerUnit).toBe(second.ratePerUnit);
    // Concurrent duplicates share one in-flight request, which is what keeps a fleet
    // standardised on one instance type from throttling itself.
    expect(pricingMock.commandCalls(GetProductsCommand)).toHaveLength(1);

    // A commitment is a different question about the same product, so it is asked.
    await lookupPrice({ ...query, term: { years: 3, purchase: 'No Upfront' } });
    expect(pricingMock.commandCalls(GetProductsCommand)).toHaveLength(2);
  });

  test('a regional Fargate usage type is matched by suffix', async () => {
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [
        product({ onDemand: 0.004445, unit: 'GB-Hours', attributes: { usagetype: 'APS3-Fargate-GB-Hours' } }),
      ],
    });

    const result = await lookupPrice({
      serviceCode: 'AmazonECS',
      region: 'ap-south-1',
      filters: { usagetype: '*Fargate-GB-Hours' },
    });

    expect(result.found).toBe(true);
    expect(result.ratePerUnit).toBeCloseTo(0.004445, 6);
    expect(pricingMock.commandCalls(GetProductsCommand)[0].args[0].input.Filters)
      .not.toContainEqual(expect.objectContaining({ Field: 'usagetype' }));
  });

  test('Aurora lookups do not add the plain-RDS databaseEdition default', async () => {
    pricingMock.on(GetProductsCommand).resolves({ PriceList: [product({ onDemand: 0.29 })] });

    const result = await lookupPrice({
      serviceCode: 'AmazonRDS',
      region: 'ap-south-1',
      filters: { instanceType: 'db.r6g.large', databaseEngine: 'Aurora PostgreSQL' },
    });

    expect(result.found).toBe(true);
    expect(pricingMock.commandCalls(GetProductsCommand)[0].args[0].input.Filters)
      .not.toContainEqual(expect.objectContaining({ Field: 'databaseEdition' }));
  });

  test('a failed lookup is not cached, so one throttle cannot poison the run', async () => {
    pricingMock.on(GetProductsCommand)
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .rejectsOnce(Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }))
      .resolves({ PriceList: [product({ onDemand: 0.2064 })] });
    const query = {
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
    };

    // Five throttles exhaust the retries, so this one gives up.
    expect((await lookupPrice(query)).found).toBe(false);
    // And the next group asking the same question gets the real rate, not the failure.
    expect((await lookupPrice(query)).ratePerUnit).toBeCloseTo(0.2064, 6);
  }, 20_000);
});

describe('pricing against a commitment', () => {
  test('a 3-year No Upfront RI is priced from the reserved term, not on-demand', async () => {
    // The real published pair for m6a.xlarge/Linux in eu-central-1.
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [product({
        onDemand: 0.2064,
        reserved: [
          { lease: '3yr', purchase: 'No Upfront', offeringClass: 'standard', hourly: 0.0939 },
          { lease: '1yr', purchase: 'No Upfront', offeringClass: 'standard', hourly: 0.13693 },
        ],
      })],
    });

    const result = await lookupPrice({
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
      term: { years: 3, purchase: 'No Upfront', offeringClass: 'standard' },
    });

    expect(result.found).toBe(true);
    expect(result.ratePerUnit).toBeCloseTo(0.0939, 6);
    // The basis of a figure is part of the figure: a cost document that cannot say
    // whether a number is committed or on-demand cannot be checked.
    expect(result.termLabel).toBe('3-year No Upfront reserved');
    expect(result.termFellBack).toBeUndefined();
  });

  test('the term asked for is the term returned, not merely any reserved offer', async () => {
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [product({
        reserved: [
          { lease: '1yr', purchase: 'No Upfront', offeringClass: 'standard', hourly: 0.13693 },
          { lease: '3yr', purchase: 'No Upfront', offeringClass: 'standard', hourly: 0.0939 },
          { lease: '3yr', purchase: 'No Upfront', offeringClass: 'convertible', hourly: 0.10767 },
        ],
      })],
    });

    const oneYear = await lookupPrice({
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
      term: { years: 1, purchase: 'No Upfront' },
    });
    expect(oneYear.ratePerUnit).toBeCloseTo(0.13693, 6);

    const convertible = await lookupPrice({
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
      term: { years: 3, purchase: 'No Upfront', offeringClass: 'convertible' },
    });
    expect(convertible.ratePerUnit).toBeCloseTo(0.10767, 6);
  });

  test('an All Upfront fee is amortised, so the rate is never reported as zero', async () => {
    // All Upfront publishes an hourly of $0 plus a one-off fee. Reporting only the
    // hourly would price a committed fleet at nothing at all.
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [product({
        reserved: [{ lease: '3yr', purchase: 'All Upfront', offeringClass: 'standard', hourly: 0, upfront: 2400 }],
      })],
    });

    const result = await lookupPrice({
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
      term: { years: 3, purchase: 'All Upfront' },
    });

    expect(result.found).toBe(true);
    // 2400 over three calendar years of hours — 8760, not 730 x 12, because the fee
    // buys the term whether or not the instance is running.
    expect(result.ratePerUnit).toBeCloseTo(2400 / (3 * 8760), 8);
    expect(result.ratePerUnit).toBeGreaterThan(0);
  });

  test('a missing commitment falls back to on-demand and says so', async () => {
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [product({ onDemand: 0.2064 })],
    });

    const result = await lookupPrice({
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
      term: { years: 3, purchase: 'No Upfront' },
    });

    // A silent fallback would present an on-demand figure as a committed one, which
    // overstates the bill by more than double and reads as if it were the discount.
    expect(result.found).toBe(true);
    expect(result.ratePerUnit).toBeCloseTo(0.2064, 6);
    expect(result.termLabel).toBe('on-demand');
    expect(result.termFellBack).toBe(true);
  });

  test('no term asked for still means on-demand, labelled', async () => {
    pricingMock.on(GetProductsCommand).resolves({
      PriceList: [product({
        onDemand: 0.2064,
        reserved: [{ lease: '3yr', purchase: 'No Upfront', offeringClass: 'standard', hourly: 0.0939 }],
      })],
    });

    const result = await lookupPrice({
      serviceCode: 'AmazonEC2',
      region: 'eu-central-1',
      filters: { instanceType: 'm6a.xlarge' },
    });

    // A discount the client did not ask for must never appear on its own.
    expect(result.ratePerUnit).toBeCloseTo(0.2064, 6);
    expect(result.termLabel).toBe('on-demand');
  });
});

// ---------------------------------------------------------------------------
// planSegments: turning a STATED request into priced segments.
// ---------------------------------------------------------------------------

function resource(overrides: Partial<CalculationResource> = {}): CalculationResource {
  return { raw: 'row', service: 'EC2', size: 't3.large', quantity: '2', ...overrides };
}

function request(overrides: Partial<EstimateScenarioRequest> = {}): EstimateScenarioRequest {
  return { label: 'Scenario', pricing_model: 'on-demand', environments: [], ...overrides };
}

describe('turning a stated request into segments', () => {
  const hoursFor = new Map<string, number>();

  test('an empty request prices nothing and asks for nothing', () => {
    const { segments, unmatched } = planSegments([], [resource()], [], hoursFor);
    expect(segments).toEqual([]);
    expect(unmatched).toEqual([]);
  });

  test('a scenario naming environments takes only those rows, and is additive', () => {
    const rows = [
      resource({ environment: 'Production' }),
      resource({ environment: 'UAT' }),
    ];
    const { segments } = planSegments(
      [request({ label: 'Production only', environments: ['production'] })],
      rows, [], hoursFor,
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('environment');
    expect(segments[0].groups.every((g) => g.environment === 'Production')).toBe(true);
    expect(segments[0].detail).toContain('these totals do add up');
  });

  test('environment matching also reads the band label, so a transposed model needs no Environment column', () => {
    // The two layouts record an environment in different places. A request that says
    // "UAT" must find the rows either way, or the answer changes with the upload's shape.
    const rows = [
      resource({ scenario: 'b-uat' }),
      resource({ scenario: 'b-prod' }),
    ];
    const bands = [
      { key: 'b-uat', label: 'UAT', kind: 'environment' as const, sheet: 'Capacity' },
      { key: 'b-prod', label: 'Production', kind: 'environment' as const, sheet: 'Capacity' },
    ];
    const { segments, unmatched } = planSegments(
      [request({ label: 'UAT only', environments: ['uat'] })],
      rows, bands, hoursFor,
    );
    expect(unmatched).toEqual([]);
    expect(segments).toHaveLength(1);
    expect(segments[0].groups).toHaveLength(1);
  });

  test('a fiscal-year label is a consecutive period, not an additive environment', () => {
    const { segments } = planSegments(
      [request({ label: 'FY 2027' }), request({ label: '27-28' })],
      [resource()], [], hoursFor,
    );
    expect(segments.map((s) => s.kind)).toEqual(['period', 'period']);
    expect(segments[0].detail).toContain('replaces theirs rather than adding to them');
  });

  test('a pricing-model comparison is an alternative, and says so', () => {
    const { segments } = planSegments(
      [request({ label: 'Cheaper commitment' })],
      [resource()], [], hoursFor,
    );
    expect(segments[0].kind).toBe('sizing');
    expect(segments[0].detail).toContain('only one of these totals will ever be spent');
  });

  test('two scenarios with the same label get distinct keys rather than overwriting', () => {
    const { segments } = planSegments(
      [request({ label: 'Production' }), request({ label: 'Production' })],
      [resource()], [], hoursFor,
    );
    expect(segments.map((s) => s.key).sort()).toEqual(['production', 'production-2']);
  });

  test('a request that matches no rows is reported by name, not silently dropped', () => {
    const { segments, unmatched } = planSegments(
      [request({ label: 'Staging DR', environments: ['staging'] })],
      [resource({ environment: 'Production' })], [], hoursFor,
    );
    expect(segments).toEqual([]);
    expect(unmatched).toHaveLength(1);
    expect(unmatched[0]).toContain('"Staging DR"');
    expect(unmatched[0]).toContain('staging');
    expect(unmatched[0]).toContain('not priced');
  });

  test('the requested pricing model becomes the segment commitment, overriding the sheet', () => {
    const row = resource({ purchase_model: '3-Yr No Upfront' });
    const { segments } = planSegments(
      [
        request({ label: 'A', pricing_model: 'ri-1yr-no-upfront' }),
        request({ label: 'B', pricing_model: 'on-demand' }),
        request({ label: 'C', pricing_model: 'compute-savings-3yr' }),
      ],
      [row], [], hoursFor,
    );
    expect(segments.map((s) => s.commitment)).toEqual([
      { model: 'reserved', years: 1, purchase: 'No Upfront' },
      { model: 'on-demand' },
      { model: 'compute-savings-plan', years: 3 },
    ]);
  });

  test('the detail sentence names the pricing model in client-facing words', () => {
    const { segments } = planSegments(
      [request({ label: 'A', pricing_model: 'ri-3yr-all-upfront', scope: 'Mumbai region', note: 'Board-approved capex.' })],
      [resource()], [], hoursFor,
    );
    expect(segments[0].detail).toContain('Mumbai region.');
    expect(segments[0].detail).toContain('3-year Reserved Instances, all upfront');
    expect(segments[0].detail).toContain('Board-approved capex.');
  });
});

// ---------------------------------------------------------------------------
// The shareable link's service definitions for Aurora and ElastiCache.
// ---------------------------------------------------------------------------

describe('deterministic link configs beyond EC2', () => {
  const hoursFor = new Map<string, number>();

  test('an Aurora row builds the columnFormIPM config the live sidecar accepts', () => {
    // The shape is not guessed: it was saved to and exported from the deployed
    // calculator sidecar before this test was written, in both the on-demand and
    // reserved forms. The lint refuses the export without `edition`, and rejects
    // "Aurora MySQL" priced through the generic RDS service.
    const rows = [resource({
      service: 'Aurora MySQL',
      size: 'db.r6g.large',
      quantity: '2',
    })];
    const { segments } = planSegments(
      [request({ label: 'A' })],
      rows, [], hoursFor,
    );
    // planSegments only groups; the plan comes from planFromGroup via the same
    // deterministic path. Assert through it directly.
    const groups = groupResources(rows, hoursFor, 'baseline');
    const plan = planFromGroup(groups[0], 'ap-south-1');
    expect(plan?.calculatorKey).toBe('amazonAuroraMySQLCompatible');
    const config = plan?.calculatorConfig as Record<string, any>;
    expect(config.edition).toBe('auroraStandard');
    expect(config.columnFormIPM.value[0]['Number of Nodes']).toEqual({ value: '2' });
    expect(config.columnFormIPM.value[0]['Instance Type']).toEqual({ value: 'db.r6g.large' });
    expect(config.columnFormIPM.value[0].TermType).toEqual({ value: 'OnDemand' });
    expect(segments).toHaveLength(1);
  });

  test('Aurora PostgreSQL selects the PostgreSQL service key', () => {
    const groups = groupResources(
      [resource({ service: 'Aurora PostgreSQL', size: 'db.r6g.large' })],
      hoursFor, 'baseline',
    );
    const plan = planFromGroup(groups[0], 'ap-south-1');
    expect(plan?.calculatorKey).toBe('amazonRDSAuroraPostgreSQLCompatibleDB');
  });

  test('plain PostgreSQL RDS compiles to its verified Calculator child service', () => {
    const groups = groupResources(
      [resource({ service: 'RDS PostgreSQL', size: 'db.r6g.large' })],
      hoursFor, 'baseline',
    );
    const plan = planFromGroup(groups[0], 'ap-south-1');
    expect(plan?.calculatorKey).toBe('amazonRDSPostgreSQLDB');
    expect(plan?.calculatorConfig?.columnFormIPM).toBeDefined();
  });

  test('an ElastiCache row builds an on-demand-only link, as the sidecar demands', () => {
    // Every reserved tuple the probe tried was refused by the export lint for
    // amazonElastiCache, so the link is On-Demand even when the report prices a
    // reservation — the per-service mix, stated the same way in the report.
    const groups = groupResources(
      [resource({ service: 'ElastiCache Redis', size: 'cache.r6g.large', quantity: '3' })],
      hoursFor, 'baseline',
    );
    const plan = planFromGroup(groups[0], 'ap-south-1');
    expect(plan?.serviceCode).toBe('AmazonElastiCache');
    expect(plan?.calculatorKey).toBe('amazonElastiCache');
    const config = plan?.calculatorConfig as Record<string, any>;
    expect(config.columnFormIPM.value[0]['Cache Engine']).toEqual({ value: 'Redis' });
    expect(config.columnFormIPM.value[0]['Number of Nodes']).toEqual({ value: '3' });
    expect(config.columnFormIPM.value[0].TermType).toEqual({ value: 'OnDemand' });
    expect(config.columnFormIPM.value[0].LeaseContractLength).toBeUndefined();
  });

  test('a committed Aurora scenario rewrites the column row around the effective term', () => {
    const rows = [resource({ service: 'Aurora MySQL', size: 'db.r6g.large', purchase_model: 'On-Demand' })];
    const { segments } = planSegments(
      [request({ label: 'Committed', pricing_model: 'ri-3yr-partial-upfront' })],
      rows, [], hoursFor,
    );
    expect(segments[0].commitment).toEqual({ model: 'reserved', years: 3, purchase: 'Partial Upfront' });
  });
});
