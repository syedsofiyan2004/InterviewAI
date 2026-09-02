/**
 * Cost Calculator API client.
 *
 * Kept separate from lib/api.ts on purpose: that file is large and is being
 * edited concurrently by the question-bank work, and nothing here needs to be
 * shared with it. The auth helper below mirrors `authFetch` in lib/api.ts
 * (which is module-local and not exported) — including the detail that API
 * Gateway's CognitoUserPoolsAuthorizer validates the **ID token**, sent as a
 * bare Authorization header with no "Bearer" prefix.
 *
 * At merge time these can be folded into the `api` object if preferred; the
 * method names and response shapes already follow its conventions.
 */

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || '';

export type CalculationStatus = 'ANALYZING' | 'REVIEW_REQUIRED' | 'PROCESSING' | 'COMPLETED' | 'NEEDS_REVIEW' | 'PARTIAL' | 'FAILED';

export interface RequirementConstraint {
  id: string;
  scope: string[];
  field: string;
  operator: 'eq' | 'in' | 'gte' | 'lte' | 'exists';
  expected: unknown;
  impact: 'critical' | 'material' | 'informational';
  source: 'workbook' | 'user' | 'system_default';
  sourceText?: string;
}

export interface RequirementPatch {
  target: {
    resourceIds?: string[];
    serviceFamily?: string;
    scenarioIds?: string[];
    environment?: string;
  };
  field: string;
  operation: 'set' | 'unset' | 'exclude' | 'include';
  value?: unknown;
  source: 'user' | 'workbook' | 'recommended';
  reason?: string;
  sourceInstruction?: string;
}

export interface PlanQuestion {
  id: string;
  prompt: string;
  field: string;
  scope: string[];
  impact: 'high' | 'medium' | 'low';
  options?: string[];
  resolved: boolean;
}

export interface CalculatorReviewCatalog {
  supported: boolean;
  source?: string;
  message?: string;
  fields: Record<string, Array<{ id: string; label: string; calculatorField: string }>>;
}

export interface PlannedScenario {
  label: string;
  pricing_model: string;
  scope?: string;
  environments: string[];
  note?: string;
}

export interface EstimatePlanRevision {
  revisionId: string;
  parentRevisionId?: string;
  scenarios: PlannedScenario[];
  requirements: RequirementConstraint[];
  hash: string;
}

export interface EstimatePlanV2 {
  planId: string;
  workbookId: string;
  status: 'DRAFT' | 'NEEDS_INPUT' | 'READY' | 'CONFIRMED';
  currentRevisionId: string;
  detectedDimensions: {
    regions: string[];
    environments: string[];
    scenarios: string[];
    serviceFamilies: string[];
    resourceCount: number;
    mappedResourceCount: number;
    excludedCount: number;
    coveragePct: number;
  };
  unresolved: PlanQuestion[];
  recommendedScenarios: PlannedScenario[];
  revisions: EstimatePlanRevision[];
}

export interface PlanProposal {
  proposalId: string;
  planId: string;
  baseRevisionId: string;
  sourceText?: string;
  summary: string;
  requirements: RequirementConstraint[];
  requirement_patches?: RequirementPatch[];
  requirement_ledger?: Array<{
    id: string;
    sourceInstruction?: string;
    target: RequirementPatch['target'];
    field: string;
    requestedValue?: unknown;
    resolvedValue?: unknown;
    status: string;
    source?: string;
    reason?: string;
  }>;
  decisions: Array<{ id: string; field: string; value: unknown; scope: string[]; source: string }>;
  scenarios?: PlannedScenario[];
  unresolved: PlanQuestion[];
}

export interface CalculationLineItem {
  service: string;
  detail?: string;
  monthly?: number | null;
  environment?: string;
  hoursPerDay?: number;
  /** True only where a utilization field was applied — drives the savings figure. */
  timeBilled?: boolean;
}

export interface CalculationEnvironmentSummary {
  name: string;
  hoursPerDay: number;
  monthly?: number | null;
}

/**
 * One priced band of an uploaded model, with its own shareable estimate.
 *
 * A migration model normally carries two: the lift-and-shift target, and a right-sized
 * recommendation. Showing only the first hides the saving the exercise exists to find;
 * showing only the second quotes a number the client has not agreed to.
 *
 * A sizing pair is only one reason a model carries several. An uploaded capacity model may
 * instead be banded by fiscal year (`26-27` … `30-31`) or by environment (Dev, QA, UAT),
 * with a whole column of usage figures per band — and each band is priced into its own
 * calculator.aws estimate. Mirrors CalculationScenarioSchema in infrastructure/schema.
 */
export interface CalculationScenario {
  /**
   * Free-form, not the `'baseline' | 'rightsized'` union this began as: a band's key comes
   * from the uploaded sheet's own column heading and cannot be enumerated here.
   */
  key: string;
  label: string;
  /**
   * Why this is a separate band, and the reason the UI must not treat them alike: `sizing`
   * scenarios are one workload costed two ways so only one will ever be spent, `period`
   * scenarios are consecutive years spent in sequence, and `environment` scenarios run
   * concurrently and genuinely do add up. Absent on estimates stored before it existed.
   */
  kind?: 'sizing' | 'period' | 'environment';
  monthly?: number | null;
  /**
   * This band's own shareable link. Null on the same grounds as the result-level `url` — a
   * run can price a band and still fail to export an estimate for it — and absent entirely
   * on estimates stored before per-band links existed.
   */
  url?: string | null;
  detail?: string;
  status?: 'SAVING' | 'VALIDATING' | 'COMPLETED' | 'NEEDS_REVIEW' | 'PARTIAL' | 'FAILED';
  upfront?: number | null;
  requirement_checks?: Array<{
    constraintId: string;
    expected?: unknown;
    actual?: unknown;
    status: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | 'UNVERIFIABLE';
    message?: string;
  }>;
  validation_errors?: string[];
}

export interface CalculationResult {
  /** Null when the run priced the workload but never saved a calculator.aws estimate. */
  url: string | null;
  currency: string;
  monthlyTotal?: number | null;
  lineItems: CalculationLineItem[];
  environments: CalculationEnvironmentSummary[];
  /** Empty for a prose estimate; two entries when an uploaded sheet offered a second sizing. */
  scenarios?: CalculationScenario[];
  /**
   * The monthly total the uploaded sheet calculated for itself, shown beside ours.
   * Live AWS pricing is always the answer; this is what the client believed before it
   * was checked, and the gap between the two is usually the conversation.
   */
  reportedMonthlyTotal?: number | null;
  assumptions: string[];
  warnings: string[];
  /** Deterministic saved-estimate validation failures. A non-empty list is never success. */
  validationErrors?: string[];
}

export interface EnvironmentHours {
  name: string;
  hoursPerDay: number;
}

/**
 * Starting point on the form. Production runs continuously; lower environments are
 * assumed to be shut down outside working hours, which is where the saving comes
 * from. Every value is editable before submitting.
 */
export const DEFAULT_ENVIRONMENT_HOURS: EnvironmentHours[] = [
  { name: 'Production', hoursPerDay: 24 },
  { name: 'Staging', hoursPerDay: 12 },
  { name: 'Dev', hoursPerDay: 8 },
];

export interface CalculationSummary {
  calculation_id: string;
  name: string;
  status: CalculationStatus;
  /** Epoch ms, as stored — matches every other record type in the hub. */
  created_at: number;
  updated_at: number;
  monthly_total?: number | null;
  /** Both present only on a revision, so the list can label it rather than showing two
   *  estimates with the same name and no way to tell which is current. */
  revision_of?: string;
  revision_number?: number;
  /** Absent on every estimate created before projects existed. Those list as ungrouped. */
  project_id?: string;
  /** Denormalised at creation, so the list can show the project without a second read. */
  project_title?: string;
}

/**
 * One row of the project list, mirroring MomProject in lib/api.ts.
 *
 * `project_id: null` is the synthetic "Ungrouped estimates" row the server adds for
 * estimates that belong to no project — it is not a real record, so it cannot be opened
 * by id or deleted.
 */
export interface CalculationProject {
  project_id: string | null;
  project_title: string;
  created_at: number;
  updated_at: number;
  estimate_count: number;
  completed_count: number;
  /** null while nothing in the project has priced yet — not the same as zero cost. */
  monthly_total?: number | null;
}

/** One row of the org-wide admin list. */
export interface AdminCalculationItem {
  calculation_id: string;
  name: string;
  status: CalculationStatus;
  region?: string | null;
  monthly_total?: number | null;
  currency?: string;
  line_item_count: number;
  environment_hours: EnvironmentHours[];
  input_file_name?: string | null;
  created_at: number;
  owner_email?: string;
  href: string;
}

/**
 * Where a run has reached and how much longer it has, as the server worked it out.
 *
 * Mirrors ProgressEstimate in infrastructure/lambdas/shared/progress-eta.ts, and every field
 * is read rather than recomputed here. The figures come from per-stage weights and an in-run
 * recalibration against the stages that have already finished; a second implementation in the
 * browser would eventually quote a different remaining time from the one the assistant quotes
 * for the same run, and two numbers that disagree are worse than either being slightly off.
 */
export interface CalculationProgress {
  /** The stage as the pipeline named it, or `queued` before a worker has written anything. */
  stage: string;
  /**
   * That stage in words, e.g. "Pricing from live AWS rates".
   *
   * A run that is over reports its outcome here instead of a stage of the work — "Estimate
   * ready", or "Stopped before finishing" for one that died.
   */
  stageLabel: string;
  stageNumber: number;
  stageCount: number;
  elapsedMs: number;
  /** 0..1, monotonic across polls, and held below 1 while a run is still live. */
  fraction: number;
  remainingLowMs: number;
  remainingHighMs: number;
  /** Nothing has written to the record for long enough that the run may be dead. Advisory. */
  stalled: boolean;
  confidence: 'low' | 'medium' | 'high';
  /**
   * One sentence fit to render verbatim, already carrying the stage, the position in the run
   * and a range for the time left. A live run's sentence opens with `stageLabel`; a finished
   * one's states how long it took.
   */
  prose: string;
}

export interface CalculationResultResponse {
  calculation_id: string;
  status: CalculationStatus;
  result: CalculationResult | null;
  error_message: string | null;
  progress_stage: string | null;
  progress_message: string | null;
  /**
   * Optional because an API deployed before this field existed simply omits it. Anything
   * showing a position has to treat its absence as "nothing to report" rather than as an
   * error — the estimate itself is in the same response and is what the page is really for.
   */
  progress?: CalculationProgress;
  environment_hours: EnvironmentHours[];
  input_file_name: string | null;
  /** Non-fatal notes from parsing the uploaded sheet — skipped rows and the like. */
  input_warnings: string[];
}

export interface CreateCalculationInput {
  name: string;
  /** Omit to create an ungrouped estimate; the server validates ownership of the project. */
  project_id?: string;
  /** Optional when a sheet is uploaded; one of the two is required. */
  prompt?: string;
  region?: string;
  environment_hours?: EnvironmentHours[];
  input_s3_key?: string;
}

/** The template a user downloads, fills in, and uploads. Kept in sync with the server's header aliases. */
export const TEMPLATE_COLUMNS = ['Environment', 'Service', 'Instance / Size', 'Qty', 'Region', 'Hours/Day', 'Notes'];

export const TEMPLATE_ROWS: string[][] = [
  ['Production', 'EC2', 't3.large', '2', 'ap-south-1', '24', 'web tier'],
  ['Production', 'RDS PostgreSQL', 'db.t3.medium', '1', 'ap-south-1', '24', 'Multi-AZ'],
  ['Production', 'S3', '200 GB Standard', '', 'ap-south-1', '', 'usage-based, hours do not apply'],
  ['Staging', 'EC2', 't3.medium', '1', 'ap-south-1', '12', ''],
  ['Dev', 'EC2', 't3.small', '2', 'ap-south-1', '8', 'off at weekends'],
];

async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { getCurrentSession } = await import('./auth');
  const session = await getCurrentSession();

  if (!session) throw new Error('Not authenticated');

  const token = session.getIdToken().getJwtToken();
  return fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: token },
  });
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

export const calculatorApi = {
  /**
   * Every estimate, or just one project's.
   *
   * `projectId: null` asks for the ungrouped ones specifically, which is not the same as
   * omitting the argument — that returns all of them.
   */
  async getCalculations(
    projectId?: string | null,
  ): Promise<{ items: CalculationSummary[]; count: number }> {
    const query = projectId === undefined
      ? ''
      : `?project_id=${projectId === null ? 'none' : encodeURIComponent(projectId)}`;
    const res = await authFetch(`${API_URL}/calculator${query}`);
    return handleResponse(res);
  },

  /** The project list, with per-project estimate counts and monthly totals. */
  async getCalculationProjects(): Promise<{ items: CalculationProject[]; count: number }> {
    const res = await authFetch(`${API_URL}/calculator-projects`);
    return handleResponse(res);
  },

  /**
   * Creates a project, or returns the existing one when the title is already taken.
   *
   * Idempotent by title on the server, case-insensitively — so re-submitting the form
   * cannot leave two identically named folders behind.
   */
  async createCalculationProject(
    project_title: string,
  ): Promise<{ project_id: string; project_title: string }> {
    const res = await authFetch(`${API_URL}/calculator-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_title }),
    });
    return handleResponse(res);
  },

  async getCalculationProject(
    id: string,
  ): Promise<{ project_id: string; project_title: string; created_at: number; updated_at: number }> {
    const res = await authFetch(`${API_URL}/calculator-projects/${id}`);
    return handleResponse(res);
  },

  /** Removes the project and every estimate inside it, with their sheets and documents. */
  async deleteCalculationProject(
    id: string,
  ): Promise<{ deleted: boolean; project_id: string; deleted_estimates: number }> {
    const res = await authFetch(`${API_URL}/calculator-projects/${id}`, { method: 'DELETE' });
    return handleResponse(res);
  },

  async createCalculation(
    data: CreateCalculationInput,
  ): Promise<{ calculation_id: string; status: CalculationStatus }> {
    const res = await authFetch(`${API_URL}/calculator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async analyzeCalculation(
    data: CreateCalculationInput,
  ): Promise<{ calculation_id: string; status: CalculationStatus; plan: EstimatePlanV2 }> {
    const res = await authFetch(`${API_URL}/calculator/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async getCalculationPlan(id: string): Promise<{ calculation_id: string; plan: EstimatePlanV2 }> {
    const res = await authFetch(`${API_URL}/calculator/plans/${id}`);
    return handleResponse(res);
  },

  async getCalculatorReviewCatalog(): Promise<CalculatorReviewCatalog> {
    const res = await authFetch(`${API_URL}/calculator/review-catalog`);
    return handleResponse(res);
  },

  async proposePlan(id: string, text: string): Promise<{ proposal: PlanProposal }> {
    const res = await authFetch(`${API_URL}/calculator/plans/${id}/proposals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    return handleResponse(res);
  },

  async proposeStructuredPlan(
    id: string,
    requirements: Array<{
      scope: string[];
      field: string;
      operator: 'eq' | 'in' | 'gte' | 'lte' | 'exists';
      expected: unknown;
      impact: 'critical' | 'material' | 'informational';
      evidence?: Array<{ sheet?: string; row?: number; label?: string; value?: string }>;
    }>,
    requirementPatches?: RequirementPatch[],
  ): Promise<{ proposal: PlanProposal }> {
    const res = await authFetch(`${API_URL}/calculator/plans/${id}/proposals`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        requirements,
        requirement_patches: requirementPatches,
      }),
    });
    return handleResponse(res);
  },

  async applyPlanProposal(id: string, proposal: PlanProposal): Promise<{ calculation_id: string; plan: EstimatePlanV2 }> {
    const res = await authFetch(`${API_URL}/calculator/plans/${id}/revisions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proposal }),
    });
    return handleResponse(res);
  },

  async confirmPlan(id: string, revisionId: string): Promise<{ calculation_id: string; plan: EstimatePlanV2 }> {
    const res = await authFetch(`${API_URL}/calculator/plans/${id}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision_id: revisionId }),
    });
    return handleResponse(res);
  },

  async runPlan(id: string): Promise<{ calculation_id: string; status: CalculationStatus; plan_revision_id: string }> {
    const res = await authFetch(`${API_URL}/calculator/plans/${id}/run`, { method: 'POST' });
    return handleResponse(res);
  },

  async getCalculationResult(id: string): Promise<CalculationResultResponse> {
    const res = await authFetch(`${API_URL}/calculator/${id}/result`);
    return handleResponse(res);
  },

  /**
   * Uploads a resource sheet straight to S3 via a presigned PUT.
   *
   * The file never passes through API Gateway, which has a 10 MB payload ceiling —
   * the same reason every other upload in the hub works this way. Returns the key
   * to hand to createCalculation.
   */
  async uploadResourceSheet(file: File): Promise<{ s3_key: string; file_name: string }> {
    const res = await authFetch(`${API_URL}/calculator/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_name: file.name,
        content_type: file.type || 'application/octet-stream',
      }),
    });
    const { upload_url, s3_key, file_name } = await handleResponse<{
      upload_url: string;
      s3_key: string;
      file_name: string;
    }>(res);

    // Presigned PUT — no Authorization header, and the Content-Type must match
    // what was signed or S3 rejects the signature.
    const put = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!put.ok) throw new Error('The file could not be uploaded. Please try again.');

    return { s3_key, file_name };
  },

  /** Presigned download URL for the client-facing PDF. */
  async getCalculationReportUrl(id: string): Promise<{ download_url: string }> {
    const res = await authFetch(`${API_URL}/calculator/${id}/report`);
    return handleResponse(res);
  },

  /**
   * Presigned download URL for the TCO workbook.
   *
   * A separate route rather than a query parameter on the PDF one, so a caller cannot
   * ask for a PDF and be handed a spreadsheet by a typo.
   */
  async getCalculationWorkbookUrl(id: string): Promise<{ download_url: string }> {
    const res = await authFetch(`${API_URL}/calculator/${id}/workbook`);
    return handleResponse(res);
  },

  /**
   * Presigned download URL for the Word document.
   *
   * A third route beside the two above for the same reason the workbook has its own: format
   * belongs in the path, where a typo cannot silently hand back a different file. What it
   * carries is a shareable estimate link per scenario, which is a shape the PDF cannot hold —
   * a printed page renders a URL as ink, so a matrix of them is a column of strings nobody
   * can click.
   */
  async getCalculationDocumentUrl(id: string): Promise<{ download_url: string }> {
    const res = await authFetch(`${API_URL}/calculator/${id}/document`);
    return handleResponse(res);
  },

  /** Removes the estimate, its uploaded sheet and its generated PDF. Owner only. */
  async deleteCalculation(id: string): Promise<{
    deleted: boolean;
    remote_estimates?: { requested: number; deleted: number; supported: boolean; warnings: string[] };
  }> {
    const res = await authFetch(`${API_URL}/calculator/${id}`, { method: 'DELETE' });
    return handleResponse(res);
  },

  /** Org-wide list for the admin portal. Requires VIEWER or above server-side. */
  async adminListCalculations(): Promise<{ items: AdminCalculationItem[]; count: number }> {
    const res = await authFetch(`${API_URL}/admin/calculator`);
    return handleResponse(res);
  },
};

/** Monthly and 12x annual as a pair, for the summary tiles. */
export function formatCurrency(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
  } catch {
    return `${value.toFixed(2)} ${currency}`;
  }
}

/**
 * What scheduled shutdown avoids, per month.
 *
 * Mirrors `schedulingSaving` in the PDF renderer so the page and the document never
 * disagree. Time-billed lines only: a usage-based service costs the same whether the
 * environment is running or not, so counting it would show a saving that is not real.
 */
export function schedulingSaving(result: CalculationResult): number | null {
  const saved = (result.lineItems || [])
    .filter((item) => item.timeBilled
      && typeof item.monthly === 'number'
      && Number.isFinite(item.monthly)
      && typeof item.hoursPerDay === 'number'
      && item.hoursPerDay > 0
      && item.hoursPerDay < 24)
    .map((item) => (item.monthly as number) * (24 / (item.hoursPerDay as number) - 1));
  return saved.length ? saved.reduce((total, value) => total + value, 0) : null;
}

/** "$1,234.56/mo", or a dash when AWS has not priced the estimate locally. */
export function formatMonthly(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined) return '—';
  try {
    return `${new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value)}/mo`;
  } catch {
    return `${value.toFixed(2)} ${currency}/mo`;
  }
}
