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
  question_guide?: InterviewQuestionGuide | null;
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
  interview_execution?: {
    summary: string;
    panel_assessment: {
      score: number;
      questions_asked_count: number;
      planned_question_coverage_percent: number;
      follow_up_quality: 'strong' | 'average' | 'weak' | 'not_enough_data';
      observations: string[];
      missed_areas: string[];
    };
    interviewer_evaluations: Array<{
      name: string;
      questions_asked_count: number;
      planned_question_coverage_percent: number;
      follow_up_quality: 'strong' | 'average' | 'weak' | 'not_enough_data';
      observations: string[];
      missed_areas: string[];
    }>;
  };
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
  reference_no?: string;
  report_type?: string;
  platform?: string;
  duration?: string;
  workstream?: string;
  facilitator?: string;
  scribe?: string;
  distribution?: string;
  issued_date?: string;
  attendees: Array<{
    name: string;
    role?: string;
    organisation?: string;
  }>;
  agenda_items: string[];
  discussion_points: Array<{
    topic: string;
    raised_by?: string;
    summary: string;
    decisions: Array<{
      decision: string;
      rationale?: string;
      decided_by?: string;
    }>;
    action_items: Array<{
      owner: string;
      task: string;
      due_date: string;
      priority?: 'High' | 'Medium' | 'Low';
    }>;
  }>;
  risks: Array<{
    description: string;
    likelihood?: 'H' | 'M' | 'L';
    impact?: 'H' | 'M' | 'L';
    owner?: string;
    mitigation?: string;
    category?: string;
  }>;
  next_steps: string[];
  next_meeting?: {
    date?: string;
    purpose?: string;
    proposed_agenda?: string;
    prep_required?: string;
  };
  previous_actions?: Array<{
    ref?: string;
    action: string;
    owner?: string;
    status?: string;
  }>;
  overall_summary: string;
}

export interface InterviewQuestionGuide {
  generated_at: number;
  source: 'approved_question_bank';
  role_title: string;
  detected_level: 'junior' | 'mid' | 'senior' | 'lead' | 'architect';
  focus_areas: string[];
  optimization_status: 'optimized' | 'bank_only';
  questions: Array<{
    id: string;
    bank_question_id: string;
    category: string;
    focus_area: string;
    source_question: string;
    question: string;
    follow_ups: string[];
    what_to_listen_for: string[];
  }>;
}

export type IntelligenceStatus =
  | 'draft'
  | 'data_ready'
  | 'questions_generated'
  | 'transcript_ready'
  | 'scores_submitted'
  | 'analysis_processing'
  | 'analysis_failed'
  | 'analysis_generated'
  | 'approved';

export interface IntelligenceQuestion {
  question: string;
  followUps: string[];
  whatToEvaluate: string[];
  questionType?: 'introduction' | 'resume' | 'role';
  countsTowardPanelEvaluation?: boolean;
}

export interface IntelligencePanelist {
  interviewerId: string;
  name: string;
  email?: string;
  role?: string;
  focusArea?: string;
  assignedQuestions?: IntelligenceQuestion[];
  score?: number;
  feedback?: string;
  opinion?: 'proceed' | 'hold' | 'reject' | 'needs_review';
}

export interface InterviewIntelligenceRecord {
  intelligence_id: string;
  owner_user_id: string;
  created_at: number;
  updated_at: number;
  source_mode: 'manual' | 'mock_keka' | 'keka_live' | 'teams_live';
  status: IntelligenceStatus;
  keka: {
    mode: 'mock' | 'disabled' | 'live';
    syncStatus: 'not_connected' | 'mocked' | 'synced' | 'failed';
    lastSyncAt?: number;
    error?: string;
  };
  teams: {
    mode: 'mock' | 'disabled' | 'live';
    meetingUrl?: string;
    meetingId?: string;
    organizerUserId?: string;
    organizerEmail?: string;
    transcriptStatus: 'not_available' | 'pending' | 'mocked' | 'synced' | 'failed';
    lastSyncAt?: number;
    error?: string;
  };
  job: {
    title: string;
    description: string;
    seniority?: string;
    requiredSkills: string[];
    preferredSkills?: string[];
  };
  candidate: {
    name: string;
    email?: string;
    resumeText?: string;
    experienceSummary?: string;
    resumeS3Key?: string;
    resumeFileName?: string;
  };
  panel: IntelligencePanelist[];
  questionPlan?: {
    generatedAt: number;
    candidateSummary: string;
    jdSummary: string;
    skillAreas: Array<{
      skill: string;
      priority: 'high' | 'medium' | 'low';
      reason: string;
    }>;
    panelPlan: Array<{
      interviewerId: string;
      focusArea: string;
      questions: Array<IntelligenceQuestion & {
        expectedStrongAnswerSignals: string[];
        redFlags: string[];
      }>;
    }>;
    scoringRubric: Array<{
      category: string;
      maxScore: number;
      guidance: string;
    }>;
  };
  transcript?: {
    rawText: string;
    source: 'manual' | 'mock_teams' | 'teams_live';
    uploadedAt: number;
  };
  aiEvaluation?: {
    generatedAt: number;
    candidateEvaluation: {
      summary: string;
      strengths: string[];
      concerns: string[];
      skillScores: Array<{ skill: string; score: number; evidence: string }>;
      recommendation: 'proceed' | 'hold' | 'reject' | 'needs_review';
      recommendationReason: string;
    };
    interviewerEvaluations: Array<{
      interviewerId: string;
      name: string;
      questionsAskedCount: number;
      jdCoveragePercent: number;
      followUpQuality: 'strong' | 'average' | 'weak' | 'not_enough_data';
      scoreJustification: 'well_supported' | 'partially_supported' | 'weakly_supported' | 'not_available';
      observations: string[];
      missedAreas: string[];
    }>;
    coverageMatrix: Array<{
      jdSkill: string;
      covered: 'yes' | 'partial' | 'no';
      evidence: string;
      askedBy?: string[];
    }>;
    panelCalibration?: {
      panelSize: number;
      scoreSpread?: number;
      outliers: Array<{ interviewerId: string; name: string; score: number; reason: string }>;
      summary: string;
      humanReviewRequired: boolean;
    };
    finalReport: string;
  };
  analysisError?: string;
  approved?: {
    approvedBy: string;
    approvedAt: number;
    notes?: string;
  };
}

export interface IntegrationStatus {
  keka: { mode: 'mock' | 'disabled' | 'live'; label: string; configured: boolean; credentialSource?: string };
  teams: { mode: 'mock' | 'disabled' | 'live'; label: string; configured: boolean };
  message: string;
}

export interface KekaJobOption {
  id: string;
  title: string;
  department?: string;
  experience?: string;
}

export interface KekaCandidateOption {
  id: string;
  name: string;
  email?: string;
  status?: string;
}

export interface KekaInterviewOption {
  id: string;
  scheduledAt?: string;
  status?: string;
  meetingUrl?: string;
  organizerEmail?: string;
}

export interface MinfyCareerJob {
  id: string;
  title: string;
  department?: string;
  location?: string;
  sourceUrl: string;
}

export interface MinfyCareerJobDetail extends MinfyCareerJob {
  description: string;
  fetchedAt: number;
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

  async generateInterviewQuestionGuide(id: string): Promise<InterviewQuestionGuide> {
    const res = await authFetch(`${API_URL}/interviews/${id}/question-guide`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async getIntegrationStatus(): Promise<IntegrationStatus> {
    const res = await authFetch(`${API_URL}/integrations/status`);
    return handleResponse(res);
  },

  async getMinfyCareerJobs(): Promise<{ source: string; source_url: string; fetched_at: number; jobs: MinfyCareerJob[] }> {
    const res = await authFetch(`${API_URL}/minfy-careers/jobs`);
    return handleResponse(res);
  },

  async getMinfyCareerJob(jobId: string): Promise<{ job: MinfyCareerJobDetail }> {
    const res = await authFetch(`${API_URL}/minfy-careers/jobs/${encodeURIComponent(jobId)}`);
    return handleResponse(res);
  },

  async attachMinfyCareerJobDescription(id: string, jobId: string): Promise<{ status: string; s3_key: string; job: MinfyCareerJob }> {
    const res = await authFetch(`${API_URL}/interviews/${id}/minfy-jd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId }),
    });
    return handleResponse(res);
  },

  async getIntelligenceInterviews(): Promise<{ items: InterviewIntelligenceRecord[]; count: number }> {
    const res = await authFetch(`${API_URL}/intelligence-interviews`);
    return handleResponse(res);
  },

  async getKekaJobs(): Promise<{ items: KekaJobOption[] }> {
    const res = await authFetch(`${API_URL}/keka/jobs`);
    return handleResponse(res);
  },

  async getKekaCandidates(jobId: string): Promise<{ items: KekaCandidateOption[] }> {
    const res = await authFetch(`${API_URL}/keka/jobs/${encodeURIComponent(jobId)}/candidates`);
    return handleResponse(res);
  },

  async getKekaInterviews(jobId: string, candidateId: string): Promise<{ items: KekaInterviewOption[] }> {
    const res = await authFetch(`${API_URL}/keka/jobs/${encodeURIComponent(jobId)}/candidates/${encodeURIComponent(candidateId)}/interviews`);
    return handleResponse(res);
  },

  async createIntelligenceInterview(data: {
    source_mode: 'manual' | 'mock_keka' | 'keka_live' | 'teams_live';
    job?: {
      title: string;
      description: string;
      seniority?: string;
      requiredSkills?: string[] | string;
      preferredSkills?: string[] | string;
    };
    candidate?: {
      name: string;
      email?: string;
      resumeText?: string;
      experienceSummary?: string;
    };
    panel?: Array<{
      interviewerId?: string;
      name: string;
      email?: string;
      role?: string;
      focusArea?: string;
    }>;
    meetingUrl?: string;
    meetingId?: string;
    organizerUserId?: string;
    organizerEmail?: string;
    jobId?: string;
    candidateId?: string;
    interviewId?: string;
  }): Promise<{ intelligence_id: string; item: InterviewIntelligenceRecord }> {
    const res = await authFetch(`${API_URL}/intelligence-interviews`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async getIntelligenceInterview(id: string): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}`);
    return handleResponse(res);
  },

  async deleteIntelligenceInterview(id: string): Promise<{ message: string }> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}`, { method: 'DELETE' });
    return handleResponse(res);
  },

  async updateIntelligenceDetails(id: string, data: { candidateEmail?: string; organizerEmail?: string }): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate_email: data.candidateEmail, organizer_email: data.organizerEmail }),
    });
    return handleResponse(res);
  },

  async getIntelligenceResumeUploadUrl(id: string, file: { fileName: string; contentType: string }): Promise<{ upload_url: string; s3_key: string }> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/resume-upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_name: file.fileName, content_type: file.contentType }),
    });
    return handleResponse(res);
  },

  async confirmIntelligenceResume(id: string, data: { s3_key: string; file_name: string }): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/confirm-resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async generateIntelligenceQuestions(id: string): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/generate-questions`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async updateIntelligenceTranscript(id: string, data: { rawText?: string; source?: 'manual' | 'mock_teams'; useMockTeams?: boolean }): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/transcript`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async syncTeamsTranscript(id: string): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/sync-teams-transcript`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async updateIntelligenceScores(id: string, panel: Array<{
    interviewerId: string;
    score?: number;
    feedback?: string;
    opinion?: 'proceed' | 'hold' | 'reject' | 'needs_review';
  }>): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/scores`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ panel }),
    });
    return handleResponse(res);
  },

  async analyzeIntelligenceInterview(id: string): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/analyze`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async approveIntelligenceInterview(id: string, notes?: string): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes }),
    });
    return handleResponse(res);
  },

  async getIntelligenceReport(id: string): Promise<{ intelligence_id: string; status: IntelligenceStatus; report: string; download_url: string }> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/report`);
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
