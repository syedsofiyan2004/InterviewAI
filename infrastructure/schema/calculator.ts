import { z } from 'zod';

import {
  EstimatePlanSchema,
  EstimatePlanV2Schema,
  ExecutionManifestSchema,
  RequirementCheckSchema,
  ResourceReadinessStatusSchema,
  SourceMeasurementSchema,
  SourceRefSchema,
} from './estimate-plan';

/**
 * Cost Calculator schemas.
 *
 * Deliberately a separate module rather than an addition to schema/index.ts: that
 * file (and schema/admin.ts) are being edited concurrently by the question-bank
 * work, and nothing here needs to be shared with them. Error codes are reused
 * from the existing ErrorCode enum in schema/index.ts for the same reason — this
 * feature adds no new codes.
 */

/** Uppercase to match InterviewStatus / the frontend StatusBadge convention. */
export const CalculationStatus = z.enum([
  'ANALYZING',
  'REVIEW_REQUIRED',
  'PROCESSING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
]);
export type CalculationStatus = z.infer<typeof CalculationStatus>;

/**
 * How many hours a day an environment's resources actually run.
 *
 * The point of the whole feature: pricing everything at 24/7 overstates cost for
 * any landscape where non-production is switched off overnight. A dev instance at
 * 8h/day is roughly a third of the same instance always-on, so an estimate that
 * cannot express this is wrong before it starts.
 */
export const EnvironmentHoursSchema = z.object({
  name: z.string().min(1).max(40),
  hoursPerDay: z.number().min(1).max(24),
});
export type EnvironmentHours = z.infer<typeof EnvironmentHoursSchema>;

/** The defaults the form starts from, and the fallback when none are supplied. */
export const DEFAULT_ENVIRONMENT_HOURS: EnvironmentHours[] = [
  { name: 'Production', hoursPerDay: 24 },
  { name: 'Staging', hoursPerDay: 12 },
  { name: 'Dev', hoursPerDay: 8 },
];

/**
 * One row of an uploaded resource list, after header matching.
 *
 * Every field is optional except the raw text: a sheet written by hand will have
 * columns we do not recognise, and dropping those rows would silently shrink the
 * estimate. Whatever cannot be mapped survives in `raw` and reaches the model as
 * text, so a row is never lost — only less structured.
 */
export const CalculationResourceSchema = z.object({
  /** Stable row identity used by Plan v2 constraints after filtering and grouping. */
  plan_resource_id: z.string().optional(),
  environment: z.string().optional(),
  service: z.string().optional(),
  size: z.string().optional(),
  quantity: z.string().optional(),
  region: z.string().optional(),
  /** Overrides the environment default for this row when present. */
  hoursPerDay: z.number().min(1).max(24).optional(),
  notes: z.string().optional(),
  /** The row exactly as it appeared, for anything the columns above missed. */
  raw: z.string(),

  // ---------------------------------------------------------------------------
  // Everything below is filled by the workbook analyser (api-handler/
  // calculator-workbook.ts) and left undefined by the simple template path. All
  // optional, so a row parsed either way validates against one schema.
  // ---------------------------------------------------------------------------

  /** Where the row came from, so a warning or a line item can cite it. */
  sheet: z.string().optional(),
  /** 1-based sheet row, matching what the user sees in Excel. */
  row: z.number().optional(),
  /** The machine's own name, when the sheet identifies its servers. */
  name: z.string().optional(),
  /** Linux, Windows, RHEL, SUSE. Changes the EC2 rate materially. */
  os: z.string().optional(),
  vcpu: z.number().optional(),
  ram_gb: z.number().optional(),
  disk_gb: z.number().optional(),
  /** "3-Yr No Upfront", "On-Demand", "Savings Plan" -- as the sheet worded it. */
  purchase_model: z.string().optional(),
  /**
   * Runtime hours per month, when the sheet states them directly.
   *
   * Needed because hoursPerDay cannot express the most common real schedule: "12x5"
   * is 260 hours a month, which is 8.55 hours a day averaged over a month and no
   * whole number of hours at all. Where both are present this one is authoritative;
   * hoursPerDay is derived from it for the existing pricing path. Capped at 744, the
   * longest possible month.
   */
  hoursPerMonth: z.number().min(1).max(744).optional(),

  /** The right-sizing recommendation, priced as the second scenario. */
  right_sized_size: z.string().optional(),
  right_sized_vcpu: z.number().optional(),
  right_sized_ram_gb: z.number().optional(),
  /** What the workload runs on today (an Azure SKU, an on-prem spec). */
  source_size: z.string().optional(),
  dr_eligible: z.boolean().optional(),

  /**
   * Figures the sheet had already calculated.
   *
   * Captured so the report can show a variance against live AWS prices, and never
   * used as a price. A client model built months ago is priced at rates that have
   * since moved, and presenting its arithmetic back as the answer would hide exactly
   * the discrepancy the estimate exists to find.
   */
  reported_monthly: z.number().optional(),
  reported_compute_monthly: z.number().optional(),
  reported_storage_monthly: z.number().optional(),
  reported_hourly_rate: z.number().optional(),

  // ---------------------------------------------------------------------------
  // Filled only by the transposed-matrix reader (shared/metric-matrix.ts).
  // ---------------------------------------------------------------------------

  /**
   * Which scenario this row belongs to, keyed to CalculationScenario.key.
   *
   * Absent on every row of a flat inventory, where one row is one machine and the whole
   * file is one scenario. Present on a banded capacity model, where the SAME architecture
   * appears once per band and the band is the only thing separating "10 Fargate tasks in
   * 26-27" from "40 in 30-31". Without it those are eight indistinguishable copies and the
   * estimate silently prices their sum.
   */
  scenario: z.string().max(60).optional(),

  /**
   * A usage driver rather than a machine, already converted to a per-month basis.
   *
   * A managed service is billed on requests, GB-months or invocations, and a capacity
   * model states those instead of an instance type. Kept apart from `quantity` because
   * quantity means machines: 200 in `quantity` is 200 servers and feeds server_count,
   * whereas 200 GB-month of S3 is one line item.
   */
  usage_amount: z.number().optional(),
  /** What usage_amount counts, after conversion -- "GB/month", "requests/month". */
  usage_unit: z.string().optional(),
  /** The sheet's own wording for the metric, so a line item can be traced back to it. */
  metric: z.string().max(300).optional(),

  // ---------------------------------------------------------------------------
  // Filled by the canonical normaliser (shared/canonical-workbook.ts), which every
  // reader now feeds its rows through. All optional, so a row produced before this
  // existed — or by a path not yet wired through it — validates unchanged.
  // ---------------------------------------------------------------------------

  /**
   * The stacked-section heading this row sat under.
   *
   * Needed by exactly one of the three layouts and meaningless to the other two.
   * docs/Core BOM.xlsx puts "Server", "Database", "Loadbalancer", "OpenSearch", "Redis",
   * "MQ", "MemoryDB" and "WAF" in a merged column A and gives every section its OWN header
   * row, so column C is "Cpu" in one section and "class" in the next. Without the heading a
   * row's columns cannot be interpreted at all, and there is nowhere else to put it.
   */
  section: z.string().max(80).optional(),

  /**
   * Named volumes, where the sheet states them separately rather than as one total.
   *
   * A Core BOM server row names three: "Os Storage" 20 GB, "Data storage for /app" 50 GB,
   * "Data storage for /app/logs" 80 GB. Summing them into disk_gb prices the right total
   * and loses which volume is which, which is the difference between a storage line a
   * client can check against their own build and a number they have to take on trust.
   * disk_gb stays authoritative for the arithmetic; this is the breakdown behind it.
   */
  disks: z.array(z.object({
    label: z.string().max(120),
    gb: z.number(),
  })).max(20).optional(),

  /**
   * Everything the sheet said that no other field on this row claimed.
   *
   * The lossless bucket for per-section columns with no fixed vocabulary: "Available Zone",
   * "Multi-AZ", "Listener", "target port/protocl" (the sheet's own typo, kept), "number of
   * replicas", "Dedicated master", "Borker type". Today those survive only inside the joined
   * `raw` string, which reaches the model as prose and cannot be read by code at all.
   */
  attributes: z.array(z.object({
    label: z.string().max(120),
    value: z.string().max(300),
  })).max(40).optional(),

  /**
   * What this row is billed on, one entry per dimension, already on a monthly basis.
   *
   * The point of the whole normalisation: a quantity that reaches the pricer WITHOUT a
   * declared unit gets a unit assumed for it, and the assumption was hours. That is how "10
   * Fargate tasks per day" was priced as 10 a month and a 1,440-minute run was billed as
   * 1,440 hours. Every entry here names its dimension explicitly, and the pricer refuses a
   * quantity whose dimension does not reconcile with the AWS rate's own unit rather than
   * multiplying two things that do not belong together.
   *
   * An array rather than one figure because several real resources are billed on more than
   * one dimension at once and collapsing them loses the shape: a Fargate task is vCPU-hours
   * AND GB-hours, a machine is runtime hours AND a gp3 volume.
   */
  quantities: z.array(z.object({
    /**
     * Must stay in step with CanonicalUnit in lambdas/shared/unit-contract.ts, which is the
     * definition; this is its wire form. Declared here rather than imported because schema/
     * depends on zod and on itself and nothing else, and a test asserts the two lists are
     * identical so the duplication cannot drift silently.
     */
    unit: z.enum([
      'hours/month',
      'GB/month',
      'GB-transfer/month',
      'requests/month',
      'invocations/month',
      'GB-seconds/month',
      'vCPU-hours/month',
      'GB-hours/month',
      'IOPS/month',
      'units/month',
    ]),
    amount: z.number(),
    originalValue: z.unknown().optional(),
    originalUnit: z.string().max(80).optional(),
    originalScale: z.string().max(80).optional(),
    originalPeriod: z.string().max(80).optional(),
    derivedValue: z.unknown().optional(),
    derivedUnit: z.string().max(80).optional(),
    derivedScale: z.string().max(80).optional(),
    derivedPeriod: z.string().max(80).optional(),
    conversionFormula: z.string().max(600).optional(),
    measurement: SourceMeasurementSchema.optional(),
    /** What this dimension buys, for the report's workings line: "task vCPU", "Os Storage". */
    basis: z.string().max(120),
    /** Every conversion applied, one prose line each, in the order applied. */
    conversions: z.array(z.string().max(300)).max(8).default([]),
  })).max(12).optional(),
  resourceId: z.string().max(240).optional(),
  role: z.string().max(120).optional(),
  configuration: z.record(z.string(), z.unknown()).optional(),
  source_evidence: z.array(SourceRefSchema).max(100).optional(),
  unresolved_fields: z.array(z.string().max(160)).max(80).optional(),
  readiness: ResourceReadinessStatusSchema.optional(),
});
export type CalculationResource = z.infer<typeof CalculationResourceSchema>;

/**
 * What an uploaded workbook said, beyond its resource rows.
 *
 * A real client model states the things that govern the whole estimate exactly once,
 * in prose or in a label/value block, and never in a column: the target region, the
 * DR region, the FX rate, the rate card it assumed. The example workbook
 * (docs/COSEC_AWS_TCO_Model.xlsx) names its region only as "Primary region | AWS
 * Frankfurt (eu-central-1)" on an assumptions tab -- so a parser that reads tables
 * alone prices 110 servers in the wrong region and reports no error.
 */
export const WorkbookSheetSummarySchema = z.object({
  name: z.string(),
  rows: z.number(),
  /** What was found on this sheet, in words, for the "how we read your file" panel. */
  detail: z.string(),
});

export const WorkbookFactSchema = z.object({
  sheet: z.string(),
  label: z.string(),
  value: z.string(),
});

/** One rate the CLIENT assumed. Compared against live AWS pricing, never used as it. */
export const WorkbookRateSchema = z.object({
  sheet: z.string(),
  item: z.string(),
  /** The rate column's own heading, e.g. "Hourly Rate ($)", when identified. */
  unit: z.string().optional(),
  rate: z.number(),
});

/** A monthly figure the sheet itself calculated, for the variance comparison. */
export const WorkbookReportedSchema = z.object({
  sheet: z.string(),
  label: z.string(),
  monthly: z.number(),
});

/** A block of the sheet passed through verbatim because it was not structured. */
export const WorkbookExcerptSchema = z.object({
  sheet: z.string(),
  text: z.string(),
});

/**
 * One scenario band found on a transposed capacity model.
 *
 * The parser's record of what it detected, distinct from CalculationScenario, which is the
 * PRICED result. Kept separate because the bands are known the moment the file is read --
 * on submit, before the orchestrator runs -- and the upload response has to be able to say
 * "this file is eight scenarios" without having priced any of them yet.
 */
export const WorkbookBandSchema = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.enum(['sizing', 'period', 'environment']),
  sheet: z.string(),
  /** How many resource rows were assembled for this band. */
  resource_count: z.number().optional(),
});

/**
 * A row the parser deliberately did not price, and why.
 *
 * Kept in the record rather than only in the warnings, because a warning list is capped
 * and truncating THIS list is exactly the failure it exists to prevent: an estimate that
 * omits a client's Pinecone spend, or a Kafka cluster the author zeroed out, and reads as
 * though it covered everything.
 */
export const WorkbookExclusionSchema = z.object({
  metric: z.string(),
  scenario: z.string().optional(),
  reason: z.string(),
});

export const WorkbookInsightsSchema = z.object({
  file_name: z.string().optional(),
  sheets: z.array(WorkbookSheetSummarySchema).default([]),
  primary_region: z.string().optional(),
  dr_region: z.string().optional(),
  regions: z.array(z.string()).default([]),
  currency: z.string().optional(),
  fx_rate: z.number().optional(),
  /**
   * What the workbook's own inventory rows add up to per month.
   *
   * The single most useful number to compare a live estimate against, and computed
   * here rather than left to the model so the comparison is arithmetic instead of
   * inference. Summed from the per-row monthly figures of every inventory sheet, so it
   * covers exactly what those rows cover — on a sheet that foots compute, storage,
   * backup and DR but bills network separately, this is the four, not the five.
   */
  reported_monthly_total: z.number().optional(),
  facts: z.array(WorkbookFactSchema).default([]),
  rate_card: z.array(WorkbookRateSchema).default([]),
  reported: z.array(WorkbookReportedSchema).default([]),
  excerpts: z.array(WorkbookExcerptSchema).default([]),
  /** Machines counted, honouring a quantity column. */
  server_count: z.number().default(0),
  total_disk_gb: z.number().default(0),
  dr_eligible_count: z.number().default(0),

  /**
   * Scenario bands detected on a transposed capacity model, in sheet order.
   *
   * Optional rather than defaulted, so every estimate already in DynamoDB -- and every
   * literal WorkbookInsights in the existing tests -- still satisfies the type.
   */
  bands: z.array(WorkbookBandSchema).optional(),
  /** Rows deliberately not priced, with the reason, so no omission is silent. */
  exclusions: z.array(WorkbookExclusionSchema).optional(),
  /** Unit conversions the parser applied, one line each. */
  conversions: z.array(z.string()).optional(),
});
export type WorkbookInsights = z.infer<typeof WorkbookInsightsSchema>;

/** What the user submits. Prose, a spreadsheet, or both. */
export const CreateCalculationSchema = z.object({
  name: z.string().min(1).max(200),
  /**
   * Free text describing the workload. Optional only when a sheet is uploaded —
   * the route rejects a request carrying neither, since there would be nothing to
   * estimate.
   */
  prompt: z.string().max(4000).optional(),
  /**
   * Optional: the model is told to default to ap-south-1 and record that choice in
   * assumptions when this is absent. Kept loose (not an enum of every AWS region)
   * because the MCP server validates region against the live manifest anyway.
   */
  region: z.string().min(2).max(40).optional(),
  environment_hours: z.array(EnvironmentHoursSchema).max(10).optional(),
  /** S3 key of an uploaded .xlsx/.csv resource list, from POST /calculator/upload-url. */
  input_s3_key: z.string().max(500).optional(),
  /**
   * An explicit scenario matrix, when the requester has one.
   *
   * Optional and absent on the ordinary one-estimate flow, where the bands are whatever
   * the uploaded sheet turns out to contain. It is filled by the assistant, which is the
   * only place a request complex enough to need it is actually stated.
   */
  plan: EstimatePlanSchema.optional(),
  /**
   * Group this estimate under an existing project.
   *
   * Optional: an estimate created without one is valid and lists as "Ungrouped", which
   * is what keeps the existing single-step "new estimate" flow working unchanged.
   */
  project_id: z.string().uuid().optional(),
});
export type CreateCalculationInput = z.infer<typeof CreateCalculationSchema>;

export const CalculationLineItemSchema = z.object({
  service: z.string(),
  detail: z.string().optional(),
  monthly: z.number().nullable().optional(),
  /**
   * The arithmetic behind `monthly`, as the estimator calculated it — the published
   * rate, the hours, the quantity. Printed in the report so a client can check the
   * figure instead of taking it on trust, which is the whole difference between a
   * cost document and an assertion.
   */
  workings: z.string().optional(),
  /** Which environment group this line belongs to, when the estimate is grouped. */
  environment: z.string().optional(),
  hoursPerDay: z.number().min(1).max(24).optional(),
  /**
   * True only for resources billed by the hour. The scheduling-savings figure is
   * derived from these lines alone — storage costs the same whether the environment
   * is up or not, so including it would invent a saving that does not exist.
   */
  timeBilled: z.boolean().optional(),
});

/** Per-environment rollup, so the PDF's subtotals match the calculator's folders. */
export const CalculationEnvironmentSummarySchema = z.object({
  name: z.string(),
  hoursPerDay: z.number().min(1).max(24),
  monthly: z.number().nullable().optional(),
});

/**
 * The estimate as returned by the tool loop.
 *
 * `monthlyTotal` is nullable because the figures come from AWS, never from the
 * model: the pricing engine runs when the estimate is saved to calculator.aws, and
 * the loop reads the priced result back with import_estimate. If that read returns
 * no total, the UI shows an em dash rather than a number nobody computed.
 */
/**
 * One priced scenario.
 *
 * An uploaded migration model usually carries two sizings for every machine: the
 * lift-and-shift target, and a right-sized recommendation. Pricing only the first
 * hides the saving the exercise exists to find; pricing only the second quotes a
 * number the client has not agreed to. So both are priced and both are shown, and the
 * saving between them is the thing that gets discussed.
 *
 * A sizing pair is only one reason a model carries several scenarios. An uploaded
 * capacity model may instead be banded by fiscal year (`26-27` … `30-31`) or by
 * environment (Dev, QA, UAT), with a whole column of usage figures per band. Those bands
 * are scenarios too, and each one gets its own priced total and its own link.
 *
 * For a sizing pair the result-level `url` and `monthlyTotal` describe the BASELINE —
 * the committed configuration, with the right-sized figure as an alternative costed from
 * the same live rates.
 */
export const CalculationScenarioSchema = z.object({
  /**
   * Stable identifier, named by whatever distinguishes the scenario.
   *
   * A free string rather than the `['baseline','rightsized']` pair this began as. The
   * lift-and-shift path still emits exactly those two and nothing about it changes, but
   * a band's name comes from the sheet and cannot be enumerated here. An enum meant a
   * year-banded workbook could only be priced by discarding its bands and summing them
   * into one number, which is the opposite of what such a model exists to show.
   */
  key: z.string().min(1).max(60),
  label: z.string(),
  /**
   * Why this is a separate scenario, so a reader knows what they are comparing.
   *
   * The three kinds are not interchangeable, and the difference decides whether totals
   * may be added: `sizing` scenarios are one workload costed two ways, so only one of
   * them will ever be spent; `period` scenarios are consecutive years, so they are spent
   * in sequence and a sum across them is a multi-year total, not a monthly one;
   * `environment` scenarios run concurrently and therefore genuinely do add up. Optional
   * because estimates stored before this existed carry none.
   */
  kind: z.enum(['sizing', 'period', 'environment']).optional(),
  monthly: z.number().nullable().optional(),
  /**
   * This scenario's own shareable calculator.aws link.
   *
   * Per scenario rather than one for the whole result, because a five-year capacity model
   * collapsed into a single link is not something a client can act on — they need the year
   * they are budgeting for. Nullable on the same grounds as the result-level `url`: a run
   * can price a scenario and still fail to export an estimate for it, and a priced
   * breakdown is worth keeping without its link.
   */
  url: z.string().url().nullable().default(null),
  /** How this scenario was sized, and what it assumes. */
  detail: z.string().optional(),
  /**
   * The twelve-month total, when it is not simply the monthly figure times twelve.
   *
   * It often is not, and the difference is real money rather than rounding. A 3-year
   * reservation taken Partial Upfront bills a lump sum in the first year on top of the
   * reduced hourly rate, so the year-one total exceeds twelve monthly bills. On the worked
   * example the gap is roughly $6,400 on one scenario — a monthly figure of $18,782.38
   * against a real twelve-month total of $231,772.56, where multiplying would have said
   * $225,388.56.
   *
   * So this is stored rather than derived. A renderer with no such figure has to multiply
   * and can only warn that committed scenarios understate the first year; a renderer given
   * this one can state the number the invoice will show. Optional because every estimate
   * priced before this field existed has none, and those must keep rendering — they fall
   * back to the multiplication, which is correct for an On-Demand scenario and stated as
   * an approximation for any other.
   */
  total_12_months: z.number().nullable().optional(),
  /**
   * Which pricing model this scenario was priced at, and the heading it belongs under.
   *
   * Both were previously recoverable only by splitting `label` on punctuation and hoping
   * the halves meant what they looked like. That inference works on "FY26-27 - 1-Year
   * Reserved Instances" and quietly misreads a legacy label like "Lift and shift - as the
   * sheet specifies" as a pricing model. The pipeline knows both values at the moment it
   * prices the band, so recording them removes the guess entirely.
   *
   * `pricing_model` is a free string rather than the chat's closed enum: it has to be able
   * to describe what was ACTUALLY priced, including a substitution the request did not
   * name, and a closed set would force those cases into the nearest wrong member.
   */
  pricing_model: z.string().max(120).optional(),
  scope: z.string().max(120).optional(),
  /**
   * Whether this band is production or a lower environment.
   *
   * Reports group by this, and the grouping was otherwise inferred from `kind` plus
   * whether a sibling band happened to exist — a rule that produces the right two tables
   * on the workbook it was written against and a single untitled table on anything else.
   */
  environment_group: z.enum(['production', 'lower', 'other']).optional(),
  /**
   * How this scenario's committed and On-Demand services divide, in one sentence.
   *
   * The mixed-model statement, stored per scenario because that is where it is true: a
   * "1-year Reserved" band prices the reservable services at the committed rate and leaves
   * the rest — Fargate above all, which has no reserved purchase model — On-Demand. A
   * reader who is not told that reads the whole band as committed and budgets short.
   */
  pricing_mix: z.string().max(600).optional(),
  /** Saved-link validation is authoritative; a local price alone cannot complete a scenario. */
  status: z.enum(['SAVING', 'VALIDATING', 'COMPLETED', 'PARTIAL', 'FAILED']).optional(),
  upfront: z.number().nullable().optional(),
  /** Optional for estimates stored before deterministic read-back validation existed. */
  requirement_checks: z.array(RequirementCheckSchema).optional(),
  validation_errors: z.array(z.string().max(1000)).optional(),
  saved_snapshot_hash: z.string().optional(),
  manifest: ExecutionManifestSchema.optional(),
});
export type CalculationScenario = z.infer<typeof CalculationScenarioSchema>;

/**
 * One machine, with the group price it belongs to allocated onto it.
 *
 * Exists because the estimate is priced by GROUP -- identical machines folded into one
 * line -- while the TCO workbook a client is handed is one row per server. The rows here
 * are an allocation of figures already priced, never a second pricing pass: every machine
 * in a group shares its size, OS, region and purchase model by construction, so dividing
 * the group's compute by its machine count is exact, and storage is split on each row's
 * own disk share so the rows still sum to the group total.
 *
 * Every field but the name is optional, and the array itself is optional on the result:
 * estimates already stored in DynamoDB have none, and those must still export.
 */
export const CalculationServerSchema = z.object({
  /** The machine's own name where the sheet gave one, else a positional label. */
  name: z.string(),
  /** Machines this row stands for, honouring a quantity column. Usually 1. */
  count: z.number().default(1),
  /** Production, Non-Prod, DR -- the reference workbook calls this Scope. */
  environment: z.string().optional(),
  /** The priced group this row was allocated from, so a reader can tie the two up. */
  group: z.string().optional(),
  os: z.string().optional(),
  /** Read from the instance family, not from the sheet. See processorOf in pipeline.ts. */
  processor: z.string().optional(),
  instance: z.string().optional(),
  vcpu: z.number().optional(),
  ramGb: z.number().optional(),
  purchaseModel: z.string().optional(),
  diskGb: z.number().optional(),
  /** gp3 where storage was priced; the pipeline quotes no other volume type. */
  diskType: z.string().optional(),
  hoursPerDay: z.number().min(1).max(24).optional(),
  computeMonthly: z.number().nullable().optional(),
  storageMonthly: z.number().nullable().optional(),
  /** Source spec, right-sizing recommendation and the sheet's own note, joined. */
  justification: z.string().optional(),
  sheet: z.string().optional(),
  row: z.number().optional(),
});
export type CalculationServer = z.infer<typeof CalculationServerSchema>;

export const CalculationResultSchema = z.object({
  /**
   * The shareable calculator.aws link, or null.
   *
   * Nullable because a run can price the workload and still not save an estimate: on a
   * large uploaded inventory the loop can run out of turns after gathering rates but
   * before export_estimate. Requiring a URL here meant Zod rejected that result and a
   * fully priced breakdown was thrown away with it. The link is the nicer half of the
   * output; the costs are the half the client actually needs.
   */
  url: z.string().url().nullable().default(null),
  currency: z.string().default('USD'),
  monthlyTotal: z.number().nullable().optional(),
  lineItems: z.array(CalculationLineItemSchema).default([]),
  environments: z.array(CalculationEnvironmentSummarySchema).default([]),
  /** Empty for a prose estimate; populated when an uploaded sheet offered a second sizing. */
  scenarios: z.array(CalculationScenarioSchema).default([]),
  /**
   * The monthly total the uploaded sheet itself calculated, echoed so the report can
   * put the two side by side. Live AWS pricing is always the answer; this is what the
   * client believed before we checked.
   */
  reportedMonthlyTotal: z.number().nullable().optional(),
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  /**
   * Per-server rows for the Excel export, when the inventory is small enough to carry.
   *
   * Optional in both senses: absent on every estimate priced before this existed, and
   * deliberately omitted above a row ceiling, because the whole result is stored on a
   * DynamoDB item capped at 400KB. The workbook falls back to group-level rows in either
   * case -- fewer rows, identical totals -- and an assumption says which happened.
   */
  servers: z.array(CalculationServerSchema).optional(),
  /**
   * The gp3 GB-month rate every storage line was multiplied by, when storage was priced.
   *
   * Stated so the workbook's assumptions can name the number rather than leaving a client
   * to reverse it out of a total. One rate covers the estimate because storage is looked
   * up once per region and an estimate has one default region.
   */
  ebsRatePerGbMonth: z.number().optional(),
  /** Empty only for legacy results that predate strict saved-estimate validation. */
  validationErrors: z.array(z.string().max(1000)).optional(),
});
export type CalculationResult = z.infer<typeof CalculationResultSchema>;

/** The stored DynamoDB item. */
export const CalculationRecordSchema = z.object({
  calculation_id: z.string(),
  owner_user_id: z.string(),
  /** Carried so admin lists can show a person rather than a Cognito sub. */
  owner_email: z.string().optional(),
  name: z.string(),
  prompt: z.string(),
  region: z.string().optional(),
  status: CalculationStatus,
  /** Runtime hours in force for this estimate, as submitted. */
  environment_hours: z.array(EnvironmentHoursSchema).default([]),
  /** Parsed rows from an uploaded sheet, empty for a prose-only estimate. */
  resources: z.array(CalculationResourceSchema).default([]),
  /**
   * Set when the parsed rows were too large to store on the item.
   *
   * A DynamoDB item is capped at 400KB and a landscape of a few thousand machines
   * exceeds that, so the full list is written to S3 as JSON and `resources` keeps a
   * bounded sample for the UI. The orchestrator reads this key when it is present and
   * uses `resources` only when it is not, so neither path has to know which happened.
   */
  resources_s3_key: z.string().optional(),
  /** True when `resources` holds a sample rather than the full list. */
  resources_truncated: z.boolean().optional(),
  /** How many rows were parsed in total, whether or not they are all on the item. */
  resource_count: z.number().optional(),
  /** Regions, rates, assumptions and unstructured blocks read from the workbook. */
  workbook: WorkbookInsightsSchema.optional(),
  /** Lossless source artifacts live in S3; the record carries stable references and hashes. */
  workbook_ir_s3_key: z.string().optional(),
  workbook_hash: z.string().optional(),
  canonical_model_s3_key: z.string().optional(),
  /**
   * The band matrix this run was asked for, when one was stated.
   *
   * Stored on the row rather than only inside `prompt` so that a re-run prices the same
   * bands without re-parsing an English sentence, and so the view page can say which of the
   * requested bands came back. A revision carries its parent's plan forward unless the
   * revision states a new one; see ReviseCalculationSchema in schema/chat.ts.
   */
  requested_plan: EstimatePlanSchema.optional(),
  /** Review/customize state. Legacy requested_plan remains readable during migration. */
  plan_v2: EstimatePlanV2Schema.optional(),
  confirmed_plan_revision_id: z.string().optional(),
  input_s3_key: z.string().optional(),
  input_file_name: z.string().optional(),
  /** Set when the sheet parsed but some rows could not be mapped to columns. */
  input_warnings: z.array(z.string()).default([]),
  /**
   * Epoch ms, matching every other table in this repo. Not ISO strings: the shared
   * progress UI derives elapsed time by subtracting a server timestamp from the
   * server clock, so a string here would make LiveProgressBanner and the
   * progress-event log unusable for this feature without a conversion layer.
   */
  created_at: z.number(),
  updated_at: z.number(),

  result: CalculationResultSchema.optional(),
  /** Lossless result; `result` is a bounded render copy to stay below DynamoDB's 400 KB limit. */
  result_s3_key: z.string().optional(),
  error_message: z.string().optional(),

  // Surfaced by the view page while the loop runs, mirroring the
  // progress_stage / progress_message fields the intelligence flow already uses.
  progress_stage: z.string().optional(),
  progress_message: z.string().optional(),

  /**
   * When the worker actually started, as distinct from when the row was created.
   *
   * They are not the same instant and the gap is not noise: `created_at` is stamped by
   * the API request, and the orchestrator is invoked asynchronously after it. Deriving
   * elapsed time from `created_at` therefore charges queue time to the first stage,
   * which is the one stage a waiting user is most likely to think has hung.
   */
  progress_started_at: z.number().optional(),
  /**
   * When the CURRENT stage began. This is what makes a remaining-time estimate possible
   * at all: without it the only known quantity is total elapsed, which says nothing
   * about how far through the present stage the run is.
   */
  progress_stage_started_at: z.number().optional(),
  /**
   * Every stage this run has entered, in order, with the instant it was entered.
   *
   * Kept as history rather than overwritten because the interesting question during a
   * long run is not "what is it doing" but "is it still moving" — and one stage plus one
   * timestamp cannot answer that. The durations also let the estimate report where its
   * fifteen minutes actually went, which is the only way a timeout gets diagnosed after
   * the fact rather than guessed at.
   *
   * Bounded so a pathological loop cannot grow the item toward DynamoDB's 400 KB limit
   * and take the whole record down with it; the pipeline emits a fixed small number of
   * stages, so the cap is far above normal and exists only as a backstop.
   */
  progress_history: z.array(z.object({
    stage: z.string().max(60),
    message: z.string().max(300).optional(),
    /** Epoch ms, like every other timestamp here. */
    at: z.number(),
  })).max(80).optional(),

  // Diagnostics: how many model turns and tool calls the estimate took.
  iterations: z.number().optional(),
  tool_call_count: z.number().optional(),

  /**
   * Set on an estimate created by applying a chat-proposed change.
   *
   * A revision is a NEW row, not an edit of the original: a PDF or workbook already
   * sent to a client must not change underneath it, and the point of comparison is
   * lost if the previous numbers are overwritten. `revision_of` always names the
   * FIRST estimate in the chain rather than the immediate parent, so the whole chain
   * is one query and revision 4 does not have to be walked back through 3, 2 and 1.
   */
  revision_of: z.string().optional(),
  /** 1 for the first revision of an original. The original itself has neither field. */
  revision_number: z.number().optional(),
  /** What the user asked the chat for, kept so the chain reads as a history. */
  revision_instruction: z.string().optional(),

  /**
   * The project this estimate belongs to, mirroring how a MOM belongs to a project.
   *
   * Both fields are optional and the title is denormalised onto the estimate on
   * purpose. Optional because every estimate created before this change has neither,
   * and those must keep listing — they group under "Ungrouped" rather than vanishing.
   * Denormalised because the list view would otherwise need a second read per row just
   * to print a heading.
   */
  project_id: z.string().optional(),
  project_title: z.string().optional(),

  /**
   * Marks a project row rather than an estimate.
   *
   * Projects live on the same table as estimates under a `PROJECT#<uuid>` partition
   * key, which is exactly what the MOM table already does. It costs a filter on every
   * list (see listCalculations) and saves a table, a stack change and a second set of
   * ownership gates.
   */
  item_type: z.literal('PROJECT').optional(),
});
export type CalculationRecord = z.infer<typeof CalculationRecordSchema>;

/** A project is just a name a user groups estimates under. */
export const CreateCalculationProjectSchema = z.object({
  project_title: z.string().trim().min(1).max(120),
});
export type CreateCalculationProjectInput = z.infer<typeof CreateCalculationProjectSchema>;

/** List-view projection — the prompt and full result are omitted deliberately. */
export const CalculationSummarySchema = CalculationRecordSchema.pick({
  calculation_id: true,
  name: true,
  status: true,
  created_at: true,
  updated_at: true,
  revision_of: true,
  revision_number: true,
  project_id: true,
  project_title: true,
}).extend({
  monthly_total: z.number().nullable().optional(),
});
export type CalculationSummary = z.infer<typeof CalculationSummarySchema>;

/** One row of the project list: the project, plus what it contains. */
export const CalculationProjectSummarySchema = z.object({
  /** Null for the synthetic "Ungrouped" row that collects pre-project estimates. */
  project_id: z.string().nullable(),
  project_title: z.string(),
  created_at: z.number(),
  updated_at: z.number(),
  estimate_count: z.number(),
  completed_count: z.number(),
  /** Sum of the monthly totals of this project's COMPLETED estimates, or null. */
  monthly_total: z.number().nullable().optional(),
});
export type CalculationProjectSummary = z.infer<typeof CalculationProjectSummarySchema>;
