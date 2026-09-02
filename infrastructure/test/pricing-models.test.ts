import {
  displayName,
  resolvePricing,
  summariseScenario,
  termLabelOf,
  type CommittedPricing,
  type OnDemandPricing,
  type PricingDecision,
  type UnpriceableCommitment,
} from '../lambdas/shared/pricing-models';

/**
 * Commitment eligibility.
 *
 * The estimate this module was written for asked for three pricing models over a mix of ECS
 * Fargate, Aurora MySQL-Compatible, ElastiCache and OpenSearch, and only three of those four
 * can be reserved. So the two RI columns were mixed-model totals, and every test here is
 * really one of two questions: did the right service get the discount, and does the output
 * SAY what it did. A silently mixed total is the failure — it looks finished, and its heading
 * is not true of all of it.
 */

const committed = (decision: PricingDecision): CommittedPricing => {
  expect(decision.pricing).toBe('committed');
  return decision as CommittedPricing;
};

const stayedOnDemand = (decision: PricingDecision): OnDemandPricing => {
  expect(decision.pricing).toBe('on-demand');
  return decision as OnDemandPricing;
};

const reserved = (years: 1 | 3, purchase?: 'No Upfront' | 'Partial Upfront' | 'All Upfront') =>
  ({ model: 'reserved' as const, years, ...(purchase ? { purchase } : {}) });

describe('Aurora at three years has to move to Partial Upfront, because No Upfront is a one-year offer', () => {
  test('a 3-year No Upfront request on RDS resolves to Partial Upfront', () => {
    // The customer's own configuration: "3-Year RI: Aurora MySQL-Compatible uses Partial
    // Upfront because Aurora No Upfront is only available for a 1-year reservation."
    const decision = committed(resolvePricing({ serviceCode: 'AmazonRDS' }, reserved(3, 'No Upfront')));

    expect(decision.term).toEqual({ years: 3, purchase: 'Partial Upfront' });
    expect(decision.termLabel).toBe('3-year Partial Upfront reserved');
  });

  test('the substitution is stated, so the 12-month total can be explained', () => {
    // A 3-year Partial Upfront reservation carries a one-off charge the 1-year scenarios do
    // not. If the report cannot say why Aurora differs, that charge looks like an error.
    const decision = committed(resolvePricing({ serviceCode: 'AmazonRDS' }, reserved(3, 'No Upfront')));

    expect(decision.substitution).toBeTruthy();
    expect(decision.substitution).toMatch(/no upfront/i);
    expect(decision.substitution).toMatch(/1-year/i);
  });

  test('the same request at one year is honoured verbatim and explains nothing', () => {
    const decision = committed(resolvePricing({ serviceCode: 'AmazonRDS' }, reserved(1, 'No Upfront')));

    expect(decision.term).toEqual({ years: 1, purchase: 'No Upfront' });
    expect(decision.substitution).toBeUndefined();
  });

  test('ElastiCache and OpenSearch keep 3-year No Upfront, so the exception is per service not per term', () => {
    // Both sat in the same 3-year scenario as Aurora on a different purchase option. If this
    // were a blanket rule about three-year terms it would have overwritten these two.
    for (const serviceCode of ['AmazonElastiCache', 'AmazonES']) {
      const decision = committed(resolvePricing({ serviceCode }, reserved(3, 'No Upfront')));
      expect(decision.term.purchase).toBe('No Upfront');
      expect(decision.substitution).toBeUndefined();
    }
  });

  test('OpenSearch answers to its newer service code as well as AmazonES', () => {
    // A missed alias would demote a fully reservable service to "eligibility unknown", which
    // drops it out of the RI scope sentence and understates the saving.
    const decision = committed(resolvePricing({ serviceCode: 'AmazonOpenSearchService' }, reserved(3)));

    expect(decision.term.purchase).toBe('No Upfront');
    expect(displayName('AmazonOpenSearchService')).toBe('OpenSearch');
  });

  test('DynamoDB reserved capacity resolves to Partial Upfront and carries its precondition', () => {
    // Reserved capacity is an upfront fee plus a discounted hourly rate — there is no No
    // Upfront to resolve to — and it buys nothing at all for a table in on-demand mode.
    const decision = committed(resolvePricing({ serviceCode: 'AmazonDynamoDB' }, reserved(1, 'No Upfront')));

    expect(decision.term.purchase).toBe('Partial Upfront');
    expect(decision.condition).toMatch(/provisioned capacity/i);
  });

  test('EC2 keeps the convertible class, and services with no such distinction do not invent one', () => {
    const ec2 = committed(resolvePricing(
      { serviceCode: 'AmazonEC2' },
      { model: 'reserved', years: 3, purchase: 'All Upfront', offeringClass: 'convertible' },
    ));
    expect(ec2.term.offeringClass).toBe('convertible');
    expect(ec2.termLabel).toBe('3-year All Upfront convertible reserved');

    const cache = committed(resolvePricing(
      { serviceCode: 'AmazonElastiCache' },
      { model: 'reserved', years: 1, offeringClass: 'convertible' },
    ));
    expect(cache.term.offeringClass).toBeUndefined();
    expect(cache.substitution).toMatch(/convertible/i);
  });
});

describe('A service with no Reserved Instance purchase model stays On-Demand and says why', () => {
  test('Fargate under a 1-year RI request stays On-Demand with a printable reason', () => {
    // The line the customer document had to carry: "ECS Fargate does not have a Reserved
    // Instance purchase model, so Fargate remains On-Demand in the RI estimates."
    const decision = stayedOnDemand(resolvePricing({ serviceCode: 'AmazonECS' }, reserved(1)));

    expect(decision.because).toBe('no-commitment-offered');
    expect(decision.reason.length).toBeGreaterThan(0);
    expect(decision.reason).toMatch(/reserved instance/i);
    expect(decision.reason).toMatch(/on-demand/i);
  });

  test('Fargate stays On-Demand at three years too, with the same standing', () => {
    const decision = stayedOnDemand(resolvePricing({ serviceCode: 'AmazonECS' }, reserved(3, 'Partial Upfront')));

    expect(decision.because).toBe('no-commitment-offered');
    expect(decision.reason).toBeTruthy();
  });

  test('every usage-billed service in the mix resolves the same way and none of them is silent', () => {
    const codes = ['AWSLambda', 'AmazonS3', 'AmazonApiGateway', 'AmazonCloudFront',
      'AmazonSNS', 'AmazonSQS', 'AmazonCognito', 'AWSDataTransfer'];

    for (const serviceCode of codes) {
      const decision = stayedOnDemand(resolvePricing({ serviceCode }, reserved(3)));
      expect(decision.because).toBe('no-commitment-offered');
      expect(decision.reason.trim().length).toBeGreaterThan(20);
    }
  });

  test('an EBS volume under AmazonEC2 stays On-Demand, because a reservation covers instance capacity only', () => {
    // EBS has no service code of its own, so the service code alone would have committed a
    // GB-month line to an instance reservation that cannot cover it.
    const decision = stayedOnDemand(resolvePricing(
      { serviceCode: 'AmazonEC2', filters: { volumeApiName: 'gp3' } },
      reserved(3),
    ));

    expect(decision.because).toBe('not-instance-capacity');
    expect(decision.reason).toMatch(/instance capacity/i);
  });

  test('an On-Demand scenario says the basis was requested, not that nothing was eligible', () => {
    // Same outcome, opposite meaning: an eligible service priced On-Demand on purpose must
    // not read as a service that could not be discounted.
    const decision = stayedOnDemand(resolvePricing({ serviceCode: 'AmazonRDS' }, { model: 'on-demand' }));

    expect(decision.because).toBe('requested');
    expect(decision.reason).toMatch(/on-demand/i);
  });
});

describe('An unrecognised service code is never given a discount it might not have', () => {
  test('an unknown code stays On-Demand and reports the eligibility as unestablished', () => {
    // Assuming eligibility overstates the saving and nothing in the report would reveal it.
    // Assuming On-Demand overstates the cost, which the customer can see and query.
    const decision = stayedOnDemand(resolvePricing({ serviceCode: 'AmazonTimestream' }, reserved(3)));

    expect(decision.because).toBe('eligibility-unknown');
    expect(decision.reason).toMatch(/has not been established|not been established/i);
    expect(decision.reason).toMatch(/AmazonTimestream/);
  });

  test('an empty service code still produces a reason rather than an assumption', () => {
    const decision = stayedOnDemand(resolvePricing({ serviceCode: '' }, reserved(1)));

    expect(decision.because).toBe('eligibility-unknown');
    expect(decision.reason.length).toBeGreaterThan(0);
  });
});

describe('A Savings Plan request is answered with a caveat, never with a Reserved rate', () => {
  test('a Compute Savings Plan on Fargate is unpriceable here and states what the figure really is', () => {
    // This repo reads committed rates only from the Price List terms.Reserved map. A Savings
    // Plan rate lives behind a different API that is not a dependency, so the only honest
    // answers are On-Demand plus a caveat, or nothing.
    const decision = resolvePricing({ serviceCode: 'AmazonECS' }, { model: 'compute-savings-plan', years: 3 });

    expect(decision.pricing).toBe('unpriceable-commitment');
    const caveated = decision as UnpriceableCommitment;
    expect(caveated.pricedAt).toBe('on-demand');
    expect(caveated.caveat).toMatch(/savings plan/i);
    expect(caveated.caveat).toMatch(/upper bound/i);
  });

  test('a Savings Plan request never yields a term, so no Reserved rate can be read for it', () => {
    // The specific mistake being blocked: aliasing a Savings Plan to the equivalent RI, which
    // would produce a figure labelled as one instrument and computed from another.
    for (const serviceCode of ['AmazonEC2', 'AmazonECS', 'AWSLambda']) {
      const decision = resolvePricing({ serviceCode }, { model: 'compute-savings-plan', years: 1 });
      expect(decision.pricing).toBe('unpriceable-commitment');
      expect('term' in decision).toBe(false);
      expect('termLabel' in decision).toBe(false);
    }
  });

  test('a Savings Plan on Aurora falls to On-Demand and points at the instrument that would work', () => {
    // Compute Savings Plans cover EC2, Fargate and Lambda. RDS is discounted by reservation,
    // which this pipeline can actually price, so the reason has to say so.
    const decision = stayedOnDemand(resolvePricing(
      { serviceCode: 'AmazonRDS' },
      { model: 'compute-savings-plan', years: 3 },
    ));

    expect(decision.because).toBe('no-savings-plan-coverage');
    expect(decision.reason).toMatch(/Reserved DB Instances/);
  });
});

describe('The scenario summary makes a mixed pricing model visible instead of leaving it implied', () => {
  const mixedScenario = () => [
    { label: 'Aurora', decision: resolvePricing({ serviceCode: 'AmazonRDS' }, reserved(1, 'No Upfront')) },
    { label: 'ElastiCache', decision: resolvePricing({ serviceCode: 'AmazonElastiCache' }, reserved(1, 'No Upfront')) },
    { label: 'OpenSearch', decision: resolvePricing({ serviceCode: 'AmazonES' }, reserved(1, 'No Upfront')) },
    { label: 'ECS Fargate', decision: resolvePricing({ serviceCode: 'AmazonECS' }, reserved(1, 'No Upfront')) },
  ];

  test('the 1-year sentence names the RI services and the On-Demand remainder', () => {
    // Reproduces the customer document's own line: "RI scope: Aurora + ElastiCache +
    // OpenSearch; non-RI services remain On-Demand".
    const summary = summariseScenario(mixedScenario());

    expect(summary.sentence).toContain('RI scope: Aurora + ElastiCache + OpenSearch');
    expect(summary.sentence).toContain('non-RI services remain On-Demand');
    expect(summary.sentence).toContain('ECS Fargate');
    expect(summary.committed).toEqual(['Aurora', 'ElastiCache', 'OpenSearch']);
    expect(summary.onDemand).toEqual(['ECS Fargate']);
  });

  test('the Fargate reason survives into the caveats, so the exclusion is explained not just listed', () => {
    const summary = summariseScenario(mixedScenario());

    expect(summary.caveats.join(' ')).toMatch(/Reserved Instance purchase model/i);
  });

  test('the 3-year sentence separates Aurora Partial Upfront from the No Upfront pair', () => {
    // The whole reason the 3-year total is shaped differently. Collapsing the two groups
    // would hide the upfront charge behind an averaged label.
    const summary = summariseScenario([
      { label: 'Aurora MySQL-Compatible', decision: resolvePricing({ serviceCode: 'AmazonRDS' }, reserved(3, 'No Upfront')) },
      { label: 'ElastiCache', decision: resolvePricing({ serviceCode: 'AmazonElastiCache' }, reserved(3, 'No Upfront')) },
      { label: 'OpenSearch', decision: resolvePricing({ serviceCode: 'AmazonES' }, reserved(3, 'No Upfront')) },
      { label: 'ECS Fargate', decision: resolvePricing({ serviceCode: 'AmazonECS' }, reserved(3, 'No Upfront')) },
    ]);

    expect(summary.sentence).toContain('ElastiCache + OpenSearch at 3-year No Upfront reserved');
    expect(summary.sentence).toContain('Aurora MySQL-Compatible at 3-year Partial Upfront reserved');
    expect(summary.sentence).toContain('non-RI services remain On-Demand (ECS Fargate)');
  });

  test('an all-On-Demand scenario reads as a choice when it was one', () => {
    const summary = summariseScenario([
      { label: 'Aurora', decision: resolvePricing({ serviceCode: 'AmazonRDS' }, { model: 'on-demand' }) },
      { label: 'ECS Fargate', decision: resolvePricing({ serviceCode: 'AmazonECS' }, { model: 'on-demand' }) },
    ]);

    expect(summary.sentence).toMatch(/as the pricing model for this scenario/i);
    expect(summary.committed).toEqual([]);
    expect(summary.caveats).toEqual([]);
  });

  test('an RI scenario where nothing was eligible says so rather than claiming an RI scope', () => {
    // A serverless estimate asked for as "3-Year Reserved" must not print an RI scope line
    // with an empty scope.
    const summary = summariseScenario([
      { label: 'Lambda', decision: resolvePricing({ serviceCode: 'AWSLambda' }, reserved(3)) },
      { label: 'S3', decision: resolvePricing({ serviceCode: 'AmazonS3' }, reserved(3)) },
    ]);

    expect(summary.sentence).toMatch(/RI scope: none/i);
    expect(summary.sentence).toContain('Lambda, S3');
  });

  test('a Savings Plan scenario carries its caveat into the summary', () => {
    const summary = summariseScenario([
      { label: 'ECS Fargate', decision: resolvePricing({ serviceCode: 'AmazonECS' }, { model: 'compute-savings-plan', years: 3 }) },
    ]);

    expect(summary.onDemand).toEqual(['ECS Fargate']);
    expect(summary.caveats.join(' ')).toMatch(/Savings Plan rates are published through a separate AWS API/);
  });
});

describe('The summary is stable across runs, because a document gets compared between them', () => {
  test('the same services supplied in two different orders produce an identical summary', () => {
    // Object key order and array order are both accidents of how the pipeline happened to
    // walk the estimate. If either leaked into the sentence, a re-run would look like an
    // edit and a reviewer would go looking for a change that was never made.
    const line = (label: string, serviceCode: string) =>
      ({ label, decision: resolvePricing({ serviceCode }, reserved(3, 'No Upfront')) });

    const forwards = summariseScenario([
      line('Aurora MySQL-Compatible', 'AmazonRDS'),
      line('ElastiCache', 'AmazonElastiCache'),
      line('OpenSearch', 'AmazonES'),
      line('ECS Fargate', 'AmazonECS'),
      line('S3', 'AmazonS3'),
    ]);

    const backwards = summariseScenario([
      line('S3', 'AmazonS3'),
      line('ECS Fargate', 'AmazonECS'),
      line('OpenSearch', 'AmazonES'),
      line('ElastiCache', 'AmazonElastiCache'),
      line('Aurora MySQL-Compatible', 'AmazonRDS'),
    ]);

    expect(backwards).toEqual(forwards);
    expect(backwards.sentence).toBe(forwards.sentence);
    expect(backwards.onDemand).toEqual(['ECS Fargate', 'S3']);
  });

  test('a duplicated service is named once, not once per line item', () => {
    // A real estimate prices many rows per service. The scope sentence describes services.
    const summary = summariseScenario([
      { label: 'ElastiCache', decision: resolvePricing({ serviceCode: 'AmazonElastiCache' }, reserved(1)) },
      { label: 'ElastiCache', decision: resolvePricing({ serviceCode: 'AmazonElastiCache' }, reserved(1)) },
      { label: 'ECS Fargate', decision: resolvePricing({ serviceCode: 'AmazonECS' }, reserved(1)) },
      { label: 'ECS Fargate', decision: resolvePricing({ serviceCode: 'AmazonECS' }, reserved(1)) },
    ]);

    expect(summary.committed).toEqual(['ElastiCache']);
    expect(summary.onDemand).toEqual(['ECS Fargate']);
    expect(summary.sentence).toBe(
      'RI scope: ElastiCache at 1-year No Upfront reserved; non-RI services remain On-Demand (ECS Fargate).',
    );
  });

  test('an unlabelled line falls back to the service code display name', () => {
    const summary = summariseScenario([
      { decision: resolvePricing({ serviceCode: 'AmazonEC2' }, reserved(3)) },
      { decision: resolvePricing({ serviceCode: 'AmazonECS' }, reserved(3)) },
    ]);

    expect(summary.committed).toEqual(['EC2']);
    expect(summary.onDemand).toEqual(['ECS Fargate']);
  });
});

describe('The term label is the vocabulary the pricing layer already uses', () => {
  test('a resolved term is shaped exactly as aws-pricing PriceTerm expects', () => {
    // These strings are matched literally against Price List termAttributes. A casing drift
    // here silently stops matching any reserved offer, and every line falls back to
    // On-Demand while still being labelled as committed upstream.
    const decision = committed(resolvePricing({ serviceCode: 'AmazonEC2' }, reserved(1, 'All Upfront')));

    expect(Object.keys(decision.term).sort()).toEqual(['offeringClass', 'purchase', 'years']);
    expect(decision.term.years).toBe(1);
    expect(decision.term.purchase).toBe('All Upfront');
    expect(decision.term.offeringClass).toBe('standard');
  });

  test('the label names convertible and leaves standard unsaid', () => {
    expect(termLabelOf({ years: 3, purchase: 'No Upfront', offeringClass: 'standard' }))
      .toBe('3-year No Upfront reserved');
    expect(termLabelOf({ years: 1, purchase: 'Partial Upfront', offeringClass: 'convertible' }))
      .toBe('1-year Partial Upfront convertible reserved');
    expect(termLabelOf({ years: 3, purchase: 'All Upfront' })).toBe('3-year All Upfront reserved');
  });
});
