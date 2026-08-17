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

export type CalculationStatus = 'PROCESSING' | 'COMPLETED' | 'FAILED';

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

export interface CalculationResult {
  url: string;
  currency: string;
  monthlyTotal?: number | null;
  lineItems: CalculationLineItem[];
  environments: CalculationEnvironmentSummary[];
  assumptions: string[];
  warnings: string[];
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

export interface CalculationResultResponse {
  calculation_id: string;
  status: CalculationStatus;
  result: CalculationResult | null;
  error_message: string | null;
  progress_stage: string | null;
  progress_message: string | null;
  environment_hours: EnvironmentHours[];
  input_file_name: string | null;
  /** Non-fatal notes from parsing the uploaded sheet — skipped rows and the like. */
  input_warnings: string[];
}

export interface CreateCalculationInput {
  name: string;
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
  async getCalculations(): Promise<{ items: CalculationSummary[]; count: number }> {
    const res = await authFetch(`${API_URL}/calculator`);
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

  /** Removes the estimate, its uploaded sheet and its generated PDF. Owner only. */
  async deleteCalculation(id: string): Promise<{ deleted: boolean }> {
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
