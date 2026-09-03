/**
 * The AWS MCP Estimate Executor's contract.
 *
 * One executor, every estimate. The initial upload, a Review revision, a chat revision and the
 * regression fixtures all hand this module the same thing — a list of semantic resources and
 * one pricing intent — and get back one saved AWS Pricing Calculator estimate with its link,
 * its rendered totals and a verdict on how faithfully it represents what was asked.
 *
 * The line this file draws, and why it is drawn exactly here: everything on the input side is
 * what the CUSTOMER has (ten tasks a day, one vCPU each, 730 hours, in Mumbai). Nothing on the
 * input side names a Calculator field, a dropdown token or a columnForm row. The failure that
 * forced the line was a hand-built `taskDuration: {unit: "hours"}` that the save API accepted,
 * the linter passed, and the calculator rehydrated as MINUTES — sixtyfold low with no error.
 * A second implementation of the Calculator's schema inside MIMO is a second place for that
 * to happen. The MCP's own `get_service_fields` and the Calculator's own service definition
 * are the schema; this module reads them at run time and never stores what it learned.
 */

import type { PricingScenarioKind, UpfrontPayment } from '../../schema/canonical-resource';

/**
 * One piece of infrastructure, described in the customer's terms.
 *
 * `configuration` is flat and semantic on purpose: `taskCount: 10, taskFrequency: "perDay"`,
 * `duration: 730, durationUnit: "hours"`. Values are the source's values. Nothing here has been
 * converted to a month, to hours, or to a Calculator token — a per-day count stays per-day,
 * because the Calculator is about to do that arithmetic itself and MIMO doing it first is how
 * two figures for one workload start to disagree.
 */
export interface SemanticResource {
  resourceId: string;
  /** The AWS service by NAME ("AWS Fargate", "Amazon EC2"), never a Calculator service key. */
  service: string;
  region: string;
  scenario?: string;
  environment?: string;
  /** One line a reader recognises the resource by. Also written into the estimate. */
  description?: string;
  configuration: Record<string, string | number | boolean>;
  /**
   * This resource's own pricing intent, overriding the scenario's.
   *
   * Set when the source states a commitment per row — a capacity model routinely puts
   * "3-Yr Reserved" on the databases and nothing on the containers — and the scenario is
   * "as the sheet states". Absent for a scenario that asks for one model across the board.
   */
  pricing?: PricingIntent;
}

/** The pricing intent for one scenario estimate. */
export interface PricingIntent {
  kind: PricingScenarioKind;
  upfrontPayment: UpfrontPayment;
}

export interface ExecutorInput {
  scenarioId: string;
  /** The estimate's name on calculator.aws. */
  estimateName: string;
  pricing: PricingIntent;
  resources: SemanticResource[];
  /** Partition, for the sovereign-cloud calculators. Defaults to "aws". */
  partition?: string;
}

/**
 * Which tool answers which role, discovered from `tools/list` rather than assumed.
 *
 * Kept as roles rather than names because the installed MCP decides the names. A role with no
 * tool is `undefined`, which the executor treats as a capability gap it must route around (no
 * update tool → re-add), not as an error at discovery time.
 */
export interface DiscoveredTools {
  search?: string;
  fields?: string;
  create?: string;
  add?: string;
  update?: string;
  validate?: string;
  export?: string;
  import?: string;
  serverInfo?: string;
  /** Every tool name the server listed, in the order it listed them. */
  all: string[];
  /** sha256 of the sorted tool list, for the diagnostics record. */
  toolListHash: string;
  mcpVersion?: string;
}

/** Which model tier a step ran on. CODE means no model was called. */
export type ExecutorTier = 'CODE' | 'HAIKU_4_5' | 'SONNET_4_6';

/** One MCP attempt for one resource, kept verbatim for diagnosis. */
export interface ResourceAttempt {
  attempt: number;
  /** How this attempt's configuration was produced. */
  producedBy: ExecutorTier | 'STRUCTURED_HINT';
  config: Record<string, unknown>;
  /** The MCP's own words when it refused; undefined when the attempt succeeded. */
  error?: string;
  /** Which tool refused it. */
  failedAt?: 'add' | 'validate';
}

/**
 * How one service's pricing was resolved against the Calculator.
 *
 * Recorded per service because a scenario's commitment does not apply uniformly: the same
 * "3-Year Compute Savings Plan" scenario commits EC2 and leaves S3 On-Demand, and a reader who
 * is not told which is which reads the total as fully committed.
 */
export interface PricingResolution {
  resourceId: string;
  service: string;
  requested: PricingScenarioKind;
  resolved: PricingScenarioKind;
  /** Plain English, fit for the report. */
  reason: string;
  /** How the Calculator expresses commitment for this service, when it does. */
  via: 'pricingStrategy' | 'columnFormIPM' | 'none';
}

export type ResourceOutcomeStatus = 'ADDED' | 'FAILED' | 'MISSING_INPUT';

export interface ResourceOutcome {
  resourceId: string;
  service: string;
  /** The Calculator service key the semantic service resolved to. */
  serviceCode?: string;
  status: ResourceOutcomeStatus;
  attempts: ResourceAttempt[];
  /** The configuration that was finally added, for the read-back comparison. */
  finalConfig?: Record<string, unknown>;
  pricing?: PricingResolution;
  /** Semantic inputs the mapper needed and the resource did not carry. */
  missingInputs?: string[];
  /** Which tiers were used, in order, so a run can show it needed no model at all. */
  tiers: Array<ExecutorTier | 'STRUCTURED_HINT'>;
  /** Anything a reader must know that is not an error. */
  notes: string[];
}

export type ExecutorStatus = 'COMPLETED' | 'NEEDS_REVIEW' | 'PARTIAL' | 'FAILED';

export interface RenderedTotals {
  monthly?: number;
  upfront?: number;
  total12Months?: number;
  /** Where the totals came from. `none` means they could not be read. */
  source: 'browser' | 'none';
}

export interface VerificationFinding {
  /** Which check produced this finding. */
  check:
    | 'resources-added'
    | 'mcp-validation'
    | 'url'
    | 'totals'
    | 'read-back'
    | 'semantic-values'
    | 'pricing-resolution';
  severity: 'critical' | 'review' | 'info';
  resourceId?: string;
  message: string;
}

export interface ExecutorDiagnostics {
  MIMO_BUILD_SHA: string;
  MCP_VERSION?: string;
  MCP_TOOL_LIST_HASH: string;
  MCP_TOOLS: string[];
  canonicalInputHash: string;
  scenarioId: string;
  /** Tier per named step, e.g. "map:prod-fargate": "CODE". */
  modelsUsed: Record<string, string>;
  /** Bedrock model ids actually invoked, by tier. */
  modelIds: Partial<Record<Exclude<ExecutorTier, 'CODE'>, string>>;
  perResourceAttempts: Record<string, ResourceAttempt[]>;
  mcpValidationOutput?: unknown;
  estimateId?: string;
  calculatorUrl?: string;
  totals: RenderedTotals;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** Every MCP tool call made, in order, with whether the tool flagged an error. */
  toolCalls: Array<{ tool: string; isError: boolean; durationMs: number }>;
}

export interface ExecutorResult {
  status: ExecutorStatus;
  scenarioId: string;
  estimateId?: string;
  calculatorUrl?: string;
  totals: RenderedTotals;
  resources: ResourceOutcome[];
  pricing: PricingResolution[];
  /**
   * The mixed-pricing statement, fit to print verbatim: which services are committed, which
   * stay On-Demand, and why. Present for every committed scenario.
   */
  pricingScope?: string;
  findings: VerificationFinding[];
  /** One plain sentence for a status badge. */
  summary: string;
  /** The saved estimate as import_estimate returned it, for downstream readers. */
  savedEstimate?: unknown;
  diagnostics: ExecutorDiagnostics;
}

/** The surface the executor needs from an MCP client. `McpSidecarClient` satisfies it. */
export interface McpGateway {
  listTools(): Promise<Array<{ name: string }>>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs?: number): Promise<{ text: string; isError: boolean }>;
  /** Optional: renders the saved link in a browser and reads the totals off the page. */
  validateLink?(url: string): Promise<{
    validUrl: boolean;
    reason?: string;
    monthly?: number;
    upfront?: number;
    total12Months?: number;
  }>;
}

/** Progress, for a UI that shows live pipeline state. */
export type ExecutorProgress = (update: { stage: string; message: string }) => void | Promise<void>;
