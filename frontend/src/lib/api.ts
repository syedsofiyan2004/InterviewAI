// The chat's own transport lives in lib/chatApi (the streaming turn goes to a Lambda
// Function URL, not the gateway). Reading a thread back is an ordinary gateway call, so
// it belongs here — but the app names and the proposal union are declared there, and
// there is no reason for a second copy of either.
import type { ChatApp, ChatProposal } from './chatApi';

const API_URL = process.env.NEXT_PUBLIC_API_BASE_URL || '';

export type BaseRole = 'MEMBER' | 'ADMIN';
export type AdminTier = 'VIEWER' | 'REVIEWER' | 'APPROVER' | 'OWNER';
export type WorkspaceStatus = 'OPEN' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED';
export type LinkedRecordType = 'interview' | 'mom' | 'intelligence';

export interface LinkedRecord {
  record_type: LinkedRecordType;
  record_id: string;
  label?: string;
  linked_at: number;
  linked_by: string;
  summary?: any;
}

export interface Member {
  org_id: string;
  user_id: string;
  email: string;
  base_role: BaseRole;
  tier: AdminTier | null;
  created_at: number;
  updated_at: number;
}

export type AuditAction = 
  | 'READ_INTERVIEW' | 'READ_MOM' | 'READ_INTELLIGENCE' | 'READ_REPORT'
  | 'DOWNLOAD_REPORT' | 'READ_WORKSPACE' | 'READ_AUDIT_LOG' | 'SEARCH'
  | 'SOFT_DELETE' | 'UPDATE_RECORD' | 'GRANT_TIER' | 'REVOKE_TIER'
  | 'CHANGE_BASE_ROLE' | 'APPROVE' | 'REJECT' | 'SHARE_ADD'
  | 'SHARE_REMOVE' | 'LIST_COGNITO_USERS' | 'QBANK_UPDATE' | 'QBANK_DELETE'
  | 'KEKA_SYNC' | 'COMPOSITE_ANALYSIS';

export interface AuditLogEntry {
  audit_id: string;
  ts: number;
  actor_user_id: string;
  actor_email?: string;
  action: AuditAction;
  target_type?: string;
  target_id?: string;
  target_owner_user_id?: string;
  detail?: string;
}

export interface SearchResult {
  type: 'interview' | 'mom' | 'intelligence';
  id: string;
  title?: string;
  owner_user_id: string;
  owner_email?: string;
  created_at: number;
  status?: string;
}

export interface AdminOverview {
  total_interviews: number;
  interviews: Record<string, number>;
  total_moms: number;
  moms: Record<string, number>;
  total_workspaces?: number;
  workspaces?: Record<string, number>;
  total_intelligence?: number;
  intelligence?: Record<string, number>;
  total_calculations?: number;
  calculations?: Record<string, number>;
}

export interface CognitoUser {
  username: string;
  status: string;
  created_at: string;
  updated_at: string;
  enabled: boolean;
  attributes: Array<{ Name: string; Value: string }>;
  has_membership?: boolean;
  user_id: string;
  email?: string;
}

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

/**
 * One stage transition, appended by the worker as it happens.
 *
 * `progress_stage`/`progress_message` only ever hold the *current* stage, so a
 * single line is all they can show. This list is the history behind it — what
 * ran, in order, with the server timestamp of each transition — which is what
 * makes a scrolling log possible instead of one overwritten sentence.
 */
export interface ProgressEvent {
  at: number;
  stage: string;
  message: string;
}

/**
 * Server-reported progress for a running analysis.
 *
 * `analysis_started_at` is stamped once when the job is queued and never
 * rewritten, so elapsed time stays correct across page refreshes. Compare it
 * against `getServerNow()`, never `Date.now()` — it is a server timestamp.
 */
export interface AnalysisProgress {
  analysis_started_at?: number | null;
  progress_stage?: string | null;
  progress_message?: string | null;
  progress_events?: ProgressEvent[] | null;
}

export interface DetailedInterview extends Omit<Interview, 'candidate_name' | 'position'>, AnalysisProgress {
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

export interface DetailedMom extends Mom, AnalysisProgress {
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
  key_topics?: any[];
  action_items?: any[];
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

export interface InterviewIntelligenceRecord extends AnalysisProgress {
  intelligence_id: string;
  owner_user_id: string;
  owner_email?: string;
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
    scheduledAt?: string;
    organizerUserId?: string;
    organizerEmail?: string;
    transcriptStatus: 'not_available' | 'pending' | 'transcribing' | 'mocked' | 'synced' | 'failed';
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
    /** Focus areas the interviewer chose for this round. */
    selectedTopics?: string[];
    /** How many role questions the interviewer asked for. */
    requestedQuestionCount?: number;
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
    caseEvaluation?: {
      overallScore: number;
      summary: string;
      competencyScores: Array<{
        competency: string;
        score: number;
        evidence: string;
      }>;
    };
    finalReport: string;
  };
  analysisError?: string;
  approved?: {
    approvedBy: string;
    approvedAt: number;
    notes?: string;
  };
  caseInterview?: {
    enabled: boolean;
    /** 'ai' = the model's own scenario; 'template' = built from the JD after a model failure. */
    source?: 'ai' | 'template';
    title?: string;
    difficulty?: string;
    problem?: string;
    format?: string;
    candidatePack?: {
      scenario: string;
      context: string[];
      deliverables: string[];
      tasks: Array<{
        title: string;
        expectedDurationMinutes?: number;
        instructions: string[];
      }>;
    };
    interviewerGuide?: {
      competencies: Array<{
        name: string;
        whatGoodLooksLike: string;
        weakSignals: string;
      }>;
      strongAnswerMarkers: string[];
      probingQuestions: Array<{
        area: string;
        question: string;
      }>;
    };
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
  title?: string;
  scheduledAt?: string;
  status?: string;
  meetingUrl?: string;
  organizerEmail?: string;
  isImported?: boolean;
  /** Status of the already-imported round, when one exists. */
  importedStatus?: string;
  /** Intelligence record id of the already-imported round, when one exists. */
  importedIntelligenceId?: string;
}

export interface ScheduledPanelist {
  interviewerId?: string;
  name: string;
  email?: string;
}

export interface ScheduledInterview {
  panelist_email: string;
  keka_interview_id: string;
  keka_job_id: string;
  keka_candidate_id: string;
  job_title: string;
  department?: string;
  candidate_name: string;
  candidate_email?: string;
  scheduled_at: number;
  title?: string;
  panel: ScheduledPanelist[];
  meeting_url?: string;
  meeting_id?: string;
  organizer_email?: string;
  organizer_user_id?: string;
  keka_status?: string;
  synced_at: number;
  cancelled_at?: number;
  intelligence_id?: string;
  workspace_id?: string;
  provisioned_at?: number;
}

export interface QuestionBankRoleSummary {
  role_key: string;
  role_title: string;
  department?: string;
  experience?: string;
  keka_job_id?: string;
  competencies: string[];
  updated_at: number;
  updated_by?: string;
}

export interface QuestionBankRole extends QuestionBankRoleSummary {
  created_at: number;
}

export interface QuestionBankItem {
  role_key: string;
  question_id: string;
  category: string;
  topic_tag?: string;
  competency?: string;
  question: string;
  follow_ups: string[];
  strong_signals: string[];
  red_flags: string[];
  active: boolean;
  source: 'SEED' | 'ADMIN';
  created_at: number;
  updated_at: number;
  updated_by?: string;
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
/**
 * Offset between this browser's clock and the API's, in ms (browser − server).
 *
 * Every progress timestamp the UI renders (analysis_started_at,
 * composite_started_at, progress events) is stamped by Lambda. Subtracting one
 * of those from `Date.now()` compares two clocks that are free to disagree: a
 * workstation a minute behind produced negative elapsed times and pinned the
 * progress timers to 0:00. The API publishes its clock on every response
 * (`X-Server-Time`), so we learn the offset once and read server time from then
 * on. Starts at 0, which is exactly right until the first response lands.
 */
let serverClockSkewMs = 0;

/** Server time, as best this client can tell. Use for anything compared against a server timestamp. */
export function getServerNow(): number {
  return Date.now() - serverClockSkewMs;
}

function recordServerClock(response: Response): void {
  const stamp = Number(response.headers.get('X-Server-Time'));
  if (!Number.isFinite(stamp) || stamp <= 0) return;
  // Half the round trip is a closer estimate than none, but the request start is
  // not tracked here and a sub-second error is irrelevant to a seconds-resolution
  // timer — so take the header at face value.
  serverClockSkewMs = Date.now() - stamp;
}

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

  const response = await fetch(url, { ...options, headers });
  recordServerClock(response);
  return response;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error?.message || `HTTP error! status: ${response.status}`);
  }
  return response.json();
}

export interface MeResponse {
  userId: string;
  email: string;
  baseRole: BaseRole;
  tier: AdminTier | null;
  isAdmin: boolean;
  org_id?: string;
}

export interface CompositeAnalysis {
  compositeScore?: number;
  overallSummary?: string;
  keyStrengths?: string[];
  majorConcerns?: string[];
  finalRecommendation?: string;
}

export interface CandidateWorkspace {
  my_permission?: 'VIEWER' | 'COMMENTER';
  workspace_id: string;
  org_id: string;
  title: string;
  candidate_name?: string;
  position?: string;
  status: WorkspaceStatus;
  owner_user_id: string;
  owner_email?: string;
  linked_records?: LinkedRecord[];
  created_at: number;
  updated_at: number;
  deleted_at?: number;
  /**
   * Multi-round synthesis (APPROVER+). Written by the async composite-analysis
   * worker, so the UI polls composite_status rather than awaiting the request.
   */
  composite_analysis?: CompositeAnalysis;
  composite_status?: 'processing' | 'done' | 'failed';
  composite_progress_stage?: string;
  composite_progress_message?: string;
  composite_progress_events?: ProgressEvent[] | null;
  composite_started_at?: number;
  composite_error?: string | null;
  /**
   * How many linked rounds actually carried a completed AI review into the
   * synthesis, out of how many are linked. A composite built from 1 of 3 rounds
   * is a different artifact from one built from all 3, so the UI states it.
   */
  composite_rounds_used?: number;
  composite_rounds_total?: number;
  composite_rounds_skipped?: string[];
}

export interface Comment {
  comment_id: string;
  workspace_id: string;
  author_user_id: string;
  author_email: string;
  body: string;
  resolved: boolean;
  created_at: number;
}

export interface SharePermission {
  workspace_id: string;
  user_id: string;
  user_email?: string;
  shared_user_id?: string;
  shared_email?: string;
  permission: 'VIEWER' | 'COMMENTER';
  created_at: number;
  created_by: string;
}

export interface WorkspaceFull {
  workspace: CandidateWorkspace;
  comments?: Comment[];
  comments_has_more?: boolean;
  shares?: SharePermission[];
  decisions?: any[];
  linked_records?: LinkedRecord[];
  my_access: {
    can_comment: boolean;
    is_owner: boolean;
    can_decide: boolean;
    via_admin_tier?: string;
  };
}

export interface Member {
  org_id: string;
  user_id: string;
  email: string;
  base_role: BaseRole;
  tier: AdminTier | null;
  created_at: number;
  updated_at: number;
}

export interface CognitoUser {
  username: string;
  status: string;
  created_at: string;
  updated_at: string;
  enabled: boolean;
  attributes: Array<{ Name: string; Value: string }>;
  has_membership?: boolean;
  user_id: string;
  email?: string;
}

// ---------------------------------------------------------------------------
// Context chat — reading threads back.
//
// These mirror ChatThreadSummarySchema / ChatThreadSchema in
// infrastructure/schema/chat.ts. Declared here, like every other response shape in
// this file, rather than imported: the browser bundle does not reach across the
// infrastructure boundary. The proposal union is the one already declared in
// lib/chatApi, so the drawer and the admin transcript render a single type instead
// of two that can drift.
// ---------------------------------------------------------------------------

/**
 * One row of the conversations list.
 *
 * Carries no turn content beyond the opening question: a list that shipped whole
 * transcripts would be a bulk export of model output about candidates, which is not
 * what an oversight list is for. `first_turn_at`/`last_turn_at` are epoch ms.
 */
export interface ChatThreadSummary {
  thread_id: string;
  app: ChatApp;
  entity_id: string;
  owner_user_id: string;
  owner_email?: string;
  /** '(record deleted)' when the artifact discussed has since been removed. */
  title: string;
  /** False when the artifact is gone. The conversation still happened, so it still lists. */
  artifact_exists: boolean;
  turn_count: number;
  preview: string;
  first_turn_at: number;
  last_turn_at: number;
  has_proposal: boolean;
  has_applied: boolean;
}

export interface ConversationListResponse {
  threads: ChatThreadSummary[];
  /** Retention window in days, so the page can say why the list stops where it does. */
  window_days: number;
}

/** One turn as the browser reads it back. `created_at`/`applied_at` are epoch ms. */
export interface ChatTranscriptTurn {
  seq: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
  proposal?: ChatProposal;
  applied_at?: number;
}

/**
 * One thread in full — the response of GET /chat/history and of
 * GET /admin/conversations/thread, deliberately the same shape for both so an owner
 * reading their own history and a reviewer reading someone else's share a renderer.
 */
export interface ChatThread {
  thread_id: string;
  app: ChatApp;
  entity_id: string;
  owner_user_id: string;
  owner_email?: string;
  title: string;
  artifact_exists: boolean;
  /** Where the artifact lives in the UI. Absent once the record is gone. */
  artifact_href?: string;
  turns: ChatTranscriptTurn[];
  /** What the model was told about the interview transcript, when there was one. */
  transcript_excerpt?: string;
}

export const api = {
  async getMe(): Promise<MeResponse> {
    const res = await authFetch(`${API_URL}/me`);
    return handleResponse(res);
  },

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

  /**
   * Presigned download URL for the minutes.
   *
   * `format` is a query parameter on the existing route rather than a route of its own,
   * because both formats render the same stored result and the API rejects any other value.
   */
  async getMomReportUrl(id: string, format: 'pdf' | 'docx' = 'pdf'): Promise<{ download_url: string }> {
    const res = await authFetch(`${API_URL}/moms/${id}/report?format=${format}`);
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

  async getMyInterviews(): Promise<{ items: ScheduledInterview[] }> {
    const res = await authFetch(`${API_URL}/my-interviews`);
    return handleResponse(res);
  },

  async refreshMyInterviews(): Promise<{ items: ScheduledInterview[] }> {
    const res = await authFetch(`${API_URL}/my-interviews/refresh`, { method: 'POST' });
    return handleResponse(res);
  },

  async openMyInterview(kekaInterviewId: string): Promise<{
    intelligence_id: string;
    item?: InterviewIntelligenceRecord;
    workspace_id?: string;
    already_provisioned?: boolean;
  }> {
    const res = await authFetch(`${API_URL}/my-interviews/${encodeURIComponent(kekaInterviewId)}/open`, {
      method: 'POST',
    });
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
  }): Promise<{ intelligence_id: string; item: InterviewIntelligenceRecord; workspace_id?: string }> {
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

  async getQuestionTopics(intelligenceId: string): Promise<{
    topics: Array<{ topic: string; priority: 'high' | 'medium' | 'low' }>;
    level: string;
    suggested_question_count: number;
    previously_covered: Array<{ topic: string; round: string }>;
  }> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${encodeURIComponent(intelligenceId)}/question-topics`);
    return handleResponse(res);
  },

  async generateIntelligenceQuestions(id: string, body?: { focus_areas?: string[]; question_count?: number }): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${encodeURIComponent(id)}/generate-questions`, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
    });
    return handleResponse(res);
  },

  async generateIntelligenceCaseInterview(id: string): Promise<InterviewIntelligenceRecord> {
    const res = await authFetch(`${API_URL}/intelligence-interviews/${id}/case-interview`, { method: 'POST' });
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

  async adminListMembers(): Promise<{ items: Member[] }> {
    const res = await authFetch(`${API_URL}/admin/members`);
    return handleResponse(res);
  },

  async adminListCognitoUsers(): Promise<{ items: CognitoUser[] }> {
    const res = await authFetch(`${API_URL}/admin/cognito-users`);
    return handleResponse(res);
  },

  async adminGrantTier(userId: string, tier: AdminTier, note?: string): Promise<{ message: string }> {
    const res = await authFetch(`${API_URL}/admin/members/${userId}/tier`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier, note }),
    });
    return handleResponse(res);
  },

  async adminRevokeTier(userId: string): Promise<{ message: string }> {
    const res = await authFetch(`${API_URL}/admin/members/${userId}/revoke`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async adminChangeBaseRole(userId: string, baseRole: BaseRole, email?: string): Promise<{ message: string }> {
    const res = await authFetch(`${API_URL}/admin/members/${userId}/base-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_role: baseRole, email }),
    });
    return handleResponse(res);
  },

  async adminListApprovals(): Promise<{ items: CandidateWorkspace[] }> {
    const res = await authFetch(`${API_URL}/admin/approvals`);
    return handleResponse(res);
  },

  async adminTriggerKekaSync(): Promise<{ status: string }> {
    const res = await authFetch(`${API_URL}/admin/keka-sync`, { method: 'POST' });
    return handleResponse(res);
  },

  async adminListQuestionBank(): Promise<{ items: QuestionBankRoleSummary[]; count: number }> {
    const res = await authFetch(`${API_URL}/admin/question-bank`);
    return handleResponse(res);
  },

  async adminGetQuestionBankRole(roleKey: string): Promise<{ role: QuestionBankRole | null; items: QuestionBankItem[]; count: number }> {
    const res = await authFetch(`${API_URL}/admin/question-bank/${encodeURIComponent(roleKey)}`);
    return handleResponse(res);
  },

  async adminUpdateQuestionBankRole(
    roleKey: string,
    data: Partial<Pick<QuestionBankRole, 'role_title' | 'department' | 'experience' | 'competencies'>>,
  ): Promise<{ role: QuestionBankRole }> {
    const res = await authFetch(`${API_URL}/admin/question-bank/${encodeURIComponent(roleKey)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async adminCreateQuestionBankItem(
    roleKey: string,
    data: Pick<QuestionBankItem, 'category' | 'question'> & Partial<Pick<QuestionBankItem, 'topic_tag' | 'competency' | 'follow_ups' | 'strong_signals' | 'red_flags'>>,
  ): Promise<{ item: QuestionBankItem }> {
    const res = await authFetch(`${API_URL}/admin/question-bank/${encodeURIComponent(roleKey)}/questions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async adminUpdateQuestionBankItem(
    roleKey: string,
    questionId: string,
    data: Partial<Pick<QuestionBankItem, 'category' | 'topic_tag' | 'competency' | 'question' | 'follow_ups' | 'strong_signals' | 'red_flags' | 'active'>>,
  ): Promise<{ item: QuestionBankItem }> {
    const res = await authFetch(`${API_URL}/admin/question-bank/${encodeURIComponent(roleKey)}/questions/${encodeURIComponent(questionId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async adminDeleteQuestionBankItem(roleKey: string, questionId: string): Promise<{ success: boolean; question_id: string }> {
    const res = await authFetch(`${API_URL}/admin/question-bank/${encodeURIComponent(roleKey)}/questions/${encodeURIComponent(questionId)}`, {
      method: 'DELETE',
    });
    return handleResponse(res);
  },

  async adminListCandidates(): Promise<{ items: CandidateWorkspace[] }> {
    const res = await authFetch(`${API_URL}/admin/candidates`);
    return handleResponse(res);
  },

  async adminListInterviews(): Promise<{ items: any[] }> {
    const res = await authFetch(`${API_URL}/admin/interviews`);
    return handleResponse(res);
  },

  async adminListMoms(): Promise<{ items: any[] }> {
    const res = await authFetch(`${API_URL}/admin/moms`);
    return handleResponse(res);
  },

  async adminSearch(query: string): Promise<{ items: SearchResult[] }> {
    const res = await authFetch(`${API_URL}/admin/search?q=${encodeURIComponent(query)}`);
    return handleResponse(res);
  },

  async getAuditLog(cursor?: string): Promise<{ items: AuditLogEntry[]; last_evaluated_key?: string }> {
    const url = cursor ? `${API_URL}/admin/audit-log?cursor=${encodeURIComponent(cursor)}` : `${API_URL}/admin/audit-log`;
    const res = await authFetch(url);
    return handleResponse(res);
  },

  async getAdminOverview(): Promise<AdminOverview> {
    const res = await authFetch(`${API_URL}/admin/overview`);
    return handleResponse(res);
  },

  /**
   * The caller's own chat thread for one artifact.
   *
   * Owner-scoped on the server — the thread id embeds the user id, so this cannot
   * reach anybody else's conversation and needs no tier. A thread that has never been
   * started is a 200 with an empty `turns`, not a 404: the drawer opens on every
   * artifact and "no history yet" is the normal case, not an error.
   */
  async getChatHistory(app: ChatApp, entityId: string): Promise<ChatThread> {
    const res = await authFetch(`${API_URL}/chat/history?app=${encodeURIComponent(app)}&entity_id=${encodeURIComponent(entityId)}`);
    return handleResponse(res);
  },

  /** Every chat thread inside the retention window, most recent activity first (REVIEWER+). */
  async listConversations(): Promise<ConversationListResponse> {
    const res = await authFetch(`${API_URL}/admin/conversations`);
    return handleResponse(res);
  },

  /**
   * One thread in full, for oversight (REVIEWER+).
   *
   * All three parts of the thread id travel as query params because there are no
   * dynamic route segments in this app, and because an id containing '#' would not
   * survive being pasted into a path.
   */
  async getConversationThread(app: ChatApp, entityId: string, userId: string): Promise<ChatThread> {
    const res = await authFetch(
      `${API_URL}/admin/conversations/thread?app=${encodeURIComponent(app)}&entity_id=${encodeURIComponent(entityId)}&user_id=${encodeURIComponent(userId)}`,
    );
    return handleResponse(res);
  },

  async getWorkspaceFull(id: string): Promise<WorkspaceFull> {
    const res = await authFetch(`${API_URL}/workspaces/${id}/full`);
    return handleResponse(res);
  },

  async listWorkspaces(): Promise<{ items: CandidateWorkspace[] }> {
    const res = await authFetch(`${API_URL}/workspaces`);
    return handleResponse(res);
  },

  async listSharedWithMe(): Promise<{ items: CandidateWorkspace[] }> {
    const res = await authFetch(`${API_URL}/workspaces/shared-with-me`);
    return handleResponse(res);
  },

  async createComment(workspace_id: string, body: string): Promise<Comment> {
    const res = await authFetch(`${API_URL}/workspaces/${workspace_id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    return handleResponse(res);
  },

  async resolveComment(workspace_id: string, comment_id: string): Promise<void> {
    const res = await authFetch(`${API_URL}/workspaces/${workspace_id}/comments/${comment_id}/resolve`, {
      method: 'POST',
    });
    return handleResponse(res);
  },

  async addWorkspaceShare(workspace_id: string, data: { shared_user_id: string, shared_email?: string, permission: 'VIEWER' | 'COMMENTER' }): Promise<void> {
    const res = await authFetch(`${API_URL}/workspaces/${workspace_id}/shares`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
    return handleResponse(res);
  },

  async removeWorkspaceShare(workspace_id: string, user_id: string): Promise<void> {
    const res = await authFetch(`${API_URL}/workspaces/${workspace_id}/shares/${user_id}`, {
      method: 'DELETE',
    });
    return handleResponse(res);
  },

  async postDecision(workspace_id: string, decision: 'APPROVED' | 'REJECTED', note?: string): Promise<void> {
    const res = await authFetch(`${API_URL}/workspaces/${workspace_id}/decision`, {
      method: 'POST',
      body: JSON.stringify({ decision, note }),
    });
    return handleResponse(res);
  },

  /**
   * Queues the multi-round synthesis (APPROVER+). Returns as soon as the worker
   * is queued — the result lands on the workspace row, so callers poll
   * getWorkspaceFull for composite_status instead of awaiting the analysis.
   */
  async generateCompositeAnalysis(workspace_id: string): Promise<{ status?: string }> {
    const res = await authFetch(`${API_URL}/workspaces/${workspace_id}/composite-analysis`, {
      method: 'POST',
    });
    return handleResponse(res);
  },
};
