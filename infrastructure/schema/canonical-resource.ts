/**
 * The canonical semantic resource: what MIMO knows about one piece of infrastructure, in the
 * one shape the MCP operator is allowed to receive.
 *
 * Why this exists. The pricing path had grown a Calculator adapter per service — each one a
 * second, private copy of that service's field schema, each drifting from the real thing the
 * moment AWS edited a dropdown. The failure mode that forced this rewrite is not a crash: it
 * is a silent one. A `taskDuration` sent as `{value: "730", unit: "hours"}` was accepted by
 * the save API, stored verbatim, and then rehydrated by the calculator at its own
 * `defaultDuration` of "min" — so a month of runtime was priced as twelve hours, sixtyfold
 * low, with no error raised anywhere in the chain. Nothing in `get_service_fields` would have
 * caught it either, because that tool does not report a durationInput's valid unit tokens at
 * all.
 *
 * So the division of labour this schema enforces:
 *
 *  - MIMO owns SEMANTICS. What the customer has: ten tasks a day, one vCPU each, running 730
 *    hours, in ap-south-1. Every number carries the unit word the source actually used.
 *  - The AWS Pricing Calculator owns PRICING and its own field schema. MIMO never encodes a
 *    field id, a dropdown token or a rate. The operator resolves those per run from
 *    `get_service_fields` and, for the unit tokens that tool omits, from the service
 *    definition itself.
 *
 * Two invariants, both load-bearing:
 *
 *  1. **Source values are preserved exactly.** A per-day count stays per-day; an annual figure
 *     stays annual. No rescaling happens here, ever. The Calculator does that arithmetic, and
 *     MIMO doing it first is how two different monthly figures start disagreeing.
 *  2. **A dimension always carries its unit.** There is no default unit and no bare number,
 *     because a bare number is the input that produced the bug above.
 */

import { z } from 'zod';

/**
 * One measured dimension of a resource, with the source's own unit word kept verbatim.
 *
 * `unit` is the SEMANTIC unit ("hours", "perDay", "GB", "vCPU"), never a Calculator token
 * ("hr", "gb|NA"). Translating semantics into tokens is the operator's job and happens against
 * the live definition, so a token AWS renames cannot rot inside stored data.
 */
export const CanonicalDimensionSchema = z.object({
  value: z.number().finite(),
  unit: z.string().min(1).max(40),
  /**
   * Where the figure came from, for the Review panel and for a report that has to be
   * defensible. Absent when the value was supplied by a person rather than read off a sheet.
   */
  source: z.string().max(200).optional(),
});
export type CanonicalDimension = z.infer<typeof CanonicalDimensionSchema>;

/**
 * The dimension names the validators and the operator understand.
 *
 * Deliberately a small, service-agnostic vocabulary rather than a field list per service:
 * "instanceCount" means the same thing to EC2, RDS and OpenSearch, and it is the validator's
 * job — not this vocabulary's — to say which of them a given service requires. Anything a
 * sheet states that is not in here survives in `attributes`, so the vocabulary being small
 * costs no information.
 */
export const CANONICAL_DIMENSIONS = [
  'instanceCount',
  'taskCount',
  'nodeCount',
  'vcpu',
  'memoryGb',
  'storageGb',
  'duration',
  'requestCount',
  'dataTransferGb',
  'iops',
  'throughputMbps',
] as const;
export type CanonicalDimensionName = (typeof CANONICAL_DIMENSIONS)[number];

/**
 * A resource's shape as the source states it, for the fields that are classes rather than
 * quantities. Kept separate from dimensions because none of these is a number to be scaled.
 */
export const CanonicalShapeSchema = z.object({
  /** Instance/node class exactly as written: "m6i.large", "db.r6g.large", "cache.t4g.medium". */
  instanceType: z.string().max(80).optional(),
  /** "Linux", "Windows", "RHEL" — the licence question, which changes the rate. */
  operatingSystem: z.string().max(60).optional(),
  /** Database or cache engine: "MySQL", "PostgreSQL", "Aurora MySQL", "Redis". */
  engine: z.string().max(60).optional(),
  /** "Single-AZ" / "Multi-AZ". A deployment choice that doubles a database bill. */
  deployment: z.string().max(40).optional(),
  /** "shared" | "dedicated" | "host". Load-bearing: real RIs need dedicated or host. */
  tenancy: z.enum(['shared', 'dedicated', 'host']).optional(),
  /** Storage class/volume type as written: "gp3", "io2", "S3 Standard". */
  storageType: z.string().max(60).optional(),
  /** CPU architecture where the service prices them differently: "x86", "arm". */
  architecture: z.string().max(20).optional(),
});
export type CanonicalShape = z.infer<typeof CanonicalShapeSchema>;

/** Where a resource was read from, so any figure can be traced back to a cell. */
export const CanonicalProvenanceSchema = z.object({
  sheet: z.string().max(120).optional(),
  row: z.number().int().nonnegative().optional(),
  /** The row's own wording, kept so a reviewer sees what MIMO was reading. */
  label: z.string().max(300).optional(),
});

/**
 * One resource, canonically.
 *
 * `service` is the AWS service NAME as identified from the source, not a Calculator service
 * code. The operator resolves the code through `search_services` at run time; storing a code
 * here would be MIMO caching a piece of the Calculator's schema, which is the thing this
 * rewrite removes.
 */
export const CanonicalResourceSchema = z.object({
  /** Stable handle for citations, patches and verification. Unique within one estimate. */
  id: z.string().min(1).max(120),
  service: z.string().min(1).max(120),
  region: z.string().min(1).max(40),
  /** "Production", "Dev", whatever the source called it. Never inferred from a fixed list. */
  environment: z.string().max(80).optional(),
  /** One line naming the resource, for the Calculator's description field and the report. */
  description: z.string().max(300).optional(),
  shape: CanonicalShapeSchema.default({}),
  /** Keyed by CanonicalDimensionName, but open so a new dimension needs no migration. */
  dimensions: z.record(z.string().max(60), CanonicalDimensionSchema).default({}),
  /**
   * Everything the source said that no dimension and no shape field claimed.
   *
   * The lossless bucket. A sheet that states "Dedicated master: yes" or "target port/protocl"
   * (the customer's own typo, kept) must not lose that on the way through, even though no
   * validator reads it and no Calculator field takes it.
   */
  attributes: z.array(z.object({
    label: z.string().min(1).max(120),
    value: z.string().max(300),
  })).max(60).default([]),
  provenance: CanonicalProvenanceSchema.default({}),
});
export type CanonicalResource = z.infer<typeof CanonicalResourceSchema>;

/**
 * What the Calculator is being asked to configure, named for the instrument it actually buys.
 *
 * These are NOT interchangeable and the naming matters commercially. An "EC2 Instance Savings
 * Plan" is not a Reserved Instance: the Calculator hides Standard and Convertible RIs entirely
 * under shared tenancy, so an estimate that says "1-Year Reserved" while sending
 * `model: instanceSavings` is describing a product the customer is not buying. True RIs appear
 * only when tenancy is dedicated or host, which is why they are separate members here.
 */
export const PricingScenarioKindSchema = z.enum([
  'on-demand',
  'ec2-instance-savings-1yr',
  'ec2-instance-savings-3yr',
  'compute-savings-1yr',
  'compute-savings-3yr',
  'standard-ri-1yr',
  'standard-ri-3yr',
  'convertible-ri-1yr',
  'convertible-ri-3yr',
  'spot',
]);
export type PricingScenarioKind = z.infer<typeof PricingScenarioKindSchema>;

/** How much of a commitment is paid up front. Exact case, as the Calculator spells it. */
export const UpfrontPaymentSchema = z.enum(['None', 'Partial', 'All']);
export type UpfrontPayment = z.infer<typeof UpfrontPaymentSchema>;

/** One scenario to be built: a whole estimate, its own link, its own commitment. */
export const PricingScenarioSchema = z.object({
  /** The reader's handle. Must name the instrument honestly; see PricingScenarioKindSchema. */
  label: z.string().min(1).max(140),
  kind: PricingScenarioKindSchema,
  upfrontPayment: UpfrontPaymentSchema.default('None'),
  /** Which environments this scenario prices. Empty means every resource. */
  environments: z.array(z.string().max(80)).max(24).default([]),
});
export type PricingScenario = z.infer<typeof PricingScenarioSchema>;

/**
 * The human-facing name of a scenario kind, used wherever a figure is labelled.
 *
 * Written out rather than derived from the enum member so the wording can be corrected without
 * a schema change, and so "savings plan" never renders as "reserved".
 */
export const SCENARIO_LABELS: Record<PricingScenarioKind, string> = {
  'on-demand': 'On-Demand',
  'ec2-instance-savings-1yr': '1-Year EC2 Instance Savings Plan',
  'ec2-instance-savings-3yr': '3-Year EC2 Instance Savings Plan',
  'compute-savings-1yr': '1-Year Compute Savings Plan',
  'compute-savings-3yr': '3-Year Compute Savings Plan',
  'standard-ri-1yr': '1-Year Standard Reserved Instances',
  'standard-ri-3yr': '3-Year Standard Reserved Instances',
  'convertible-ri-1yr': '1-Year Convertible Reserved Instances',
  'convertible-ri-3yr': '3-Year Convertible Reserved Instances',
  spot: 'Spot Instances',
};

/**
 * The Calculator's own `pricingStrategy` object for a scenario kind, or null for On-Demand.
 *
 * The OBJECT form is mandatory for every committed model. The catalog's own trap entry records
 * why: the shorthand strings "reserved" and "instanceSavings" may silently save On-Demand or a
 * $0 line. `term` is always stated because an omitted term defaults to 3 Year — so a 1-year
 * request that leaves it out silently buys three years.
 */
export function calculatorPricingStrategy(
  kind: PricingScenarioKind,
  upfrontPayment: UpfrontPayment = 'None',
): { model: string; term: string; upfrontPayment: UpfrontPayment } | 'ondemand' | 'spot' | null {
  switch (kind) {
    case 'on-demand':
      return 'ondemand';
    case 'spot':
      return 'spot';
    case 'ec2-instance-savings-1yr':
      return { model: 'instanceSavings', term: '1 Year', upfrontPayment };
    case 'ec2-instance-savings-3yr':
      return { model: 'instanceSavings', term: '3 Year', upfrontPayment };
    case 'compute-savings-1yr':
      return { model: 'computeSavings', term: '1 Year', upfrontPayment };
    case 'compute-savings-3yr':
      return { model: 'computeSavings', term: '3 Year', upfrontPayment };
    case 'standard-ri-1yr':
      return { model: 'standard', term: '1 Year', upfrontPayment };
    case 'standard-ri-3yr':
      return { model: 'standard', term: '3 Year', upfrontPayment };
    case 'convertible-ri-1yr':
      return { model: 'convertible', term: '1 Year', upfrontPayment };
    case 'convertible-ri-3yr':
      return { model: 'convertible', term: '3 Year', upfrontPayment };
    default:
      return null;
  }
}

/**
 * Whether a scenario kind is a true Reserved Instance, which the Calculator only offers on
 * dedicated or host tenancy.
 *
 * Separated out because asking for a Standard RI on shared tenancy is not a small error: the
 * Calculator hides the option, the save may fall back, and the customer is quoted a product
 * that was never configured.
 */
export function requiresDedicatedTenancy(kind: PricingScenarioKind): boolean {
  return kind.startsWith('standard-ri') || kind.startsWith('convertible-ri');
}
