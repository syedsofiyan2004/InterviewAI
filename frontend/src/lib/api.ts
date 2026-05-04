const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || '';

export type InterviewStatus = 
  | 'CREATED' 
  | 'FILES_UPLOADED' 
  | 'QUEUED' 
  | 'PROCESSING' 
  | 'COMPLETED' 
  | 'FAILED';

export interface InterviewMetadata {
  candidate_name: string;
  position: string;
  interview_date: string;
  model_id?: string;
}

export interface Interview {
  interview_id: string;
  status: InterviewStatus;
  created_at: number;
  updated_at: number;
  candidate_name: string;
  position: string;
}

export interface DetailedInterview extends Omit<Interview, 'candidate_name' | 'position'> {
  metadata: InterviewMetadata;
  transcript_uploaded: boolean;
  jd_uploaded: boolean;
  resume_uploaded?: boolean;
  jd_s3_key?: string;
  transcript_s3_key?: string;
  resume_s3_key?: string;
  inferred_role?: string;
  is_mismatched?: boolean;
  results?: {
    overall_score: number;
    recommendation: string;
    confidence: number;
    coverage_percent: number;
    result_s3_key?: string;
  } | null;
  model_id?: string;
  report_s3_key?: string;
  error?: {
    message: string;
  } | null;
}

export interface EvaluationResult {
  overall_score: number;
  recommendation: 'Strong Hire' | 'Hire' | 'Maybe' | 'No Hire' | 'Strong No Hire';
  confidence: number;
  coverage_percent: number;
  jd_fit_score: number;
  technical_depth: number;
  dimension_breakdown: Array<{
    dimension: string;
    score: number;
    reason: string;
    evidence_found: boolean;
  }>;
  strengths: string[];
  areas_for_review: string[];
  evidence_items: Array<{
    quote: string;
    context: string;
    dimension: string;
  }>;
  executive_summary: string;
  final_recommendation_note: string;
}

export type MomStatus = 'CREATED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export interface Mom {
  mom_id: string;
  project_id?: string | null;
  status: MomStatus;
  created_at: number;
  updated_at: number;
  title: string;
  project_title: string;
  source_type: 'file' | 'text';
  source_file_name?: string | null;
  source_last_modified?: number | null;
  meeting_date?: string | null;
  meeting_date_sort?: number | null;
  error_message?: string;
}

export interface MomProject {
  project_id: string | null;
  project_title: string;
  created_at: number;
  updated_at: number;
  mom_count: number;
  completed_count: number;
}

export interface DetailedMom extends Mom {
  transcript_uploaded: boolean;
  transcript_s3_key?: string;
  result_s3_key?: string;
  report_s3_key?: string;
  error?: {
    message: string;
  } | null;
}

export interface MomResult {
  title: string;
  date: string;
  attendees: string[];
  agenda_items: string[];
  discussion_points: Array<{
    topic: string;
    summary: string;
    decisions: string[];
    action_items: Array<{
      owner: string;
      task: string;
      due_date: string;
    }>;
  }>;
  risks: string[];
  next_steps: string[];
  overall_summary: string;
}

export type TfJobStatus =
  | 'CREATED'
  | 'PLAN_QUEUED'
  | 'PLAN_RUNNING'
  | 'PLAN_SUCCEEDED'
  | 'PLAN_FAILED'
  | 'APPROVED'
  | 'APPLY_QUEUED'
  | 'APPLY_RUNNING'
  | 'APPLY_SUCCEEDED'
  | 'APPLY_FAILED';

export interface TfJob {
  job_id: string;
  status: TfJobStatus;
  deployment_name: string;
  primary_region: string;
  role_arn: string;
  file_count: number;
  created_at: number;
  updated_at: number;
  approved_at?: number | null;
  plan_build_id?: string | null;
  apply_build_id?: string | null;
  plan_output?: string | null;
  apply_output?: string | null;
  error_message?: string | null;
}

export interface TfJobFile {
  filename: string;
  content: string;
}

// ---------------------------------------------------------------------------
// Auth-aware fetch — attaches the Cognito ID token to every API call.
// CognitoUserPoolsAuthorizer validates the ID token (not the access token).
// ---------------------------------------------------------------------------
async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const { getCurrentSession } = await import('./auth');
  const session = await getCurrentSession();

  if (!session) {
    // AppShell's auth guard handles the redirect to /login.
    // Just throw so the caller gets an error, not a broken redirect loop.
    throw new Error('Not authenticated');
  }

  // Use the ID token — API Gateway CognitoUserPoolsAuthorizer checks the
  // `aud` claim in the ID token against the User Pool Client ID.
  const token = session.getIdToken().getJwtToken();
  const headers: HeadersInit = {
    ...(options.headers || {}),
    Authorization: token,
  };

  return fetch(url, { ...options, headers });
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

export const api = {
  async getInterviews(): Promise<{ items: Interview[]; count: number }> {
    const res = await authFetch(`${API_URL}/interviews`);
    return handleResponse(res);
  },

  async createInterview(data: InterviewMetadata): Promise<{ interview_id: string }> {
    const res = await authFetch(`${API_URL}/interviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async getInterview(id: string): Promise<DetailedInterview> {
    const res = await authFetch(`${API_URL}/interviews/${id}`);
    return handleResponse(res);
  },

  async getUploadUrl(id: string, fileType: 'transcript' | 'jd' | 'resume', fileName: string, contentType: string): Promise<{ upload_url: string; s3_key: string }> {
    const res = await authFetch(`${API_URL}/interviews/${id}/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_type: fileType, file_name: fileName, content_type: contentType }),
    });
    return handleResponse(res);
  },

  async confirmUpload(id: string, fileType: 'transcript' | 'jd' | 'resume', s3Key: string): Promise<{ status: string }> {
    const res = await authFetch(`${API_URL}/interviews/${id}/confirm-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_type: fileType, s3_key: s3Key }),
    });
    return handleResponse(res);
  },

  async analyzeInterview(id: string): Promise<{ status: string }> {
    const res = await authFetch(`${API_URL}/interviews/${id}/analyze`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async deleteInterview(id: string): Promise<{ message: string }> {
    const res = await authFetch(`${API_URL}/interviews/${id}`, {
      method: 'DELETE',
    });
    return handleResponse(res);
  },

  async getEvaluationResult(id: string): Promise<EvaluationResult> {
    const res = await authFetch(`${API_URL}/interviews/${id}/result`);
    return handleResponse(res);
  },
  
  async getReportUrl(id: string): Promise<{ download_url: string }> {
    const res = await authFetch(`${API_URL}/interviews/${id}/report`);
    return handleResponse(res);
  },

  async getMoms(): Promise<{ items: Mom[]; count: number }> {
    const res = await authFetch(`${API_URL}/moms`);
    return handleResponse(res);
  },

  async getMomProjects(): Promise<{ items: MomProject[]; count: number }> {
    const res = await authFetch(`${API_URL}/mom-projects`);
    return handleResponse(res);
  },

  async createMomProject(data: { project_title: string }): Promise<{ project_id: string; project_title: string }> {
    const res = await authFetch(`${API_URL}/mom-projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async getMomProject(id: string): Promise<{ project_id: string; project_title: string; created_at: number; updated_at: number }> {
    const res = await authFetch(`${API_URL}/mom-projects/${id}`);
    return handleResponse(res);
  },

  async deleteMomProject(id: string): Promise<{ message: string; deleted_moms: number }> {
    const res = await authFetch(`${API_URL}/mom-projects/${id}`, {
      method: 'DELETE',
    });
    return handleResponse(res);
  },

  async createMom(data: {
    title: string;
    project_id?: string | null;
    project_title?: string;
    source_type: 'file' | 'text';
    source_file_name?: string;
    source_last_modified?: number;
  }): Promise<{ mom_id: string }> {
    const res = await authFetch(`${API_URL}/moms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async getMom(id: string): Promise<DetailedMom> {
    const res = await authFetch(`${API_URL}/moms/${id}`);
    return handleResponse(res);
  },

  async deleteMom(id: string): Promise<{ message: string }> {
    const res = await authFetch(`${API_URL}/moms/${id}`, {
      method: 'DELETE',
    });
    return handleResponse(res);
  },

  async getMomUploadUrl(id: string, fileName: string, contentType: string): Promise<{ upload_url: string; s3_key: string }> {
    const res = await authFetch(`${API_URL}/moms/${id}/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_type: 'transcript', file_name: fileName, content_type: contentType }),
    });
    return handleResponse(res);
  },

  async confirmMomUpload(id: string, s3Key: string): Promise<{ status: string }> {
    const res = await authFetch(`${API_URL}/moms/${id}/confirm-upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_type: 'transcript', s3_key: s3Key }),
    });
    return handleResponse(res);
  },

  async analyzeMom(id: string): Promise<{ status: string }> {
    const res = await authFetch(`${API_URL}/moms/${id}/analyze`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async getMomResult(id: string): Promise<MomResult> {
    const res = await authFetch(`${API_URL}/moms/${id}/result`);
    return handleResponse(res);
  },

  async getMomReportUrl(id: string): Promise<{ download_url: string }> {
    const res = await authFetch(`${API_URL}/moms/${id}/report`);
    return handleResponse(res);
  },

  async createTfJob(data: {
    deployment_name: string;
    primary_region: string;
    role_arn: string;
    files: TfJobFile[];
  }): Promise<TfJob> {
    const res = await authFetch(`${API_URL}/tf-jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async getTfJob(id: string): Promise<TfJob> {
    const res = await authFetch(`${API_URL}/tf-jobs/${id}`);
    return handleResponse(res);
  },

  async runTfPlan(id: string): Promise<TfJob> {
    const res = await authFetch(`${API_URL}/tf-jobs/${id}/plan`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async approveTfJob(id: string): Promise<TfJob> {
    const res = await authFetch(`${API_URL}/tf-jobs/${id}/approve`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async runTfApply(id: string): Promise<TfJob> {
    const res = await authFetch(`${API_URL}/tf-jobs/${id}/apply`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async getUserPreferences(): Promise<{ tour_completed: boolean; completed_tours?: Record<string, boolean> }> {
    try {
      const res = await authFetch(`${API_URL}/user/preferences`);
      if (!res.ok) return { tour_completed: false, completed_tours: {} };
      return res.json();
    } catch {
      return { tour_completed: false, completed_tours: {} };
    }
  },

  async updateUserPreferences(prefs: { tour_completed?: boolean; tour_key?: string; completed_tours?: Record<string, boolean> }): Promise<void> {
    try {
      await authFetch(`${API_URL}/user/preferences`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      });
    } catch {
      // silent fail — localStorage fallback handles it
    }
  },
};
