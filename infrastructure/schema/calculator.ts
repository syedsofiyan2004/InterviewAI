import { z } from 'zod';

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
export const CalculationStatus = z.enum(['PROCESSING', 'COMPLETED', 'FAILED']);
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
});
export type CalculationResource = z.infer<typeof CalculationResourceSchema>;

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
export const CalculationResultSchema = z.object({
  url: z.string().url(),
  currency: z.string().default('USD'),
  monthlyTotal: z.number().nullable().optional(),
  lineItems: z.array(CalculationLineItemSchema).default([]),
  environments: z.array(CalculationEnvironmentSummarySchema).default([]),
  assumptions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
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
  error_message: z.string().optional(),

  // Surfaced by the view page while the loop runs, mirroring the
  // progress_stage / progress_message fields the intelligence flow already uses.
  progress_stage: z.string().optional(),
  progress_message: z.string().optional(),

  // Diagnostics: how many model turns and tool calls the estimate took.
  iterations: z.number().optional(),
  tool_call_count: z.number().optional(),
});
export type CalculationRecord = z.infer<typeof CalculationRecordSchema>;

/** List-view projection — the prompt and full result are omitted deliberately. */
export const CalculationSummarySchema = CalculationRecordSchema.pick({
  calculation_id: true,
  name: true,
  status: true,
  created_at: true,
  updated_at: true,
}).extend({
  monthly_total: z.number().nullable().optional(),
});
export type CalculationSummary = z.infer<typeof CalculationSummarySchema>;
