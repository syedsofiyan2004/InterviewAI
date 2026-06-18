export type IntelligenceSourceMode = 'manual' | 'mock_keka' | 'keka_live';
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
  }>;
}

export interface TeamsIntegration {
  getTranscript(input: {
    meetingUrl?: string;
    meetingId?: string;
  }): Promise<{
    rawText: string;
    meetingId?: string;
  }>;
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
  // TODO: Implement Microsoft Graph Teams adapter with server-side credentials.
  return new ManualIntegration();
}
