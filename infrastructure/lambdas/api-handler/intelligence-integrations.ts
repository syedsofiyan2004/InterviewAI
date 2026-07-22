import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export type IntelligenceSourceMode = 'manual' | 'mock_keka' | 'keka_live' | 'teams_live';
export type IntegrationMode = 'mock' | 'disabled' | 'live';
export type IntelligenceStatus =
  | 'draft'
  | 'data_ready'
  | 'questions_generated'
  | 'transcript_ready'
  | 'scores_submitted'
  | 'analysis_generated'
  | 'approved';

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
  created_at: number;
  updated_at: number;
  source_mode: IntelligenceSourceMode;
  status: IntelligenceStatus;
  keka: {
    mode: IntegrationMode;
    jobId?: string;
    candidateId?: string;
    interviewId?: string;
    syncStatus: 'not_connected' | 'mocked' | 'synced' | 'failed';
    lastSyncAt?: number;
    error?: string;
  };
  teams: {
    mode: IntegrationMode;
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
      skillScores: Array<{
        skill: string;
        score: number;
        evidence: string;
      }>;
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
      outliers: Array<{
        interviewerId: string;
        name: string;
        score: number;
        reason: string;
      }>;
      summary: string;
      humanReviewRequired: boolean;
    };
    finalReport: string;
  };
  approved?: {
    approvedBy: string;
    approvedAt: number;
    notes?: string;
  };
}

export interface KekaIntegration {
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
    organizerUserId?: string;
    organizerEmail?: string;
  }>;
}

export interface TeamsIntegration {
  getTranscript(input: {
    meetingUrl?: string;
    meetingId?: string;
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<{
    rawText: string;
    meetingId?: string;
    organizerUserId?: string;
  }>;
}

type TeamsGraphCredentials = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
};

const graphClient = new SecretsManagerClient({});
let cachedTeamsCredentials: { value: TeamsGraphCredentials; expiresAt: number } | undefined;

export class TeamsIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamsIntegrationError';
  }
}

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
    const response = await graphClient.send(new GetSecretValueCommand({ SecretId: secretId }));
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
      throw new TeamsIntegrationError(forbiddenMessage);
    }
    if (response.status === 404) {
      throw new TeamsIntegrationError('The Teams meeting or transcript was not found. It may not be available yet.');
    }
    throw new TeamsIntegrationError('Microsoft Graph could not retrieve the meeting transcript.');
  }

  private async resolveOrganizerUserId(input: {
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<string> {
    const suppliedUserId = getRequiredString(input.organizerUserId);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(suppliedUserId)) {
      return suppliedUserId;
    }

    const email = getRequiredString(input.organizerEmail) || suppliedUserId;
    if (!email) {
      throw new TeamsIntegrationError('Teams sync needs the meeting organiser ID or email from the interview schedule.');
    }

    const response = await this.graphGet(
      `/users/${encodeURIComponent(email)}?$select=id`,
      'application/json',
      'Microsoft Graph could not resolve the meeting organiser. Verify the organiser email and grant the User.ReadBasic.All application permission.',
    );
    const user = await response.json() as { id?: string };
    if (!user.id) {
      throw new TeamsIntegrationError('Microsoft Graph returned no user ID for the meeting organiser. Verify the organiser email.');
    }

    return user.id;
  }

  async getTranscript(input: {
    meetingUrl?: string;
    meetingId?: string;
    organizerUserId?: string;
    organizerEmail?: string;
  }): Promise<{ rawText: string; meetingId?: string; organizerUserId?: string }> {
    const organizerUserId = await this.resolveOrganizerUserId(input);
    const userId = encodeURIComponent(organizerUserId);
    let meetingId = input.meetingId;
    if (!meetingId) {
      if (!input.meetingUrl) {
        throw new TeamsIntegrationError('Teams sync needs a meeting link or a Microsoft Graph online meeting ID.');
      }

      const filter = new URLSearchParams({
        '$filter': `JoinWebUrl eq '${input.meetingUrl.replace(/'/g, "''")}'`,
        '$select': 'id,joinWebUrl',
      });
      const meetingResponse = await this.graphGet(`/users/${userId}/onlineMeetings?${filter.toString()}`);
      const meetings = await meetingResponse.json() as { value?: Array<{ id?: string }> };
      meetingId = meetings.value?.[0]?.id;
    }

    if (!meetingId) {
      throw new TeamsIntegrationError('Microsoft Graph could not resolve this Teams meeting for the authorised organiser.');
    }

    const encodedMeetingId = encodeURIComponent(meetingId);
    const transcriptResponse = await this.graphGet(`/users/${userId}/onlineMeetings/${encodedMeetingId}/transcripts?$select=id,createdDateTime`);
    const transcripts = await transcriptResponse.json() as { value?: Array<{ id?: string; createdDateTime?: string }> };
    const transcript = [...(transcripts.value || [])]
      .filter((entry) => entry.id)
      .sort((left, right) => String(right.createdDateTime || '').localeCompare(String(left.createdDateTime || '')))[0];

    if (!transcript?.id) {
      throw new TeamsIntegrationError('No Teams transcript is available for this meeting yet. Confirm transcription has finished and try again.');
    }

    const contentResponse = await this.graphGet(
      `/users/${userId}/onlineMeetings/${encodedMeetingId}/transcripts/${encodeURIComponent(transcript.id)}/content`,
      'text/vtt',
    );
    const rawText = normalizeTranscript(await contentResponse.text());
    if (!rawText) {
      throw new TeamsIntegrationError('Microsoft Teams returned an empty transcript. Please confirm the meeting transcript is ready.');
    }

    return { rawText, meetingId, organizerUserId };
  }
}

export class MockKekaIntegration implements KekaIntegration {
  async getInterviewData(): Promise<{
    job: InterviewIntelligenceRecord['job'];
    candidate: InterviewIntelligenceRecord['candidate'];
    panel: InterviewIntelligenceRecord['panel'];
    meetingUrl?: string;
  }> {
    return {
      job: {
        title: 'Senior AWS Platform Engineer',
        seniority: 'Senior',
        description:
          'Own AWS landing-zone delivery, Terraform modules, CI/CD automation, production operations, IAM design, observability, and incident response for customer cloud platforms.',
        requiredSkills: ['AWS', 'Terraform', 'IAM', 'CI/CD', 'Observability', 'Incident response'],
        preferredSkills: ['Kubernetes', 'Python automation', 'Cost optimization'],
      },
      candidate: {
        name: 'Aarav Mehta',
        email: 'aarav.mehta@example.com',
        resumeText:
          'Cloud engineer with 7 years of AWS experience, Terraform module ownership, GitHub Actions pipelines, IAM guardrails, CloudWatch dashboards, and production incident rotation.',
        experienceSummary: '7 years in AWS platform engineering and infrastructure automation.',
      },
      panel: [
        {
          interviewerId: 'panel-1',
          name: 'Priya Raman',
          email: 'priya.raman@example.com',
          role: 'Cloud Architect',
          focusArea: 'AWS architecture',
        },
        {
          interviewerId: 'panel-2',
          name: 'Nikhil Shah',
          email: 'nikhil.shah@example.com',
          role: 'DevOps Lead',
          focusArea: 'Terraform and CI/CD',
        },
      ],
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/mock-interview',
    };
  }
}

export class MockTeamsIntegration implements TeamsIntegration {
  async getTranscript(): Promise<{ rawText: string; meetingId?: string }> {
    return {
      meetingId: 'mock-teams-meeting-001',
      rawText:
        'Priya: Can you walk us through how you design a secure multi-account AWS landing zone? Aarav: I start with account boundaries, SCP guardrails, IAM Identity Center, centralized logging, and network segmentation. Priya: How would you handle production incident response? Aarav: I define severity, use CloudWatch alarms, runbooks, rollback plans, and post-incident reviews. Nikhil: How do you structure Terraform modules for reusable VPC and IAM patterns? Aarav: I keep modules small, versioned, validated in CI, with clear inputs and outputs. Nikhil: What would you do if Terraform state is locked during a release? Aarav: I would identify the active operation, avoid force unlock unless confirmed safe, communicate with the team, and recover from backend logs.',
    };
  }
}

export class ManualIntegration implements KekaIntegration, TeamsIntegration {
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
}

export function createKekaIntegration(mode: string | undefined): KekaIntegration {
  if (mode === 'mock') return new MockKekaIntegration();
  // TODO: Implement live Keka adapter with server-side credentials.
  return new ManualIntegration();
}

export function createTeamsIntegration(mode: string | undefined): TeamsIntegration {
  if (mode === 'mock') return new MockTeamsIntegration();
  if (mode === 'live') return new MicrosoftGraphTeamsIntegration();
  return new ManualIntegration();
}
