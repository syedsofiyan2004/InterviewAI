import { z } from 'zod';

/**
 * What an estimate was ASKED to produce, as opposed to what it produced.
 *
 * These shapes live in their own file because three otherwise unrelated places need the
 * same vocabulary: the assistant proposes a matrix (schema/chat.ts), the create and revise
 * routes accept one and store it on the row (schema/calculator.ts), and the orchestrator
 * prices against it. Declaring it inside any one of those would make the other two import
 * that one for a reason that has nothing to do with it -- the calculator record would
 * depend on the chat schema, which is backwards.
 *
 * Kept strictly separate from `CalculationScenarioSchema`, which is the RESULT. A requested
 * scenario and the priced scenario it produced can legitimately differ: a band can be asked
 * for and come back unpriceable, and folding the two together would leave no way to say so.
 */

/**
 * A pricing model a conversation can ask for, as a closed set.
 *
 * Deliberately a chat-facing enum rather than the internal commitment vocabulary the
 * pricing layer uses. Two reasons, and both matter. A model emitting free text would
 * produce "1yr RI", "1-Year Reserved", "one year reserved" and worse for the same thing,
 * and each spelling would need matching downstream forever. And the term/upfront/offering
 * triple the AWS Price List actually keys on is not something to make a conversation
 * responsible for getting right — the mapping from one of these names to that triple is
 * code, and code is where the Aurora-style exceptions belong.
 *
 * The upfront variants are separate members because they are genuinely different prices,
 * not presentation: a 3-year reservation quoted No Upfront when only Partial exists for
 * that service is a number nobody can buy.
 */
export const PricingModelRequestSchema = z.enum([
  'sheet-specified',
  'on-demand',
  'ri-1yr-no-upfront',
  'ri-1yr-partial-upfront',
  'ri-1yr-all-upfront',
  'ri-3yr-no-upfront',
  'ri-3yr-partial-upfront',
  'ri-3yr-all-upfront',
  'compute-savings-1yr',
  'compute-savings-3yr',
]);
export type PricingModelRequest = z.infer<typeof PricingModelRequestSchema>;

/**
 * One estimate the conversation is asking to be produced, as its own priced scenario
 * with its own shareable link.
 *
 * This exists because the real requests are matrices, not single estimates: five fiscal
 * years across three pricing models, then the lower environments again on the same terms —
 * eighteen links for one workload. Before this there was no way to say that at all. The
 * chat could only nudge the sizing of the one estimate that already existed, so a matrix
 * request had to be answered by a human running the tool eighteen times, which is where
 * the unit mistakes crept in.
 *
 * `scope` and `environments` are separate on purpose. Scope is the label a reader sees in
 * the deliverable ("FY26-27", "Dev + QA + UAT"); environments selects which parsed rows
 * the scenario is priced over. A five-year projection shares one inventory and differs
 * only by scope, whereas a lower-environment scenario is a genuinely different row set,
 * and collapsing the two would make one of those inexpressible.
 */
export const EstimateScenarioRequestSchema = z.object({
  /** What this scenario is called in the report. The reader's handle on it. */
  label: z.string().min(1).max(120),
  pricing_model: PricingModelRequestSchema,
  /** The grouping heading, e.g. a fiscal year or "Lower environments". */
  scope: z.string().max(120).optional(),
  /**
   * Which environments to price. Empty means every row, which is the common case and so
   * is the default rather than something a conversation has to remember to say.
   */
  environments: z.array(z.string().max(60)).max(12).default([]),
  /** Anything about this scenario a reader would otherwise have to infer. */
  note: z.string().max(400).optional(),
});
export type EstimateScenarioRequest = z.infer<typeof EstimateScenarioRequestSchema>;

/**
 * Which documents to produce, and how the links are divided between them.
 *
 * `formats` is asked for by name because the formats are not interchangeable: a matrix of
 * eighteen links is unreadable as a PDF and belongs in a Word document, while the workbook
 * exists to be pivoted rather than read. `link_per_scenario` is a separate question from
 * the format -- a caller can want eighteen links inside one Word document, and can equally
 * want one link rendered three ways.
 */
export const EstimateDeliverablesSchema = z.object({
  formats: z.array(z.enum(['pdf', 'xlsx', 'docx'])).max(3).default([]),
  link_per_scenario: z.boolean().optional(),
});
export type EstimateDeliverables = z.infer<typeof EstimateDeliverablesSchema>;

/**
 * A scenario matrix and what to produce from it, as one storable object.
 *
 * The point of storing it is that a request like "three pricing models across five years,
 * then the lower environments on the same terms" survives the boundary as structure. Carried
 * as prose it reaches the orchestrator inside `prompt`, where it has to be re-derived on
 * every run and a dropped band goes unnoticed. Carried as this, the bands are countable, and
 * a band that came back unpriced can be named.
 *
 * `max(30)` matches the cap on the proposal it usually arrives in: above the eighteen a real
 * request needed, and below the point where one fifteen-minute Lambda invocation could not
 * price them all.
 */
export const EstimatePlanSchema = z.object({
  scenarios: z.array(EstimateScenarioRequestSchema).max(30).default([]),
  deliverables: EstimateDeliverablesSchema.optional(),
  /** Why this matrix, in the requester's own words, for the assumptions section. */
  rationale: z.string().max(600).optional(),
});
export type EstimatePlan = z.infer<typeof EstimatePlanSchema>;

// ---------------------------------------------------------------------------
// Estimate Plan v2
// ---------------------------------------------------------------------------

export const SourceRefSchema = z.object({
  sheet: z.string().optional(),
  row: z.number().int().positive().optional(),
  col: z.number().int().positive().optional(),
  a1: z.string().optional(),
  label: z.string().max(300).optional(),
  value: z.string().max(1000).optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const RequirementConstraintSchema = z.object({
  id: z.string().min(1).max(160),
  /** Resource/scenario selectors such as resource ids, service families or environments. */
  scope: z.array(z.string().min(1).max(160)).max(100).default([]),
  field: z.string().min(1).max(160),
  operator: z.enum(['eq', 'in', 'gte', 'lte', 'exists']),
  expected: z.unknown(),
  impact: z.enum(['critical', 'material', 'informational']),
  source: z.enum(['workbook', 'user', 'system_default']),
  sourceText: z.string().max(2000).optional(),
  evidence: z.array(SourceRefSchema).max(50).optional(),
});
export type RequirementConstraint = z.infer<typeof RequirementConstraintSchema>;

export const RequirementCheckSchema = z.object({
  constraintId: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
  status: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE', 'UNVERIFIABLE']),
  evidencePath: z.string().optional(),
  message: z.string().max(600).optional(),
});
export type RequirementCheck = z.infer<typeof RequirementCheckSchema>;

export const PlanQuestionSchema = z.object({
  id: z.string().min(1).max(160),
  prompt: z.string().min(1).max(1000),
  field: z.string().min(1).max(160),
  scope: z.array(z.string().max(160)).max(100).default([]),
  impact: z.enum(['high', 'medium', 'low']),
  options: z.array(z.string().max(240)).max(20).optional(),
  evidence: z.array(SourceRefSchema).max(50).optional(),
  resolved: z.boolean().default(false),
});
export type PlanQuestion = z.infer<typeof PlanQuestionSchema>;

export const PlanDecisionSchema = z.object({
  id: z.string().min(1).max(160),
  field: z.string().min(1).max(160),
  value: z.unknown(),
  scope: z.array(z.string().max(160)).max(100).default([]),
  rationale: z.string().max(1000).optional(),
  source: z.enum(['workbook', 'user', 'system_default']),
});
export type PlanDecision = z.infer<typeof PlanDecisionSchema>;

export const ResourceReadinessStatusSchema = z.enum([
  'PARSED',
  'SEMANTICALLY_MAPPED',
  'NEEDS_INPUT',
  'CALCULATOR_READY',
  'COMPILED',
  'VALIDATED',
]);
export type ResourceReadinessStatus = z.infer<typeof ResourceReadinessStatusSchema>;

export const SourceMeasurementSchema = z.object({
  originalValue: z.unknown().optional(),
  originalUnit: z.string().max(80).optional(),
  originalScale: z.string().max(80).optional(),
  originalPeriod: z.string().max(80).optional(),
  derivedValue: z.unknown().optional(),
  derivedUnit: z.string().max(80).optional(),
  derivedScale: z.string().max(80).optional(),
  derivedPeriod: z.string().max(80).optional(),
  conversionFormula: z.string().max(600).optional(),
  evidence: z.array(SourceRefSchema).max(50).optional(),
});
export type SourceMeasurement = z.infer<typeof SourceMeasurementSchema>;

export const ResourcePreflightCheckSchema = z.object({
  field: z.string().min(1).max(160),
  status: z.enum(['PASS', 'FAIL', 'UNRESOLVED', 'EXCLUDED']),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  source: z.enum(['workbook', 'user', 'user-approved-inference', 'system_default', 'mcp']).optional(),
  evidence: z.array(SourceRefSchema).max(50).optional(),
  message: z.string().max(1000).optional(),
  measurement: SourceMeasurementSchema.optional(),
});
export type ResourcePreflightCheck = z.infer<typeof ResourcePreflightCheckSchema>;

export const ResourcePreflightSchema = z.object({
  resourceId: z.string().min(1).max(240),
  label: z.string().min(1).max(300),
  service: z.string().max(120).optional(),
  scenario: z.string().max(120).optional(),
  environment: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  readiness: ResourceReadinessStatusSchema,
  checks: z.array(ResourcePreflightCheckSchema).max(100),
  blockers: z.array(z.string().max(1000)).default([]),
  sourceEvidence: z.array(SourceRefSchema).max(100).default([]),
});
export type ResourcePreflight = z.infer<typeof ResourcePreflightSchema>;

export const EstimatePlanRevisionSchema = z.object({
  revisionId: z.string().min(1),
  planId: z.string().min(1),
  parentRevisionId: z.string().optional(),
  createdAt: z.string().datetime(),
  createdBy: z.enum(['system', 'user', 'chat']),
  scenarios: z.array(EstimateScenarioRequestSchema).max(30),
  requirements: z.array(RequirementConstraintSchema).max(500),
  decisions: z.array(PlanDecisionSchema).max(300),
  deliverables: EstimateDeliverablesSchema.optional(),
  hash: z.string().min(16),
});
export type EstimatePlanRevision = z.infer<typeof EstimatePlanRevisionSchema>;

export const EstimatePlanV2Schema = z.object({
  planId: z.string().min(1),
  workbookId: z.string().min(1),
  status: z.enum(['DRAFT', 'NEEDS_INPUT', 'READY', 'CONFIRMED']),
  currentRevisionId: z.string().min(1),
  detectedDimensions: z.object({
    regions: z.array(z.string()).default([]),
    environments: z.array(z.string()).default([]),
    scenarios: z.array(z.string()).default([]),
    serviceFamilies: z.array(z.string()).default([]),
    resourceCount: z.number().int().nonnegative(),
    mappedResourceCount: z.number().int().nonnegative(),
    excludedCount: z.number().int().nonnegative(),
    coveragePct: z.number().min(0).max(100),
  }),
  unresolved: z.array(PlanQuestionSchema).max(300),
  recommendedScenarios: z.array(EstimateScenarioRequestSchema).max(30),
  revisions: z.array(EstimatePlanRevisionSchema).min(1).max(50),
});
export type EstimatePlanV2 = z.infer<typeof EstimatePlanV2Schema>;

export const PlanProposalSchema = z.object({
  proposalId: z.string().min(1),
  planId: z.string().min(1),
  baseRevisionId: z.string().min(1),
  sourceText: z.string().max(4000).optional(),
  summary: z.string().min(1).max(1000),
  requirements: z.array(RequirementConstraintSchema).max(200).default([]),
  decisions: z.array(PlanDecisionSchema).max(100).default([]),
  scenarios: z.array(EstimateScenarioRequestSchema).max(30).optional(),
  unresolved: z.array(PlanQuestionSchema).max(100).default([]),
});
export type PlanProposal = z.infer<typeof PlanProposalSchema>;

export const CreatePlanProposalSchema = z.object({
  text: z.string().min(1).max(4000).optional(),
  requirements: z.array(RequirementConstraintSchema.omit({
    id: true,
    source: true,
    sourceText: true,
  })).max(200).optional(),
  decisions: z.array(PlanDecisionSchema.omit({ id: true, source: true })).max(100).optional(),
  scenarios: z.array(EstimateScenarioRequestSchema).max(30).optional(),
}).refine(
  (value) => Boolean(value.text || value.requirements?.length || value.decisions?.length || value.scenarios?.length),
  'Provide custom text or at least one structured change.',
);
export type CreatePlanProposal = z.infer<typeof CreatePlanProposalSchema>;

export const ApplyPlanProposalSchema = z.object({
  proposal: PlanProposalSchema,
});

export const ConfirmPlanSchema = z.object({
  revision_id: z.string().min(1),
});

export const ExecutionManifestSchema = z.object({
  scenarioId: z.string(),
  planRevisionId: z.string(),
  inputHash: z.string(),
  preflight: z.array(ResourcePreflightSchema).default([]),
  expectedResources: z.array(z.object({
    id: z.string(),
    serviceCode: z.string(),
    calculatorService: z.string(),
    group: z.string(),
    description: z.string(),
    semanticIntent: z.record(z.string(), z.unknown()).optional(),
    criticalFields: z.record(z.string(), z.unknown()),
  })),
  constraints: z.array(RequirementConstraintSchema),
  pricingResolution: z.array(z.object({
    resourceId: z.string(),
    requested: z.string(),
    resolved: z.string(),
    status: z.enum(['EXACT', 'MIXED', 'UNSUPPORTED']),
    reason: z.string().optional(),
  })),
  manifestHash: z.string(),
});
export type ExecutionManifest = z.infer<typeof ExecutionManifestSchema>;
