import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { Readable } from 'node:stream';

export type IntelligenceSourceMode = 'manual' | 'keka_live' | 'teams_live';
export type IntegrationMode = 'disabled' | 'live';
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
export type CandidateRecommendation =
  | 'strongly_recommend'
  | 'recommend'
  | 'proceed_with_reservations'
  | 'additional_assessment_required'
  | 'not_recommended'
  | 'strongly_not_recommended'
  | 'proceed'
  | 'hold'
  | 'reject'
  | 'needs_review';
export type CompetencyAssessmentStatus =
  | 'exceeds_standard'
  | 'meets_standard'
  | 'partially_demonstrated'
  | 'below_standard'
  | 'not_assessed';
export type EvidenceConfidence = 'high' | 'medium' | 'low';

export interface IntelligenceQuestion {
  question: string;
  followUps: string[];
  whatToEvaluate: string[];
  /** Context questions help the panel understand the candidate but are excluded from interviewer coverage scoring. */
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
  owner_email?: string;
  created_at: number;
  updated_at: number;
  source_mode: IntelligenceSourceMode;
  status: IntelligenceStatus;
  keka: {
    mode: IntegrationMode;
    jobId?: string;
    candidateId?: string;
    interviewId?: string;
    syncStatus: 'not_connected' | 'synced' | 'failed';
    lastSyncAt?: number;
    error?: string;
  };
  teams: {
    mode: IntegrationMode;
    meetingUrl?: string;
    meetingId?: string;
    scheduledAt?: string;
    organizerUserId?: string;
    organizerEmail?: string;
    transcriptStatus: 'not_available' | 'pending' | 'synced' | 'failed' | 'transcribing';
    transcriptSource?: 'teams_transcript' | 'teams_recording_transcribe';
    recordingId?: string;
    recordingS3Key?: string;
    transcribeJobName?: string;
    transcribeOutputKey?: string;
    recordingWorkerToken?: string;
    recordingWorkerStartedAt?: number;
    lastSyncAt?: number;
    error?: string;
  };
  job: {
    title: string;
    description: string;
    seniority?: string;
    requiredSkills: string[];
    preferredSkills?: string[];
    /**
     * Real, assessable role competencies (Part B). Provenance-tagged so the UI
     * and report can show whether each came from an admin override, Sonnet 5
     * extraction of the JD, or the deterministic inferSkills fallback. This is
     * what is surfaced as "skills"/"focus areas"; the question bank's internal
     * topicTag/focusArea labels (e.g. "1500+ VM Migrations") never are.
     */
    competencies?: Array<{ name: string; source: 'admin' | 'ai' | 'inferred' }>;
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
  caseInterview?: {
    enabled: boolean;
    generatedAt?: number;
    /**
     * Where this case study came from. 'ai' is the model's own scenario;
     * 'template' is the deterministic study built from the JD when the model call
     * failed or timed out. The two read alike on the page, so the panel needs to
     * be told which one they are running.
     */
    source?: 'ai' | 'template';
    title?: string;
    difficulty?: 'foundation' | 'practitioner' | 'senior' | 'principal';
    format?: string;
    candidatePack?: {
      scenario: string;
      context: string[];
      exhibits: Array<{
        title: string;
        content: string[];
        revealTiming?: 'initial' | 'on_request';
      }>;
      tasks: Array<{
        title: string;
        instructions: string[];
        expectedDurationMinutes?: number;
      }>;
      deliverables: string[];
    };
    interviewerGuide?: {
      competencies: Array<{
        name: string;
        whatGoodLooksLike: string;
        weakSignals: string;
        maxScore: number;
      }>;
      strongAnswerMarkers: string[];
      probingQuestions: Array<{
        area: string;
        question: string;
        expectedSignal: string;
        redFlag: string;
      }>;
      hiddenFacts: string[];
    };
  };
  transcript?: {
    rawText: string;
    source: 'manual' | 'teams_live' | 'teams_recording_transcribe';
    uploadedAt: number;
  };
  aiEvaluation?: {
    generatedAt: number;
    candidateEvaluation: {
      candidateScore?: number;
      candidateScoreReason?: string;
      jdCoveragePercent?: number;
      evidenceBullets?: string[];
      evidenceConfidence?: EvidenceConfidence;
      decisionConfidence?: EvidenceConfidence;
      nextAction?: string;
      validationWarnings?: string[];
      summary: string;
      strengths: string[];
      concerns: string[];
      skillScores: Array<{
        skill: string;
        score: number;
        evidence: string;
      }>;
      competencyRatings?: Array<{
        competency: string;
        requirement: string;
        status: CompetencyAssessmentStatus;
        rating: number | null;
        questionAsked: string;
        relevantResponse: string;
        followUpProbes: string[];
        performanceBenchmark: string;
        ratingJustification: string;
        evidenceConfidence: EvidenceConfidence;
        requiredFollowUp: string;
      }>;
      recommendation: CandidateRecommendation;
      recommendationReason: string;
    };
    interviewerEvaluations: Array<{
      interviewerId: string;
      name: string;
      panelScore: number;
      panelScoreReason: string;
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
      outliers: Array<{
        interviewerId: string;
        name: string;
        score: number;
        reason: string;
      }>;
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
        risk: string;
      }>;
      strongSignals: string[];
      concerns: string[];
      missedProbes: string[];
      candidateApproach: string;
      recommendationImpact: string;
    };
    finalReport: string;
  };
  analysisError?: string;
  approved?: {
    approvedBy: string;
    approvedAt: number;
    notes?: string;
  };
  /** Set once the round is linked to a candidate review workspace. */
  workspace_id?: string;
  /** Present on admin (recoverable) deletes; absent on live records. */
  deleted_at?: number;
  /** Stamped once when analysis is queued; never rewritten, so elapsed time is stable. */
  analysis_started_at?: number;
  /** Machine-readable phase of the running analysis (queued/preparing/evaluating/saving/done). */
  progress_stage?: string;
  /** Human-readable description of the current phase, shown in the UI. */
  progress_message?: string;
  /**
   * Append-only history of the stage transitions of the CURRENT run, oldest
   * first. progress_stage/progress_message hold only the phase in flight, so this
   * is what lets the UI show an activity log instead of one overwritten line.
   * Reset when a run is queued, which bounds it to one run's worth of entries.
   */
  progress_events?: ProgressEvent[];
}

/** One stage transition, stamped from the server clock. */
export interface ProgressEvent {
  at: number;
  stage: string;
  message: string;
}

export interface KekaIntegration {
  listJobs(): Promise<KekaJob[]>;
  listCandidates(jobId: string): Promise<KekaCandidate[]>;
  listInterviews(jobId: string, candidateId: string): Promise<KekaScheduledInterview[]>;
  getInterviewData(input: {
    jobId?: string;
    candidateId?: string;
    interviewId?: string;
  }): Promise<{
    job: InterviewIntelligenceRecord['job'];
    candidate: InterviewIntelligenceRecord['candidate'];
    panel: InterviewIntelligenceRecord['panel'];
    meetingUrl?: string;
    meetingId?: string;
    scheduledAt?: string;
    organizerUserId?: string;
    organizerEmail?: string;
    /** Keka's own meeting title, used to label the round in its workspace. */
    kekaMeetingTitle?: string;
  }>;
  /**
   * Why interviewer emails could not be resolved during this integration's
   * lifetime, if they could not — the sweep reports it as the reason some rounds
   * were not indexed. Optional because it only applies to the live Hire client.
   */
  readonly panelEmailLookupError?: string;
}

/** Shared so the message the operator sees is identical wherever it surfaces. */
export const PANEL_EMAIL_PERMISSION_MESSAGE = 'Keka denied access to employee email data. Ask a Keka administrator to grant HRIS Employees Read permission to the API application.';

export interface KekaJob {
  id: string;
  title: string;
  department?: string;
  experience?: string;
}

export interface KekaCandidate {
  id: string;
  name: string;
  email?: string;
  status?: string;
}

export interface KekaScheduledInterview {
  id: string;
  title?: string;
  scheduledAt?: string;
  status?: string;
  panel: IntelligencePanelist[];
  meetingUrl?: string;
  meetingId?: string;
  organizerEmail?: string;
  organizerUserId?: string;
}

export interface TeamsIntegration {
  getTranscript(input: {
    meetingUrl?: string;
    meetingId?: string;
    scheduledAt?: string;
    candidateName?: string;
    candidateEmail?: string;
    jobTitle?: string;
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<{
    rawText: string;
    meetingId?: string;
    organizerUserId?: string;
  }>;
  getRecording(input: {
    meetingUrl?: string;
    meetingId?: string;
    scheduledAt?: string;
    candidateName?: string;
    candidateEmail?: string;
    jobTitle?: string;
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<{
    stream: Readable;
    contentType: string;
    extension: string;
    recordingId: string;
    contentLength?: number;
    meetingId?: string;
    organizerUserId?: string;
    createdDateTime?: string;
  }>;
}

type TeamsGraphCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

const secretsClient = new SecretsManagerClient({});
let cachedTeamsCredentials: { value: TeamsGraphCredentials; expiresAt: number } | undefined;
let cachedKekaCredentials: { value: KekaCredentials; expiresAt: number } | undefined;

export class TeamsIntegrationError extends Error {
  constructor(message: string, readonly recordingFallbackAllowed = false) {
    super(message);
    this.name = 'TeamsIntegrationError';
  }
}

/**
 * Why a Keka call failed.
 *
 * 'denied' and 'absent' are answers FROM Keka — the resource is off-limits or not
 * there, and asking again changes nothing. Everything else ('unreachable',
 * 'unusable') means we never got a usable answer, so the caller must not read it
 * as a verdict. Callers that degrade on a permission gap depend on this
 * distinction: treating a dropped connection as "permission denied" would record a
 * phantom permission problem and silently stop resolving data the tenant can
 * actually see.
 */
export type KekaFailureKind = 'denied' | 'absent' | 'unreachable' | 'unusable';

export class KekaIntegrationError extends Error {
  constructor(message: string, readonly kind: KekaFailureKind = 'unusable') {
    super(message);
    this.name = 'KekaIntegrationError';
  }
}

type KekaCredentials = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  scope: string;
};

type KekaRecord = Record<string, unknown>;
type GraphCalendarEvent = {
  id?: string;
  subject?: string;
  onlineMeetingUrl?: string;
  webLink?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  onlineMeeting?: { joinUrl?: string };
  attendees?: Array<{ emailAddress?: { address?: string; name?: string } }>;
};

function getRequiredString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

async function getTeamsGraphCredentials(): Promise<TeamsGraphCredentials> {
  if (cachedTeamsCredentials && cachedTeamsCredentials.expiresAt > Date.now()) {
    return cachedTeamsCredentials.value;
  }

  const secretId = getRequiredString(process.env.MS_TEAMS_SECRET_ARN);
  if (!secretId) {
    throw new TeamsIntegrationError('Microsoft Teams credentials are not configured in AWS Secrets Manager.');
  }

  let secretString = '';
  try {
    const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
    secretString = response.SecretString || '';
  } catch {
    throw new TeamsIntegrationError('Microsoft Teams credentials could not be read from AWS Secrets Manager.');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(secretString) as Record<string, unknown>;
  } catch {
    throw new TeamsIntegrationError('Microsoft Teams credentials are not stored as valid JSON.');
  }

  const credentials: TeamsGraphCredentials = {
    tenantId: getRequiredString(payload.tenantId || payload.MS_TENANT_ID),
    clientId: getRequiredString(payload.clientId || payload.MS_CLIENT_ID),
    clientSecret: getRequiredString(payload.clientSecret || payload.MS_CLIENT_SECRET),
  };

  if (!credentials.tenantId || !credentials.clientId || !credentials.clientSecret) {
    throw new TeamsIntegrationError('Microsoft Teams credentials must contain tenantId, clientId, and clientSecret.');
  }

  cachedTeamsCredentials = { value: credentials, expiresAt: Date.now() + 15 * 60 * 1000 };
  return credentials;
}

function asRecord(value: unknown): KekaRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as KekaRecord : undefined;
}

function firstString(record: KekaRecord | undefined, keys: string[]): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const raw = record[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    const value = getRequiredString(raw);
    if (value) return value;
  }
  return undefined;
}

function normalizeKekaBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/]+$/i.test(trimmed)) {
    throw new KekaIntegrationError('Keka base URL must use the company URL format, for example https://company.keka.com.');
  }
  return trimmed;
}

function listFromKekaPage(payload: unknown): KekaRecord[] {
  const record = asRecord(payload);
  const entries = record?.data ?? record?.items ?? record?.value;
  return Array.isArray(entries) ? entries.map(asRecord).filter((item): item is KekaRecord => !!item) : [];
}

function cleanKekaText(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePersonName(value: string | undefined): string {
  return cleanKekaText(getRequiredString(value))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function employeeDisplayName(record: KekaRecord): string | undefined {
  return firstString(record, ['displayName', 'name', 'fullName', 'employeeName'])
    ?? getRequiredString([
      firstString(record, ['firstName', 'first_name']),
      firstString(record, ['middleName', 'middle_name']),
      firstString(record, ['lastName', 'last_name']),
    ].filter(Boolean).join(' '));
}

function employeeEmail(record: KekaRecord): string | undefined {
  return firstString(record, ['email', 'emailId', 'officialEmail', 'workEmail']);
}

function exactSingleEmployeeEmail(rows: KekaRecord[], panelName: string): string | null {
  const target = normalizePersonName(panelName);
  if (!target) return null;
  const exactEmails = Array.from(new Set(
    rows
      .filter((row) => normalizePersonName(employeeDisplayName(row)) === target)
      .map(employeeEmail)
      .filter((email): email is string => !!email),
  ));
  return exactEmails.length === 1 ? exactEmails[0] : null;
}

function kekaDateToMs(value: string | undefined): number | undefined {
  const text = getRequiredString(value);
  if (!text) return undefined;
  if (/^\d{10}(\.\d+)?$/.test(text)) return Number.parseFloat(text) * 1000;
  if (/^\d{13}(\.\d+)?$/.test(text)) return Number.parseFloat(text);
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeKekaDate(value: string | undefined): string | undefined {
  const ms = kekaDateToMs(value);
  return ms === undefined ? getRequiredString(value) || undefined : new Date(ms).toISOString();
}

function kekaTimeParts(value: unknown): { hours: number; minutes: number } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const hours = Number(record.hours ?? record.hour);
  const minutes = Number(record.minutes ?? record.minute ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return undefined;
  return { hours, minutes };
}

function timezoneOffsetMinutes(timeZoneId?: string): number {
  const normalized = getRequiredString(timeZoneId).toLowerCase();
  if (normalized.includes('india')) return 330;
  return 0;
}

function normalizeKekaScheduledAt(record: KekaRecord): string | undefined {
  const dateText = firstString(record, ['scheduledDateTime', 'scheduledAt', 'scheduledOn', 'interviewDate', 'date', 'scheduledDate']);
  const baseMs = kekaDateToMs(dateText);
  if (baseMs === undefined) return normalizeKekaDate(dateText);

  const time = kekaTimeParts(record.startTime);
  if (!time) return new Date(baseMs).toISOString();

  const offset = timezoneOffsetMinutes(firstString(record, ['timeZoneId', 'timezone', 'timeZone']));
  const date = new Date(baseMs);
  const utc = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), time.hours, time.minutes) - offset * 60 * 1000;
  return new Date(utc).toISOString();
}

function resumeTextFromKeka(payload: unknown): string {
  const ignoredKeys = new Set(['id', 'candidateid', 'fileid', 'filename', 'fileurl', 'url', 'downloadurl', 'createdat', 'updatedat']);
  const lines: string[] = [];
  const visit = (value: unknown, label?: string, depth = 0) => {
    if (depth > 5 || value === null || value === undefined) return;
    if (typeof value === 'string') {
      const text = cleanKekaText(value);
      if (text.length > 2 && !/^https?:\/\//i.test(text)) {
        lines.push(label ? `${label}: ${text}` : text);
      }
      return;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return;
    if (Array.isArray(value)) {
      value.slice(0, 30).forEach((entry) => visit(entry, label, depth + 1));
      return;
    }
    const record = asRecord(value);
    if (!record) return;
    Object.entries(record).forEach(([key, entry]) => {
      if (ignoredKeys.has(key.toLowerCase())) return;
      const readableLabel = key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim();
      visit(entry, readableLabel, depth + 1);
    });
  };

  visit(payload);
  return Array.from(new Set(lines)).join('\n').slice(0, 18_000).trim();
}

function toKekaPanelist(value: KekaRecord, index: number): IntelligencePanelist {
  const name = firstString(value, ['name', 'fullName', 'interviewerName', 'employeeName']) || `Interviewer ${index + 1}`;
  return {
    interviewerId: firstString(value, ['id', 'employeeId', 'interviewerId', 'userId']) || `keka-panel-${index + 1}`,
    name,
    email: firstString(value, ['email', 'emailId', 'officialEmail']),
    role: firstString(value, ['role', 'designation', 'jobTitle']),
  };
}

function extractPanel(record: KekaRecord): IntelligencePanelist[] {
  const source = record.panelMembers ?? record.interviewers ?? record.panel ?? record.interviewerDetails;
  if (Array.isArray(source)) {
    return source.map(asRecord).filter((item): item is KekaRecord => !!item).map(toKekaPanelist);
  }
  const panelText = getRequiredString(source);
  if (!panelText) return [];
  return panelText
    .split(/[,;|]/)
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name, index) => ({
      interviewerId: `keka-panel-${index + 1}`,
      name,
    }));
}

function toKekaJob(record: KekaRecord): KekaJob {
  const id = firstString(record, ['id', 'jobId']);
  const title = firstString(record, ['title', 'jobTitle', 'name']);
  if (!id || !title) throw new KekaIntegrationError('Keka returned a job without an ID or title.');
  return {
    id,
    title,
    department: firstString(record, ['departmentName', 'department']),
    experience: firstString(record, ['experience', 'experienceRange']),
  };
}

function toKekaCandidate(record: KekaRecord): KekaCandidate | undefined {
  // The Hire list endpoint can return either the candidate directly or an
  // interview/application row containing a nested candidate object.
  const candidate = asRecord(record.candidate) ?? asRecord(record.candidateDetails) ?? asRecord(record.candidateData) ?? record;
  const id = firstString(candidate, ['id', 'candidateId', 'candidate_id']) ?? firstString(record, ['candidateId', 'candidate_id']);
  const name = firstString(candidate, ['name', 'fullName', 'candidateName'])
    ?? getRequiredString([firstString(candidate, ['firstName', 'first_name']), firstString(candidate, ['lastName', 'last_name'])].filter(Boolean).join(' '))
    ?? firstString(record, ['candidateName', 'name']);
  if (!id || !name) return undefined;
  return {
    id,
    name,
    email: firstString(candidate, ['email', 'emailId', 'candidateEmail', 'officialEmail']) ?? firstString(record, ['candidateEmail', 'email']),
    status: firstString(candidate, ['status', 'candidateStatus']) ?? firstString(record, ['candidateStatus', 'status']),
  };
}

function toKekaInterview(record: KekaRecord): KekaScheduledInterview {
  const id = firstString(record, ['id', 'interviewId']);
  if (!id) throw new KekaIntegrationError('Keka returned an interview without an ID.');
  const organizer = asRecord(record.organizer)
    ?? asRecord(record.meetingOrganizer)
    ?? asRecord(record.scheduledBy)
    ?? asRecord(record.createdBy);
  const meeting = asRecord(record.meeting)
    ?? asRecord(record.onlineMeeting)
    ?? asRecord(record.teamsMeeting);
  return {
    id,
    title: firstString(record, ['title', 'roundName', 'stageName', 'interviewType']),
    scheduledAt: normalizeKekaScheduledAt(record),
    status: firstString(record, ['status', 'interviewStatus']),
    panel: extractPanel(record),
    meetingUrl: firstString(record, ['meetingUrl', 'teamsMeetingUrl', 'onlineMeetingUrl', 'joinWebUrl', 'interviewLink'])
      ?? firstString(meeting, ['meetingUrl', 'teamsMeetingUrl', 'onlineMeetingUrl', 'joinWebUrl', 'webUrl']),
    meetingId: firstString(record, ['meetingId', 'onlineMeetingId'])
      ?? firstString(meeting, ['id', 'meetingId', 'onlineMeetingId']),
    organizerEmail: firstString(record, ['organizerEmail', 'meetingOrganizerEmail', 'scheduledByEmail'])
      ?? (/@/.test(getRequiredString(record.scheduledBy)) ? getRequiredString(record.scheduledBy) : undefined)
      ?? firstString(organizer, ['email', 'emailId', 'officialEmail', 'userPrincipalName']),
    organizerUserId: firstString(record, ['organizerUserId', 'organizerId', 'scheduledById'])
      ?? firstString(organizer, ['id', 'userId', 'employeeId']),
  };
}

async function getKekaCredentials(): Promise<KekaCredentials> {
  if (cachedKekaCredentials && cachedKekaCredentials.expiresAt > Date.now()) return cachedKekaCredentials.value;

  let payload: KekaRecord = {};
  const secretId = getRequiredString(process.env.KEKA_SECRET_ARN);
  if (secretId) {
    try {
      const response = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));
      payload = JSON.parse(response.SecretString || '{}') as KekaRecord;
    } catch {
      throw new KekaIntegrationError('Keka credentials could not be read from AWS Secrets Manager.');
    }
  }

  const credentials: KekaCredentials = {
    baseUrl: getRequiredString(payload.baseUrl || payload.KEKA_BASE_URL || process.env.KEKA_BASE_URL),
    clientId: getRequiredString(payload.clientId || payload.KEKA_CLIENT_ID || process.env.KEKA_CLIENT_ID),
    clientSecret: getRequiredString(payload.clientSecret || payload.KEKA_CLIENT_SECRET || process.env.KEKA_CLIENT_SECRET),
    apiKey: getRequiredString(payload.apiKey || payload.KEKA_API_KEY || process.env.KEKA_API_KEY),
    scope: getRequiredString(payload.scope || payload.KEKA_SCOPE || process.env.KEKA_SCOPE) || 'kekaapi',
  };
  credentials.baseUrl = normalizeKekaBaseUrl(credentials.baseUrl);
  if (!credentials.clientId || !credentials.clientSecret || !credentials.apiKey) {
    throw new KekaIntegrationError('Keka credentials must include client ID, client secret, and API key.');
  }
  cachedKekaCredentials = { value: credentials, expiresAt: Date.now() + 15 * 60 * 1000 };
  return credentials;
}

function normalizeTranscript(vtt: string): string {
  const lines = vtt
    .replace(/^WEBVTT\s*/i, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^\d+$/.test(line)) return false;
      if (/^\d{2}:\d{2}:\d{2}[.,]\d{3}\s+-->/.test(line)) return false;
      if (/^(NOTE|STYLE|REGION)\b/i.test(line)) return false;
      return true;
    })
    .map((line) => line.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  return Array.from(new Set(lines)).join('\n').trim();
}

export class MicrosoftGraphTeamsIntegration implements TeamsIntegration {
  private accessToken?: { value: string; expiresAt: number };

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) {
      return this.accessToken.value;
    }

    const credentials = await getTeamsGraphCredentials();
    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`;
    const form = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });

    let response: Response;
    try {
      response = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch {
      throw new TeamsIntegrationError('Microsoft identity service could not be reached. Please try again shortly.');
    }

    if (!response.ok) {
      throw new TeamsIntegrationError('Microsoft Graph credentials were rejected. Verify the client secret and tenant configuration.');
    }

    const payload = await response.json() as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new TeamsIntegrationError('Microsoft identity service did not return an access token.');
    }

    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 3600) - 120) * 1000,
    };
    return this.accessToken.value;
  }

  private async graphGet(
    path: string,
    accept = 'application/json',
    forbiddenMessage = 'Microsoft Graph denied access. Verify application permissions and the Teams Application Access Policy for this meeting organiser.',
    /**
     * True when a failure of THIS call means "the Teams transcript is not
     * obtainable" — which is exactly the condition the recording + AWS Transcribe
     * fallback exists for. Passed only by the transcript-specific calls, never by
     * meeting resolution: if we cannot identify the meeting we cannot identify its
     * recording either, so falling back there would transcribe the wrong thing.
     */
    transcriptUnobtainableAllowsRecording = false,
  ): Promise<Response> {
    const token = await this.getAccessToken();
    let response: Response;
    try {
      response = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: accept },
      });
    } catch {
      throw new TeamsIntegrationError('Microsoft Graph could not be reached. Please try again shortly.');
    }

    if (response.ok) return response;
    if (response.status === 401) {
      throw new TeamsIntegrationError('Microsoft Graph rejected the configured application credentials.');
    }
    if (response.status === 403) {
      // A denial on the transcript endpoints is the clearest possible case of
      // "Microsoft Graph cannot provide it" — which is what the UI promises will
      // trigger the recording route. Transcript and recording are separate Graph
      // permissions (OnlineMeetingTranscript.Read.All vs
      // OnlineMeetingRecording.Read.All), so being refused one says nothing about
      // the other; and if the recording is refused too, that attempt fails with
      // its own message. Previously only a 404 allowed the fallback, so a tenant
      // whose transcript permission was missing never reached AWS Transcribe at
      // all — the exact symptom this parameter was added to prevent.
      throw new TeamsIntegrationError(forbiddenMessage, transcriptUnobtainableAllowsRecording);
    }
    if (response.status === 404) {
      throw new TeamsIntegrationError(
        'The Teams meeting or transcript was not found. It may not be available yet.',
        transcriptUnobtainableAllowsRecording,
      );
    }
    throw new TeamsIntegrationError('Microsoft Graph could not retrieve the meeting transcript.');
  }

  private async resolveOrganizerUserId(input: {
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<string> {
    const suppliedUserId = getRequiredString(input.organizerUserId);
    const email = getRequiredString(input.organizerEmail);

    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedUserId)) {
      if (!email) {
        const response = await this.graphGet(
          `/users/${encodeURIComponent(suppliedUserId)}?$select=id,mail,userPrincipalName`,
          'application/json',
          'Microsoft Graph could not validate the meeting organiser. Verify the Teams Application Access Policy.',
        );
        await response.json() as { id?: string; mail?: string; userPrincipalName?: string };
      }
      return suppliedUserId;
    }

    const identity = email || suppliedUserId;
    if (!identity) {
      throw new TeamsIntegrationError('Teams sync needs the meeting organiser ID or email from the interview schedule.');
    }

    const response = await this.graphGet(
      `/users/${encodeURIComponent(identity)}?$select=id`,
      'application/json',
      'Microsoft Graph could not resolve the meeting organiser. Verify the organiser email and grant the User.ReadBasic.All application permission.',
    );
    const user = await response.json() as { id?: string };
    if (!user.id) {
      throw new TeamsIntegrationError('Microsoft Graph returned no user ID for the meeting organiser. Verify the organiser email.');
    }

    return user.id;
  }

  private calendarSearchTerms(input: {
    candidateName?: string;
    candidateEmail?: string;
    jobTitle?: string;
  }): string[] {
    const words = [
      ...getRequiredString(input.candidateName).split(/\s+/),
      ...getRequiredString(input.jobTitle).split(/\s+/),
      getRequiredString(input.candidateEmail),
    ];
    return Array.from(new Set(words
      .map((word) => word.toLowerCase().replace(/[^a-z0-9@._-]/g, ''))
      .filter((word) => word.length >= 3)));
  }

  private graphDateToMs(dateTime?: string, timeZone?: string): number | undefined {
    const value = getRequiredString(dateTime);
    if (!value) return undefined;
    if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }

    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/);
    if (!match) {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? undefined : parsed;
    }

    const offset = timezoneOffsetMinutes(timeZone);
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] || 0),
    ) - offset * 60 * 1000;
  }

  private scoreCalendarEvent(event: GraphCalendarEvent, input: {
    scheduledAt: Date;
    candidateName?: string;
    candidateEmail?: string;
    jobTitle?: string;
  }): number {
    const subject = getRequiredString(event.subject).toLowerCase();
    const attendees = (event.attendees || [])
      .map((attendee) => getRequiredString(attendee.emailAddress?.address).toLowerCase())
      .filter(Boolean);
    const terms = this.calendarSearchTerms(input);
    let score = 0;

    for (const term of terms) {
      if (subject.includes(term)) score += 2;
      if (attendees.some((address) => address.includes(term))) score += 3;
    }

    const candidateEmail = getRequiredString(input.candidateEmail).toLowerCase();
    if (candidateEmail && attendees.includes(candidateEmail)) score += 8;

    const startMs = this.graphDateToMs(event.start?.dateTime, event.start?.timeZone);
    if (startMs !== undefined) {
      const diffMinutes = Math.abs(startMs - input.scheduledAt.getTime()) / 60000;
      if (diffMinutes <= 20) score += 6;
      else if (diffMinutes <= 60) score += 3;
      else if (diffMinutes <= 180) score += 1;
    }

    return score;
  }

  private hasCandidateEvidence(event: GraphCalendarEvent, input: {
    candidateName?: string;
    candidateEmail?: string;
  }): boolean {
    const candidateEmail = getRequiredString(input.candidateEmail).toLowerCase();
    const candidateName = getRequiredString(input.candidateName).toLowerCase().replace(/\s+/g, ' ');
    const subject = getRequiredString(event.subject).toLowerCase().replace(/\s+/g, ' ');
    const attendees = (event.attendees || []).map((attendee) => ({
      email: getRequiredString(attendee.emailAddress?.address).toLowerCase(),
      name: getRequiredString(attendee.emailAddress?.name).toLowerCase().replace(/\s+/g, ' '),
    }));

    if (candidateEmail && attendees.some((attendee) => attendee.email === candidateEmail)) return true;
    const nameTokens = candidateName.split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
    if (nameTokens.length < 2) return false;
    const containsEveryNameToken = (value: string) => {
      const valueTokens = new Set(value.split(/[^a-z0-9]+/).filter(Boolean));
      return nameTokens.every((token) => valueTokens.has(token));
    };
    return containsEveryNameToken(subject) || attendees.some((attendee) => containsEveryNameToken(attendee.name));
  }

  private isWithinCalendarTolerance(event: GraphCalendarEvent, scheduledAt: Date): boolean {
    const startMs = this.graphDateToMs(event.start?.dateTime, event.start?.timeZone);
    if (startMs === undefined) return false;
    return Math.abs(startMs - scheduledAt.getTime()) <= 3 * 60 * 60 * 1000;
  }

  private async findMeetingUrlFromCalendar(input: {
    userId: string;
    scheduledAt?: string;
    candidateName?: string;
    candidateEmail?: string;
    jobTitle?: string;
  }): Promise<string | undefined> {
    const scheduledAt = new Date(getRequiredString(input.scheduledAt));
    if (Number.isNaN(scheduledAt.getTime())) return undefined;

    const startDateTime = new Date(scheduledAt.getTime() - 12 * 60 * 60 * 1000).toISOString();
    const endDateTime = new Date(scheduledAt.getTime() + 12 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      startDateTime,
      endDateTime,
      '$select': 'id,subject,start,end,onlineMeeting,onlineMeetingUrl,webLink,attendees',
      '$top': '50',
    });

    const response = await this.graphGet(
      `/users/${encodeURIComponent(input.userId)}/calendarView?${params.toString()}`,
      'application/json',
      'Microsoft Graph could not read the organiser calendar. Verify Calendars.Read application permission and that the organiser is accessible to this application.',
    );
    const payload = await response.json() as { value?: GraphCalendarEvent[] };
    const teamsEvents = (payload.value || [])
      .map((event) => ({
        event,
        joinUrl: getRequiredString(event.onlineMeeting?.joinUrl) || getRequiredString(event.onlineMeetingUrl),
      }))
      .filter((entry) => entry.joinUrl);

    if (!teamsEvents.length) return undefined;
    const candidateEvents = teamsEvents.filter((entry) => (
      this.hasCandidateEvidence(entry.event, input)
      && this.isWithinCalendarTolerance(entry.event, scheduledAt)
    ));
    if (!candidateEvents.length) {
      throw new TeamsIntegrationError('No Teams meeting with this candidate was found around the Keka interview time. Add the exact Teams meeting link in Keka or verify the candidate attendee details.');
    }
    if (candidateEvents.length === 1) return candidateEvents[0].joinUrl;

    const scored = candidateEvents
      .map((entry) => ({
        ...entry,
        score: this.scoreCalendarEvent(entry.event, {
          scheduledAt,
          candidateName: input.candidateName,
          candidateEmail: input.candidateEmail,
          jobTitle: input.jobTitle,
        }),
      }))
      .sort((left, right) => right.score - left.score);

    if (scored[0].score > 0 && scored[0].score > scored[1].score) {
      return scored[0].joinUrl;
    }

    throw new TeamsIntegrationError('Multiple Teams meetings were found around this Keka interview time. Add the exact Teams meeting link in Keka, or use a schedule with a unique Teams meeting.');
  }

  private async resolveMeeting(input: {
    meetingUrl?: string;
    meetingId?: string;
    scheduledAt?: string;
    candidateName?: string;
    candidateEmail?: string;
    jobTitle?: string;
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<{ meetingId: string; organizerUserId: string }> {
    const organizerUserId = await this.resolveOrganizerUserId(input);
    const userId = encodeURIComponent(organizerUserId);
    let meetingId = input.meetingId;
    let meetingUrl = input.meetingUrl;
    if (!meetingId && !meetingUrl) {
      meetingUrl = await this.findMeetingUrlFromCalendar({
        userId: organizerUserId,
        scheduledAt: input.scheduledAt,
        candidateName: input.candidateName,
        candidateEmail: input.candidateEmail,
        jobTitle: input.jobTitle,
      });
    }

    if (!meetingId) {
      if (!meetingUrl) {
        throw new TeamsIntegrationError('Microsoft Graph could not find a Teams meeting for this Keka interview schedule. Confirm the organiser, meeting time, and Teams meeting link in Keka.');
      }

      const filter = new URLSearchParams({
        '$filter': `JoinWebUrl eq '${meetingUrl.replace(/'/g, "''")}'`,
        '$select': 'id,joinWebUrl',
      });
      const meetingResponse = await this.graphGet(`/users/${userId}/onlineMeetings?${filter.toString()}`);
      const meetings = await meetingResponse.json() as { value?: Array<{ id?: string }> };
      meetingId = meetings.value?.[0]?.id;
    }

    if (!meetingId) {
      throw new TeamsIntegrationError('Microsoft Graph could not resolve this Teams meeting for the authorised organiser.');
    }

    return { meetingId, organizerUserId };
  }

  async getTranscript(input: {
    meetingUrl?: string;
    meetingId?: string;
    scheduledAt?: string;
    candidateName?: string;
    candidateEmail?: string;
    jobTitle?: string;
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<{ rawText: string; meetingId?: string; organizerUserId?: string }> {
    const { meetingId, organizerUserId } = await this.resolveMeeting(input);
    const userId = encodeURIComponent(organizerUserId);
    const encodedMeetingId = encodeURIComponent(meetingId);
    const transcriptResponse = await this.graphGet(
      `/users/${userId}/onlineMeetings/${encodedMeetingId}/transcripts?$select=id,createdDateTime`,
      'application/json',
      'Microsoft Graph denied access to the Teams transcript. Verify transcript permissions and the Teams Application Access Policy.',
      true,
    );
    const transcripts = await transcriptResponse.json() as { value?: Array<{ id?: string; createdDateTime?: string }> };
    const transcript = [...(transcripts.value || [])]
      .filter((entry) => entry.id)
      .sort((left, right) => String(right.createdDateTime || '').localeCompare(String(left.createdDateTime || '')))[0];

    if (!transcript?.id) {
      throw new TeamsIntegrationError('No Teams transcript is available for this meeting yet. Confirm transcription has finished and try again.', true);
    }

    const contentResponse = await this.graphGet(
      `/users/${userId}/onlineMeetings/${encodedMeetingId}/transcripts/${encodeURIComponent(transcript.id)}/content`,
      'text/vtt',
      'Microsoft Graph denied access to download the Teams transcript. Verify transcript permissions and the Teams Application Access Policy.',
      true,
    );
    const rawText = normalizeTranscript(await contentResponse.text());
    if (!rawText) {
      throw new TeamsIntegrationError('Microsoft Teams returned an empty transcript. Please confirm the meeting transcript is ready.', true);
    }

    return { rawText, meetingId, organizerUserId };
  }

  async getRecording(input: {
    meetingUrl?: string;
    meetingId?: string;
    scheduledAt?: string;
    candidateName?: string;
    candidateEmail?: string;
    jobTitle?: string;
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<{
    stream: Readable;
    contentType: string;
    extension: string;
    recordingId: string;
    contentLength?: number;
    meetingId?: string;
    organizerUserId?: string;
    createdDateTime?: string;
  }> {
    const { meetingId, organizerUserId } = await this.resolveMeeting(input);
    const userId = encodeURIComponent(organizerUserId);
    const encodedMeetingId = encodeURIComponent(meetingId);
    const recordingResponse = await this.graphGet(
      `/users/${userId}/onlineMeetings/${encodedMeetingId}/recordings?$select=id,createdDateTime`,
      'application/json',
      'Microsoft Graph denied access to the Teams recording. Verify OnlineMeetingRecording.Read.All and the Teams Application Access Policy for this organiser.',
    );
    const recordings = await recordingResponse.json() as { value?: Array<{ id?: string; createdDateTime?: string }> };
    const recording = [...(recordings.value || [])]
      .filter((entry) => entry.id)
      .sort((left, right) => String(right.createdDateTime || '').localeCompare(String(left.createdDateTime || '')))[0];

    if (!recording?.id) {
      throw new TeamsIntegrationError('No Teams recording is available for this meeting yet. Confirm the recording has finished processing and try again.');
    }

    const contentResponse = await this.graphGet(
      `/users/${userId}/onlineMeetings/${encodedMeetingId}/recordings/${encodeURIComponent(recording.id)}/content`,
      'application/octet-stream',
      'Microsoft Graph denied access to download the Teams recording. Verify recording permissions and the Teams Application Access Policy.',
    );
    const contentType = contentResponse.headers.get('content-type') || 'video/mp4';
    const extension = contentType.includes('webm') ? 'webm'
      : contentType.includes('quicktime') || contentType.includes('m4a') ? 'm4a'
        : contentType.includes('mpeg') || contentType.includes('mp3') ? 'mp3'
          : contentType.includes('wav') ? 'wav'
            : 'mp4';
    if (!contentResponse.body) {
      throw new TeamsIntegrationError('Microsoft Teams returned an empty recording file. Please confirm the meeting recording is ready.');
    }
    const contentLengthHeader = Number(contentResponse.headers.get('content-length'));
    const contentLength = Number.isFinite(contentLengthHeader) && contentLengthHeader > 0
      ? contentLengthHeader
      : undefined;

    return {
      stream: Readable.fromWeb(contentResponse.body as any),
      contentType,
      extension,
      recordingId: recording.id,
      contentLength,
      meetingId,
      organizerUserId,
      createdDateTime: recording.createdDateTime,
    };
  }
}

export class KekaHireIntegration implements KekaIntegration {
  private accessToken?: { value: string; expiresAt: number };
  private readonly employeeEmailsById = new Map<string, string | null>();
  private readonly employeeEmailsByName = new Map<string, string | null>();
  /**
   * Set once the HRIS employee directory answers with a denial, so the rest of
   * the run stops asking. Readable by the sweep, which reports it as the reason
   * some rounds could not be indexed.
   */
  private panelEmailLookupDenied?: string;

  /** Why panel emails could not be resolved this run, if they could not. */
  get panelEmailLookupError(): string | undefined {
    return this.panelEmailLookupDenied;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > Date.now()) return this.accessToken.value;

    const credentials = await getKekaCredentials();
    const form = new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      api_key: credentials.apiKey,
      scope: credentials.scope,
      grant_type: 'kekaapi',
    });
    let response: Response;
    try {
      response = await fetch('https://login.keka.com/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      });
    } catch {
      throw new KekaIntegrationError('Keka authentication service could not be reached. Please try again shortly.');
    }
    if (!response.ok) {
      throw new KekaIntegrationError('Keka rejected the configured credentials. Verify the client ID, client secret, API key, and approved Hire privileges.');
    }
    const payload = await response.json() as { access_token?: string; expires_in?: number };
    if (!payload.access_token) throw new KekaIntegrationError('Keka authentication did not return an access token.');
    this.accessToken = {
      value: payload.access_token,
      expiresAt: Date.now() + Math.max(60, Number(payload.expires_in || 3600) - 120) * 1000,
    };
    return this.accessToken.value;
  }

  private async get(
    path: string,
    unavailableMessage: string,
    forbiddenMessage = 'Keka denied access to this Hire resource. Confirm the API application has the required Job, Candidate, Interview, and Resume read privileges.',
  ): Promise<unknown> {
    const [credentials, token] = await Promise.all([getKekaCredentials(), this.getAccessToken()]);
    let response: Response;
    try {
      response = await fetch(`${credentials.baseUrl}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
    } catch {
      throw new KekaIntegrationError('Keka Hire could not be reached. Please try again shortly.', 'unreachable');
    }
    if (response.ok) return response.json();
    if (response.status === 401) throw new KekaIntegrationError('Keka rejected the configured credentials. Please verify the API application configuration.', 'denied');
    if (response.status === 403) throw new KekaIntegrationError(forbiddenMessage, 'denied');
    if (response.status === 404) throw new KekaIntegrationError(unavailableMessage, 'absent');
    throw new KekaIntegrationError('Keka Hire could not retrieve the requested data. Please try again shortly.', 'unusable');
  }

  private async listPage(path: string, unavailableMessage: string, forbiddenMessage?: string): Promise<KekaRecord[]> {
    return listFromKekaPage(await this.get(path, unavailableMessage, forbiddenMessage));
  }

  /**
   * Fills in panel emails that Keka Hire did not include, from the HRIS employee
   * directory.
   *
   * Hire returns interviewers as {id, name}; the email lives in HRIS, behind a
   * separate privilege (HRIS Employees Read). That privilege is genuinely optional
   * to this call — some tenants put the email on the Hire payload directly, and
   * those interviews need no lookup at all.
   *
   * So a denial degrades rather than throwing. It used to propagate out of
   * listInterviews and abort the entire schedule sweep, which threw away every
   * interview in the run INCLUDING the ones whose emails Hire had already
   * supplied. The caller decides what an unresolved panel means; here we resolve
   * what we can, remember the denial so the remaining batches stop re-requesting
   * it, and let `panelEmailLookupDenied` tell the sweep why some rounds have no
   * addresses.
   */
  private async hydratePanelEmails(interviews: KekaScheduledInterview[]): Promise<KekaScheduledInterview[]> {
    const unresolvedIds = Array.from(new Set(
      interviews.flatMap((interview) => interview.panel)
        .filter((member) => !member.email)
        .map((member) => getRequiredString(member.interviewerId))
        .filter((id) => id && !id.startsWith('keka-panel-') && !this.employeeEmailsById.has(id)),
    ));

    for (let offset = 0; offset < unresolvedIds.length && !this.panelEmailLookupDenied; offset += 100) {
      const ids = unresolvedIds.slice(offset, offset + 100);
      let rows: KekaRecord[];
      try {
        rows = await this.listPage(
          `/api/v1/hris/employees?employeeIds=${ids.map(encodeURIComponent).join(',')}&pageNumber=1&pageSize=200`,
          'Keka could not find employee records for the interview panel.',
          PANEL_EMAIL_PERMISSION_MESSAGE,
        );
      } catch (err) {
        // Only Keka's own "no" is tolerated. An unreachable host or an unusable
        // response is not evidence that the directory is off-limits, so it still
        // propagates and the run retries later rather than recording a phantom
        // permission gap and quietly giving up on emails it could have read.
        if (!(err instanceof KekaIntegrationError) || (err.kind !== 'denied' && err.kind !== 'absent')) throw err;
        this.panelEmailLookupDenied = err.message;
        console.warn('[Keka] Panel email lookup unavailable; continuing with Hire-supplied emails only:', err.message);
        break;
      }
      const emails = new Map(rows.map((row) => [
        firstString(row, ['id', 'employeeId', 'employee_id']),
        employeeEmail(row),
      ]).filter((entry): entry is [string, string] => !!entry[0] && !!entry[1]));

      for (const id of ids) {
        this.employeeEmailsById.set(id, emails.get(id) || null);
      }
    }

    const unresolvedNames = Array.from(new Set(
      interviews.flatMap((interview) => interview.panel)
        .filter((member) => {
          if (member.email) return false;
          const byId = this.employeeEmailsById.get(getRequiredString(member.interviewerId));
          return !byId;
        })
        .map((member) => member.name)
        .map(normalizePersonName)
        .filter((name) => name && !this.employeeEmailsByName.has(name)),
    ));

    for (const normalizedName of unresolvedNames) {
      if (this.panelEmailLookupDenied) break;
      const member = interviews.flatMap((interview) => interview.panel)
        .find((panelist) => normalizePersonName(panelist.name) === normalizedName);
      if (!member) continue;
      try {
        const rows = await this.listPage(
          `/api/v1/hris/employees?searchKey=${encodeURIComponent(member.name)}&pageNumber=1&pageSize=5`,
          'Keka could not find employee records for the interview panel.',
          PANEL_EMAIL_PERMISSION_MESSAGE,
        );
        this.employeeEmailsByName.set(normalizedName, exactSingleEmployeeEmail(rows, member.name));
      } catch (err) {
        if (!(err instanceof KekaIntegrationError) || (err.kind !== 'denied' && err.kind !== 'absent')) throw err;
        this.panelEmailLookupDenied = err.message;
        console.warn('[Keka] Panel email lookup unavailable; continuing with Hire-supplied emails only:', err.message);
        break;
      }
    }

    return interviews.map((interview) => ({
      ...interview,
      panel: interview.panel.map((member) => ({
        ...member,
        email: member.email
          || this.employeeEmailsById.get(getRequiredString(member.interviewerId))
          || this.employeeEmailsByName.get(normalizePersonName(member.name))
          || undefined,
      })),
    }));
  }

  async listJobs(): Promise<KekaJob[]> {
    const rows = await this.listPage('/api/v1/hire/jobs?pageNumber=1&pageSize=200', 'Keka could not find any Hire jobs.');
    return rows.map(toKekaJob).sort((left, right) => left.title.localeCompare(right.title));
  }

  async listCandidates(jobId: string): Promise<KekaCandidate[]> {
    const safeJobId = encodeURIComponent(getRequiredString(jobId));
    if (!safeJobId) throw new KekaIntegrationError('Choose a Keka job before loading candidates.');
    const rows = await this.listPage(`/api/v1/hire/jobs/${safeJobId}/candidates?pageNumber=1&pageSize=200`, 'Keka could not find candidates for this job.');
    const candidates = rows.map(toKekaCandidate).filter((candidate): candidate is KekaCandidate => !!candidate);
    if (rows.length > 0 && candidates.length === 0) {
      throw new KekaIntegrationError('Keka returned candidate records without usable candidate details for this role.');
    }
    return candidates.sort((left, right) => left.name.localeCompare(right.name));
  }

  async listInterviews(jobId: string, candidateId: string): Promise<KekaScheduledInterview[]> {
    const safeJobId = encodeURIComponent(getRequiredString(jobId));
    const safeCandidateId = encodeURIComponent(getRequiredString(candidateId));
    if (!safeJobId || !safeCandidateId) throw new KekaIntegrationError('Choose both a Keka job and candidate before loading interviews.');
    const rows = await this.listPage(`/api/v1/hire/jobs/${safeJobId}/candidate/${safeCandidateId}/interviews?pageNumber=1&pageSize=100`, 'Keka could not find scheduled interviews for this candidate.');
    const interviews = rows.map(toKekaInterview);
    const hydrated = await this.hydratePanelEmails(interviews);
    return hydrated.sort((left, right) => String(right.scheduledAt || '').localeCompare(String(left.scheduledAt || '')));
  }

  private async getCandidateResumeText(candidateId: string): Promise<string> {
    const safeCandidateId = encodeURIComponent(getRequiredString(candidateId));
    if (!safeCandidateId) throw new KekaIntegrationError('Choose a Keka candidate before loading the resume.');
    const payload = await this.get(
      `/api/v1/hire/jobs/candidate/${safeCandidateId}/resume?pageNumber=1&pageSize=100`,
      'Keka could not find a resume for this candidate.',
    );
    const resumeText = resumeTextFromKeka(payload);
    if (!resumeText) {
      throw new KekaIntegrationError('Keka did not return readable resume details for this candidate. Confirm CandidateResume Read access and that a resume is attached in Keka.');
    }
    return resumeText;
  }

  async getInterviewData(input: { jobId?: string; candidateId?: string; interviewId?: string }): Promise<{
    job: InterviewIntelligenceRecord['job'];
    candidate: InterviewIntelligenceRecord['candidate'];
    panel: InterviewIntelligenceRecord['panel'];
    meetingUrl?: string;
    meetingId?: string;
    scheduledAt?: string;
    organizerUserId?: string;
    organizerEmail?: string;
    kekaMeetingTitle?: string;
  }> {
    const jobId = getRequiredString(input.jobId);
    const candidateId = getRequiredString(input.candidateId);
    if (!jobId || !candidateId) {
      throw new KekaIntegrationError('Choose the Keka job and candidate before creating an interview workspace.');
    }

    const [jobs, candidates, interviews, resumeText] = await Promise.all([
      this.listJobs(),
      this.listCandidates(jobId),
      this.listInterviews(jobId, candidateId),
      this.getCandidateResumeText(candidateId),
    ]);
    const job = jobs.find((entry) => entry.id === jobId);
    const candidate = candidates.find((entry) => entry.id === candidateId);
    if (!job || !candidate) throw new KekaIntegrationError('The selected Keka job or candidate is no longer available. Refresh the selection and try again.');
    const interview = getRequiredString(input.interviewId)
      ? interviews.find((entry) => entry.id === getRequiredString(input.interviewId))
      : interviews[0];
    if (!interview) throw new KekaIntegrationError('No scheduled Keka interview was found for this candidate.');

    const jobRow = (await this.listPage('/api/v1/hire/jobs?pageNumber=1&pageSize=200', 'Keka could not load the selected job.')).find((entry) => firstString(entry, ['id', 'jobId']) === jobId);
    const description = cleanKekaText(firstString(jobRow, ['description', 'jobDescription', 'summary']) || '');
    if (!description) throw new KekaIntegrationError('The selected Keka job has no job description. Add the description in Keka before creating the workspace.');

    return {
      job: {
        title: job.title,
        description,
        seniority: job.experience,
        requiredSkills: [],
        preferredSkills: [],
      },
      candidate: {
        name: candidate.name,
        email: candidate.email,
        resumeText,
        experienceSummary: resumeText.slice(0, 600),
      },
      panel: interview.panel,
      meetingUrl: interview.meetingUrl,
      meetingId: interview.meetingId,
      scheduledAt: interview.scheduledAt,
      organizerEmail: interview.organizerEmail,
      organizerUserId: interview.organizerUserId,
      kekaMeetingTitle: interview.title,
    };
  }
}

export class ManualIntegration implements KekaIntegration, TeamsIntegration {
  async listJobs(): Promise<KekaJob[]> { return []; }
  async listCandidates(): Promise<KekaCandidate[]> { return []; }
  async listInterviews(): Promise<KekaScheduledInterview[]> { return []; }

  async getInterviewData(): Promise<{
    job: InterviewIntelligenceRecord['job'];
    candidate: InterviewIntelligenceRecord['candidate'];
    panel: InterviewIntelligenceRecord['panel'];
  }> {
    return {
      job: { title: '', description: '', requiredSkills: [] },
      candidate: { name: '' },
      panel: [],
    };
  }

  async getTranscript(): Promise<{ rawText: string }> {
    return { rawText: '' };
  }

  async getRecording(): Promise<{
    stream: Readable;
    contentType: string;
    extension: string;
    recordingId: string;
    contentLength?: number;
  }> {
    return {
      stream: Readable.from(Buffer.alloc(0)),
      contentType: 'video/mp4',
      extension: 'mp4',
      recordingId: 'manual-recording',
    };
  }
}

export function createKekaIntegration(mode: string | undefined): KekaIntegration {
  if (mode === 'live') return new KekaHireIntegration();
  return new ManualIntegration();
}

export function createTeamsIntegration(mode: string | undefined): TeamsIntegration {
  if (mode === 'live') return new MicrosoftGraphTeamsIntegration();
  return new ManualIntegration();
}
