/**
 * Which AWS services can actually take a commitment discount, and what a service that
 * cannot must be priced at instead.
 *
 * Why this exists. An estimate asked for in three pricing models — On-Demand, 1-Year
 * Reserved, 3-Year Reserved — is not three copies of the same arithmetic with a discount
 * applied. A real service mix does not commit uniformly: on the Digital Assets estimate the
 * customer ran ECS Fargate, Aurora MySQL-Compatible, ElastiCache and OpenSearch, and only
 * three of those four have a reservation to buy. Fargate has no Reserved Instance purchase
 * model at all, so in both RI scenarios it stayed On-Demand. The RI scenarios were therefore
 * mixed-model estimates, and the document had to say so in as many words: "RI scope: Aurora +
 * ElastiCache + OpenSearch; non-RI services remain On-Demand".
 *
 * The failure this prevents is a reader trusting a label. A column headed "3-Year Reserved
 * Instances" over a total that is part committed and part On-Demand is not wrong by a
 * rounding difference — it is a number whose basis is unstated, and the two mistakes it
 * invites are opposite. Apply a discount to a service that has no reservation and the saving
 * is fabricated; refuse a discount to a service that does have one and the bill is overstated
 * by most of the saving. Only one of those is safe to hand a customer, which is why an
 * unrecognised service here resolves to On-Demand and says the eligibility is unknown, rather
 * than assuming either way quietly.
 *
 * Eligibility is deliberately NOT a boolean. Aurora publishes No Upfront for a one-year
 * reservation and does not publish it for three years, so a 3-year Aurora reservation has to
 * resolve to Partial Upfront — a real published offer, chosen on purpose, and reported as a
 * substitution. That per-term, per-purchase-option shape is the whole table; a single
 * "isReserved" flag could not have produced the customer's own 3-year configuration.
 *
 * Three deliberate non-goals:
 *
 *  - It reads no rates and calls nothing. It answers "what should this line be priced
 *    against, and what must the report say about that", so it stays exhaustively testable.
 *  - It does not price Savings Plans, and does not pretend to. See SAVINGS_PLAN_CAVEAT.
 *  - It is not a catalogue of AWS. Every entry is here because a service appeared in a real
 *    estimate; generality would mean guessing, and a guessed discount is the defect.
 *
 * A note the customer document makes explicitly, and worth repeating because it bounds what
 * this module may change: a reservation is a billing commitment against supported instance
 * capacity. It never alters the workload — not the instance type, not the count, not the
 * hours. Nothing here may touch a quantity.
 */

import type { PricingModelRequest } from '../../schema/estimate-plan';

/** Commitment lengths the AWS Price List publishes. There is no other value. */
export type CommitmentYears = 1 | 3;

/** How much of a reservation is paid up front, spelled as `termAttributes.PurchaseOption`. */
export type PurchaseOption = 'No Upfront' | 'Partial Upfront' | 'All Upfront';

/** Spelled as `termAttributes.OfferingClass`, which is lower case in the Price List. */
export type OfferingClass = 'standard' | 'convertible';

/**
 * A resolved commitment, in the exact shape `aws-pricing.PriceTerm` consumes.
 *
 * Structurally identical to that interface on purpose, so a decision can be handed straight
 * to `lookupPrice({ term })` with no translation layer to drift. It is redeclared rather
 * than imported because importing from `calculator-orchestrator/aws-pricing` would pull
 * `@aws-sdk/client-pricing` into a module whose entire value is that it has no I/O. If the
 * field names or the string casings there ever change, they must change here in the same
 * commit — the Price List matches these values literally.
 */
export interface CommitmentTerm {
  years: CommitmentYears;
  purchase: PurchaseOption;
  /** Omitted for services that publish no such distinction; see `offeringClassApplies`. */
  offeringClass?: OfferingClass;
}

/**
 * What the estimate asked for.
 *
 * A Savings Plan is its own model, not a flavour of reservation, because the two are priced
 * from different places and only one of them is reachable from this repo.
 */
export type CommitmentRequest =
  | { model: 'on-demand' }
  | {
    model: 'reserved';
    years: CommitmentYears;
    /** Defaults to No Upfront: the least cash committed, and what "1-Year RI" means unbadged. */
    purchase?: PurchaseOption;
    offeringClass?: OfferingClass;
  }
  | { model: 'compute-savings-plan'; years: CommitmentYears };

/**
 * The line being priced.
 *
 * The service code alone is not always enough to know whether the subject is reservable
 * capacity: EBS volumes, snapshots, data transfer and NAT gateways are all billed under
 * `AmazonEC2`, and none of them can be reserved. The filters are how that is told apart, so
 * they are part of the question rather than an afterthought.
 */
export interface PricingSubject {
  /** Price List service code, e.g. AmazonEC2, AmazonRDS, AmazonES. */
  serviceCode: string;
  /** The TERM_MATCH filters this line will be priced with, when they are known. */
  filters?: Record<string, string>;
}

/** A line that will be priced against a commitment. */
export interface CommittedPricing {
  pricing: 'committed';
  serviceCode: string;
  /** Hand straight to `lookupPrice({ term })`. */
  term: CommitmentTerm;
  /** How the basis reads in a report, e.g. "3-year Partial Upfront reserved". */
  termLabel: string;
  /** AWS's own name for the instrument, e.g. "Reserved DB Instances". */
  instrument: string;
  /**
   * Present only when the purchase option asked for is not published at this term, naming
   * what was used instead and why. Absent means the request was honoured verbatim, so a
   * report can stay silent rather than explaining a non-event.
   */
  substitution?: string;
  /** A precondition of the discount that this module cannot verify from a service code. */
  condition?: string;
}

/**
 * Machine-readable ground for an On-Demand outcome.
 *
 * Separate from the prose because the two have different jobs: `reason` is printed, this is
 * branched on. A scenario where every line is On-Demand because On-Demand was asked for
 * reads nothing like one where every line is On-Demand because nothing was eligible, and a
 * summary that could not tell them apart would print the wrong sentence for both.
 */
export type OnDemandGround =
  | 'requested'
  | 'no-commitment-offered'
  | 'not-instance-capacity'
  | 'no-savings-plan-coverage'
  | 'eligibility-unknown';

/** A line that stays On-Demand, carrying the sentence that says why. */
export interface OnDemandPricing {
  pricing: 'on-demand';
  serviceCode: string;
  /** Fit to print verbatim in a report. Never empty. */
  reason: string;
  because: OnDemandGround;
}

/**
 * A commitment that is real at AWS but not priceable here.
 *
 * Kept distinct from both other outcomes because collapsing it into either would be a lie of
 * a different kind: calling it "committed" would attach a Reserved rate to a Savings Plan
 * request, and calling it plain On-Demand would imply no discount exists when one does.
 */
export interface UnpriceableCommitment {
  pricing: 'unpriceable-commitment';
  serviceCode: string;
  /** What the figure will actually be, so nobody has to infer it. */
  pricedAt: 'on-demand';
  /** Fit to print verbatim. Never empty. */
  caveat: string;
}

export type PricingDecision = CommittedPricing | OnDemandPricing | UnpriceableCommitment;

/**
 * What a service publishes, per term.
 *
 * `purchaseOptions` is the mechanism behind the Aurora exception and is why this is a table
 * of lists rather than a set of flags: the availability of a purchase option is a property of
 * the (service, term) pair, not of the service.
 */
interface ReservedOffering {
  purchaseOptions: Record<CommitmentYears, PurchaseOption[]>;
  /** Whether standard/convertible means anything here. RDS and the node-based services omit it. */
  offeringClassApplies: boolean;
  /** AWS's own name for the instrument, quoted in reports so the wording matches the console. */
  instrument: string;
  condition?: string;
}

type ServiceProfile = {
  /** How the service reads in a client-facing sentence. */
  label: string;
  /**
   * True for the services a Compute Savings Plan covers — EC2, Fargate and Lambda, and
   * nothing else. Recorded even on services with no reservation, because "no RI" and "no
   * discount instrument at all" are different answers to give a customer.
   */
  computeSavingsPlan?: boolean;
} & (
  | { reserved: ReservedOffering; noReservationReason?: undefined }
  /** Required when there is no reservation: an outcome with no reason is not an outcome. */
  | { reserved?: undefined; noReservationReason: string }
);

/**
 * Every purchase option, ordered by cash committed up front, ascending.
 *
 * Serves twice over: it is the full set an unrestricted service offers, and — because the
 * order is meaningful rather than arbitrary — the preference order used when the option asked
 * for is not published at the requested term. Least cash out is the closest substitute for a
 * customer who chose No Upfront, and it is what their own 3-year Aurora line resolved to.
 */
const PURCHASE_PREFERENCE: PurchaseOption[] = ['No Upfront', 'Partial Upfront', 'All Upfront'];

/** Instance reservations where AWS publishes every payment option at both terms. */
const FULL_OPTIONS: Record<CommitmentYears, PurchaseOption[]> = {
  1: PURCHASE_PREFERENCE,
  3: PURCHASE_PREFERENCE,
};

/**
 * No Upfront at one year, but not at three.
 *
 * Verified against the customer's own configuration: "3-Year RI: Aurora MySQL-Compatible
 * uses Partial Upfront because Aurora No Upfront is only available for a 1-year reservation."
 * The same shape holds for RDS reservations generally and for Redshift reserved nodes, which
 * is why it is a shared constant rather than an Aurora special case — the exception is the
 * mechanism, and a second service needed it immediately.
 *
 * If this is ever wrong for some engine, the consequence is a Partial Upfront rate where No
 * Upfront was available: a different published offer, reported as a substitution, never an
 * invented number.
 */
const NO_UPFRONT_ONE_YEAR_ONLY: Record<CommitmentYears, PurchaseOption[]> = {
  1: PURCHASE_PREFERENCE,
  3: ['Partial Upfront', 'All Upfront'],
};

/**
 * The eligibility table, keyed on Price List service codes.
 *
 * Two kinds of entry, and the ineligible ones are not filler. A service with no reservation
 * has to be in this table to produce its named reason; leaving it out would give it the
 * "eligibility unknown" answer, which is true of a service nobody has checked and false of
 * Fargate, where the absence of an RI purchase model is the established fact the customer's
 * estimate turned on.
 */
const PROFILES: Record<string, ServiceProfile> = {
  AmazonEC2: {
    label: 'EC2',
    computeSavingsPlan: true,
    reserved: {
      purchaseOptions: FULL_OPTIONS,
      // The one service where the class genuinely changes the rate: convertible buys the
      // right to switch instance family later and costs more for it.
      offeringClassApplies: true,
      instrument: 'EC2 Reserved Instances',
    },
  },

  // Aurora arrives here too: the Price List publishes every engine under AmazonRDS and keys
  // reservations by service, not by engine, so the 3-year restriction the customer hit on
  // Aurora is expressed at this level.
  AmazonRDS: {
    label: 'RDS',
    reserved: {
      purchaseOptions: NO_UPFRONT_ONE_YEAR_ONLY,
      // Absent from RDS reserved offers entirely, which `readReservedRate` already tolerates.
      // Claiming "standard" in a report would invent a distinction AWS does not make here.
      offeringClassApplies: false,
      instrument: 'Reserved DB Instances',
    },
  },

  AmazonElastiCache: {
    label: 'ElastiCache',
    reserved: {
      // 3-year No Upfront exists here and this is not symmetry with RDS: the customer's
      // 3-year scenario used ElastiCache 3-Year No Upfront alongside Aurora Partial Upfront,
      // in the same estimate. The asymmetry is the observed fact.
      purchaseOptions: FULL_OPTIONS,
      offeringClassApplies: false,
      instrument: 'ElastiCache Reserved Nodes',
    },
  },

  // Still AmazonES in the Price List years after the rename; AmazonOpenSearchService is
  // aliased below because model output and newer docs use it and a missed alias would
  // downgrade a fully reservable service to "eligibility unknown".
  AmazonES: {
    label: 'OpenSearch',
    reserved: {
      purchaseOptions: FULL_OPTIONS,
      offeringClassApplies: false,
      instrument: 'OpenSearch Reserved Instances',
    },
  },

  AmazonRedshift: {
    label: 'Redshift',
    reserved: {
      purchaseOptions: NO_UPFRONT_ONE_YEAR_ONLY,
      offeringClassApplies: false,
      instrument: 'Redshift Reserved Nodes',
    },
  },

  AmazonDynamoDB: {
    label: 'DynamoDB',
    reserved: {
      // Reserved capacity is bought as an upfront fee plus a discounted hourly rate, which
      // is Partial Upfront and only Partial Upfront. Offering No Upfront here would resolve
      // to an offer that does not exist, and the line would silently fall back to On-Demand.
      purchaseOptions: { 1: ['Partial Upfront'], 3: ['Partial Upfront'] },
      offeringClassApplies: false,
      instrument: 'DynamoDB reserved capacity',
      // Load-bearing: a table in on-demand capacity mode gets no discount from reserved
      // capacity at all, and this module cannot see the capacity mode from a service code.
      condition: 'DynamoDB reserved capacity applies only to tables in provisioned capacity '
        + 'mode; a table billed in on-demand capacity mode takes no discount from it.',
    },
  },

  // The service the whole module was written for. Fargate is covered by Compute Savings
  // Plans, so "no discount is available" would be false — but no reservation exists, and
  // that is what an RI estimate has to be told.
  AmazonECS: {
    label: 'ECS Fargate',
    computeSavingsPlan: true,
    noReservationReason: 'ECS Fargate has no Reserved Instance purchase model, so it remains '
      + 'On-Demand in the Reserved Instance estimates. A Compute Savings Plan is the only '
      + 'commitment that discounts Fargate.',
  },

  AWSLambda: {
    label: 'Lambda',
    computeSavingsPlan: true,
    noReservationReason: 'Lambda has no Reserved Instance purchase model — it is billed per '
      + 'request and per GB-second — so it remains On-Demand. A Compute Savings Plan is the '
      + 'only commitment that discounts it.',
  },

  AmazonS3: {
    label: 'S3',
    noReservationReason: 'S3 has no Reserved Instance purchase model, so it remains '
      + 'On-Demand. Storage cost is reduced by storage class and lifecycle policy, not by a '
      + 'commitment.',
  },

  AmazonApiGateway: {
    label: 'API Gateway',
    noReservationReason: 'API Gateway is billed per request and has no reservation or Savings '
      + 'Plan, so it remains On-Demand.',
  },

  AmazonCloudFront: {
    label: 'CloudFront',
    // Private pricing agreements do exist, but they are negotiated and unpublished — nothing
    // in the Price List, so nothing this pipeline could price.
    noReservationReason: 'CloudFront is billed per GB and per request with no reservation '
      + 'published in the Price List, so it remains On-Demand.',
  },

  AmazonSNS: {
    label: 'SNS',
    noReservationReason: 'SNS is billed per request with no commitment purchase model, so it '
      + 'remains On-Demand.',
  },

  AWSQueueService: {
    label: 'SQS',
    noReservationReason: 'SQS is billed per request with no commitment purchase model, so it '
      + 'remains On-Demand.',
  },

  AmazonCognito: {
    label: 'Cognito',
    noReservationReason: 'Cognito is billed per monthly active user with no commitment '
      + 'purchase model, so it remains On-Demand.',
  },

  AWSDataTransfer: {
    label: 'Data transfer',
    noReservationReason: 'Data transfer is billed per GB moved and cannot be reserved, so it '
      + 'remains On-Demand.',
  },
};

/**
 * Alternative spellings of the same service.
 *
 * A miss here is not harmless: it turns a reservable service into "eligibility unknown" and
 * quietly drops it out of the RI scope sentence, so the estimate understates the saving and
 * the reader is told the wrong scope.
 */
const ALIASES: Record<string, string> = {
  AmazonOpenSearchService: 'AmazonES',
  AmazonSQS: 'AWSQueueService',
  // EBS has no service code of its own; it is priced under AmazonEC2 and caught by the
  // capacity check instead. Listed nowhere on purpose.
};

function profileOf(serviceCode: string): ServiceProfile | undefined {
  const code = String(serviceCode || '').trim();
  return PROFILES[code] ?? PROFILES[ALIASES[code] ?? ''];
}

/** How a service reads in a sentence, falling back to the code so prose never says undefined. */
export function displayName(serviceCode: string): string {
  return profileOf(serviceCode)?.label ?? String(serviceCode || 'unknown service');
}

/**
 * Filter keys and product families that mean "this is not reservable instance capacity".
 *
 * A denylist rather than an allowlist, which is the one place this module departs from
 * refuse-by-default, and for a reason: under an RI-eligible service code an unrecognised
 * product family is far more likely to be capacity than not, and the cost of being wrong is
 * bounded. `readReservedRate` finds no matching offer, `fetchPrice` falls back to On-Demand
 * and sets `termFellBack`, so the figure is the right one and the report already says the
 * commitment did not apply. Refusing real capacity, by contrast, overstates a bill with no
 * such signal anywhere.
 */
const NON_CAPACITY_FILTER_KEYS = ['volumeapiname', 'storageclass', 'transfertype'];

const NON_CAPACITY_FAMILIES = [
  'storage',
  'storage snapshot',
  'snapshot',
  'system operation',
  'provisioned throughput',
  'data transfer',
  'ip address',
  'nat gateway',
  'load balancer',
  'load balancer-application',
  'load balancer-network',
  'fee',
];

/** What the subject is, if it is demonstrably not instance capacity. */
function nonCapacitySubject(subject: PricingSubject): string | undefined {
  const filters = subject.filters || {};
  for (const [key, value] of Object.entries(filters)) {
    const name = key.toLowerCase();
    if (NON_CAPACITY_FILTER_KEYS.includes(name)) {
      return name === 'volumeapiname' ? 'an EBS volume' : 'a storage or transfer dimension';
    }
    const text = String(value || '').toLowerCase();
    if (name === 'productfamily' && NON_CAPACITY_FAMILIES.some((family) => text.startsWith(family))) {
      return `a ${text} line`;
    }
    if (name === 'usagetype' && /datatransfer|ebs[:\-]/.test(text)) {
      return 'a data transfer or EBS line';
    }
  }
  return undefined;
}

/**
 * The caveat a Savings Plan request carries, and the design decision behind it.
 *
 * This repo reads committed rates from exactly one place: the `terms.Reserved` map of a
 * Price List product. Savings Plan rates are not in there — they come from a separate
 * SavingsPlans API this package has no dependency on and is not going to grow one for. So a
 * Savings Plan rate is not obtainable today, and there are only two honest things to do with
 * the request: refuse it, or price On-Demand and say loudly that the discount is missing.
 * Aliasing it to the equivalent Reserved Instance rate would be a third option and it is the
 * one to avoid — the numbers differ, the coverage differs (a Compute Savings Plan spans
 * instance families and regions in a way an RI does not), and the result would be a figure
 * labelled as one thing and computed as another, which is exactly the defect this module
 * exists to stop.
 */
export const SAVINGS_PLAN_CAVEAT = 'A Compute Savings Plan discount could not be applied: '
  + 'Savings Plan rates are published through a separate AWS API that this estimate does not '
  + 'read, so the line is priced at On-Demand. The real cost under a Compute Savings Plan '
  + 'would be lower than shown — treat this figure as an upper bound, not as the plan rate.';

/** How a resolved term reads in a report. The basis of a figure is part of the figure. */
export function termLabelOf(term: CommitmentTerm): string {
  // "standard" is left unsaid because it is the default everywhere and naming it in a client
  // sentence adds a word that carries no information; "convertible" is always named because
  // it changes both the rate and what the customer is buying.
  const classSuffix = term.offeringClass === 'convertible' ? ' convertible' : '';
  return `${term.years}-year ${term.purchase}${classSuffix} reserved`;
}

/**
 * The one place a requested pricing model becomes a priceable commitment.
 *
 * `PricingModelRequest` is a closed, chat-facing enum precisely so that this translation is
 * code rather than string matching: a conversation asked for "3-Year RI, partial upfront",
 * and the term/upfront/offering triple the AWS Price List keys on is not something a model
 * should be responsible for spelling. Free text would arrive as "3yr RI", "3-Year Reserved",
 * "three year reserved" and worse for the same thing, and every spelling would need matching
 * here forever.
 *
 * The upfront variants map to genuinely different requests rather than to one another,
 * because they are different prices. A 3-year reservation quoted No Upfront for a service
 * that only publishes Partial is a figure nobody can buy, and `resolvePricing` can only say
 * so if it is told which one was asked for.
 *
 * `offeringClass` is deliberately left unset. Standard is the default everywhere and the
 * request enum has no convertible member, so setting it here would assert a choice the
 * requester never made -- and `offeringClassApplies` already omits it for services that
 * publish no such distinction.
 */
export function commitmentFromRequest(model: PricingModelRequest): CommitmentRequest | undefined {
  switch (model) {
    case 'sheet-specified':
      return undefined;
    case 'on-demand':
      return { model: 'on-demand' };
    case 'ri-1yr-no-upfront':
      return { model: 'reserved', years: 1, purchase: 'No Upfront' };
    case 'ri-1yr-partial-upfront':
      return { model: 'reserved', years: 1, purchase: 'Partial Upfront' };
    case 'ri-1yr-all-upfront':
      return { model: 'reserved', years: 1, purchase: 'All Upfront' };
    case 'ri-3yr-no-upfront':
      return { model: 'reserved', years: 3, purchase: 'No Upfront' };
    case 'ri-3yr-partial-upfront':
      return { model: 'reserved', years: 3, purchase: 'Partial Upfront' };
    case 'ri-3yr-all-upfront':
      return { model: 'reserved', years: 3, purchase: 'All Upfront' };
    case 'compute-savings-1yr':
      return { model: 'compute-savings-plan', years: 1 };
    case 'compute-savings-3yr':
      return { model: 'compute-savings-plan', years: 3 };
  }
  // No default clause above, so a new enum member fails the build here rather than falling
  // through to a silent On-Demand -- which would quote an undiscounted rate under a heading
  // promising a commitment, the one error in this file that a reader cannot see.
  const exhaustive: never = model;
  throw new Error(`Unhandled pricing model request: ${String(exhaustive)}`);
}

/**
 * How a requested pricing model reads in a sentence a client sees.
 *
 * Separate from `termLabelOf`, which names the term that was actually RESOLVED. The two can
 * legitimately differ -- a 3-year reservation can be asked for and come back On-Demand
 * because the service publishes none -- and a document that used the resolved label to
 * describe the request would quietly rewrite what the customer asked for into what they got.
 */
export function describeRequest(model: PricingModelRequest): string {
  switch (model) {
    case 'sheet-specified':
      return 'the purchase model stated for each resource';
    case 'on-demand':
      return 'On-Demand';
    case 'ri-1yr-no-upfront':
      return '1-year Reserved Instances, no upfront';
    case 'ri-1yr-partial-upfront':
      return '1-year Reserved Instances, partial upfront';
    case 'ri-1yr-all-upfront':
      return '1-year Reserved Instances, all upfront';
    case 'ri-3yr-no-upfront':
      return '3-year Reserved Instances, no upfront';
    case 'ri-3yr-partial-upfront':
      return '3-year Reserved Instances, partial upfront';
    case 'ri-3yr-all-upfront':
      return '3-year Reserved Instances, all upfront';
    case 'compute-savings-1yr':
      return 'a 1-year Compute Savings Plan';
    case 'compute-savings-3yr':
      return 'a 3-year Compute Savings Plan';
  }
  const exhaustive: never = model;
  throw new Error(`Unhandled pricing model request: ${String(exhaustive)}`);
}

function onDemand(serviceCode: string, because: OnDemandGround, reason: string): OnDemandPricing {
  return { pricing: 'on-demand', serviceCode, because, reason };
}

/**
 * What this line should actually be priced against, and what the report must say about it.
 *
 * Never throws and never returns an outcome without prose. The three outcomes are
 * exhaustive by construction: a commitment that can be priced, an On-Demand line that says
 * why it is On-Demand, or a commitment that exists at AWS and cannot be priced here.
 */
export function resolvePricing(
  subject: PricingSubject,
  request: CommitmentRequest,
): PricingDecision {
  const serviceCode = String(subject.serviceCode || '').trim();

  if (request.model === 'on-demand') {
    return onDemand(
      serviceCode,
      'requested',
      'Priced at On-Demand rates, as the pricing model for this scenario.',
    );
  }

  const profile = profileOf(serviceCode);
  if (!profile) {
    // The safe direction. A discount assumed here would show a saving nobody can point at a
    // purchase for; On-Demand overstates the cost, which is visible to the customer and
    // correctable by adding an entry above.
    return onDemand(
      serviceCode,
      'eligibility-unknown',
      `Whether ${serviceCode || 'this service'} offers a commitment purchase model has not `
      + 'been established, so it is priced at On-Demand rather than assuming a discount that '
      + 'may not exist.',
    );
  }

  if (!profile.reserved) {
    if (request.model === 'compute-savings-plan') {
      return profile.computeSavingsPlan
        ? {
          pricing: 'unpriceable-commitment',
          serviceCode,
          pricedAt: 'on-demand',
          caveat: `${profile.label}: ${SAVINGS_PLAN_CAVEAT}`,
        }
        : onDemand(serviceCode, 'no-savings-plan-coverage', noSavingsPlanReason(profile.label));
    }
    return onDemand(serviceCode, 'no-commitment-offered', profile.noReservationReason);
  }

  const notCapacity = nonCapacitySubject(subject);
  if (notCapacity) {
    // The customer document states the boundary this enforces: a reservation is a billing
    // commitment against supported instance capacity. A GB-month or a per-GB transfer rate
    // is not capacity, however eligible the surrounding service is.
    return onDemand(
      serviceCode,
      'not-instance-capacity',
      `A commitment covers supported instance capacity only, and this line is ${notCapacity}, `
      + `so it remains On-Demand even though ${profile.label} instances are reservable.`,
    );
  }

  if (request.model === 'compute-savings-plan') {
    return profile.computeSavingsPlan
      ? {
        pricing: 'unpriceable-commitment',
        serviceCode,
        pricedAt: 'on-demand',
        caveat: `${profile.label}: ${SAVINGS_PLAN_CAVEAT}`,
      }
      : onDemand(
        serviceCode,
        'no-savings-plan-coverage',
        `${noSavingsPlanReason(profile.label)} ${profile.label} capacity is discounted through `
        + `${profile.reserved.instrument} instead, which this estimate can price if the `
        + 'scenario asks for a reservation.',
      );
  }

  return resolveReserved(serviceCode, profile.label, profile.reserved, request);
}

function noSavingsPlanReason(label: string): string {
  return 'Compute Savings Plans cover EC2, Fargate and Lambda only, so no Savings Plan '
    + `applies to ${label} and the line is priced at On-Demand.`;
}

function resolveReserved(
  serviceCode: string,
  label: string,
  offering: ReservedOffering,
  request: Extract<CommitmentRequest, { model: 'reserved' }>,
): CommittedPricing {
  const available = offering.purchaseOptions[request.years];
  const wanted = request.purchase ?? 'No Upfront';

  // Preference order, not first-available: when the option asked for is missing the least
  // cash committed is the closest substitute, and it is what the customer's own 3-year
  // Aurora configuration used.
  const chosen = available.includes(wanted)
    ? wanted
    : PURCHASE_PREFERENCE.find((option) => available.includes(option)) ?? available[0];

  const term: CommitmentTerm = {
    years: request.years,
    purchase: chosen,
    ...(offering.offeringClassApplies
      ? { offeringClass: request.offeringClass ?? 'standard' }
      : {}),
  };

  const substitutions: string[] = [];
  if (chosen !== wanted) {
    substitutions.push(
      `${label} uses ${chosen} at ${request.years} years because ${wanted} is not offered on a `
      + `${request.years}-year ${label} reservation`
      + (offering.purchaseOptions[1].includes(wanted) && request.years === 3
        ? ` — ${wanted} is available for a 1-year reservation only.`
        : '.'),
    );
  }
  if (request.offeringClass === 'convertible' && !offering.offeringClassApplies) {
    substitutions.push(
      `${offering.instrument} publish no standard/convertible distinction, so the convertible `
      + 'class was not applied.',
    );
  }

  return {
    pricing: 'committed',
    serviceCode,
    term,
    termLabel: termLabelOf(term),
    instrument: offering.instrument,
    ...(substitutions.length ? { substitution: substitutions.join(' ') } : {}),
    ...(offering.condition ? { condition: offering.condition } : {}),
  };
}

/** One resolved line, as the scenario summary wants it. */
export interface ScenarioLine {
  /**
   * How this service should read in the sentence, e.g. "Aurora MySQL-Compatible". Falls back
   * to the service code's own label, which is right for EC2 and wrong for Aurora — the
   * engine is not in the service code, so only the caller knows.
   */
  label?: string;
  decision: PricingDecision;
}

/** The mix, stated. */
export interface ScenarioSummary {
  /**
   * The pricing-model line for the estimate, e.g. "RI scope: Aurora + ElastiCache +
   * OpenSearch at 1-year No Upfront reserved; non-RI services remain On-Demand (ECS Fargate)."
   */
  sentence: string;
  /** Services priced against a commitment, sorted, deduplicated. */
  committed: string[];
  /** Services left at On-Demand, sorted, deduplicated. */
  onDemand: string[];
  /** Substitutions, conditions and Savings Plan caveats worth printing beneath the table. */
  caveats: string[];
}

/**
 * Deterministic ordering, by code unit rather than locale.
 *
 * `localeCompare` reads the host's collation, so the same estimate rendered in a Lambda and
 * on a developer's machine could produce two different sentences and look like a content
 * change in a diff. This is a document that gets compared between runs; stability matters
 * more than alphabetising accented characters politely.
 */
function ordered(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Turns a set of per-service decisions into the sentence that makes a mixed model visible.
 *
 * This is the output the customer document could not do without: three columns headed
 * On-Demand, 1-Year Reserved and 3-Year Reserved, where the second and third are part
 * committed and part not. Without this sentence the reader has no way to know that, and the
 * totals quietly disagree with their own headings.
 *
 * Committed services are grouped by term label, because when they differ that difference is
 * the interesting part — Aurora on Partial Upfront beside ElastiCache and OpenSearch on No
 * Upfront is not a detail, it is the reason the 3-year total is shaped the way it is.
 */
export function summariseScenario(lines: ScenarioLine[]): ScenarioSummary {
  const nameOf = (line: ScenarioLine): string =>
    line.label?.trim() || displayName(line.decision.serviceCode);

  const byTerm = new Map<string, string[]>();
  const onDemandNames: string[] = [];
  const caveats: string[] = [];
  let requestedCount = 0;
  let onDemandCount = 0;

  for (const line of lines) {
    const name = nameOf(line);
    const decision = line.decision;
    if (decision.pricing === 'committed') {
      const group = byTerm.get(decision.termLabel) ?? [];
      group.push(name);
      byTerm.set(decision.termLabel, group);
      if (decision.substitution) caveats.push(decision.substitution);
      if (decision.condition) caveats.push(decision.condition);
      continue;
    }
    onDemandNames.push(name);
    onDemandCount += 1;
    if (decision.pricing === 'unpriceable-commitment') {
      caveats.push(decision.caveat);
    } else if (decision.because === 'requested') {
      requestedCount += 1;
    } else {
      caveats.push(`${name}: ${decision.reason}`);
    }
  }

  const onDemand = ordered(onDemandNames);
  const committed = ordered([...byTerm.values()].flat());

  const scope = ordered(byTerm.keys())
    .map((termLabel) => `${ordered(byTerm.get(termLabel)!).join(' + ')} at ${termLabel}`)
    .join(' and ');

  const remainder = onDemand.length
    ? `non-RI services remain On-Demand (${onDemand.join(', ')})`
    : '';

  let sentence: string;
  if (committed.length) {
    sentence = remainder ? `RI scope: ${scope}; ${remainder}.` : `RI scope: ${scope}.`;
  } else if (onDemandCount && requestedCount === onDemandCount) {
    sentence = 'Every service in this estimate is priced at On-Demand rates, as the pricing '
      + 'model for this scenario.';
  } else if (onDemandCount) {
    sentence = 'RI scope: none — no service in this estimate has a commitment purchase model '
      + `that could be priced, so every line remains On-Demand (${onDemand.join(', ')}).`;
  } else {
    sentence = 'No services were priced in this scenario.';
  }

  return { sentence, committed, onDemand, caveats: ordered(caveats) };
}
