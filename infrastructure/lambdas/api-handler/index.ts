import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { DeleteTranscriptionJobCommand, GetTranscriptionJobCommand, StartTranscriptionJobCommand, TranscribeClient } from '@aws-sdk/client-transcribe';
import { 
  PutCommand, 
  GetCommand, 
  UpdateCommand, 
  ScanCommand,
  DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { 
  ddbDocClient, 
  getFileBuffer,
  getPresignedUploadUrl,
  saveFileContent,
  s3Client,
  validateEnv
} from '../shared/aws';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { 
  errorResponse, 
  successResponse, 
  createdResponse,
  acceptedResponse
} from '../shared/responses';
import { 
  CreateInterviewSchema, 
  UploadUrlSchema,
  ConfirmUploadSchema
} from '../../schema';
import {
  createKekaIntegration,
  createTeamsIntegration,
  KekaIntegrationError,
  TeamsIntegrationError,
  InterviewIntelligenceRecord,
  IntelligencePanelist,
  IntelligenceQuestion,
  ProgressEvent
} from './intelligence-integrations.js';
import { selectQuestionsFromBank, detectInterviewLevel, SelectedBankQuestion } from './manual-question-bank.js';
import {
  queryScheduledForPanelist,
  findScheduledByInterviewId,
  findScheduledWithMeetingByKekaInterviewId,
  claimScheduledProvisioning,
  clearScheduledProvisioning,
  releaseScheduledProvisioning,
  stampScheduledProvisioned,
} from './scheduled-interviews.js';
import { loadRoleBankPool, loadRoleCompetencyOverride, roleKeyForJob } from './question-bank-store.js';
import { isLikelyCompetency, validateCompetencies } from './competencies.js';
import { getMinfyCareerJob, listMinfyCareerJobs } from './minfy-careers.js';
import {
  getMe,
  getAdminOverview,
  adminSearch,
  adminListInterviews,
  adminListMoms,
  adminListCalculations,
  adminListIntelligenceInterviews,
  adminListCandidates,
  getAuditLog,
  adminListMembers,
  adminGetMemberGrants,
  adminGrantTier,
  adminRevokeTier,
  adminChangeBaseRole,
  adminListCognitoUsers,
} from './admin-routes.js';
import {
  listQuestionBankRoles,
  getQuestionBankRole,
  updateQuestionBankRole,
  createQuestionBankItem,
  updateQuestionBankItem,
  deleteQuestionBankItem,
} from './question-bank-routes.js';
import { runKekaScheduleSyncWorker } from './keka-schedule-sync.js';
import {
  createWorkspace,
  listWorkspaces,
  listSharedWithMe,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  addShare,
  removeShare,
  listComments,
  createComment,
  resolveComment,
  linkRecord,
  unlinkRecord,
  getWorkspaceFull,
  adminListApprovals,
  postDecision,
  handleLookupWorkspace,
  generateCompositeAnalysis,
  runCompositeAnalysisWorker,
  ensureCandidateWorkspace,
  unlinkRecordFromWorkspaces,
} from './workspace-routes.js';
import {
  analyzeCalculation,
  createCalculation,
  listCalculations,
  getCalculation,
  getCalculationResult,
  getCalculationUploadUrl,
  getCalculationReport,
  getCalculationWorkbook,
  getCalculationDocument,
  reviseCalculation,
  deleteCalculation,
  getCalculatorReviewCatalog,
  createCalculationProject,
  listCalculationProjects,
  getCalculationProject,
  deleteCalculationProject,
  getCalculationPlan,
  proposeCalculationPlan,
  createCalculationPlanRevision,
  confirmCalculationPlan,
  runCalculationPlan,
} from './calculator-routes.js';
import {
  adminListConversations,
  adminGetConversationThread,
  getChatHistory,
} from './conversation-routes.js';
import { getCallerContext, requireAdminTier, CallerContext } from './authz.js';
import { writeAuditLog } from './audit.js';
import type { AdminTier, AuditAction } from '../../schema/admin.js';

type IntelligenceQuestionPlan = NonNullable<InterviewIntelligenceRecord['questionPlan']>;
type IntelligenceEvaluation = NonNullable<InterviewIntelligenceRecord['aiEvaluation']>;
type IntelligenceCoverageMatrix = IntelligenceEvaluation['coverageMatrix'];
type IntelligenceCaseInterview = NonNullable<InterviewIntelligenceRecord['caseInterview']>;
type CandidateRecommendation = IntelligenceEvaluation['candidateEvaluation']['recommendation'];
type CompetencyRating = NonNullable<IntelligenceEvaluation['candidateEvaluation']['competencyRatings']>[number];
import {
  ConfirmMomUploadSchema,
  CreateMomProjectSchema,
  CreateMomSchema,
  MomResultSchema,
  MomUploadUrlSchema
} from '../../schema/mom.js';
import { markProposalApplied } from '../chat/store.js';
import { ApplyMomEditSchema, chatThreadId, type ApplyMomEdit } from '../../schema/chat.js';
import { generateMomPdfReport } from '../shared/mom-report.js';
import { generateMomDocxReport } from '../shared/mom-docx';
import { generateInterviewPdfReport } from '../processor/index.js';
import { generateIntelligencePdfReport } from '../shared/intelligence-report.js';

validateEnv(['TABLE_NAME', 'BUCKET_NAME', 'QUEUE_URL', 'MOM_TABLE_NAME', 'MOM_QUEUE_URL', 'INTELLIGENCE_TABLE_NAME']);

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const MOM_TABLE_NAME = process.env.MOM_TABLE_NAME!;
const MOM_QUEUE_URL = process.env.MOM_QUEUE_URL!;
const INTELLIGENCE_TABLE_NAME = process.env.INTELLIGENCE_TABLE_NAME!;
const SONNET_5_MODEL_ID = 'global.anthropic.claude-sonnet-5';
const BEDROCK_INTERACTIVE_TIMEOUT_MS = 23_000;
/**
 * Background work is not bound by API Gateway's 29s response ceiling, so the
 * model gets room to actually finish. The interactive limit above was silently
 * aborting every question-guide rewrite mid-flight, which made the UI fall back
 * to raw question-bank wording without telling anyone.
 */
const BEDROCK_BACKGROUND_TIMEOUT_MS = 240_000;
const BEDROCK_QUESTION_GUIDE_TOKENS = 8_000;
const BEDROCK_CASE_TOKENS = 8_000;
const BEDROCK_INTELLIGENCE_REVIEW_TOKENS = 16_000;

const sqsClient = new SQSClient({});
const lambdaClient = new LambdaClient({});
const transcribeClient = new TranscribeClient({});

function anthropicRequestBody(modelId: string, prompt: string, maxTokens: number, temperature = 0) {
  const body: Record<string, unknown> = {
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
  };
  if (!modelId.includes('claude-sonnet-5')) {
    body.temperature = temperature;
  }
  return body;
}

function getBedrockText(payload: any): string {
  if (!Array.isArray(payload?.content)) return '';
  return payload.content
    .filter((block: { type?: string; text?: unknown }) => block.type === 'text' && typeof block.text === 'string')
    .map((block: { text: string }) => block.text)
    .join('\n')
    .trim();
}

function parseTaggedJson<T>(
  rawText: string,
  tagName: string,
  extractJson: (text: string) => string,
  stopReason?: string,
): T {
  const tagged = rawText.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'))?.[1]?.trim();
  const jsonText = tagged || extractJson(rawText);
  if (!jsonText) {
    throw new Error(stopReason === 'max_tokens' ? 'AI_OUTPUT_TRUNCATED' : 'AI_EMPTY_RESPONSE');
  }
  try {
    return JSON.parse(jsonText) as T;
  } catch (error: any) {
    const message = String(error?.message || '');
    if (stopReason === 'max_tokens' || message.includes('Unexpected end')) {
      throw new Error('AI_OUTPUT_TRUNCATED');
    }
    throw new Error(`AI_MALFORMED_OUTPUT: ${message}`);
  }
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if ((event as any).__internalTask === 'intelligence-analysis') {
    return await runIntelligenceAnalysisWorker(String((event as any).intelligenceId || ''));
  }
  if ((event as any).__internalTask === 'intelligence-questions') {
    return await runIntelligenceQuestionsWorker(
      String((event as any).intelligenceId || ''),
      {
        focusAreas: (event as any).focusAreas,
        questionCount: (event as any).questionCount,
      },
    );
  }
  if ((event as any).__internalTask === 'teams-recording-transcription') {
    return await runTeamsRecordingTranscriptionWorker(String((event as any).intelligenceId || ''));
  }
  if ((event as any).__internalTask === 'composite-analysis') {
    return await runCompositeAnalysisWorker(String((event as any).workspaceId || ''));
  }
  if ((event as any).__internalTask === 'keka-schedule-sync') {
    return await runKekaScheduleSyncWorker(String((event as any).triggeredBy || 'internal'));
  }
  const { httpMethod, resource, pathParameters } = event;
  console.log(`Request: ${httpMethod} ${resource} (ID: ${pathParameters?.id || 'N/A'})`);

  try {
    if (httpMethod === 'GET' && resource === '/me') {
      return await getMe(event);
    }

    // --- Context chat ---
    if (httpMethod === 'GET' && resource === '/chat/config') {
      return await getChatConfig(event);
    }
    // Owner-scoped by construction — the thread id is built from the verified caller,
    // so this route takes no user parameter and needs no tier check. See
    // conversation-routes.ts.
    if (httpMethod === 'GET' && resource === '/chat/history') {
      return await getChatHistory(event);
    }

    // --- AWS Cost Calculator (the hub's third app) ---
    // Kept to a handful of lines here; everything else lives in calculator-routes.ts.
    //
    // Projects first, and on their own top-level path rather than under /calculator/...:
    // a nested /calculator/projects would be ambiguous with /calculator/{id} at the
    // gateway, which would route a project list to getCalculation with id='projects'.
    if (resource === '/calculator-projects') {
      if (httpMethod === 'POST') return await createCalculationProject(event);
      if (httpMethod === 'GET') return await listCalculationProjects(event);
    }
    if (httpMethod === 'GET' && resource === '/calculator-projects/{id}') {
      return await getCalculationProject(pathParameters?.id, event);
    }
    if (httpMethod === 'DELETE' && resource === '/calculator-projects/{id}') {
      return await deleteCalculationProject(pathParameters?.id, event);
    }
    if (resource === '/calculator') {
      if (httpMethod === 'POST') return await createCalculation(event);
      if (httpMethod === 'GET') return await listCalculations(event);
    }
    if (httpMethod === 'POST' && resource === '/calculator/analyze') {
      return await analyzeCalculation(event);
    }
    if (httpMethod === 'GET' && resource === '/calculator/plans/{id}') {
      return await getCalculationPlan(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/calculator/plans/{id}/proposals') {
      return await proposeCalculationPlan(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/calculator/plans/{id}/revisions') {
      return await createCalculationPlanRevision(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/calculator/plans/{id}/confirm') {
      return await confirmCalculationPlan(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/calculator/plans/{id}/run') {
      return await runCalculationPlan(pathParameters?.id, event);
    }
    if (httpMethod === 'GET' && resource === '/calculator/runs/{id}') {
      return await getCalculationResult(pathParameters?.id, event);
    }
    if (httpMethod === 'GET' && resource === '/calculator/review-catalog') {
      return await getCalculatorReviewCatalog(event);
    }
    if (httpMethod === 'POST' && resource === '/calculator/upload-url') {
      return await getCalculationUploadUrl(event);
    }
    if (httpMethod === 'GET' && resource === '/calculator/{id}') {
      return await getCalculation(pathParameters?.id, event);
    }
    if (httpMethod === 'GET' && resource === '/calculator/{id}/result') {
      return await getCalculationResult(pathParameters?.id, event);
    }
    if (httpMethod === 'GET' && resource === '/calculator/{id}/report') {
      return await getCalculationReport(pathParameters?.id, event);
    }
    if (httpMethod === 'GET' && resource === '/calculator/{id}/workbook') {
      return await getCalculationWorkbook(pathParameters?.id, event);
    }
    if (httpMethod === 'GET' && resource === '/calculator/{id}/document') {
      return await getCalculationDocument(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/calculator/{id}/revise') {
      return await reviseCalculation(pathParameters?.id, event);
    }
    if (httpMethod === 'DELETE' && resource === '/calculator/{id}') {
      return await deleteCalculation(pathParameters?.id, event);
    }

    // --- Admin Portal routes ---
    if (httpMethod === 'GET' && resource === '/admin/overview') {
      return await getAdminOverview(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/search') {
      return await adminSearch(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/interviews') {
      return await adminListInterviews(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/moms') {
      return await adminListMoms(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/calculator') {
      return await adminListCalculations(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/intelligence-interviews') {
      return await adminListIntelligenceInterviews(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/candidates') {
      return await adminListCandidates(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/audit-log') {
      return await getAuditLog(event);
    }
    // Context-chat oversight. The thread route takes app/entity_id/user_id as query
    // params rather than a path segment, because a thread id contains `#` and a URL path
    // cannot carry one.
    if (httpMethod === 'GET' && resource === '/admin/conversations') {
      return await adminListConversations(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/conversations/thread') {
      return await adminGetConversationThread(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/members') {
      return await adminListMembers(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/members/{userId}/grants') {
      return await adminGetMemberGrants(pathParameters?.userId, event);
    }
    if (httpMethod === 'POST' && resource === '/admin/members/{userId}/tier') {
      return await adminGrantTier(pathParameters?.userId, event);
    }
    if (httpMethod === 'POST' && resource === '/admin/members/{userId}/revoke') {
      return await adminRevokeTier(pathParameters?.userId, event);
    }
    if (httpMethod === 'POST' && resource === '/admin/members/{userId}/base-role') {
      return await adminChangeBaseRole(pathParameters?.userId, event);
    }
    if (httpMethod === 'GET' && resource === '/admin/cognito-users') {
      return await adminListCognitoUsers(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/approvals') {
      return await adminListApprovals(event);
    }
    if (httpMethod === 'POST' && resource === '/admin/keka-sync') {
      return await triggerKekaScheduleSync(event);
    }

    // --- Question bank (OWNER-gated org config) ---
    if (httpMethod === 'GET' && resource === '/admin/question-bank') {
      return await listQuestionBankRoles(event);
    }
    if (httpMethod === 'GET' && resource === '/admin/question-bank/{roleKey}') {
      return await getQuestionBankRole(pathParameters?.roleKey, event);
    }
    if (httpMethod === 'PATCH' && resource === '/admin/question-bank/{roleKey}') {
      return await updateQuestionBankRole(pathParameters?.roleKey, event);
    }
    if (httpMethod === 'POST' && resource === '/admin/question-bank/{roleKey}/questions') {
      return await createQuestionBankItem(pathParameters?.roleKey, event);
    }
    if (httpMethod === 'PATCH' && resource === '/admin/question-bank/{roleKey}/questions/{questionId}') {
      return await updateQuestionBankItem(pathParameters?.roleKey, pathParameters?.questionId, event);
    }
    if (httpMethod === 'DELETE' && resource === '/admin/question-bank/{roleKey}/questions/{questionId}') {
      return await deleteQuestionBankItem(pathParameters?.roleKey, pathParameters?.questionId, event);
    }

    // --- Candidate workspace / collaboration routes ---
    if (httpMethod === 'POST' && resource === '/workspaces') {
      return await createWorkspace(event);
    }
    if (httpMethod === 'GET' && resource === '/workspaces') {
      return await listWorkspaces(event);
    }
    if (httpMethod === 'GET' && resource === '/workspaces/shared-with-me') {
      return await listSharedWithMe(event);
    }
    if (httpMethod === 'GET' && resource === '/workspaces/{id}') {
      return await getWorkspace(pathParameters?.id, event);
    }
    if (httpMethod === 'PATCH' && resource === '/workspaces/{id}') {
      return await updateWorkspace(pathParameters?.id, event);
    }
    if (httpMethod === 'DELETE' && resource === '/workspaces/{id}') {
      return await deleteWorkspace(pathParameters?.id, event);
    }
    if (httpMethod === 'GET' && resource === '/workspaces/{id}/full') {
      return await getWorkspaceFull(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/workspaces/{id}/shares') {
      return await addShare(pathParameters?.id, event);
    }
    if (httpMethod === 'DELETE' && resource === '/workspaces/{id}/shares/{userId}') {
      return await removeShare(pathParameters?.id, pathParameters?.userId, event);
    }
    if (httpMethod === 'GET' && resource === '/workspaces/{id}/comments') {
      return await listComments(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/workspaces/{id}/comments') {
      return await createComment(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/workspaces/{id}/comments/{commentId}/resolve') {
      return await resolveComment(pathParameters?.id, pathParameters?.commentId, event);
    }
    if (httpMethod === 'POST' && resource === '/workspaces/{id}/link') {
      return await linkRecord(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/workspaces/{id}/unlink') {
      return await unlinkRecord(pathParameters?.id, event);
    }
    if (httpMethod === 'POST' && resource === '/workspaces/{id}/decision') {
      return await postDecision(pathParameters?.id, event);
    }
    if (httpMethod === 'GET' && resource === '/workspaces/lookup') {
      return await handleLookupWorkspace(event);
    }
    if (httpMethod === 'POST' && resource === '/workspaces/{id}/composite-analysis') {
      return await generateCompositeAnalysis(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/user/preferences') {
      return await getUserPreferences(event);
    }

    if (httpMethod === 'POST' && resource === '/user/preferences') {
      return await updateUserPreferences(event);
    }

    if (httpMethod === 'GET' && resource === '/integrations/status') {
      return await getIntegrationStatus();
    }

    if (httpMethod === 'GET' && resource === '/minfy-careers/jobs') {
      return await listMinfyCareers(event);
    }

    if (httpMethod === 'GET' && resource === '/minfy-careers/jobs/{jobId}') {
      return await getMinfyCareer(event.pathParameters?.jobId, event);
    }

    if (httpMethod === 'GET' && resource === '/intelligence-interviews') {
      return await listIntelligenceInterviews(event);
    }

    if (httpMethod === 'GET' && resource === '/keka/jobs') {
      return await listKekaJobs(event);
    }

    if (httpMethod === 'GET' && resource === '/keka/jobs/{jobId}/candidates') {
      return await listKekaCandidates(event.pathParameters?.jobId, event);
    }

    if (httpMethod === 'GET' && resource === '/keka/jobs/{jobId}/candidates/{candidateId}/interviews') {
      return await listKekaInterviews(event.pathParameters?.jobId, event.pathParameters?.candidateId, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews') {
      return await createIntelligenceInterview(event);
    }

    // --- Part A: My Interviews (interviewer-centric landing) ---
    if (httpMethod === 'GET' && resource === '/my-interviews') {
      return await getMyInterviews(event);
    }
    if (httpMethod === 'POST' && resource === '/my-interviews/refresh') {
      return await refreshMyInterviews(event);
    }
    if (httpMethod === 'POST' && resource === '/my-interviews/{schedId}/open') {
      return await openMyInterview(pathParameters?.schedId, event);
    }

    if (httpMethod === 'POST' && resource === '/interviews/{id}/minfy-jd') {
      return await attachMinfyCareerJobDescription(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/intelligence-interviews/{id}') {
      return await getIntelligenceInterview(pathParameters?.id, event);
    }

    if (httpMethod === 'DELETE' && resource === '/intelligence-interviews/{id}') {
      return await deleteIntelligenceInterview(pathParameters?.id, event);
    }

    if (httpMethod === 'PATCH' && resource === '/intelligence-interviews/{id}') {
      return await updateIntelligenceDetails(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/resume-upload-url') {
      return await getIntelligenceResumeUploadUrl(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/confirm-resume') {
      return await confirmIntelligenceResume(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/generate-questions') {
      return await generateIntelligenceQuestions(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/intelligence-interviews/{id}/question-topics') {
      return await listIntelligenceQuestionTopics(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/case-interview') {
      return await generateIntelligenceCaseInterview(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/transcript') {
      return await updateIntelligenceTranscript(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/sync-teams-transcript') {
      return await syncIntelligenceTeamsTranscript(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/scores') {
      return await updateIntelligenceScores(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/analyze') {
      return await analyzeIntelligenceInterview(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/approve') {
      return await approveIntelligenceInterview(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/intelligence-interviews/{id}/report') {
      return await getIntelligenceReport(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/moms') {
      return await createMom(event);
    }

    if (httpMethod === 'GET' && resource === '/moms') {
      return await listMoms(event);
    }

    if (httpMethod === 'POST' && resource === '/mom-projects') {
      return await createMomProject(event);
    }

    if (httpMethod === 'GET' && resource === '/mom-projects') {
      return await listMomProjects(event);
    }

    if (httpMethod === 'GET' && resource === '/mom-projects/{id}') {
      return await getMomProject(pathParameters?.id, event);
    }

    if (httpMethod === 'DELETE' && resource === '/mom-projects/{id}') {
      return await deleteMomProject(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/moms/{id}') {
      return await getMom(pathParameters?.id, event);
    }

    if (httpMethod === 'DELETE' && resource === '/moms/{id}') {
      return await deleteMom(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/moms/{id}/upload-url') {
      return await getMomUploadUrl(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/moms/{id}/confirm-upload') {
      return await confirmMomUpload(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/moms/{id}/analyze') {
      return await runMomAnalysis(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/moms/{id}/result') {
      return await getMomResult(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/moms/{id}/revise') {
      return await applyMomEdit(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/moms/{id}/report') {
      return await getMomReport(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/interviews') {
      return await createInterview(event);
    }

    if (httpMethod === 'GET' && resource === '/interviews') {
      return await listInterviews(event);
    }

    if (httpMethod === 'GET' && resource === '/interviews/{id}') {
      return await getInterview(pathParameters?.id, event);
    }

    if (httpMethod === 'DELETE' && resource === '/interviews/{id}') {
      return await deleteInterview(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/interviews/{id}/upload-url') {
      return await getUploadUrl(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/interviews/{id}/confirm-upload') {
      return await confirmUpload(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/interviews/{id}/analyze') {
      return await runAnalysis(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/interviews/{id}/question-guide') {
      return await generateInterviewQuestionGuide(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/interviews/{id}/result') {
      return await getEvaluationResult(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/interviews/{id}/report') {
      return await getInterviewReport(pathParameters?.id, event);
    }



    return errorResponse(404, 'NOT_FOUND', 'Route not found');
  } catch (err: any) {
    console.error('Handler Error:', err);
    return errorResponse(500, 'INTERNAL_ERROR', err.message || 'An internal error occurred');
  }
};

function getAuthenticatedUserId(event: APIGatewayProxyEvent): string | null {
  return event.requestContext.authorizer?.claims?.sub || null;
}

function getAuthenticatedUserEmail(event: APIGatewayProxyEvent): string | null {
  const email = event.requestContext.authorizer?.claims?.email || event.requestContext.authorizer?.claims?.username || null;
  if (!email) return null;
  return String(email).toLowerCase();
}

function normalizeUserFolder(email: string): string {
  const localPart = email.split('@')[0] || email;
  return localPart
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'user';
}

/**
 * Resolves the readable per-user S3 folder ("users/<folder>/...").
 *
 * The folder is always derived from the caller's email so the bucket stays
 * browsable. Older records fell back to the raw Cognito sub whenever the email
 * claim was absent, which is what produced the UUID-named folders; that path is
 * gone. If the email claim is ever missing we look the sub up in Cognito rather
 * than naming a folder after it.
 */
const userFolderCache = new Map<string, string>();

async function resolveUserFolder(event: APIGatewayProxyEvent, fallbackUserId: string): Promise<string> {
  const email = getAuthenticatedUserEmail(event);
  if (email) return normalizeUserFolder(email);

  const cached = userFolderCache.get(fallbackUserId);
  if (cached) return cached;

  // No email on the token: ask Cognito for it instead of falling back to the
  // opaque sub, which is what created the unreadable folders in the first place.
  try {
    const { CognitoIdentityProviderClient, ListUsersCommand } = await import('@aws-sdk/client-cognito-identity-provider');
    const cognito = new CognitoIdentityProviderClient({});
    const found = await cognito.send(new ListUsersCommand({
      UserPoolId: process.env.USER_POOL_ID!,
      Filter: `sub = "${fallbackUserId}"`,
      Limit: 1,
    }));
    const resolved = found.Users?.[0]?.Attributes?.find((a) => a.Name === 'email')?.Value;
    if (resolved) {
      const folder = normalizeUserFolder(resolved);
      userFolderCache.set(fallbackUserId, folder);
      return folder;
    }
  } catch (err) {
    console.warn('Could not resolve user folder from Cognito:', err);
  }

  // Last resort. Reaching here means the sub has no email anywhere, so the
  // record is unattributable either way — keep it working rather than fail.
  return fallbackUserId;
}

function userInterviewPrefix(userFolder: string, interviewId: string): string {
  return `users/${userFolder}/interviews/${interviewId}`;
}

function userMomPrefix(userFolder: string, momId: string): string {
  return `users/${userFolder}/moms/${momId}`;
}

async function deleteS3ObjectIfExists(key: string | undefined) {
  if (!key) return;
  try {
    await s3Client.send(new DeleteObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
    }));
  } catch (err) {
    console.warn(`Failed to delete S3 object ${key} (might already be gone):`, err);
  }
}

async function cancelTranscriptionJobIfStarted(jobName: string | undefined) {
  if (!jobName) return;
  try {
    await transcribeClient.send(new DeleteTranscriptionJobCommand({
      TranscriptionJobName: jobName,
    }));
  } catch (err) {
    console.warn(`Failed to cancel Transcribe job ${jobName} (it might already be terminal):`, err);
  }
}

async function deleteS3Prefix(prefix: string) {
  let continuationToken: string | undefined;
  do {
    const listed = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));
    const objects = (listed.Contents || []).flatMap((object) => object.Key ? [{ Key: object.Key }] : []);
    if (objects.length) {
      await s3Client.send(new DeleteObjectsCommand({ Bucket: BUCKET_NAME, Delete: { Objects: objects, Quiet: true } }));
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

function momProjectKey(projectId: string): string {
  return `PROJECT#${projectId}`;
}

function isOwnedBy(item: any, userId: string): boolean {
  return item?.owner_user_id === userId;
}

/**
 * Admin fallback for the four getOwned*Record helpers below. Extends each gate
 * with the brief's rule `isOwnedBy || (isAdmin && hasTier('OWNER'))` WITHOUT
 * altering the owner path: it is invoked only when the caller is NOT the owner
 * and only when a route explicitly opts in by passing `adminAccess`.
 *
 * Returns null when admin access is granted (after writing a synchronous audit
 * entry), or an error response to return to the caller otherwise. A VIEWER- or
 * REVIEWER-tier admin — anyone below the required tier — gets 403 here.
 */
interface AdminAccessOptions {
  minTier: AdminTier;
  auditAction: AuditAction;
  targetType: 'interview' | 'mom' | 'mom_project' | 'intelligence';
}

async function triggerKekaScheduleSync(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;

  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'KEKA_SYNC',
    targetType: 'keka',
    targetId: 'schedule-sync',
    detail: 'manual schedule sync queued',
  });

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify({
        __internalTask: 'keka-schedule-sync',
        triggeredBy: caller!.userId,
      })),
    }));
    return acceptedResponse({ status: 'PROCESSING' });
  } catch (error) {
    console.error('Could not queue Keka schedule sync:', error);
    return errorResponse(502, 'KEKA_SYNC_QUEUE_FAILED', 'The Keka schedule sync could not be started. Please retry.');
  }
}

async function resolveAdminAccess(
  event: APIGatewayProxyEvent,
  item: any,
  id: string,
  adminAccess: AdminAccessOptions,
): Promise<APIGatewayProxyResult | null> {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, adminAccess.minTier);
  if (denied) return denied;
  // Awaited on purpose: an admin action that cannot be logged must fail (500),
  // never succeed silently.
  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: adminAccess.auditAction,
    targetType: adminAccess.targetType,
    targetId: id,
    targetOwnerUserId: item?.owner_user_id,
  });
  return null;
}

async function getOwnedInterviewRecord(
  id: string | undefined,
  event: APIGatewayProxyEvent,
  adminAccess?: AdminAccessOptions,
) {
  if (!id) {
    return { response: errorResponse(400, 'VALIDATION_ERROR', 'Missing id') };
  }

  const userId = getAuthenticatedUserId(event);
  if (!userId) {
    return { response: errorResponse(401, 'ACCESS_DENIED', 'Unauthorized') };
  }

  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
  }));

  const item = result.Item;
  if (!item) {
    return { response: errorResponse(404, 'NOT_FOUND', 'Interview not found') };
  }

  const isOwner = isOwnedBy(item, userId);
  if (!isOwner) {
    if (!adminAccess) {
      return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this interview') };
    }
    const denied = await resolveAdminAccess(event, item, id, adminAccess);
    if (denied) return { response: denied };
  } else if (item.deleted_at) {
    // A soft-deleted record is invisible to its owner.
    return { response: errorResponse(404, 'NOT_FOUND', 'Interview not found') };
  }

  // Lazy owner_email backfill only for the actual owner — never stamp an admin's
  // email onto someone else's record.
  const userEmail = getAuthenticatedUserEmail(event);
  if (isOwner && !item.owner_email && userEmail) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
      UpdateExpression: 'SET owner_email = :email',
      ExpressionAttributeValues: { ':email': userEmail },
    }));
    item.owner_email = userEmail;
  }

  return { item, userId, isOwner };
}

async function getOwnedMomRecord(
  id: string | undefined,
  event: APIGatewayProxyEvent,
  adminAccess?: AdminAccessOptions,
) {
  if (!id) {
    return { response: errorResponse(400, 'VALIDATION_ERROR', 'Missing id') };
  }

  const userId = getAuthenticatedUserId(event);
  if (!userId) {
    return { response: errorResponse(401, 'ACCESS_DENIED', 'Unauthorized') };
  }

  const result = await ddbDocClient.send(new GetCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: id },
  }));

  const item = result.Item;
  if (!item) {
    return { response: errorResponse(404, 'NOT_FOUND', 'MOM not found') };
  }

  const isOwner = isOwnedBy(item, userId);
  if (!isOwner) {
    if (!adminAccess) {
      return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this MOM') };
    }
    const denied = await resolveAdminAccess(event, item, id, adminAccess);
    if (denied) return { response: denied };
  } else if (item.deleted_at) {
    return { response: errorResponse(404, 'NOT_FOUND', 'MOM not found') };
  }

  const userEmail = getAuthenticatedUserEmail(event);
  if (isOwner && !item.owner_email && userEmail) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: MOM_TABLE_NAME,
      Key: { mom_id: id },
      UpdateExpression: 'SET owner_email = :email',
      ExpressionAttributeValues: { ':email': userEmail },
    }));
    item.owner_email = userEmail;
  }

  return { item, userId, isOwner };
}

async function getOwnedMomProjectRecord(
  id: string | undefined,
  event: APIGatewayProxyEvent,
  adminAccess?: AdminAccessOptions,
) {
  if (!id) {
    return { response: errorResponse(400, 'VALIDATION_ERROR', 'Missing id') };
  }

  const userId = getAuthenticatedUserId(event);
  if (!userId) {
    return { response: errorResponse(401, 'ACCESS_DENIED', 'Unauthorized') };
  }

  const result = await ddbDocClient.send(new GetCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: momProjectKey(id) },
  }));

  const item = result.Item;
  if (!item) {
    return { response: errorResponse(404, 'NOT_FOUND', 'MOM project not found') };
  }

  const isOwner = isOwnedBy(item, userId);
  if (!isOwner) {
    if (!adminAccess) {
      return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this MOM project') };
    }
    const denied = await resolveAdminAccess(event, item, id, adminAccess);
    if (denied) return { response: denied };
  } else if (item.deleted_at) {
    return { response: errorResponse(404, 'NOT_FOUND', 'MOM project not found') };
  }

  return { item, userId, isOwner };
}

async function createInterview(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const result = CreateInterviewSchema.safeParse(body);
  
  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const interviewId = uuidv4();
  const now = Date.now();
  
  const item = {
    PK: `INTERVIEW#${interviewId}`,
    SK: 'METADATA',
    interview_id: interviewId, // Keep for backward compatibility/clarity in the object
    status: 'CREATED',
    owner_user_id: userId,
    owner_email: getAuthenticatedUserEmail(event),
    created_at: now,
    updated_at: now,
    metadata: result.data,
    model_id: result.data.model_id || 'claude-sonnet-5',
  };

  await ddbDocClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  return createdResponse({ interview_id: interviewId });
}

async function listInterviews(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'begins_with(PK, :pkPrefix) AND SK = :sk AND owner_user_id = :owner AND attribute_not_exists(deleted_at)',
    ExpressionAttributeValues: { ':pkPrefix': 'INTERVIEW#', ':sk': 'METADATA', ':owner': userId },
    Limit: 50,
  }));

  // Map to structured output
  const items = (result.Items || [])
    .map(item => {
      const interviewId = item.interview_id || item.PK?.replace(/^INTERVIEW#/, '');
      if (!interviewId) return null;

      return {
        interview_id: interviewId,
        status: item.status,
        candidate_name: item.metadata?.candidate_name,
        position: item.metadata?.position,
        created_at: item.created_at || item.updated_at || 0,
        model_id: item.model_id,
      };
    })
    .filter(Boolean);

  return successResponse({ 
    items,
    count: items.length,
    last_evaluated_key: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64') : null
  });
}


async function getInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedInterviewRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'READ_INTERVIEW',
    targetType: 'interview',
  });
  if (response) return response;

  // Return structured contract shape
  return successResponse({
    interview_id: item.interview_id || id,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    metadata: item.metadata,
    transcript_uploaded: !!item.transcript_s3_key,
    jd_uploaded: !!item.jd_s3_key,
    resume_uploaded: !!item.resume_s3_key,
    jd_s3_key: item.jd_s3_key,
    transcript_s3_key: item.transcript_s3_key,
    resume_s3_key: item.resume_s3_key,
    model_id: item.model_id,
    inferred_role: item.inferred_role,
    is_mismatched: item.is_mismatched,
    question_guide: item.question_guide || null,
    report_s3_key: item.report_s3_key,
    analysis_started_at: item.analysis_started_at || null,
    progress_stage: item.progress_stage || null,
    progress_message: item.progress_message || null,
    progress_events: item.progress_events || null,
    results: item.status === 'COMPLETED' ? {
      overall_score: item.overall_score,
      recommendation: item.recommendation,
      confidence: item.confidence,
      coverage_percent: item.coverage_percent,
      result_s3_key: item.result_s3_key,
    } : null,

    error: item.error_message ? { message: item.error_message } : null,
  });
}


interface ManualInterviewQuestionGuide {
  generated_at: number;
  source: 'approved_question_bank';
  role_title: string;
  detected_level: string;
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
    /** Model-authored, question-specific failure signals. */
    red_flags?: string[];
  }>;
}

function normalizeOptimizedQuestion(
  bankQuestion: SelectedBankQuestion,
  candidate: any,
  roleTitle: string,
): ManualInterviewQuestionGuide['questions'][number] {
  const cleanList = (value: unknown, fallback: string[]) => {
    if (!Array.isArray(value)) return fallback;
    const cleaned = value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 4);
    return cleaned.length ? cleaned : fallback;
  };

  const scenarioFallback = () => {
    const variants = [
      `Tell me about a project where ${bankQuestion.focusArea} materially affected delivery, reliability, cost, security, or customer trust. What was the situation, what decision did you own, and what did you learn from the outcome?`,
      `Walk me through a time ${bankQuestion.focusArea} became a real constraint during delivery. How did you diagnose the issue, align the right people, and decide what to do next?`,
      `Imagine you join a project where ${bankQuestion.focusArea} is the reason progress has slowed down. What would you check first, what trade-offs would you surface, and how would you move the team toward a defensible decision?`,
      `Could you describe a situation where your judgment around ${bankQuestion.focusArea} changed the direction of a project? I am interested in the context, the alternatives you considered, and the result your choice produced.`,
      `Tell me about a time you had to explain a ${bankQuestion.focusArea} decision to people who cared about different outcomes. How did you frame the risk, make the recommendation, and confirm it worked?`,
    ];
    const hash = Array.from(`${bankQuestion.id}-${bankQuestion.focusArea}`)
      .reduce((total, char) => total + char.charCodeAt(0), 0);
    return variants[hash % variants.length];
  };

  const interviewerQuestion = (value: unknown) => {
    let question = String(value || '').trim();
    if (!question) {
      return scenarioFallback();
    }
    question = question
      .replace(/^let'?s make this concrete\.?\s*/i, '')
      .replace(/^let'?s use a practical[^.?!]*[.?!]\s*/i, '')
      .replace(/\s*please ground your answer in a real project:?\s*what was happening,?\s*what you owned,?\s*which trade-offs you considered,?\s*and what changed as a result\.?$/i, '')
      .replace(/\s*please talk me through the context,?\s*your decision-making,?\s*and the outcome\.?$/i, '')
      .trim();
    if (!question) return scenarioFallback();
    return question;
  };

  return {
    id: bankQuestion.id,
    bank_question_id: bankQuestion.bankQuestionId,
    category: bankQuestion.category,
    focus_area: bankQuestion.focusArea,
    source_question: bankQuestion.question,
    question: interviewerQuestion(candidate?.question || bankQuestion.question),
    follow_ups: cleanList(candidate?.follow_ups, bankQuestion.followUps),
    what_to_listen_for: cleanList(candidate?.what_to_listen_for, bankQuestion.whatToListenFor),
    // Left undefined when the model did not author any, so the UI can fall back
    // to its own copy rather than render an empty section.
    red_flags: (() => {
      if (!Array.isArray(candidate?.red_flags)) return undefined;
      const cleaned = candidate.red_flags
        .map((entry: unknown) => String(entry || '').trim())
        .filter(Boolean)
        .slice(0, 3);
      return cleaned.length ? cleaned : undefined;
    })(),
  };
}

async function optimizeQuestionBankSelection(input: {
  roleTitle: string;
  level: string;
  jdText: string;
  resumeText: string;
  questions: SelectedBankQuestion[];
  targetCount?: number;
}): Promise<{ status: 'optimized' | 'bank_only'; questions: ManualInterviewQuestionGuide['questions'] }> {
  const fallback = input.questions.map((question) => normalizeOptimizedQuestion(question, null, input.roleTitle));

  try {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const { extractJson } = await import('../shared/utils.js');
    const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
    const modelId = process.env.BEDROCK_SONNET_5_PROFILE_ARN || SONNET_5_MODEL_ID;
    const prompt = `
You are a principal-level interviewer and hiring bar-raiser. Rewrite the
selected interview questions into a live interview guide that sounds natural
when spoken by a skilled human interviewer.

The approved question bank is reference material for coverage, not final copy.
Keep each supplied ID exactly once so the UI can map the result, but you may
substantially rewrite, combine context, deepen the scenario, and replace weak
phrasing as long as the same competency and focus area are covered.

Use a STAR-style evidence model: every main question should invite the
candidate to describe Situation, Task/ownership, Actions/trade-offs, and
Result/measurement. The goal is not trivia recall. The goal is evidence of
judgment, ownership, depth, communication, and delivery maturity.

Question style requirements:
- Write like a real interviewer speaking to the candidate.
- Start with a realistic workplace situation, customer problem, production
  constraint, delivery pressure, ambiguity, incident, migration risk, stakeholder
  conflict, design trade-off, or ownership moment.
- Ask the candidate to walk through what happened, what they owned, what options
  they considered, why they chose one path, what failed or changed, and how they
  measured success.
- Use the JD and resume only to choose realistic context. Do not expose private
  resume details or pretend facts are confirmed.
- The question must be self-contained and professional, but conversational.
- Every question must have a different sentence structure. Do not repeat the
  same opener, same middle clause, or same closing instruction across questions.
- Make the question style match the competency:
  * Architecture or design: ask about constraints, alternatives, failure modes,
    and why one design was chosen.
  * Delivery or migration: ask about sequencing, dependency handling, rollback,
    stakeholder alignment, and measurable cutover/readiness criteria.
  * Operations or support: ask about incident handling, diagnosis, prevention,
    and communication under pressure.
  * Compliance or security: ask about data sensitivity, controls, auditability,
    exception handling, and business impact.
  * Leadership or collaboration: ask about disagreement, ambiguity, delegation,
    influence, and ownership boundaries.
- Use natural interviewer language. A strong question can be direct, for
  example: "A client pushes for a faster launch, but your team has not closed
  the data-control gaps yet. How would you handle that conversation and what
  would have to be true before you approve the release?"

Hard bans:
- Do not write "relevant to this role".
- Do not write "as a <role>", "as a <years> candidate", or awkward seniority
  language.
- Do not write "Let's use a practical..." as a template opener.
- Do not write "Let's make this concrete".
- Do not end every question with "what you owned, which trade-offs you
  considered, and what changed as a result". Vary the evidence requested.
- Do not ask textbook questions such as "What is", "Define", or "Explain the
  concept of" unless the bank question is explicitly foundational.
- Do not include the answer, scoring rationale, or why the question was chosen.
- Do not add fashionable tools or trends unless supported by the JD, resume, or
  bank focus.

Main question examples of the expected style:
- "Imagine a release is blocked because the migration plan looks technically
  sound, but operations is worried about rollback and ownership after cutover.
  How would you work through that situation, what trade-offs would you make, and
  how would you prove the plan is safe enough to proceed?"
- "Tell me about a time a pipeline or automation change improved delivery speed
  but carried production risk. What was the situation, what controls did you put
  in place, and what did you measure after the change?"
- "Walk me through a project where the technically clean answer was not the
  easiest answer for the business. What options did you compare, who needed to
  be aligned, and what result did your decision produce?"

Follow-up style:
- Follow-ups must be short, natural interviewer prompts.
- They should probe failure handling, validation, ownership, stakeholder
  alignment, metrics, operational readiness, and lessons learned.
- Avoid repeating the main question.

Listening guide style:
- "what_to_listen_for" should be concrete evidence signals, not generic labels.
- Prefer signals such as measurable outcome, named trade-off, rollback plan,
  dependency handling, ownership boundary, customer impact, incident learning,
  test/validation evidence, cost/security/reliability reasoning.

Return only valid JSON inside <question_guide> tags using this shape:
{
  "questions": [
    {
      "id": "REC-01",
      "question": "string",
      "follow_ups": ["string"],
      "what_to_listen_for": ["string"],
      "red_flags": ["string"]
    }
  ]
}

Ownership of the question set:
- The approved bank is REFERENCE for topic coverage, not a script. You may
  rewrite any question completely, merge two weak questions into one stronger
  scenario, drop a question that does not earn its place, reorder for a natural
  interview arc, and write entirely new questions where the bank has a gap.
- Reuse a supplied id when your question descends from that bank entry, so the
  UI can trace coverage. Use a new id of the form NEW-01, NEW-02 for questions
  you author yourself. Ids must be unique.
- Return ${input.targetCount
    ? `exactly ${input.targetCount} questions. The interviewer chose this number to fit their session length, so respect it.`
    : `between ${Math.max(4, input.questions.length - 2)} and ${input.questions.length + 2} questions.`}
- Between them, the questions must still cover the important competencies and
  focus areas represented in the bank selection and the job description.

Per-question evaluation guidance (write these yourself, never boilerplate):
- "what_to_listen_for": 2-4 concrete evidence signals SPECIFIC to that question.
  A reader must be able to tell which question it belongs to. Never write a
  generic line such as "Practical experience relevant to X".
- "red_flags": 2-3 concrete failure signals SPECIFIC to that question — what a
  weak answer to THIS question actually sounds like. Never repeat the same red
  flags across questions.
- The two lists must not duplicate each other.

Role: ${input.roleTitle}
Detected level: ${input.level}
Job description excerpt:
${input.jdText.slice(0, 12000)}

Resume excerpt (context only; do not expose private details in questions):
${input.resumeText.slice(0, 12000) || 'No resume uploaded'}

Approved bank selection (reference for coverage):
${JSON.stringify(input.questions)}
`;

    // Background work is not behind API Gateway, so give the model room to
    // finish instead of aborting it mid-rewrite.
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), BEDROCK_BACKGROUND_TIMEOUT_MS);
    let response;
    try {
      response = await client.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(anthropicRequestBody(modelId, prompt, BEDROCK_QUESTION_GUIDE_TOKENS, 0)),
      }), { abortSignal: abortController.signal });
    } finally {
      clearTimeout(timeout);
    }

    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const rawText = getBedrockText(payload);
    const parsed = parseTaggedJson<{ questions?: any[] }>(rawText, 'question_guide', extractJson, payload.stop_reason);

    // Validate on quality, not identity. The old contract required the exact
    // same count, ids and order, so a single shifted id threw away every
    // rewrite and silently served raw bank text.
    if (!Array.isArray(parsed.questions) || parsed.questions.length < 4) {
      throw new Error('Question optimizer returned too few questions');
    }

    const bankById = new Map(input.questions.map((question) => [question.id, question]));
    const usedIds = new Set<string>();
    const questions = parsed.questions
      .filter((candidate: any) => typeof candidate?.question === 'string' && candidate.question.trim().length > 20)
      .filter((candidate: any) => {
        const candidateId = String(candidate?.id || '');
        if (!candidateId || usedIds.has(candidateId)) return false;
        usedIds.add(candidateId);
        return true;
      })
      .map((candidate: any, index: number) => {
        // Fall back to the nearest bank entry for provenance fields when the
        // model authored a brand new question.
        const source = bankById.get(String(candidate.id))
          || input.questions[Math.min(index, input.questions.length - 1)];
        return normalizeOptimizedQuestion(source, candidate, input.roleTitle);
      });

    if (questions.length < 4) {
      throw new Error('Question optimizer returned too few usable questions');
    }

    console.info('[Question Guide] Optimized by Sonnet 5', {
      requested: input.questions.length,
      returned: questions.length,
    });
    return { status: 'optimized', questions };
  } catch (error) {
    console.warn('[Question Guide] Bedrock refinement failed; using curated bank wording.', error);
    return { status: 'bank_only', questions: fallback };
  }
}

async function generateInterviewQuestionGuide(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedInterviewRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'READ_INTERVIEW',
    targetType: 'interview',
  });
  if (response) return response;

  if (!item.jd_s3_key) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Upload the job description before preparing the interview guide.');
  }

  try {
    const { getFileBuffer } = await import('../shared/aws.js');
    const { extractTextFromBuffer } = await import('../shared/utils.js');
    const jdBuffer = await getFileBuffer(BUCKET_NAME, item.jd_s3_key);
    const jdText = await extractTextFromBuffer(jdBuffer, item.jd_s3_key);
    const resumeText = item.resume_s3_key
      ? await extractTextFromBuffer(await getFileBuffer(BUCKET_NAME, item.resume_s3_key), item.resume_s3_key)
      : '';
    const roleTitle = String(item.metadata?.position || item.inferred_role || 'Target role').trim();
    const rolePool = await loadRoleBankPool();
    const selection = selectQuestionsFromBank({
      interviewId: id!,
      roleTitle,
      jdText,
      count: 8,
      rolePool,
    });
    const optimized = await optimizeQuestionBankSelection({
      roleTitle,
      level: selection.level,
      jdText,
      resumeText,
      questions: selection.questions,
    });

    const guide: ManualInterviewQuestionGuide = {
      generated_at: Date.now(),
      source: 'approved_question_bank',
      role_title: roleTitle,
      detected_level: selection.level,
      focus_areas: selection.focusAreas,
      optimization_status: optimized.status,
      questions: optimized.questions,
    };

    await ddbDocClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
      UpdateExpression: 'SET question_guide = :guide, updated_at = :now',
      ExpressionAttributeValues: {
        ':guide': guide,
        ':now': Date.now(),
      },
    }));

    return successResponse(guide);
  } catch (error: any) {
    console.error('[Question Guide] Failed to prepare guide:', error);
    return errorResponse(500, 'QUESTION_GUIDE_FAILED', 'The interview guide could not be prepared from this job description.');
  }
}


async function getUploadUrl(id: string | undefined, event: APIGatewayProxyEvent) {
  const owned = await getOwnedInterviewRecord(id, event);
  if (owned.response) return owned.response;
  const userId = owned.userId!;
  const userFolder = await resolveUserFolder(event, userId);

  const body = JSON.parse(event.body || '{}');
  const result = UploadUrlSchema.safeParse(body);
  
  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const { file_type, file_name, content_type } = result.data;
  
  // Safe extension handling
  const extension = file_name.split('.').pop();
  const allowedExtensions = ['txt', 'pdf', 'docx'];
  if (!extension || !allowedExtensions.includes(extension.toLowerCase())) {
     return errorResponse(400, 'VALIDATION_ERROR', `Unsupported file extension: .${extension}`);
  }

  const s3Key = `${userInterviewPrefix(userFolder, id!)}/uploads/${file_type}-${Date.now()}.${extension}`;
  
  const uploadUrl = await getPresignedUploadUrl(BUCKET_NAME, s3Key, content_type);

  return successResponse({ 
    upload_url: uploadUrl, 
    s3_key: s3Key,
    file_type
  });
}

async function confirmUpload(id: string | undefined, event: APIGatewayProxyEvent) {
  const owned = await getOwnedInterviewRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'UPDATE_RECORD',
    targetType: 'interview',
  });
  if (owned.response) return owned.response;
  const item = owned.item!;
  const userId = owned.userId!;
  const userFolder = await resolveUserFolder(event, userId);

  const body = JSON.parse(event.body || '{}');
  const result = ConfirmUploadSchema.safeParse(body);
  
  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const { file_type, s3_key } = result.data;
  const expectedPrefix = `${userInterviewPrefix(userFolder, id!)}/uploads/`;

  if (!s3_key.startsWith(expectedPrefix)) {
    return errorResponse(403, 'ACCESS_DENIED', 'Upload key does not belong to this user');
  }

  // 1. Verify object exists in S3
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3_key,
    }));
  } catch (err) {
    return errorResponse(404, 'UPLOAD_ERROR', 'File not found in storage. Please upload first.');
  }

  // 2. Map file type and determine status
  const attrMap: Record<string, string> = {
    'transcript': 'transcript_s3_key',
    'jd': 'jd_s3_key',
    'resume': 'resume_s3_key'
  };
  
  const attrName = attrMap[file_type];
  const previousKey = item[attrName];

  if (previousKey && previousKey !== s3_key) {
    await deleteS3ObjectIfExists(previousKey);
  }
  
  // Determine if we should move to FILES_UPLOADED
  // (Only transcript and JD are strictly required for evaluation)
  // Determine if we should move to FILES_UPLOADED
  // (Only transcript and JD are strictly required for evaluation)
  const transcriptKey = file_type === 'transcript' ? s3_key : item.transcript_s3_key;
  const jdKey = file_type === 'jd' ? s3_key : item.jd_s3_key;
  
  const finalStatus = (transcriptKey && jdKey) ? 'FILES_UPLOADED' : item.status;

  // --- NEW: Dynamic Role Alignment Inference & State Reset ---
  let inferredRole = item.inferred_role;
  let isMismatched = item.is_mismatched;

  if (file_type === 'jd') {
    console.log('Automated JD check triggered...');
    
    // RESET evaluation results and mismatch state if JD changes
    inferredRole = null;
    isMismatched = false;
    
    try {
      const { getFileBuffer } = await import('../shared/aws.js');
      const { extractTextFromBuffer, extractJson } = await import('../shared/utils.js');
      
      const jdBuffer = await getFileBuffer(BUCKET_NAME, s3_key);
      const jdText = await extractTextFromBuffer(jdBuffer, s3_key);
      
      const enteredRole = item.metadata?.position || 'N/A';
      const inferPrompt = `
        Compare the "Requirement" with the "Job Description".
        
        RULES:
        1. Professional Ecosystems: Categorize into broad domains (e.g. IT, Healthcare, HR).
        2. Ecosystem Clash: If fundamentally different ecosystems, they are NOT ALIGNED.
        3. Keyword Shield: Do not match based on generic words like "management" if domains clash.
        
        Return ONLY JSON: { "aligned": boolean, "inferred_role": "string", "reason": "string" }
        
        Requirement: "${enteredRole}"
        JD Content: ${jdText.substring(0, 3000)}
      `;

      const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
      
      const selectedModel = item.model_id || 'claude-sonnet-5';
      const mapping: Record<string, string | undefined> = {
        'claude-sonnet-5': process.env.BEDROCK_SONNET_5_PROFILE_ARN || SONNET_5_MODEL_ID,
        'claude-3-sonnet': process.env.BEDROCK_SONNET_PROFILE_ARN,
        'claude-sonnet-4-6': process.env.BEDROCK_SONNET_46_PROFILE_ARN || 'arn:aws:bedrock:ap-south-1::inference-profile/global.anthropic.claude-sonnet-4-6',
        'nova-pro': process.env.BEDROCK_NOVA_PROFILE_ARN,
      };

      const finalModelId = mapping[selectedModel] || 
        (selectedModel === 'claude-sonnet-5'
          ? SONNET_5_MODEL_ID
          : selectedModel === 'nova-pro'
          ? 'amazon.nova-pro-v1:0'
          : selectedModel === 'claude-sonnet-4-6'
            ? 'global.anthropic.claude-sonnet-4-6'
            : 'apac.anthropic.claude-3-7-sonnet-20250219-v1:0');
      
      const bedrockResp = await client.send(new InvokeModelCommand({
        modelId: finalModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(anthropicRequestBody(
          finalModelId,
          inferPrompt + '\n\nIMPORTANT: Wrap your final JSON result inside <jd_check> tags.',
          600,
          0,
        )),
      }));

      const resData = JSON.parse(new TextDecoder().decode(bedrockResp.body));
      const rawText = resData.content?.[0]?.text || '';
      const xmlMatch = rawText.match(/<jd_check>([\s\S]*?)<\/jd_check>/i);
      const jsonStr = xmlMatch ? xmlMatch[1] : extractJson(rawText);
      
      if (jsonStr) {
        const result = JSON.parse(jsonStr);
        inferredRole = result.inferred_role;
        isMismatched = !result.aligned;
      }
    } catch (err: any) {
      console.error('[JD Alignment Failed]', err.message);
    }
  }

  // Final update: reset all results if a core file (JD, Transcript, or Resume) is updated
  const resetResults = file_type === 'jd' || file_type === 'transcript' || file_type === 'resume';
  
  let updateExpr = `SET #attr = :key, #st = :status, inferred_role = :ir, is_mismatched = :im, updated_at = :now`;
  const exprValues: any = {
    ':key': s3_key,
    ':status': finalStatus,
    ':ir': inferredRole || null,
    ':im': isMismatched || false,
    ':now': Date.now(),
  };

  if (resetResults) {
    updateExpr += `, overall_score = :null, recommendation = :null, confidence = :null, coverage_percent = :null, dimension_breakdown = :null, result_s3_key = :null, report_s3_key = :null, strengths = :null, areas_for_review = :null, evidence_items = :null, executive_summary = :null, final_recommendation_note = :null, technical_depth = :null, jd_fit_score = :null, experience_level = :null, fit_gap_analysis = :null, error_message = :null`;
    exprValues[':null'] = null;
  }

  if (file_type === 'jd') {
    updateExpr += ', question_guide = :null';
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
    UpdateExpression: updateExpr,
    ExpressionAttributeNames: { 
      '#attr': attrName,
      '#st': 'status' 
    },
    ExpressionAttributeValues: exprValues,
  }));

  return successResponse({ status: finalStatus, inferred_role: inferredRole, is_mismatched: isMismatched });
}



async function runAnalysis(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedInterviewRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'UPDATE_RECORD',
    targetType: 'interview',
  });
  if (response) return response;

  if (!item.transcript_s3_key || !item.jd_s3_key) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Both transcript and JD must be uploaded before analysis.');
  }

  if (!item.question_guide) {
    return errorResponse(400, 'QUESTION_GUIDE_REQUIRED', 'Prepare the interview question guide before starting the evaluation.');
  }

  // 1. Verify BOTH objects exist in S3 (Double check)
  try {
    await Promise.all([
      s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: item.transcript_s3_key })),
      s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: item.jd_s3_key })),
    ]);
  } catch (err) {
    return errorResponse(400, 'UPLOAD_ERROR', 'One or more files missing in storage. Please re-confirm uploads.');
  }

  // 2. Update status to QUEUED
  // analysis_started_at is stamped once here and never rewritten, so the UI can
  // show a true elapsed time that survives a page refresh. updated_at is not
  // usable for that: every progress write bumps it and the timer would reset.
  await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
    UpdateExpression: 'SET #st = :status, updated_at = :now, analysis_started_at = :now, progress_stage = :stage, progress_message = :msg, progress_events = :events',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':status': 'QUEUED',
      ':now': Date.now(),
      ':stage': 'queued',
      ':msg': 'Queued for analysis...',
      // Overwritten, not appended: this is the start of a run, so the log begins
      // here and cannot inherit a previous attempt's stages.
      ':events': [{ at: Date.now(), stage: 'queued', message: 'Queued for analysis...' }],
    },
  }));

  // 3. Send to SQS
  await sqsClient.send(new SendMessageCommand({
    QueueUrl: QUEUE_URL,
    MessageBody: JSON.stringify({ interview_id: id, owner_user_id: item.owner_user_id }),
  }));
  
  return acceptedResponse({ status: 'QUEUED' });
}

async function getEvaluationResult(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedInterviewRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'READ_REPORT',
    targetType: 'interview',
  });
  if (response) return response;

  if (!item || !item.result_s3_key) {
    return errorResponse(404, 'NOT_FOUND', 'Evaluation result not found or not yet available');
  }

  const content = await s3Client.send(new HeadObjectCommand({
    Bucket: BUCKET_NAME,
    Key: item.result_s3_key,
  }));
  
  if (!content) return errorResponse(404, 'NOT_FOUND', 'Result file missing in storage');

  // Fetch the actual JSON content
  const jsonContent = await getFileContent(BUCKET_NAME, item.result_s3_key);
  
  return successResponse(JSON.parse(jsonContent));
}

async function deleteInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response, isOwner } = await getOwnedInterviewRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'SOFT_DELETE',
    targetType: 'interview',
  });
  if (response) return response;

  // Admin (non-owner, OWNER-tier) deletes are SOFT and recoverable: flag the row
  // and leave S3 objects intact. Only the record's own owner hard-deletes.
  if (!isOwner) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
      UpdateExpression: 'SET deleted_at = :now, updated_at = :now',
      ExpressionAttributeValues: { ':now': Date.now() },
    }));
    await unlinkRecordFromWorkspaces('interview', id!, item.workspace_id);
    return successResponse({ message: 'Interview deleted successfully' });
  }

  // 1. Identify potential S3 objects to delete
  const keysToDelete = [
    item.transcript_s3_key,
    item.jd_s3_key,
    item.resume_s3_key,
    item.result_s3_key,
    item.report_s3_key,
  ].filter(Boolean);

  // 2. Delete from S3 (Fail-safe: ignore "Not Found" errors)
  console.log(`Deleting ${keysToDelete.length} S3 objects for interview ${id}`);
  await Promise.all(keysToDelete.map(async (key) => {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }));
    } catch (err) {
      console.warn(`Failed to delete S3 object ${key} (might already be gone):`, err);
    }
  }));

  // 3. Delete from DynamoDB
  await ddbDocClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
  }));

  await unlinkRecordFromWorkspaces('interview', id!, item.workspace_id);
  return successResponse({ message: 'Interview deleted successfully' });
}

async function getFileContent(bucket: string, key: string): Promise<string> {
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  }));
  return await response.Body?.transformToString() || '';
}

async function getInterviewReport(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedInterviewRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'DOWNLOAD_REPORT',
    targetType: 'interview',
  });
  if (response) return response;

  if (!item) return errorResponse(404, 'NOT_FOUND', 'Interview not found');
  if (!item.result_s3_key) return errorResponse(404, 'NOT_FOUND', 'Evaluation result not found or not yet available');

  const resultJson = await getFileContent(BUCKET_NAME, item.result_s3_key);
  const parsedResult = JSON.parse(resultJson);
  const reportKey = item.report_s3_key || `${userInterviewPrefix(item.owner_user_id, id!)}/processed/report.pdf`;
  const pdfReport = await generateInterviewPdfReport(item, parsedResult);
  await saveFileContent(BUCKET_NAME, reportKey, pdfReport, 'application/pdf');

  await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
    UpdateExpression: 'SET report_s3_key = :report, updated_at = :now',
    ExpressionAttributeValues: {
      ':report': reportKey,
      ':now': Date.now(),
    },
  }));

  const safeName = item.metadata?.candidate_name?.replace(/[^a-zA-Z0-9]/g, '-') || 'Candidate';
  const filename = `interview-report-${safeName}.pdf`;

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: reportKey,
    ResponseContentDisposition: `attachment; filename="${filename}"`
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  
  return successResponse({ download_url: url });
}

async function createMomProject(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const result = CreateMomProjectSchema.safeParse(body);

  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const existing = await ddbDocClient.send(new ScanCommand({
    TableName: MOM_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner AND item_type = :type',
    ExpressionAttributeValues: {
      ':owner': userId,
      ':type': 'PROJECT',
    },
    Limit: 100,
  }));

  const normalizedTitle = result.data.project_title.trim().toLowerCase();
  const existingProject = (existing.Items || []).find((item) =>
    (item.project_title || '').trim().toLowerCase() === normalizedTitle
  );

  if (existingProject?.project_id) {
    return successResponse({
      project_id: existingProject.project_id,
      project_title: existingProject.project_title || result.data.project_title,
    });
  }

  const projectId = uuidv4();
  const now = Date.now();
  const item = {
    mom_id: momProjectKey(projectId),
    project_id: projectId,
    item_type: 'PROJECT',
    owner_user_id: userId,
    project_title: result.data.project_title,
    created_at: now,
    updated_at: now,
  };

  await ddbDocClient.send(new PutCommand({
    TableName: MOM_TABLE_NAME,
    Item: item,
  }));

  return createdResponse({
    project_id: projectId,
    project_title: result.data.project_title,
  });
}

async function listMomProjects(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: MOM_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner',
    ExpressionAttributeValues: { ':owner': userId },
    Limit: 200,
  }));

  const projects = new Map<string, any>();
  const momCounts = new Map<string, { count: number; completed: number; updated_at: number }>();

  (result.Items || []).forEach((item) => {
    if (item.item_type === 'PROJECT') {
      projects.set(item.project_id, {
        project_id: item.project_id,
        project_title: item.project_title || 'Untitled project',
        created_at: item.created_at || item.updated_at || 0,
        updated_at: item.updated_at || item.created_at || 0,
        mom_count: 0,
        completed_count: 0,
      });
      return;
    }

    if (!item.mom_id || item.mom_id?.startsWith('PROJECT#')) return;
    const key = item.project_id || `TITLE#${item.project_title || 'General'}`;
    const current = momCounts.get(key) || { count: 0, completed: 0, updated_at: 0 };
    current.count += 1;
    if (item.status === 'COMPLETED') current.completed += 1;
    current.updated_at = Math.max(current.updated_at, item.updated_at || item.created_at || 0);
    momCounts.set(key, current);

    if (!item.project_id && !projects.has(key)) {
      projects.set(key, {
        project_id: null,
        project_title: item.project_title || 'General',
        created_at: item.created_at || item.updated_at || 0,
        updated_at: item.updated_at || item.created_at || 0,
        mom_count: 0,
        completed_count: 0,
      });
    }
  });

  for (const [key, counts] of momCounts.entries()) {
    const project = projects.get(key);
    if (project) {
      project.mom_count = counts.count;
      project.completed_count = counts.completed;
      project.updated_at = Math.max(project.updated_at || 0, counts.updated_at);
    }
  }

  const items = [...projects.values()]
    .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  return successResponse({
    items,
    count: items.length,
  });
}

async function getMomProject(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedMomProjectRecord(id, event);
  if (response) return response;

  return successResponse({
    project_id: item.project_id,
    project_title: item.project_title || 'Untitled project',
    created_at: item.created_at,
    updated_at: item.updated_at,
  });
}

async function deleteMomProject(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item: project, response, userId, isOwner } = await getOwnedMomProjectRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'SOFT_DELETE',
    targetType: 'mom_project',
  });
  if (response) return response;

  // Admin (non-owner) delete is a recoverable soft delete of the project row
  // only; child MOMs and S3 objects are left intact.
  if (!isOwner) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: MOM_TABLE_NAME,
      Key: { mom_id: project.mom_id },
      UpdateExpression: 'SET deleted_at = :now',
      ExpressionAttributeValues: { ':now': Date.now() },
    }));
    return successResponse({ message: 'MOM project deleted successfully', deleted_moms: 0 });
  }

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: MOM_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner',
    ExpressionAttributeValues: { ':owner': userId },
    Limit: 200,
  }));

  const projectMoms = (result.Items || []).filter((item) =>
    item.item_type !== 'PROJECT' &&
    !item.mom_id?.startsWith('PROJECT#') &&
    item.project_id === id
  );

  const keysToDelete = projectMoms.flatMap((item) => [
    item.transcript_s3_key,
    item.result_s3_key,
    item.report_s3_key,
  ]).filter(Boolean);

  await Promise.all(keysToDelete.map(async (key) => {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }));
    } catch (err) {
      console.warn(`Failed to delete S3 object ${key} (might already be gone):`, err);
    }
  }));

  await Promise.all(projectMoms.map((mom) => ddbDocClient.send(new DeleteCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: mom.mom_id },
  }))));

  await ddbDocClient.send(new DeleteCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: project.mom_id },
  }));

  return successResponse({
    message: 'MOM project deleted successfully',
    deleted_moms: projectMoms.length,
  });
}

async function createMom(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const result = CreateMomSchema.safeParse(body);

  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const momId = uuidv4();
  const now = Date.now();
  let projectId = result.data.project_id || null;
  let projectTitle = result.data.project_title || 'General';

  if (projectId) {
    const project = await ddbDocClient.send(new GetCommand({
      TableName: MOM_TABLE_NAME,
      Key: { mom_id: momProjectKey(projectId) },
    }));
    if (!project.Item) return errorResponse(404, 'NOT_FOUND', 'MOM project not found');
    if (!isOwnedBy(project.Item, userId)) {
      return errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this MOM project');
    }
    projectTitle = project.Item.project_title || projectTitle;
  }

  const item = {
    mom_id: momId,
    owner_user_id: userId,
    owner_email: getAuthenticatedUserEmail(event),
    item_type: 'MOM',
    status: 'CREATED',
    created_at: now,
    updated_at: now,
    title: result.data.title,
    project_id: projectId,
    project_title: projectTitle,
    source_type: result.data.source_type,
    source_file_name: result.data.source_file_name || null,
    source_last_modified: result.data.source_last_modified || null,
  };

  await ddbDocClient.send(new PutCommand({
    TableName: MOM_TABLE_NAME,
    Item: item,
  }));

  return createdResponse({ mom_id: momId });
}

async function listMoms(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: MOM_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner AND attribute_not_exists(deleted_at)',
    ExpressionAttributeValues: { ':owner': userId },
    Limit: 50,
  }));

  const items = (result.Items || [])
    .filter(item => item.item_type !== 'PROJECT' && !item.mom_id?.startsWith('PROJECT#'))
    .map(item => ({
      mom_id: item.mom_id,
      status: item.status,
      title: item.title || 'Untitled meeting',
      project_id: item.project_id || null,
      project_title: item.project_title || 'General',
      source_type: item.source_type || 'file',
      source_file_name: item.source_file_name || null,
      source_last_modified: item.source_last_modified || null,
      meeting_date: item.meeting_date || null,
      meeting_date_sort: item.meeting_date_sort || null,
      created_at: item.created_at || item.updated_at || 0,
      updated_at: item.updated_at || item.created_at || 0,
      error_message: item.error_message,
    }))
    .filter(item => item.mom_id);

  return successResponse({
    items,
    count: items.length,
    last_evaluated_key: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64') : null,
  });
}

async function getMom(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedMomRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'READ_MOM',
    targetType: 'mom',
  });
  if (response) return response;

  return successResponse({
    mom_id: item.mom_id,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    title: item.title || 'Untitled meeting',
    project_id: item.project_id || null,
    project_title: item.project_title || 'General',
    source_type: item.source_type || 'file',
    source_file_name: item.source_file_name || null,
    source_last_modified: item.source_last_modified || null,
    meeting_date: item.meeting_date || null,
    meeting_date_sort: item.meeting_date_sort || null,
    transcript_uploaded: !!item.transcript_s3_key,
    transcript_s3_key: item.transcript_s3_key,
    result_s3_key: item.result_s3_key,
    report_s3_key: item.report_s3_key,
    analysis_started_at: item.analysis_started_at || null,
    progress_stage: item.progress_stage || null,
    progress_message: item.progress_message || null,
    progress_events: item.progress_events || null,
    error: item.error_message ? { message: item.error_message } : null,
  });
}

async function getMomUploadUrl(id: string | undefined, event: APIGatewayProxyEvent) {
  const owned = await getOwnedMomRecord(id, event);
  if (owned.response) return owned.response;
  const userId = owned.userId!;
  const userFolder = await resolveUserFolder(event, userId);

  const body = JSON.parse(event.body || '{}');
  const result = MomUploadUrlSchema.safeParse(body);

  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const { file_name, content_type } = result.data;
  const extension = file_name.split('.').pop();
  const allowedExtensions = ['txt', 'pdf', 'docx'];
  if (!extension || !allowedExtensions.includes(extension.toLowerCase())) {
    return errorResponse(400, 'VALIDATION_ERROR', `Unsupported file extension: .${extension}`);
  }

  const s3Key = `${userMomPrefix(userFolder, id!)}/uploads/transcript-${Date.now()}.${extension}`;
  const uploadUrl = await getPresignedUploadUrl(BUCKET_NAME, s3Key, content_type);

  return successResponse({
    upload_url: uploadUrl,
    s3_key: s3Key,
    file_type: 'transcript',
  });
}

async function confirmMomUpload(id: string | undefined, event: APIGatewayProxyEvent) {
  const owned = await getOwnedMomRecord(id, event);
  if (owned.response) return owned.response;
  const userId = owned.userId!;
  const userFolder = await resolveUserFolder(event, userId);

  const body = JSON.parse(event.body || '{}');
  const result = ConfirmMomUploadSchema.safeParse(body);

  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const { s3_key } = result.data;
  const expectedPrefix = `${userMomPrefix(userFolder, id!)}/uploads/`;
  if (!s3_key.startsWith(expectedPrefix)) {
    return errorResponse(403, 'ACCESS_DENIED', 'Upload key does not belong to this user');
  }

  const previousKey = owned.item?.transcript_s3_key;
  if (previousKey && previousKey !== s3_key) {
    await deleteS3ObjectIfExists(previousKey);
  }

  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3_key,
    }));
  } catch {
    return errorResponse(404, 'UPLOAD_ERROR', 'File not found in storage. Please upload first.');
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: id! },
    UpdateExpression: 'SET transcript_s3_key = :key, #st = :status, updated_at = :now, result_s3_key = :null, report_s3_key = :null, error_message = :null',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':key': s3_key,
      ':status': 'CREATED',
      ':now': Date.now(),
      ':null': null,
    },
  }));

  return successResponse({ status: 'CREATED' });
}

async function runMomAnalysis(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedMomRecord(id, event);
  if (response) return response;

  if (!item.transcript_s3_key) {
    return errorResponse(400, 'VALIDATION_ERROR', 'A transcript must be uploaded before MOM analysis.');
  }

  if (item.status === 'PROCESSING') {
    return acceptedResponse({ status: 'PROCESSING', already_processing: true });
  }

  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: item.transcript_s3_key }));
  } catch {
    return errorResponse(400, 'UPLOAD_ERROR', 'Transcript file is missing in storage. Please upload again.');
  }

  const queuedAt = Date.now();
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: MOM_TABLE_NAME,
      Key: { mom_id: id! },
      UpdateExpression: 'SET #st = :processing, updated_at = :queuedAt, analysis_started_at = :queuedAt, progress_stage = :stage, progress_message = :message, progress_events = :events, error_message = :null',
      ConditionExpression: '#st = :expectedStatus AND updated_at = :expectedUpdatedAt',
      ExpressionAttributeNames: { '#st': 'status' },
      ExpressionAttributeValues: {
        ':processing': 'PROCESSING',
        ':expectedStatus': item.status,
        ':expectedUpdatedAt': item.updated_at,
        ':queuedAt': queuedAt,
        ':stage': 'queued',
        ':message': 'Queued for MOM analysis...',
        ':events': [{ at: queuedAt, stage: 'queued', message: 'Queued for MOM analysis...' }],
        ':null': null,
      },
    }));
  } catch (error: any) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
    const latest = await ddbDocClient.send(new GetCommand({
      TableName: MOM_TABLE_NAME,
      Key: { mom_id: id! },
      ConsistentRead: true,
    }));
    if (latest.Item?.status === 'PROCESSING') {
      return acceptedResponse({ status: 'PROCESSING', already_processing: true });
    }
    return errorResponse(409, 'MOM_STATE_CHANGED', 'The MOM changed while analysis was starting. Refresh and try again.');
  }

  try {
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: MOM_QUEUE_URL,
      MessageBody: JSON.stringify({ mom_id: id, owner_user_id: item.owner_user_id }),
    }));
  } catch (error) {
    console.error('Could not queue MOM analysis:', error);
    try {
      await ddbDocClient.send(new UpdateCommand({
        TableName: MOM_TABLE_NAME,
        Key: { mom_id: id! },
        UpdateExpression: 'SET #st = :failed, updated_at = :now, progress_stage = :stage, progress_message = :message, error_message = :message',
        ConditionExpression: '#st = :processing AND updated_at = :queuedAt',
        ExpressionAttributeNames: { '#st': 'status' },
        ExpressionAttributeValues: {
          ':failed': 'FAILED',
          ':processing': 'PROCESSING',
          ':queuedAt': queuedAt,
          ':now': Date.now(),
          ':stage': 'failed',
          ':message': 'The MOM analysis could not be started. Please retry.',
        },
      }));
    } catch (rollbackError: any) {
      if (rollbackError?.name !== 'ConditionalCheckFailedException') {
        console.error('Could not roll back MOM analysis queue state:', rollbackError);
      }
    }
    return errorResponse(502, 'MOM_ANALYSIS_QUEUE_FAILED', 'The MOM analysis could not be started. Please retry.');
  }

  return acceptedResponse({ status: 'PROCESSING' });
}

async function getMomResult(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedMomRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'READ_REPORT',
    targetType: 'mom',
  });
  if (response) return response;

  if (!item.result_s3_key) {
    return errorResponse(404, 'NOT_FOUND', 'MOM result not found or not yet available');
  }

  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: item.result_s3_key,
    }));
  } catch {
    return errorResponse(404, 'NOT_FOUND', 'Result file missing in storage');
  }

  const jsonContent = await getFileContent(BUCKET_NAME, item.result_s3_key);
  return successResponse(JSON.parse(jsonContent));
}

async function getMomReport(id: string | undefined, event: APIGatewayProxyEvent) {
  // Rejected rather than defaulted: a caller that mistypes `?format=word` should be told, not
  // handed a PDF it will try to open as a Word file.
  const format = (event.queryStringParameters?.format || 'pdf').toLowerCase();
  if (format !== 'pdf' && format !== 'docx') {
    return errorResponse(400, 'VALIDATION_ERROR', 'format must be pdf or docx');
  }

  const { item, response } = await getOwnedMomRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'DOWNLOAD_REPORT',
    targetType: 'mom',
  });
  if (response) return response;

  if (!item.result_s3_key) {
    return errorResponse(404, 'NOT_FOUND', 'MOM result not found or not yet available');
  }

  const jsonContent = await getFileContent(BUCKET_NAME, item.result_s3_key);
  const parsed = JSON.parse(jsonContent);
  const validation = MomResultSchema.safeParse(parsed);
  if (!validation.success) {
    return errorResponse(500, 'INTERNAL_ERROR', 'Stored MOM result could not be converted to a report');
  }

  const reportFolder = item.owner_email ? normalizeUserFolder(item.owner_email) : item.owner_user_id;
  const projectTitle = item.project_title || 'General';

  if (format === 'docx') {
    // A key of its own, and `report_s3_key` is deliberately left pointing at the PDF: that
    // column is what the rest of the app treats as "the report", and repointing it at a Word
    // file would change what every other caller downloads.
    const docxKey = `users/${reportFolder}/moms/${id}/processed/report.docx`;
    const docxReport = await generateMomDocxReport(validation.data, { projectTitle });
    await saveFileContent(
      BUCKET_NAME,
      docxKey,
      docxReport,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    const docxCommand = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: docxKey,
      ResponseContentDisposition: `attachment; filename="${momReportFileName(item)}.docx"`,
    });
    return successResponse({ download_url: await getSignedUrl(s3Client, docxCommand, { expiresIn: 3600 }) });
  }

  const reportKey = item.report_s3_key || `users/${reportFolder}/moms/${id}/processed/report.pdf`;
  const pdfReport = await generateMomPdfReport(validation.data, { projectTitle });
  await saveFileContent(BUCKET_NAME, reportKey, pdfReport, 'application/pdf');

  await ddbDocClient.send(new UpdateCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: id! },
    UpdateExpression: 'SET report_s3_key = :report, updated_at = :now',
    ExpressionAttributeValues: {
      ':report': reportKey,
      ':now': Date.now(),
    },
  }));

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: reportKey,
    ResponseContentDisposition: `attachment; filename="${momReportFileName(item)}.pdf"`,
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  return successResponse({ download_url: url });
}

/** Shared by both formats so the two downloads differ only in extension. */
function momReportFileName(item: { project_title?: string; title?: string }): string {
  const safeProject = (item.project_title || 'General').replace(/[^a-zA-Z0-9]/g, '-');
  const safeName = (item.title || 'mom-report').replace(/[^a-zA-Z0-9]/g, '-');
  return `mom-report-${safeProject}-${safeName}`;
}

/**
 * POST /moms/{id}/revise — applies a chat-proposed edit to the stored minutes.
 *
 * OWNER only, and not by accident. Reading someone else's minutes is a VIEWER-tier
 * admin action elsewhere in this file, but rewriting them is not: an admin quietly
 * editing another person's record of a meeting is a different thing from reading it,
 * and it is not what this feature was asked for.
 *
 * The body is a PARTIAL result, and each field it carries replaces the stored one
 * whole. That is what the chat is for — "drop the two internal risks" sends a complete
 * risks array without them. A merge at the element level would need the model to
 * describe a deletion, which is exactly the kind of instruction it gets wrong.
 */
async function applyMomEdit(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response, isOwner, userId } = await getOwnedMomRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'UPDATE_RECORD',
    targetType: 'mom',
  });
  if (response) return response;
  if (!isOwner) {
    return errorResponse(403, 'ACCESS_DENIED', 'Only the owner of these minutes can edit them.');
  }

  if (!item.result_s3_key) {
    return errorResponse(404, 'NOT_FOUND', 'MOM result not found or not yet available');
  }

  let input: ApplyMomEdit;
  try {
    input = ApplyMomEditSchema.parse(JSON.parse(event.body || '{}'));
  } catch (error) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', (error as Error).message);
  }
  const patch = input.patch as Record<string, unknown>;
  if (!Object.keys(patch).length) {
    return errorResponse(400, 'VALIDATION_ERROR', 'The edit contained no changes.');
  }

  const storedJson = await getFileContent(BUCKET_NAME, item.result_s3_key);
  const stored = MomResultSchema.safeParse(JSON.parse(storedJson));
  if (!stored.success) {
    return errorResponse(500, 'INTERNAL_ERROR', 'The stored minutes could not be read for editing.');
  }

  // Re-validated as a whole after merging, not field by field before it: a patch that
  // is individually valid can still leave the document inconsistent, and the renderers
  // downstream assume a complete, valid MomResult.
  const merged = MomResultSchema.safeParse({ ...stored.data, ...patch });
  if (!merged.success) {
    return errorResponse(
      400,
      'VALIDATION_ERROR',
      'That edit would leave the minutes incomplete.',
      merged.error.issues.slice(0, 5).map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    );
  }

  await saveFileContent(
    BUCKET_NAME,
    item.result_s3_key,
    JSON.stringify(merged.data, null, 2),
    'application/json',
  );

  // Both documents are regenerated now rather than on next download, so a user who
  // applies an edit and immediately re-sends the file cannot send the old one. The
  // Word file is written to its own key for the reason getMomReport explains.
  const reportFolder = item.owner_email ? normalizeUserFolder(item.owner_email) : item.owner_user_id;
  const projectTitle = item.project_title || 'General';
  const reportKey = item.report_s3_key || `users/${reportFolder}/moms/${id}/processed/report.pdf`;
  const docxKey = `users/${reportFolder}/moms/${id}/processed/report.docx`;

  try {
    const [pdfReport, docxReport] = await Promise.all([
      generateMomPdfReport(merged.data, { projectTitle }),
      generateMomDocxReport(merged.data, { projectTitle }),
    ]);
    await Promise.all([
      saveFileContent(BUCKET_NAME, reportKey, pdfReport, 'application/pdf'),
      saveFileContent(
        BUCKET_NAME,
        docxKey,
        docxReport,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      ),
    ]);
  } catch (error) {
    // The edit itself is saved and is the source of truth; a failed render is a stale
    // download, not lost work, and the next download regenerates from the new result.
    console.error('[applyMomEdit] could not regenerate reports:', error);
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: id! },
    UpdateExpression: 'SET report_s3_key = :report, updated_at = :now',
    ExpressionAttributeValues: { ':report': reportKey, ':now': Date.now() },
  }));

  // The minutes are rewritten and the row is updated, so the proposal really was
  // applied. Marked from here rather than from the chat, which cannot know whether the
  // user ever pressed apply.
  //
  // The thread id is built from the CALLER'S own userId, which is what makes this safe
  // without a second ownership check: the owner is part of the partition key, so a caller
  // can only ever stamp a turn in a thread they own. (This route is OWNER-only anyway, so
  // the caller and the record's owner are the same person here.) Awaited rather than fired
  // and forgotten — it cannot throw, and the drawer refetches its history immediately,
  // which would race an unawaited write.
  if (input.chat_seq && userId) {
    await markProposalApplied(chatThreadId('mom', id!, userId), input.chat_seq);
  }

  return successResponse({
    mom_id: id,
    updated_fields: Object.keys(patch),
    result: merged.data,
  });
}

/**
 * GET /chat/config — hands the browser the chat Function URL.
 *
 * Served at runtime rather than baked in as a NEXT_PUBLIC_* var because the URL does
 * not exist until the stack is deployed, and a build-time value would force a
 * deploy-then-rebuild-then-deploy cycle on every fresh environment.
 *
 * An empty string when the variable is unset, not an error: the frontend hides the
 * chat launcher rather than showing a button that cannot work.
 */
async function getChatConfig(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  return successResponse({ chat_url: process.env.CHAT_FUNCTION_URL || '' });
}

async function deleteMom(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response, isOwner } = await getOwnedMomRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'SOFT_DELETE',
    targetType: 'mom',
  });
  if (response) return response;

  // Admin (non-owner) delete is a recoverable soft delete; S3 objects are kept.
  if (!isOwner) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: MOM_TABLE_NAME,
      Key: { mom_id: id! },
      UpdateExpression: 'SET deleted_at = :now',
      ExpressionAttributeValues: { ':now': Date.now() },
    }));
    await unlinkRecordFromWorkspaces('mom', id!, item.workspace_id);
    return successResponse({ message: 'MOM deleted successfully' });
  }

  const keysToDelete = [
    item.transcript_s3_key,
    item.result_s3_key,
    item.report_s3_key,
  ].filter(Boolean);

  await Promise.all(keysToDelete.map(async (key) => {
    try {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
      }));
    } catch (err) {
      console.warn(`Failed to delete S3 object ${key} (might already be gone):`, err);
    }
  }));

  await ddbDocClient.send(new DeleteCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: id! },
  }));

  await unlinkRecordFromWorkspaces('mom', id!, item.workspace_id);
  return successResponse({ message: 'MOM deleted successfully' });
}

async function getOwnedIntelligenceRecord(
  id: string | undefined,
  event: APIGatewayProxyEvent,
  adminAccess?: AdminAccessOptions,
) {
  if (!id) {
    return { response: errorResponse(400, 'VALIDATION_ERROR', 'Missing id') };
  }

  const userId = getAuthenticatedUserId(event);
  if (!userId) {
    return { response: errorResponse(401, 'ACCESS_DENIED', 'Unauthorized') };
  }

  const result = await ddbDocClient.send(new GetCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    Key: { intelligence_id: id },
  }));

  const item = result.Item as InterviewIntelligenceRecord | undefined;
  if (!item) {
    return { response: errorResponse(404, 'NOT_FOUND', 'Interview intelligence record not found') };
  }

  const isOwner = isOwnedBy(item, userId);
  if (!isOwner) {
    if (!adminAccess) {
      return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this intelligence interview') };
    }
    const denied = await resolveAdminAccess(event, item, id, adminAccess);
    if (denied) return { response: denied };
  } else if ((item as any).deleted_at) {
    return { response: errorResponse(404, 'NOT_FOUND', 'Interview intelligence record not found') };
  }

  // Lazy owner_email backfill, matching the interview and MOM read paths. Only
  // the actual owner stamps it — never an admin reading someone else's record.
  const userEmail = getAuthenticatedUserEmail(event);
  if (isOwner && !item.owner_email && userEmail) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      Key: { intelligence_id: item.intelligence_id },
      UpdateExpression: 'SET owner_email = :email',
      ExpressionAttributeValues: { ':email': userEmail },
    }));
    item.owner_email = userEmail;
  }

  return { item, userId, isOwner };
}

function intelligenceStorageFolder(item: InterviewIntelligenceRecord): string {
  return item.owner_email ? normalizeUserFolder(item.owner_email) : item.owner_user_id;
}

function transcribeMediaFormat(extension: string): 'mp3' | 'mp4' | 'wav' | 'flac' | 'ogg' | 'amr' | 'webm' | 'm4a' {
  const normalized = extension.toLowerCase();
  if (['mp3', 'mp4', 'wav', 'flac', 'ogg', 'amr', 'webm', 'm4a'].includes(normalized)) {
    return normalized as 'mp3' | 'mp4' | 'wav' | 'flac' | 'ogg' | 'amr' | 'webm' | 'm4a';
  }
  return 'mp4';
}

function extractTranscribeText(payload: unknown): string {
  const record = payload && typeof payload === 'object' ? payload as Record<string, any> : {};
  const transcript = record.results?.transcripts?.[0]?.transcript;
  return typeof transcript === 'string' ? transcript.replace(/\s+/g, ' ').trim() : '';
}

async function refreshTeamsTranscriptionIfNeeded(item: InterviewIntelligenceRecord): Promise<InterviewIntelligenceRecord> {
  if (item.teams.transcriptStatus !== 'transcribing') return item;
  if (!item.teams.transcribeJobName) {
    const startedAt = Number(item.teams.lastSyncAt || 0);
    if (!startedAt || Date.now() - startedAt <= 16 * 60 * 1000) return item;
    const now = Date.now();
    const message = 'Recording transcription did not start before the worker timeout. Please retry.';
    try {
      const response = await ddbDocClient.send(new UpdateCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: item.intelligence_id },
        UpdateExpression: 'SET #teams.#transcriptStatus = :failed, #teams.#lastSyncAt = :now, #teams.#error = :error, #updatedAt = :now REMOVE #teams.#workerToken, #teams.#workerStartedAt',
        ConditionExpression: '#teams.#transcriptStatus = :transcribing AND attribute_not_exists(#teams.#jobName)',
        ExpressionAttributeNames: {
          '#teams': 'teams',
          '#transcriptStatus': 'transcriptStatus',
          '#lastSyncAt': 'lastSyncAt',
          '#error': 'error',
          '#updatedAt': 'updated_at',
          '#jobName': 'transcribeJobName',
          '#workerToken': 'recordingWorkerToken',
          '#workerStartedAt': 'recordingWorkerStartedAt',
        },
        ExpressionAttributeValues: {
          ':failed': 'failed',
          ':transcribing': 'transcribing',
          ':now': now,
          ':error': message,
        },
        ReturnValues: 'ALL_NEW',
      }));
      return (response.Attributes as InterviewIntelligenceRecord | undefined) || {
        ...item,
        updated_at: now,
        teams: { ...item.teams, transcriptStatus: 'failed', lastSyncAt: now, error: message },
      };
    } catch (error: any) {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
      const latest = await ddbDocClient.send(new GetCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: item.intelligence_id },
        ConsistentRead: true,
      }));
      return (latest.Item as InterviewIntelligenceRecord | undefined) || item;
    }
  }

  let job;
  try {
    const response = await transcribeClient.send(new GetTranscriptionJobCommand({
      TranscriptionJobName: item.teams.transcribeJobName,
    }));
    job = response.TranscriptionJob;
  } catch (error) {
    console.warn('Could not refresh AWS Transcribe job:', error);
    return item;
  }

  const status = job?.TranscriptionJobStatus;
  if (status === 'QUEUED' || status === 'IN_PROGRESS') return item;

  const now = Date.now();
  if (status === 'FAILED') {
    const message = job?.FailureReason || 'AWS Transcribe could not process the Teams recording.';
    try {
      const response = await ddbDocClient.send(new UpdateCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: item.intelligence_id },
        UpdateExpression: 'SET #teams.#transcriptStatus = :failed, #teams.#lastSyncAt = :now, #teams.#error = :error, #updatedAt = :now',
        ConditionExpression: '#teams.#transcriptStatus = :transcribing AND #teams.#jobName = :jobName AND attribute_not_exists(#transcript.#rawText)',
        ExpressionAttributeNames: {
          '#teams': 'teams', '#transcriptStatus': 'transcriptStatus', '#lastSyncAt': 'lastSyncAt',
          '#error': 'error', '#updatedAt': 'updated_at', '#jobName': 'transcribeJobName',
          '#transcript': 'transcript', '#rawText': 'rawText',
        },
        ExpressionAttributeValues: {
          ':failed': 'failed', ':transcribing': 'transcribing', ':now': now,
          ':error': message, ':jobName': item.teams.transcribeJobName,
        },
        ReturnValues: 'ALL_NEW',
      }));
      await deleteS3ObjectIfExists(item.teams.recordingS3Key);
      await deleteS3ObjectIfExists(item.teams.transcribeOutputKey);
      return (response.Attributes as InterviewIntelligenceRecord | undefined) || {
        ...item,
        updated_at: now,
        teams: { ...item.teams, transcriptStatus: 'failed', lastSyncAt: now, error: message },
      };
    } catch (error: any) {
      if (error?.name !== 'ConditionalCheckFailedException') throw error;
      const latest = await ddbDocClient.send(new GetCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: item.intelligence_id },
        ConsistentRead: true,
      }));
      return (latest.Item as InterviewIntelligenceRecord | undefined) || item;
    }
  }

  if (status !== 'COMPLETED') return item;

  try {
    const outputKey = item.teams.transcribeOutputKey;
    if (!outputKey) throw new Error('Missing Transcribe output key.');
    const outputJson = await getFileContent(BUCKET_NAME, outputKey);
    const rawText = extractTranscribeText(JSON.parse(outputJson));
    if (!rawText) throw new Error('AWS Transcribe returned an empty transcript.');

    const transcript = { rawText, source: 'teams_recording_transcribe' as const, uploadedAt: now };
    const response = await ddbDocClient.send(new UpdateCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      Key: { intelligence_id: item.intelligence_id },
      UpdateExpression: 'SET #status = :ready, #teams.#transcriptStatus = :synced, #teams.#source = :source, #teams.#lastSyncAt = :now, #transcript = :transcript, #updatedAt = :now REMOVE #teams.#error',
      ConditionExpression: '#teams.#transcriptStatus = :transcribing AND #teams.#jobName = :jobName AND attribute_not_exists(#transcript.#rawText)',
      ExpressionAttributeNames: {
        '#status': 'status', '#teams': 'teams', '#transcriptStatus': 'transcriptStatus',
        '#source': 'transcriptSource', '#lastSyncAt': 'lastSyncAt', '#transcript': 'transcript',
        '#updatedAt': 'updated_at', '#error': 'error', '#jobName': 'transcribeJobName', '#rawText': 'rawText',
      },
      ExpressionAttributeValues: {
        ':ready': 'transcript_ready', ':synced': 'synced', ':source': 'teams_recording_transcribe',
        ':now': now, ':transcript': transcript, ':transcribing': 'transcribing',
        ':jobName': item.teams.transcribeJobName,
      },
      ReturnValues: 'ALL_NEW',
    }));
    await deleteS3ObjectIfExists(item.teams.recordingS3Key);
    await deleteS3ObjectIfExists(item.teams.transcribeOutputKey);
    return (response.Attributes as InterviewIntelligenceRecord | undefined) || {
      ...item,
      updated_at: now,
      status: 'transcript_ready',
      teams: { ...item.teams, transcriptStatus: 'synced', transcriptSource: 'teams_recording_transcribe', lastSyncAt: now, error: undefined },
      transcript,
    };
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      const latest = await ddbDocClient.send(new GetCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: item.intelligence_id },
        ConsistentRead: true,
      }));
      return (latest.Item as InterviewIntelligenceRecord | undefined) || item;
    }

    const message = error instanceof Error ? error.message : 'AWS Transcribe output could not be read.';
    try {
      const response = await ddbDocClient.send(new UpdateCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: item.intelligence_id },
        UpdateExpression: 'SET #teams.#transcriptStatus = :failed, #teams.#lastSyncAt = :now, #teams.#error = :error, #updatedAt = :now',
        ConditionExpression: '#teams.#transcriptStatus = :transcribing AND #teams.#jobName = :jobName AND attribute_not_exists(#transcript.#rawText)',
        ExpressionAttributeNames: {
          '#teams': 'teams', '#transcriptStatus': 'transcriptStatus', '#lastSyncAt': 'lastSyncAt',
          '#error': 'error', '#updatedAt': 'updated_at', '#jobName': 'transcribeJobName',
          '#transcript': 'transcript', '#rawText': 'rawText',
        },
        ExpressionAttributeValues: {
          ':failed': 'failed', ':transcribing': 'transcribing', ':now': now,
          ':error': message, ':jobName': item.teams.transcribeJobName,
        },
        ReturnValues: 'ALL_NEW',
      }));
      await deleteS3ObjectIfExists(item.teams.recordingS3Key);
      await deleteS3ObjectIfExists(item.teams.transcribeOutputKey);
      return (response.Attributes as InterviewIntelligenceRecord | undefined) || {
        ...item,
        updated_at: now,
        teams: { ...item.teams, transcriptStatus: 'failed', lastSyncAt: now, error: message },
      };
    } catch (updateError: any) {
      if (updateError?.name !== 'ConditionalCheckFailedException') throw updateError;
      const latest = await ddbDocClient.send(new GetCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: item.intelligence_id },
        ConsistentRead: true,
      }));
      return (latest.Item as InterviewIntelligenceRecord | undefined) || item;
    }
  }
}

function getIntegrationMode(value: string | undefined): 'disabled' | 'live' {
  if (value === 'live') return 'live';
  return 'disabled';
}

async function getIntegrationStatus() {
  const kekaMode = getIntegrationMode(process.env.KEKA_INTEGRATION_MODE);
  const teamsMode = getIntegrationMode(process.env.TEAMS_INTEGRATION_MODE);

  return successResponse({
    keka: {
      mode: kekaMode,
      label: kekaMode === 'live' ? 'Keka live mode' : 'Keka disabled',
      configured: kekaMode === 'live' && !!(
        process.env.KEKA_SECRET_ARN ||
        (process.env.KEKA_BASE_URL && process.env.KEKA_CLIENT_ID && process.env.KEKA_CLIENT_SECRET && process.env.KEKA_API_KEY)
      ),
      credentialSource: kekaMode === 'live' && process.env.KEKA_SECRET_ARN ? 'AWS Secrets Manager' : undefined,
    },
    teams: {
      mode: teamsMode,
      label: teamsMode === 'live' ? 'Teams live mode' : 'Teams disabled',
      configured: teamsMode === 'live' && !!process.env.MS_TEAMS_SECRET_ARN,
      credentialSource: teamsMode === 'live' && process.env.MS_TEAMS_SECRET_ARN ? 'AWS Secrets Manager' : undefined,
    },
    message: 'Integration modes are configured from backend environment variables.',
  });
}

async function ensureLiveKeka(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult | undefined> {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'REVIEWER');
  if (denied) return denied;
  if (getIntegrationMode(process.env.KEKA_INTEGRATION_MODE) !== 'live') {
    return errorResponse(503, 'INTEGRATION_NOT_READY', 'Keka Hire is not configured for live interview selection yet.');
  }
  return undefined;
}

async function listKekaJobs(event: APIGatewayProxyEvent) {
  const response = await ensureLiveKeka(event);
  if (response) return response;
  try {
    return successResponse({ items: await createKekaIntegration('live').listJobs() });
  } catch (error: any) {
    console.warn('[Keka Hire] Could not list jobs:', error instanceof Error ? error.message : 'Unknown error');
    return errorResponse(502, 'KEKA_SYNC_FAILED', error instanceof KekaIntegrationError ? error.message : 'Keka Hire could not load jobs.');
  }
}

async function listKekaCandidates(jobId: string | undefined, event: APIGatewayProxyEvent) {
  const response = await ensureLiveKeka(event);
  if (response) return response;
  try {
    return successResponse({ items: await createKekaIntegration('live').listCandidates(String(jobId || '')) });
  } catch (error: any) {
    console.warn('[Keka Hire] Could not list candidates:', error instanceof Error ? error.message : 'Unknown error');
    return errorResponse(502, 'KEKA_SYNC_FAILED', error instanceof KekaIntegrationError ? error.message : 'Keka Hire could not load candidates.');
  }
}

async function listKekaInterviews(jobId: string | undefined, candidateId: string | undefined, event: APIGatewayProxyEvent) {
  const response = await ensureLiveKeka(event);
  if (response) return response;
  try {
    const items = await createKekaIntegration('live').listInterviews(String(jobId || ''), String(candidateId || ''));
    
    // Annotate each scheduled interview with the live state of its imported
    // round, so the picker can show "Report ready" / "In progress" instead of a
    // flat "Already imported". Soft-deleted rounds are excluded: a deleted round
    // must free its Keka interview to be imported again.
    if (items.length > 0) {
      const scan = await ddbDocClient.send(new ScanCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        FilterExpression: 'keka.candidateId = :cId AND attribute_not_exists(deleted_at)',
        ExpressionAttributeValues: { ':cId': String(candidateId || '') },
        ProjectionExpression: 'keka.interviewId, intelligence_id, #st',
        ExpressionAttributeNames: { '#st': 'status' },
      }));
      const importedById = new Map<string, { status?: string; intelligenceId?: string }>();
      for (const row of scan.Items || []) {
        const interviewId = row.keka?.interviewId;
        if (interviewId) {
          importedById.set(interviewId, {
            status: row.status,
            intelligenceId: row.intelligence_id,
          });
        }
      }
      items.forEach((item: any) => {
        const existing = importedById.get(item.id);
        item.isImported = Boolean(existing);
        item.importedStatus = existing?.status;
        item.importedIntelligenceId = existing?.intelligenceId;
      });
    }

    return successResponse({ items });
  } catch (error: any) {
    console.warn('[Keka Hire] Could not list interviews:', error instanceof Error ? error.message : 'Unknown error');
    return errorResponse(502, 'KEKA_SYNC_FAILED', error instanceof KekaIntegrationError ? error.message : 'Keka Hire could not load interviews.');
  }
}

async function listMinfyCareers(event: APIGatewayProxyEvent) {
  if (!getAuthenticatedUserId(event)) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  try {
    const catalog = await listMinfyCareerJobs(BUCKET_NAME);
    return successResponse({
      source: 'Minfy Careers',
      source_url: 'https://minfytech.zohorecruit.com/jobs/Careers',
      fetched_at: catalog.fetchedAt,
      jobs: catalog.jobs,
    });
  } catch (error: any) {
    console.error('[Minfy Careers] Could not load career catalogue:', error);
    return errorResponse(502, 'CAREERS_SOURCE_UNAVAILABLE', error?.message || 'Minfy Careers could not be reached. Please try again shortly.');
  }
}

async function getMinfyCareer(jobId: string | undefined, event: APIGatewayProxyEvent) {
  if (!getAuthenticatedUserId(event)) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  try {
    return successResponse({ job: await getMinfyCareerJob(BUCKET_NAME, String(jobId || '')) });
  } catch (error: any) {
    console.error('[Minfy Careers] Could not load job description:', error);
    return errorResponse(502, 'CAREERS_SOURCE_UNAVAILABLE', error?.message || 'The job description could not be retrieved.');
  }
}

async function attachMinfyCareerJobDescription(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, userId, response } = await getOwnedInterviewRecord(id, event);
  if (response) return response;

  const jobId = String(parseBody(event).job_id || '').trim();
  try {
    const job = await getMinfyCareerJob(BUCKET_NAME, jobId);
    const storageFolder = await resolveUserFolder(event, userId!);
    const s3Key = `${userInterviewPrefix(storageFolder, id!)}/uploads/jd-minfy-careers-${job.id}.txt`;
    await saveFileContent(BUCKET_NAME, s3Key, job.description, 'text/plain; charset=utf-8');
    await ddbDocClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
      UpdateExpression: 'SET jd_s3_key = :key, inferred_role = :role, metadata.#position = :role, jd_source = :source, updated_at = :now',
      ExpressionAttributeNames: { '#position': 'position' },
      ExpressionAttributeValues: {
        ':key': s3Key,
        ':role': job.title,
        ':source': { type: 'minfy_careers', job_id: job.id, source_url: job.sourceUrl, fetched_at: job.fetchedAt },
        ':now': Date.now(),
      },
    }));
    return successResponse({ status: 'CREATED', s3_key: s3Key, job });
  } catch (error: any) {
    console.error('[Minfy Careers] Could not attach job description:', error);
    return errorResponse(502, 'CAREERS_SOURCE_UNAVAILABLE', error?.message || 'The job description could not be attached.');
  }
}

function parseBody(event: APIGatewayProxyEvent): any {
  return JSON.parse(event.body || '{}');
}

function normalizeStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(/[,;\n]/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function summarizeText(text: string | undefined, fallback: string): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return fallback;
  return clean.length > 260 ? `${clean.slice(0, 257)}...` : clean;
}

function inferSkills(job: InterviewIntelligenceRecord['job']): string[] {
  const explicit = [...(job.requiredSkills || []), ...(job.preferredSkills || [])]
    .map((skill) => skill.trim())
    .filter(Boolean);
  if (explicit.length) return Array.from(new Set(explicit)).slice(0, 10);

  const known = ['AWS', 'Terraform', 'Kubernetes', 'Python', 'Java', 'React', 'Node.js', 'SQL', 'CI/CD', 'IAM', 'Security', 'Observability'];
  const lower = `${job.title} ${job.description}`.toLowerCase();
  const inferred = known.filter((skill) => lower.includes(skill.toLowerCase()));
  return inferred.length ? inferred : ['Problem solving', 'Communication', 'Role fit'];
}

type RoleCompetency = NonNullable<InterviewIntelligenceRecord['job']['competencies']>[number];

/**
 * Deterministic guard against the reported defect: the bank's topicTag labels
 * ("1500+ VM Migrations", "3000 users", "Terraform 1.5") are program details or
 * tool versions, not competencies a panel can assess in conversation. The rule
 * itself lives in ./competencies.ts so it is unit-testable without loading this
 * handler or calling a model; isLikelyCompetency is re-exported here because the
 * pipeline below is its only caller.
 */
export { isLikelyCompetency, validateCompetencies };

/**
 * Asks Sonnet 5 to normalise the JD into 6–12 assessable competency names,
 * stripping volumes, counts, client names, and program specifics. Same Bedrock
 * pattern as the other model calls in this file; small output, so the interactive
 * timeout is ample even in the background.
 */
async function extractCompetenciesWithModel(
  job: InterviewIntelligenceRecord['job'],
  timeoutMs = BEDROCK_INTERACTIVE_TIMEOUT_MS,
): Promise<string[]> {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const { extractJson } = await import('../shared/utils.js');
  const modelId = process.env.BEDROCK_SONNET_5_PROFILE_ARN || SONNET_5_MODEL_ID;
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  const prompt = `
You are a hiring domain expert. Read the job below and list the core
competencies a panel would actually assess in an interview conversation.

Rules for each competency:
- It must be a capability that can be probed and scored in a live conversation
  (a skill, a kind of judgment, an area of ownership) — not a task count, a
  volume, a client name, a product/program name, or a tool version.
- Strip quantities, headcounts, versions, and program specifics, and normalise
  to the underlying capability. Examples:
  * "1500+ VM Migrations" -> "Large-scale VM migration"
  * "Hyperscaler Program Usage" -> "Cloud provider program & funding"
  * "Terraform 1.5" -> "Infrastructure as code"
- Use short, human-readable noun phrases (2-5 words). No numbers unless a number
  is genuinely part of the name.
- Return 6 to 12, most important first, no duplicates.

Return only valid JSON inside <competencies_json>...</competencies_json> tags:
{ "competencies": ["string", "string"] }

ROLE TITLE: ${job.title || 'Unspecified role'}
SENIORITY: ${job.seniority || 'Unspecified'}
JOB DESCRIPTION:
${(job.description || '').slice(0, 12000) || 'No job description was supplied.'}
`;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await client.send(new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(anthropicRequestBody(modelId, prompt, 1200, 0)),
    }), { abortSignal: abortController.signal });
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const rawText = getBedrockText(payload);
    const parsed = parseTaggedJson<{ competencies?: unknown }>(rawText, 'competencies_json', extractJson, payload.stop_reason);
    return Array.isArray(parsed?.competencies)
      ? parsed.competencies.map((entry) => String(entry || '')).filter(Boolean)
      : [];
  } finally {
    clearTimeout(timeout);
  }
}

/** Targeted cache write so a later resolution reuses the AI extraction. */
async function cacheCompetencies(intelligenceId: string, competencies: RoleCompetency[]): Promise<void> {
  if (!intelligenceId) return;
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      Key: { intelligence_id: intelligenceId },
      UpdateExpression: 'SET job.competencies = :c, updated_at = :u',
      ConditionExpression: 'attribute_exists(intelligence_id)',
      ExpressionAttributeValues: { ':c': competencies, ':u': Date.now() },
    }));
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') {
      console.warn('Could not cache resolved competencies:', err);
    }
  }
}

/**
 * The single source of truth for a role's competencies (Part B), resolved in
 * strict priority order. Mutates record.job.competencies in place so a caller
 * that persists the record (the question/analysis workers) caches the result
 * for free; the AI path also writes back directly so a read-only caller (the
 * topics picker) still caches. The result is never empty, so the pipeline that
 * consumes it cannot break.
 */
async function resolveRoleCompetencies(
  record: InterviewIntelligenceRecord,
  options?: { timeoutMs?: number },
): Promise<RoleCompetency[]> {
  // 1. Admin override — always wins, read fresh (a single cheap Query on the
  //    QuestionBankRole META row). Never cached, so admin edits take effect at
  //    once and a removed override cannot linger as a stale snapshot.
  try {
    const roleKey = roleKeyForJob({ kekaJobId: record.keka?.jobId, jobTitle: record.job?.title });
    const validated = validateCompetencies((await loadRoleCompetencyOverride(roleKey)) || []);
    if (validated.length) {
      const result = validated.map((name) => ({ name, source: 'admin' as const }));
      record.job.competencies = result;
      return result;
    }
  } catch (err) {
    console.warn('Competency admin-override lookup failed; continuing:', err);
  }

  // 2. Cached AI extraction from a previous resolution (ignore admin/inferred
  //    snapshots: admin is re-checked above, inferred should retry the model).
  const cachedAi = validateCompetencies(
    (record.job.competencies || []).filter((c) => c?.source === 'ai').map((c) => c.name),
  );
  if (cachedAi.length) {
    return cachedAi.map((name) => ({ name, source: 'ai' as const }));
  }

  // 3. Sonnet 5 extraction from the JD.
  try {
    const validated = validateCompetencies(await extractCompetenciesWithModel(record.job, options?.timeoutMs));
    if (validated.length >= 3) {
      const result = validated.map((name) => ({ name, source: 'ai' as const }));
      record.job.competencies = result;
      await cacheCompetencies(record.intelligence_id, result);
      return result;
    }
  } catch (err) {
    console.warn('Competency extraction failed; using inferSkills fallback:', err);
  }

  // 4. Deterministic fallback — kept so nothing can break. Not cached, so a
  //    later resolution retries the model.
  const inferred = inferSkills(record.job);
  const validatedInferred = validateCompetencies(inferred);
  const result = (validatedInferred.length ? validatedInferred : inferred).map((name) => ({ name, source: 'inferred' as const }));
  record.job.competencies = result;
  return result;
}


function buildIntroductionQuestion(): IntelligenceQuestion & { expectedStrongAnswerSignals: string[]; redFlags: string[] } {
  return {
    question: 'To begin, could you briefly walk us through the experience that has prepared you for this role and one project you are most proud of?',
    followUps: ['What was your specific contribution?', 'What result or lesson from that work is most relevant here?'],
    whatToEvaluate: ['Clarity of career narrative', 'Ownership of past work'],
    questionType: 'introduction',
    countsTowardPanelEvaluation: false,
    expectedStrongAnswerSignals: ['Clear, concise career narrative', 'Specific contribution and outcome'],
    redFlags: ['Cannot explain individual contribution', 'Only vague project descriptions'],
  };
}

function buildResumeQuestion(topic: string): IntelligenceQuestion & { expectedStrongAnswerSignals: string[]; redFlags: string[] } {
  return {
    question: `Your resume mentions ${topic}. Could you walk us through the situation, the decisions you owned, and the outcome?`,
    followUps: ['What was the hardest trade-off?', 'How did you measure whether the approach worked?'],
    whatToEvaluate: ['Accuracy and depth of resume experience', 'Ownership and reflection'],
    questionType: 'resume',
    countsTowardPanelEvaluation: false,
    expectedStrongAnswerSignals: ['Specific context, contribution, and measurable outcome', 'Thoughtful explanation of trade-offs'],
    redFlags: ['Cannot go beyond the resume headline', 'Attributes all work to the wider team'],
  };
}

function resumeTopics(record: InterviewIntelligenceRecord, skills: string[]): string[] {
  const resume = (record.candidate.resumeText || '').replace(/\s+/g, ' ').trim();
  if (!resume) return [];
  const lower = resume.toLowerCase();
  const jobSkills = skills.filter((skill) => lower.includes(skill.toLowerCase()));
  const knownTopics = ['AWS', 'Azure', 'GCP', 'Terraform', 'Kubernetes', 'Docker', 'Python', 'Java', 'React', 'Node.js', 'SQL', 'CI/CD', 'IAM', 'Security', 'Observability']
    .filter((topic) => lower.includes(topic.toLowerCase()));
  const unique = Array.from(new Set([...jobSkills, ...knownTopics]));
  return unique.length ? unique.slice(0, 3) : ['the project experience highlighted in your resume'];
}

async function buildQuestionPlan(
  record: InterviewIntelligenceRecord,
  preferences?: { focusAreas?: string[]; questionCount?: number },
): Promise<IntelligenceQuestionPlan> {
  const skills = inferSkills(record.job);
  const panel = record.panel.length ? record.panel : [{ interviewerId: 'interviewer-1', name: 'Interviewer' }];
  const requestedCount = preferences?.questionCount;
  // Part B: what the round declares it covers is real competencies, not the
  // bank's internal topicTag labels. The interviewer's picks (from the topics
  // picker, which now shows competencies) define selectedTopics; if they picked
  // nothing, the full resolved set is used. Runs in the background worker, so
  // the model gets the longer timeout.
  const competencies = await resolveRoleCompetencies(record, { timeoutMs: BEDROCK_BACKGROUND_TIMEOUT_MS });
  const competencyNames = competencies.map((c) => c.name);
  const requestedAreas = preferences?.focusAreas?.length ? preferences.focusAreas : undefined;
  const topics = requestedAreas && requestedAreas.length ? requestedAreas : competencyNames;
  // The curated pool (admin edits) when it has rows, else the shipped static
  // bank — resolved inside the store, so this call site is fallback-agnostic.
  // NOTE: competency names are deliberately NOT passed as the bank's focusAreas
  // filter — that filter matches the bank's own topicTag vocabulary, so feeding
  // competencies would select zero questions. The bank picks by JD + role; the
  // competencies steer only what the guide and report surface.
  const rolePool = await loadRoleBankPool();
  const selection = selectQuestionsFromBank({
    interviewId: record.intelligence_id,
    roleTitle: record.job.title || 'Target role',
    jdText: record.job.description,
    count: requestedCount || 8,
    rolePool,
  });
  const optimized = await optimizeQuestionBankSelection({
    roleTitle: record.job.title || 'Target role',
    level: selection.level,
    jdText: record.job.description,
    resumeText: record.candidate.resumeText || '',
    questions: selection.questions,
    targetCount: requestedCount,
  });
  // The model may now add, drop, or merge questions, so the guide is driven by
  // what it actually returned rather than by the original bank selection.
  const roleQuestions = optimized.questions.map((optimizedQuestion) => {
    const bankQuestion = selection.questions.find((entry) => entry.id === optimizedQuestion.id);
    return {
      question: optimizedQuestion.question || bankQuestion?.question || '',
      followUps: optimizedQuestion.follow_ups || bankQuestion?.followUps || [],
      whatToEvaluate: optimizedQuestion.what_to_listen_for || bankQuestion?.whatToListenFor || [],
      questionType: 'role' as const,
      countsTowardPanelEvaluation: true,
      expectedStrongAnswerSignals: optimizedQuestion.what_to_listen_for || bankQuestion?.whatToListenFor || [],
      // Prefer the model's question-specific failure signals. The generic list
      // below is only a floor for records generated before that existed.
      redFlags: optimizedQuestion.red_flags?.length
        ? optimizedQuestion.red_flags
        : [
            'Cannot connect the answer to a real delivery or production example',
            'Does not explain their individual contribution or decision-making',
            'Avoids discussing trade-offs, validation, or the outcome',
          ],
    };
  });
  const skillAreas = topics.map((skill, index) => ({
    skill,
    priority: index < 3 ? 'high' as const : index < 6 ? 'medium' as const : 'low' as const,
    reason: `${skill} is a core competency for ${record.job.title || 'the role'}, drawn from the job description for this round.`,
  }));

  const panelPlan = panel.map((interviewer, index) => {
    const assignedQuestions = panel.length === 1
      ? roleQuestions
      : roleQuestions.filter((_, questionIndex) => questionIndex % panel.length === index);
    // Label each panelist with the round's competencies (Part B), never the
    // bank's internal focusArea/topicTag on the assigned questions.
    const panelistTopics = panel.length === 1
      ? topics.slice(0, 3)
      : topics.filter((_, topicIndex) => topicIndex % panel.length === index);
    const focusArea = interviewer.focusArea
      || (panelistTopics.length ? Array.from(new Set(panelistTopics)).slice(0, 2).join(' / ') : 'Role assessment');
    const contextQuestions = index === 0
      ? [buildIntroductionQuestion(), ...resumeTopics(record, skills).map((topic) => buildResumeQuestion(topic))]
      : [];
    return {
      interviewerId: interviewer.interviewerId,
      focusArea: contextQuestions.length ? `${focusArea} / candidate experience` : focusArea,
      questions: [...contextQuestions, ...assignedQuestions],
    };
  });

  return {
    generatedAt: Date.now(),
    // What the interviewer actually chose to cover, so the report and the
    // candidate workspace can show which ground this round covered (and a later
    // panel can pick different ground). Real competencies now, never bank topicTags.
    selectedTopics: topics,
    requestedQuestionCount: requestedCount || roleQuestions.length,
    candidateSummary: summarizeText(record.candidate.experienceSummary || record.candidate.resumeText, `${record.candidate.name} has been added for interview preparation.`),
    jdSummary: summarizeText(record.job.description, `Interview guide for ${record.job.title || 'the selected role'}.`),
    skillAreas,
    panelPlan,
    scoringRubric: [
      { category: 'Technical depth', maxScore: 10, guidance: 'Rate the candidate on practical depth, examples, troubleshooting, and trade-off thinking.' },
      { category: 'Role alignment', maxScore: 10, guidance: 'Rate how strongly the candidate maps to the JD responsibilities and seniority.' },
      { category: 'Communication', maxScore: 10, guidance: 'Rate clarity, structure, collaboration signals, and ability to explain decisions.' },
      { category: 'Ownership and judgment', maxScore: 10, guidance: 'Rate accountability, risk awareness, production maturity, and escalation judgment.' },
    ],
  };
}

function inferCaseDomain(record: InterviewIntelligenceRecord): {
  label: string;
  scenarioType: string;
  competencies: string[];
} {
  const text = `${record.job.title} ${record.job.description} ${(record.job.requiredSkills || []).join(' ')}`.toLowerCase();
  const hasAny = (terms: string[]) => terms.some((term) => text.includes(term));
  if (hasAny(['migration', 'cloud', 'aws', 'azure', 'gcp', 'infrastructure', 'devops', 'sre', 'terraform', 'kubernetes'])) {
    return {
      label: 'Cloud and infrastructure delivery',
      scenarioType: 'cloud transformation decision case',
      competencies: ['Problem framing', 'Architecture judgment', 'Risk ownership', 'Execution plan', 'Commercial awareness'],
    };
  }
  if (hasAny(['data', 'analytics', 'bi', 'dashboard', 'quicksight', 'power bi', 'machine learning', 'ai', 'ml'])) {
    return {
      label: 'Data and analytics delivery',
      scenarioType: 'data product prioritisation case',
      competencies: ['Data problem framing', 'Metric judgment', 'Solution design', 'Governance', 'Stakeholder communication'],
    };
  }
  if (hasAny(['sales', 'presales', 'business development', 'account', 'customer', 'commercial'])) {
    return {
      label: 'Client solution and commercial strategy',
      scenarioType: 'client discovery and proposal case',
      competencies: ['Discovery quality', 'Value articulation', 'Solution fit', 'Commercial realism', 'Executive communication'],
    };
  }
  if (hasAny(['hr', 'recruit', 'talent', 'people', 'operations', 'admin', 'finance'])) {
    return {
      label: 'Operational decision making',
      scenarioType: 'process improvement and stakeholder case',
      competencies: ['Process diagnosis', 'Stakeholder management', 'Controls', 'Prioritisation', 'Communication'],
    };
  }
  return {
    label: 'Role-specific problem solving',
    scenarioType: 'role simulation case',
    competencies: ['Clarifying questions', 'Structured thinking', 'Practical solutioning', 'Risk awareness', 'Communication'],
  };
}

function inferCaseDifficulty(record: InterviewIntelligenceRecord): IntelligenceCaseInterview['difficulty'] {
  const text = `${record.job.title} ${record.job.seniority || ''} ${record.job.description}`.toLowerCase();
  if (/\b(architect|principal|director|head|vp|10\+|12\+|15\+)\b/.test(text)) return 'principal';
  if (/\b(lead|manager|senior|8\+|7\+|6\+)\b/.test(text)) return 'senior';
  if (/\b(associate|engineer|consultant|3\+|4\+|5\+)\b/.test(text)) return 'practitioner';
  return 'foundation';
}

function buildFallbackCaseInterview(record: InterviewIntelligenceRecord): IntelligenceCaseInterview {
  const domain = inferCaseDomain(record);
  const difficulty = inferCaseDifficulty(record);
  const skills = inferSkills(record.job).slice(0, 5);
  const role = record.job.title || 'the selected role';
  const skillText = skills.length ? skills.join(', ') : 'the role requirements';
  return {
    enabled: true,
    generatedAt: Date.now(),
    // Deterministic study assembled from the JD, not a model output. Stamped so
    // the UI can say so rather than presenting it as AI-authored.
    source: 'template',
    title: `${role} case interview`,
    difficulty,
    format: '15 minutes preparation, 30 minutes candidate walkthrough, 15 minutes panel probing',
    candidatePack: {
      scenario: `You have joined a client engagement where a delivery decision must be made in the ${domain.label.toLowerCase()} workstream. The client needs a practical recommendation that balances business impact, implementation risk, constraints, and stakeholder confidence.`,
      context: [
        `The role requires evidence across ${skillText}.`,
        'The client expects a clear recommendation, not only a list of options.',
        'Assume some information is incomplete; the candidate should state assumptions and ask clarifying questions.',
      ],
      exhibits: [
        {
          title: 'Current situation',
          content: [
            'The client has a mixed operating environment with multiple stakeholders and limited tolerance for delivery disruption.',
            'The business team wants a phased plan with measurable checkpoints.',
          ],
          revealTiming: 'initial',
        },
        {
          title: 'Constraint update',
          content: [
            'Budget, timeline, security, and operational readiness must be considered before recommending an approach.',
            'The panel may reveal one additional constraint during probing.',
          ],
          revealTiming: 'on_request',
        },
      ],
      tasks: [
        {
          title: 'Frame the problem',
          instructions: ['Clarify the business goal, technical context, assumptions, and decision criteria.'],
          expectedDurationMinutes: 8,
        },
        {
          title: 'Recommend an approach',
          instructions: ['Compare two practical options, explain trade-offs, and select one recommendation.'],
          expectedDurationMinutes: 15,
        },
        {
          title: 'Plan delivery and controls',
          instructions: ['Define key risks, mitigations, milestones, owners, and success measures.'],
          expectedDurationMinutes: 12,
        },
      ],
      deliverables: ['Problem statement', 'Recommended option with rationale', 'Risk and mitigation plan', 'First 30-60 day execution plan'],
    },
    interviewerGuide: {
      competencies: domain.competencies.map((competency) => ({
        name: competency,
        whatGoodLooksLike: `Candidate gives a practical, evidence-led answer for ${competency.toLowerCase()} and connects it to the role.`,
        weakSignals: 'Answer stays theoretical, ignores trade-offs, or does not explain ownership and measurable outcomes.',
        maxScore: 5,
      })),
      strongAnswerMarkers: [
        'Asks clarifying questions before recommending a solution.',
        'Separates facts, assumptions, risks, and decisions.',
        'Explains trade-offs and why one option is better for the client context.',
        'Defines measurable checkpoints and ownership.',
      ],
      probingQuestions: domain.competencies.map((competency) => ({
        area: competency,
        question: `If the client challenged your ${competency.toLowerCase()} recommendation, what evidence would you use to defend or adjust it?`,
        expectedSignal: 'Uses specific constraints, measurable evidence, and practical alternatives.',
        redFlag: 'Repeats the original answer without adapting to the new constraint.',
      })),
      hiddenFacts: [
        'The panel should reveal constraints only after the candidate has framed the initial approach.',
        'Do not score the candidate down for asking clarifying questions; that is expected case behavior.',
      ],
    },
  };
}

function normalizeCaseInterview(value: any, record: InterviewIntelligenceRecord): IntelligenceCaseInterview {
  const fallback = buildFallbackCaseInterview(record);
  const candidatePack = value?.candidatePack || {};
  const interviewerGuide = value?.interviewerGuide || {};
  return {
    enabled: true,
    generatedAt: Date.now(),
    // Reached only when the model returned a parseable case, so this is the AI's
    // scenario even where individual fields fell back to the template's values.
    source: 'ai',
    title: cleanAiText(value?.title, fallback.title || `${record.job.title} case interview`),
    difficulty: cleanAiEnum(value?.difficulty, ['foundation', 'practitioner', 'senior', 'principal'] as const, fallback.difficulty || 'practitioner'),
    format: cleanAiText(value?.format, fallback.format || '15 minutes preparation, 30 minutes walkthrough, 15 minutes probing'),
    candidatePack: {
      scenario: cleanAiText(candidatePack?.scenario, fallback.candidatePack!.scenario),
      context: cleanAiList(candidatePack?.context, 8).length ? cleanAiList(candidatePack?.context, 8) : fallback.candidatePack!.context,
      exhibits: (Array.isArray(candidatePack?.exhibits) ? candidatePack.exhibits : fallback.candidatePack!.exhibits).slice(0, 6).map((entry: any) => ({
        title: cleanAiText(entry?.title, 'Case exhibit'),
        content: cleanAiList(entry?.content, 8),
        revealTiming: cleanAiEnum(entry?.revealTiming, ['initial', 'on_request'] as const, 'initial'),
      })),
      tasks: (Array.isArray(candidatePack?.tasks) ? candidatePack.tasks : fallback.candidatePack!.tasks).slice(0, 5).map((entry: any) => ({
        title: cleanAiText(entry?.title, 'Case task'),
        instructions: cleanAiList(entry?.instructions, 8),
        expectedDurationMinutes: Number.isFinite(Number(entry?.expectedDurationMinutes)) ? Math.max(1, Math.round(Number(entry.expectedDurationMinutes))) : undefined,
      })),
      deliverables: cleanAiList(candidatePack?.deliverables, 8).length ? cleanAiList(candidatePack?.deliverables, 8) : fallback.candidatePack!.deliverables,
    },
    interviewerGuide: {
      competencies: (Array.isArray(interviewerGuide?.competencies) ? interviewerGuide.competencies : fallback.interviewerGuide!.competencies).slice(0, 6).map((entry: any) => ({
        name: cleanAiText(entry?.name, 'Case competency'),
        whatGoodLooksLike: cleanAiText(entry?.whatGoodLooksLike, 'Clear practical reasoning backed by the case facts.'),
        weakSignals: cleanAiText(entry?.weakSignals, 'The answer remains generic or misses key constraints.'),
        maxScore: Number.isFinite(Number(entry?.maxScore)) ? Math.max(1, Math.min(10, Math.round(Number(entry.maxScore)))) : 5,
      })),
      strongAnswerMarkers: cleanAiList(interviewerGuide?.strongAnswerMarkers, 10).length ? cleanAiList(interviewerGuide?.strongAnswerMarkers, 10) : fallback.interviewerGuide!.strongAnswerMarkers,
      probingQuestions: (Array.isArray(interviewerGuide?.probingQuestions) ? interviewerGuide.probingQuestions : fallback.interviewerGuide!.probingQuestions).slice(0, 8).map((entry: any) => ({
        area: cleanAiText(entry?.area, 'Case probing'),
        question: cleanAiText(entry?.question, 'What trade-off would you revisit if the client constraint changed?'),
        expectedSignal: cleanAiText(entry?.expectedSignal, 'Candidate adapts the recommendation using case facts.'),
        redFlag: cleanAiText(entry?.redFlag, 'Candidate cannot explain the trade-off.'),
      })),
      hiddenFacts: cleanAiList(interviewerGuide?.hiddenFacts, 8).length ? cleanAiList(interviewerGuide?.hiddenFacts, 8) : fallback.interviewerGuide!.hiddenFacts,
    },
  };
}

async function buildCaseInterview(record: InterviewIntelligenceRecord): Promise<IntelligenceCaseInterview> {
  const fallback = buildFallbackCaseInterview(record);
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const { extractJson } = await import('../shared/utils.js');
  const modelId = process.env.BEDROCK_SONNET_5_PROFILE_ARN || SONNET_5_MODEL_ID;
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  const domain = inferCaseDomain(record);
  const prompt = `
You are a senior interview-design consultant. Create an optional case interview
pack for the selected role. The case must be role-relevant, realistic, and fair.
It must work for any role: engineering, cloud, data, sales, HR, operations,
finance, or leadership. Do not copy the job description. Do not invent employer
facts. Use the JD and resume only to choose the case focus.

The case has two audiences:
1. candidatePack: can be shown to the candidate/interviewer before the case.
2. interviewerGuide: panel-only scoring guidance, probes, strong signals, and red flags.

Return only valid JSON inside <case_json>...</case_json> tags:
{
  "title": "string",
  "difficulty": "foundation|practitioner|senior|principal",
  "format": "string",
  "candidatePack": {
    "scenario": "one concise realistic business scenario",
    "context": ["3-6 useful case facts"],
    "exhibits": [{"title":"string","content":["2-5 bullet facts"],"revealTiming":"initial|on_request"}],
    "tasks": [{"title":"string","instructions":["1-4 instructions"],"expectedDurationMinutes": 10}],
    "deliverables": ["3-5 expected outputs"]
  },
  "interviewerGuide": {
    "competencies": [{"name":"string","whatGoodLooksLike":"string","weakSignals":"string","maxScore":5}],
    "strongAnswerMarkers": ["4-8 markers"],
    "probingQuestions": [{"area":"string","question":"professional interviewer-style question","expectedSignal":"string","redFlag":"string"}],
    "hiddenFacts": ["2-5 panel-only facts or constraints"]
  }
}

Design reference:
- Candidate gets a concise scenario, exhibits, tasks, and deliverables.
- Panel gets strong answer markers, probing questions, red flags, and a rubric.
- Keep it practical; avoid childish generic prompts.
- Use interviewer-style wording: natural, senior, and conversational.

Role: ${record.job.title}
Detected case domain: ${domain.label}
Case type: ${domain.scenarioType}
Difficulty: ${fallback.difficulty}
JD:
${record.job.description.slice(0, 12000)}

Resume:
${(record.candidate.resumeText || 'No resume was supplied.').slice(0, 7000)}
`;
  try {
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), BEDROCK_INTERACTIVE_TIMEOUT_MS);
    let response;
    try {
      response = await client.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(anthropicRequestBody(modelId, prompt, BEDROCK_CASE_TOKENS, 0)),
      }), { abortSignal: abortController.signal });
    } finally {
      clearTimeout(timeout);
    }
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const rawText = getBedrockText(payload);
    return normalizeCaseInterview(parseTaggedJson(rawText, 'case_json', extractJson, payload.stop_reason), record);
  } catch (error) {
    console.warn('Case interview generation used deterministic fallback:', error);
    return fallback;
  }
}

async function generateIntelligenceCaseInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  const caseInterview = await buildCaseInterview(item);
  const updated: InterviewIntelligenceRecord = {
    ...item,
    caseInterview,
    aiEvaluation: undefined,
    status: item.transcript ? 'transcript_ready' : item.questionPlan ? 'questions_generated' : 'data_ready',
    updated_at: Date.now(),
  };
  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
  return successResponse(updated);
}

async function listIntelligenceInterviews(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner AND attribute_not_exists(deleted_at)',
    ExpressionAttributeValues: { ':owner': userId },
  }));

  const items = (result.Items || [])
    .map((item) => item as InterviewIntelligenceRecord)
    .sort((a, b) => b.created_at - a.created_at);

  return successResponse({ items, count: items.length });
}

async function createIntelligenceInterview(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  // Manual candidate/workspace creation is an admin tool (Part E): REVIEWER+.
  // Interviewers reach their own rounds through My Interviews, which provisions
  // without a tier via the panel-membership boundary instead.
  const denied = requireAdminTier(caller, 'REVIEWER');
  if (denied) return denied;

  const body = parseBody(event);
  const sourceMode = body.source_mode === 'keka_live'
      ? 'keka_live'
      : body.source_mode === 'teams_live'
        ? 'teams_live'
        : 'manual';
  const kekaMode = getIntegrationMode(process.env.KEKA_INTEGRATION_MODE);
  const teamsMode = getIntegrationMode(process.env.TEAMS_INTEGRATION_MODE);

  if (sourceMode === 'keka_live') {
    if (kekaMode !== 'live' || teamsMode !== 'live') {
      return errorResponse(
        503,
        'INTEGRATION_NOT_READY',
        'Automatic interview sync is not ready. Keka Hire and Microsoft Teams must both be configured by an administrator.',
      );
    }
  }

  if (sourceMode === 'teams_live' && teamsMode !== 'live') {
    return errorResponse(
      503,
      'INTEGRATION_NOT_READY',
      'Microsoft Teams live sync is not ready. Configure the Microsoft Graph credentials and grant the Teams Application Access Policy to the meeting organiser.',
    );
  }

  let integrationData: Awaited<ReturnType<ReturnType<typeof createKekaIntegration>['getInterviewData']>>;
  if (sourceMode === 'keka_live') {
    try {
      integrationData = await createKekaIntegration('live').getInterviewData({
        jobId: body.jobId,
        candidateId: body.candidateId,
        interviewId: body.interviewId,
      });
    } catch (error: any) {
      console.warn('[Keka Hire] Could not create interview workspace:', error instanceof Error ? error.message : 'Unknown error');
      return errorResponse(502, 'KEKA_SYNC_FAILED', error instanceof KekaIntegrationError ? error.message : 'Keka Hire could not create this interview workspace.');
    }
  } else {
    const panel = Array.isArray(body.panel) ? body.panel : [];
    integrationData = {
      job: {
        title: String(body.job?.title || '').trim(),
        description: String(body.job?.description || '').trim(),
        seniority: String(body.job?.seniority || '').trim() || undefined,
        requiredSkills: normalizeStringArray(body.job?.requiredSkills),
        preferredSkills: normalizeStringArray(body.job?.preferredSkills),
      },
      candidate: {
        name: String(body.candidate?.name || '').trim(),
        email: String(body.candidate?.email || '').trim() || undefined,
        resumeText: String(body.candidate?.resumeText || '').trim() || undefined,
        experienceSummary: String(body.candidate?.experienceSummary || '').trim() || undefined,
      },
      panel: panel.map((member: any, index: number) => ({
        interviewerId: String(member.interviewerId || `panel-${index + 1}`),
        name: String(member.name || `Interviewer ${index + 1}`).trim(),
        email: String(member.email || '').trim() || undefined,
        role: String(member.role || '').trim() || undefined,
        focusArea: String(member.focusArea || '').trim() || undefined,
      })),
      meetingUrl: String(body.meetingUrl || '').trim() || undefined,
      meetingId: String(body.meetingId || '').trim() || undefined,
      scheduledAt: String(body.scheduledAt || '').trim() || undefined,
      organizerUserId: String(body.organizerUserId || '').trim() || undefined,
      organizerEmail: String(body.organizerEmail || '').trim() || undefined,
    };
  }

  if (!integrationData.job.title || !integrationData.job.description || !integrationData.candidate.name) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Job title, job description, and candidate name are required.');
  }

  const { intelligenceId, record, workspaceId } = await provisionIntelligenceRecord({
    caller,
    event,
    integrationData,
    sourceMode,
    kekaIds: { jobId: body.jobId, candidateId: body.candidateId, interviewId: body.interviewId },
  });

  return createdResponse({ intelligence_id: intelligenceId, item: record, workspace_id: workspaceId });
}

/**
 * Builds and persists an InterviewIntelligenceRecord from resolved integration
 * data, then ensures the candidate workspace links to it. Extracted from
 * createIntelligenceInterview (Part A) so two callers share one code path:
 * the admin manual wrapper, and POST /my-interviews/{schedId}/open. The record
 * shape, workspace linking, and best-effort link failure handling are
 * byte-for-byte what createIntelligenceInterview did before the extraction.
 */
async function provisionIntelligenceRecord(params: {
  caller: CallerContext;
  event: APIGatewayProxyEvent;
  integrationData: Awaited<ReturnType<ReturnType<typeof createKekaIntegration>['getInterviewData']>>;
  sourceMode: 'manual' | 'keka_live' | 'teams_live';
  kekaIds?: { jobId?: string; candidateId?: string; interviewId?: string };
  intelligenceId?: string;
}): Promise<{ intelligenceId: string; record: InterviewIntelligenceRecord; workspaceId?: string }> {
  const { caller, event, integrationData, sourceMode, kekaIds } = params;
  const now = Date.now();
  const id = params.intelligenceId || uuidv4();
  const kekaMode = getIntegrationMode(process.env.KEKA_INTEGRATION_MODE);
  const teamsMode = getIntegrationMode(process.env.TEAMS_INTEGRATION_MODE);

  const record: InterviewIntelligenceRecord = {
    intelligence_id: id,
    owner_user_id: caller.userId,
    // Stamped at creation so the UI can name the interviewer without falling
    // back to the opaque Cognito sub.
    owner_email: getAuthenticatedUserEmail(event) ?? undefined,
    created_at: now,
    updated_at: now,
    source_mode: sourceMode,
    status: 'data_ready',
    keka: {
      mode: sourceMode === 'keka_live' ? 'live' : kekaMode,
      jobId: kekaIds?.jobId,
      candidateId: kekaIds?.candidateId,
      interviewId: kekaIds?.interviewId,
      syncStatus: sourceMode === 'keka_live' ? 'synced' : 'not_connected',
      lastSyncAt: sourceMode === 'keka_live' ? now : undefined,
    },
    teams: {
      mode: teamsMode,
      meetingUrl: integrationData.meetingUrl,
      meetingId: integrationData.meetingId,
      scheduledAt: integrationData.scheduledAt,
      organizerUserId: integrationData.organizerUserId,
      organizerEmail: integrationData.organizerEmail,
      transcriptStatus: integrationData.meetingUrl || integrationData.meetingId || (integrationData.scheduledAt && (integrationData.organizerEmail || integrationData.organizerUserId))
        ? 'pending'
        : 'not_available',
    },
    job: {
      ...integrationData.job,
      requiredSkills: integrationData.job.requiredSkills?.length ? integrationData.job.requiredSkills : inferSkills(integrationData.job),
      preferredSkills: integrationData.job.preferredSkills || [],
    },
    candidate: integrationData.candidate,
    panel: integrationData.panel.length ? integrationData.panel : [{ interviewerId: 'panel-1', name: 'Interviewer 1' }],
  };

  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: record }));

  let workspaceId: string | undefined;
  try {
    const ws = await ensureCandidateWorkspace(
      caller,
      integrationData.candidate.name,
      integrationData.job.title,
      id,
      integrationData.candidate.email,
      integrationData.kekaMeetingTitle
    );
    workspaceId = ws?.workspace_id;
  } catch (err) {
    console.error('Failed to link intelligence record to candidate workspace:', err);
  }

  return { intelligenceId: id, record, workspaceId };
}

// ---------------------------------------------------------------------------
// Part A: My Interviews — the interviewer-centric landing.
//
// An interviewer signs in and sees their own scheduled rounds (populated by the
// Keka sync worker), then opens one. No company-wide dropdown, no manual
// workspace creation. The privilege boundary is panel membership: a SCHED row
// exists in SCHED#<my-email> only if my email was on that interview's panel, so
// a caller can only ever address interviews they belong to — no tier needed.
// ---------------------------------------------------------------------------

/** GET /my-interviews — the caller's own scheduled interviews, chronological. */
async function getMyInterviews(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!caller.email) return successResponse({ items: [] });
  const items = await queryScheduledForPanelist(caller.email);
  return successResponse({ items });
}

/**
 * POST /my-interviews/refresh — cheap per-user re-read of the caller's own
 * scheduled rows. Missing Teams links resolve automatically from the organiser
 * calendar at transcript time (inside the Teams integration), so this path
 * deliberately does NOT run a Keka sweep — that is the OWNER-gated
 * POST /admin/keka-sync. Kept as its own route so the UI has an explicit,
 * safe-to-spam refresh that never triggers the expensive company-wide walk.
 */
async function refreshMyInterviews(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!caller.email) return successResponse({ items: [] });
  const items = await queryScheduledForPanelist(caller.email);
  return successResponse({ items });
}

async function scheduledIntelligenceStillExists(intelligenceId: string): Promise<boolean> {
  const result = await ddbDocClient.send(new GetCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    Key: { intelligence_id: intelligenceId },
    ProjectionExpression: 'intelligence_id, deleted_at',
  }));
  const item = result.Item as { deleted_at?: number } | undefined;
  return !!item && !item.deleted_at;
}

/**
 * POST /my-interviews/{schedId}/open — provision the caller's own scheduled
 * interview into the evaluation pipeline. No tier required: panel membership is
 * the boundary (see above). schedId is the Keka interview id. Idempotent — a
 * second open returns the same intelligence_id and provisions nothing new, so a
 * double click never creates a duplicate round.
 */
async function openMyInterview(schedId: string | undefined, event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!caller.email) {
    return errorResponse(403, 'ACCESS_DENIED', 'Your account has no email on record, so no scheduled interviews can be matched to you.');
  }
  const kekaInterviewId = String(schedId || '').trim();
  if (!kekaInterviewId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing scheduled interview id.');

  const row = await findScheduledByInterviewId(caller.email, kekaInterviewId);
  // Absent from the caller's partition => the caller was not on this panel.
  // This is the panel-membership privilege boundary (asserted by test).
  if (!row) return errorResponse(404, 'NOT_FOUND', 'No scheduled interview found for you with that id.');

  // Idempotent: already provisioned => return the existing round, no new work.
  // If the workspace was deleted later, clear the stale pointer so reopening
  // this scheduled interview creates a fresh intelligence record.
  if (row.intelligence_id) {
    if (await scheduledIntelligenceStillExists(row.intelligence_id)) {
      return successResponse({
        intelligence_id: row.intelligence_id,
        workspace_id: row.workspace_id,
        already_provisioned: true,
      });
    }
    await clearScheduledProvisioning(row);
  }

  if (row.cancelled_at) {
    return errorResponse(409, 'INTERVIEW_CANCELLED', 'This interview was cancelled in Keka and cannot be opened.');
  }

  // Same readiness guard as manual keka_live creation.
  const kekaMode = getIntegrationMode(process.env.KEKA_INTEGRATION_MODE);
  const teamsMode = getIntegrationMode(process.env.TEAMS_INTEGRATION_MODE);
  if (kekaMode !== 'live' || teamsMode !== 'live') {
    return errorResponse(
      503,
      'INTEGRATION_NOT_READY',
      'Automatic interview sync is not ready. Keka Hire and Microsoft Teams must both be configured by an administrator.',
    );
  }

  const claimToken = uuidv4();
  const claim = await claimScheduledProvisioning(row, {
    token: claimToken,
    intelligenceId: uuidv4(),
    provisionedBy: caller.userId,
  });
  if (claim.status === 'busy') {
    const fresh = await findScheduledByInterviewId(caller.email, kekaInterviewId);
    if (fresh?.intelligence_id) {
      return successResponse({
        intelligence_id: fresh.intelligence_id,
        workspace_id: fresh.workspace_id,
        already_provisioned: true,
      });
    }
    return errorResponse(409, 'INTERVIEW_PROVISIONING', 'This interview is already being opened. Refresh shortly to continue.');
  }

  let finalized = false;
  let provisioned: { intelligenceId: string; workspaceId?: string } | undefined;
  let cleanupIsSafe = true;
  try {
    let integrationData: Awaited<ReturnType<ReturnType<typeof createKekaIntegration>['getInterviewData']>>;
    try {
      integrationData = await createKekaIntegration('live').getInterviewData({
        jobId: row.keka_job_id,
        candidateId: row.keka_candidate_id,
        interviewId: row.keka_interview_id,
      });
    } catch (error: any) {
      console.warn('[My Interviews] Could not load interview data from Keka:', error instanceof Error ? error.message : 'Unknown error');
      return errorResponse(502, 'KEKA_SYNC_FAILED', error instanceof KekaIntegrationError ? error.message : 'Keka Hire could not load this interview.');
    }

    integrationData = {
      ...integrationData,
      meetingUrl: integrationData.meetingUrl || row.meeting_url,
      meetingId: integrationData.meetingId || row.meeting_id,
      organizerEmail: integrationData.organizerEmail || row.organizer_email,
      organizerUserId: integrationData.organizerUserId || row.organizer_user_id,
    };

    if (!integrationData.job.title || !integrationData.job.description || !integrationData.candidate.name) {
      return errorResponse(422, 'INCOMPLETE_INTERVIEW_DATA', 'This interview is missing the job or candidate details needed to open it. Ask an administrator to complete it in Keka.');
    }

    const { intelligenceId, record, workspaceId } = await provisionIntelligenceRecord({
      caller,
      event,
      integrationData,
      sourceMode: 'keka_live',
      kekaIds: { jobId: row.keka_job_id, candidateId: row.keka_candidate_id, interviewId: row.keka_interview_id },
      intelligenceId: claim.intelligenceId,
    });
    provisioned = { intelligenceId, workspaceId };

    const stamp = await stampScheduledProvisioned(row, {
      token: claimToken,
      intelligenceId,
      workspaceId,
      provisionedBy: caller.userId,
    });
    if (stamp === 'already') {
      const fresh = await findScheduledByInterviewId(caller.email, kekaInterviewId);
      if (fresh?.intelligence_id) {
        finalized = fresh.intelligence_id === intelligenceId;
        return successResponse({
          intelligence_id: fresh.intelligence_id,
          workspace_id: fresh.workspace_id,
          already_provisioned: true,
        });
      }
      return errorResponse(409, 'INTERVIEW_PROVISIONING', 'This interview is already being opened. Refresh shortly to continue.');
    }

    finalized = true;
    return createdResponse({ intelligence_id: intelligenceId, item: record, workspace_id: workspaceId });
  } finally {
    if (!finalized && provisioned) {
      try {
        const fresh = await findScheduledByInterviewId(caller.email, kekaInterviewId);
        finalized = fresh?.intelligence_id === provisioned.intelligenceId;
      } catch (err) {
        console.warn('[My Interviews] Could not verify the provisioning stamp before cleanup:', err);
        cleanupIsSafe = false;
      }
    }
    if (!finalized && cleanupIsSafe) {
      try {
        if (provisioned) {
          await unlinkRecordFromWorkspaces('intelligence', provisioned.intelligenceId, provisioned.workspaceId);
          await ddbDocClient.send(new DeleteCommand({
            TableName: INTELLIGENCE_TABLE_NAME,
            Key: { intelligence_id: provisioned.intelligenceId },
          }));
        }
      } finally {
        await releaseScheduledProvisioning(row, claimToken);
      }
    }
  }
}

async function getIntelligenceInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'READ_INTELLIGENCE',
    targetType: 'intelligence',
  });
  if (response) return response;
  const recovered = await recoverStaleQuestionGeneration(item);
  return successResponse(await refreshTeamsTranscriptionIfNeeded(recovered));
}

const QUESTION_GENERATION_TIMEOUT_MS = 16 * 60 * 1000;

async function recoverStaleQuestionGeneration(
  item: InterviewIntelligenceRecord,
): Promise<InterviewIntelligenceRecord> {
  const isQuestionWorker = item.progress_stage === 'generating_questions'
    || (item.progress_stage === 'queued' && item.status !== 'analysis_processing');
  const startedAt = Number(item.analysis_started_at || 0);
  if (!isQuestionWorker || !startedAt || Date.now() - startedAt <= QUESTION_GENERATION_TIMEOUT_MS) {
    return item;
  }

  const message = 'Question generation timed out before completing. Please retry.';
  await setIntelligenceProgress(item.intelligence_id, 'failed', message);
  return {
    ...item,
    progress_stage: 'failed',
    progress_message: message,
    updated_at: Date.now(),
  };
}

async function deleteIntelligenceInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, userId, response, isOwner } = await getOwnedIntelligenceRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'SOFT_DELETE',
    targetType: 'intelligence',
  });
  if (response) return response;

  // Admin (non-owner) delete is a recoverable soft delete; S3 objects are kept.
  if (!isOwner) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      Key: { intelligence_id: item.intelligence_id },
      UpdateExpression: 'SET deleted_at = :now',
      ExpressionAttributeValues: { ':now': Date.now() },
    }));
    await unlinkRecordFromWorkspaces('intelligence', item.intelligence_id, item.workspace_id);
    return successResponse({ message: 'Interview intelligence workspace deleted successfully' });
  }

  const storageFolder = await resolveUserFolder(event, userId!);
  try {
    await deleteS3Prefix(`users/${storageFolder}/intelligence/${item.intelligence_id}/`);
  } catch (error) {
    console.warn('Intelligence workspace objects could not be removed:', error);
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    Key: { intelligence_id: item.intelligence_id },
  }));
  await unlinkRecordFromWorkspaces('intelligence', item.intelligence_id, item.workspace_id);
  return successResponse({ message: 'Interview intelligence workspace deleted successfully' });
}

async function updateIntelligenceDetails(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'UPDATE_RECORD',
    targetType: 'intelligence',
  });
  if (response) return response;

  const body = parseBody(event);
  const candidateEmail = String(body.candidate_email || '').trim();
  const organizerEmail = String(body.organizer_email || '').trim();
  const updated: InterviewIntelligenceRecord = {
    ...item,
    candidate: {
      ...item.candidate,
      email: candidateEmail || undefined,
    },
    teams: {
      ...item.teams,
      organizerEmail: organizerEmail || item.teams.organizerEmail,
    },
    updated_at: Date.now(),
  };
  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
  return successResponse(updated);
}

async function getIntelligenceResumeUploadUrl(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, userId, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  const body = parseBody(event);
  const fileName = String(body.file_name || '').trim();
  const contentType = String(body.content_type || 'application/octet-stream').trim();
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (!fileName || !extension || !['pdf', 'docx', 'txt'].includes(extension)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Upload a resume as a PDF, DOCX, or TXT file.');
  }

  const userFolder = await resolveUserFolder(event, userId!);
  const s3Key = `users/${userFolder}/intelligence/${item.intelligence_id}/uploads/resume-${Date.now()}.${extension}`;
  const uploadUrl = await getPresignedUploadUrl(BUCKET_NAME, s3Key, contentType);
  return successResponse({ upload_url: uploadUrl, s3_key: s3Key });
}

async function confirmIntelligenceResume(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, userId, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  const body = parseBody(event);
  const s3Key = String(body.s3_key || '').trim();
  const fileName = String(body.file_name || '').trim();
  const userFolder = await resolveUserFolder(event, userId!);
  const expectedPrefix = `users/${userFolder}/intelligence/${item.intelligence_id}/uploads/`;
  if (!s3Key.startsWith(expectedPrefix) || !fileName) {
    return errorResponse(403, 'ACCESS_DENIED', 'The uploaded resume does not belong to this workspace.');
  }

  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: s3Key }));
  } catch {
    return errorResponse(404, 'UPLOAD_ERROR', 'The resume upload was not found. Upload the file again and retry.');
  }

  let resumeText = '';
  try {
    const { extractTextFromBuffer } = await import('../shared/utils.js');
    resumeText = (await extractTextFromBuffer(await getFileBuffer(BUCKET_NAME, s3Key), fileName)).replace(/\s+/g, ' ').trim();
  } catch {
    return errorResponse(422, 'RESUME_READ_FAILED', 'The resume could not be read. Use a text-based PDF, DOCX, or TXT file.');
  }
  if (!resumeText) {
    return errorResponse(422, 'RESUME_READ_FAILED', 'No readable text was found in the resume. Use a text-based PDF, DOCX, or TXT file.');
  }

  if (item.candidate.resumeS3Key && item.candidate.resumeS3Key !== s3Key) {
    await deleteS3ObjectIfExists(item.candidate.resumeS3Key);
  }

  const updated: InterviewIntelligenceRecord = {
    ...item,
    candidate: {
      ...item.candidate,
      resumeS3Key: s3Key,
      resumeFileName: fileName,
      resumeText,
      experienceSummary: item.candidate.experienceSummary || summarizeText(resumeText, ''),
    },
    questionPlan: undefined,
    status: 'data_ready',
    updated_at: Date.now(),
  };
  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
  return successResponse(updated);
}

/**
 * GET /intelligence-interviews/{id}/question-topics
 *
 * Returns the focus areas available for this role so the interviewer can choose
 * what to cover before the guide is generated. Pure bank/JD matching, no model
 * call, so it answers immediately.
 */
async function listIntelligenceQuestionTopics(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  // Part B: the picker shows real, assessable competencies (admin override ->
  // cached AI -> JD extraction -> inferSkills), never the bank's internal
  // topicTag labels. resolveRoleCompetencies caches its AI result, so opening
  // the picker warms the cache for the guide generation that follows.
  const competencies = await resolveRoleCompetencies(item);
  const topics = competencies.map((competency, index) => ({
    topic: competency.name,
    source: competency.source,
    priority: index < 3 ? 'high' : index < 6 ? 'medium' : 'low',
  }));

  return successResponse({
    topics,
    level: detectInterviewLevel(item.job.title || 'Target role', item.job.description || ''),
    suggested_question_count: 8,
    // Topics already covered by earlier rounds for this candidate, so a second
    // panel can deliberately pick different ground.
    previously_covered: await previouslyCoveredTopics(item),
  });
}

/** Focus areas covered by other completed rounds linked to the same workspace. */
async function previouslyCoveredTopics(item: InterviewIntelligenceRecord): Promise<Array<{ topic: string; round: string }>> {
  if (!item.workspace_id) return [];
  try {
    const scan = await ddbDocClient.send(new ScanCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      FilterExpression: 'workspace_id = :ws AND attribute_not_exists(deleted_at)',
      ExpressionAttributeValues: { ':ws': item.workspace_id },
    }));
    const covered: Array<{ topic: string; round: string }> = [];
    for (const row of scan.Items || []) {
      if (row.intelligence_id === item.intelligence_id) continue;
      const roundLabel = row.keka?.title || 'Earlier round';
      for (const topic of row.questionPlan?.selectedTopics || []) {
        covered.push({ topic: String(topic), round: String(roundLabel) });
      }
    }
    return covered;
  } catch (err) {
    console.warn('Could not read previously covered topics:', err);
    return [];
  }
}

async function generateIntelligenceQuestions(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  // The interviewer picks the topics and how many questions fit their slot.
  const body = parseBody(event) as Record<string, unknown>;
  const focusAreas = Array.isArray(body.focus_areas)
    ? body.focus_areas.map((area) => String(area || '').trim()).filter(Boolean).slice(0, 20)
    : undefined;
  const rawCount = Number(body.question_count);
  const questionCount = Number.isFinite(rawCount) && rawCount > 0
    ? Math.max(3, Math.min(Math.round(rawCount), 20))
    : undefined;

  // Building the guide calls Sonnet 5 and legitimately takes longer than API
  // Gateway's 29s response ceiling. Running it inline meant the model was
  // aborted every time and the UI silently served raw question-bank wording,
  // so the work is queued and the client polls for the finished plan.
  const queuedAt = Date.now();
  const queued: InterviewIntelligenceRecord = {
    ...item,
    analysis_started_at: queuedAt,
    progress_stage: 'queued',
    progress_message: 'Queued for question generation...',
    // Fresh log per run, so a re-generated guide does not show the previous
    // attempt's stages and the list cannot grow without bound.
    progress_events: [{ at: queuedAt, stage: 'queued', message: 'Queued for question generation...' }],
    updated_at: queuedAt,
  };
  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: queued }));

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify({
        __internalTask: 'intelligence-questions',
        intelligenceId: item.intelligence_id,
        focusAreas,
        questionCount,
      })),
    }));
    return successResponse(queued);
  } catch (error) {
    console.error('Could not queue interview question generation:', error);
    await setIntelligenceProgress(
      item.intelligence_id,
      'failed',
      'The interview guide could not be started. Please retry.',
    );
    return errorResponse(502, 'QUESTION_GUIDE_QUEUE_FAILED', 'The interview guide could not be started. Please retry.');
  }
}

/** Background worker: builds the question plan without an API Gateway deadline. */
async function runIntelligenceQuestionsWorker(
  intelligenceId: string,
  preferences?: { focusAreas?: string[]; questionCount?: number },
): Promise<APIGatewayProxyResult> {
  if (!intelligenceId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing intelligence workspace id.');

  const result = await ddbDocClient.send(new GetCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    Key: { intelligence_id: intelligenceId },
    ConsistentRead: true,
  }));
  const item = result.Item as InterviewIntelligenceRecord | undefined;
  if (!item) return errorResponse(404, 'NOT_FOUND', 'Intelligence workspace not found.');

  try {
    await setIntelligenceProgress(
      intelligenceId,
      'generating_questions',
      'AI is writing role-specific interview questions. This is the longest step.',
    );

    const questionPlan = await buildQuestionPlan(item, preferences);
    const panel = item.panel.map((member) => {
      const plan = questionPlan.panelPlan.find((entry) => entry.interviewerId === member.interviewerId);
      return {
        ...member,
        focusArea: plan?.focusArea || member.focusArea,
        assignedQuestions: plan?.questions.map((question) => ({
          question: question.question,
          followUps: question.followUps,
          whatToEvaluate: question.whatToEvaluate,
          questionType: question.questionType,
          countsTowardPanelEvaluation: question.countsTowardPanelEvaluation,
        })) || [],
      };
    });

    const updated = {
      ...item,
      panel,
      questionPlan,
      status: 'questions_generated' as const,
      progress_stage: 'done',
      progress_message: 'Interview guide ready.',
      // Dropped on completion. The mid-run entries were appended atomically by
      // setIntelligenceProgress, but `item` was read before they landed, so
      // persisting the spread copy would write a stale partial log. The banner —
      // and with it the log — only renders while the task is in flight, so there
      // is nothing to keep here.
      progress_events: undefined,
      updated_at: Date.now(),
    };

    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
    return successResponse({ intelligence_id: intelligenceId, status: updated.status });
  } catch (error) {
    console.error('Interview question generation failed:', error);
    await setIntelligenceProgress(
      intelligenceId,
      'failed',
      'The interview guide could not be generated. Please retry.',
    );
    return errorResponse(502, 'QUESTION_GUIDE_FAILED', 'The interview guide could not be generated. Please retry.');
  }
}

async function updateIntelligenceTranscript(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'UPDATE_RECORD',
    targetType: 'intelligence',
  });
  if (response) return response;

  const body = parseBody(event);
  let rawText = String(body.rawText || '').trim();
  const source: 'manual' | 'teams_live' = 'manual';
  let meetingId = item.teams.meetingId;

  if (!rawText) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Transcript text is required.');
  }

  const now = Date.now();
  const updated: InterviewIntelligenceRecord = {
    ...item,
    updated_at: now,
    status: 'transcript_ready',
    teams: {
      ...item.teams,
      meetingId,
      transcriptStatus: 'synced',
      lastSyncAt: now,
    },
    transcript: { rawText, source, uploadedAt: now },
  };

  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
  return successResponse(updated);
}

async function syncIntelligenceTeamsTranscript(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  if (item.teams.mode !== 'live') {
    return errorResponse(409, 'INTEGRATION_NOT_READY', 'Microsoft Teams live sync is not enabled for this interview workspace.');
  }

  let itemForSync: InterviewIntelligenceRecord = item;
  const needsKekaRefresh = !!(
    item.keka.mode === 'live' &&
    item.keka.jobId &&
    item.keka.candidateId &&
    item.keka.interviewId &&
    (!item.teams.meetingUrl || !item.teams.meetingId || !item.teams.scheduledAt || (!item.teams.organizerEmail && !item.teams.organizerUserId))
  );

  if (needsKekaRefresh) {
    try {
      const refreshed = await createKekaIntegration('live').getInterviewData({
        jobId: item.keka.jobId,
        candidateId: item.keka.candidateId,
        interviewId: item.keka.interviewId,
      });
      itemForSync = {
        ...item,
        panel: item.panel.length ? item.panel : refreshed.panel,
        teams: {
          ...item.teams,
          meetingUrl: item.teams.meetingUrl || refreshed.meetingUrl,
          meetingId: item.teams.meetingId || refreshed.meetingId,
          scheduledAt: item.teams.scheduledAt || refreshed.scheduledAt,
          organizerUserId: item.teams.organizerUserId || refreshed.organizerUserId,
          organizerEmail: item.teams.organizerEmail || refreshed.organizerEmail,
        },
      };
    } catch (error) {
      console.warn('[Keka Hire] Could not refresh interview metadata before Teams sync:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  if (
    itemForSync.keka.interviewId
    && !itemForSync.teams.meetingUrl
    && !itemForSync.teams.meetingId
  ) {
    try {
      const scheduled = await findScheduledWithMeetingByKekaInterviewId(itemForSync.keka.interviewId);
      if (scheduled) {
        itemForSync = {
          ...itemForSync,
          teams: {
            ...itemForSync.teams,
            meetingUrl: itemForSync.teams.meetingUrl || scheduled.meeting_url,
            meetingId: itemForSync.teams.meetingId || scheduled.meeting_id,
            organizerEmail: itemForSync.teams.organizerEmail || scheduled.organizer_email,
            organizerUserId: itemForSync.teams.organizerUserId || scheduled.organizer_user_id,
            scheduledAt: itemForSync.teams.scheduledAt || new Date(scheduled.scheduled_at).toISOString(),
          },
        };
      }
    } catch (error) {
      console.warn('[My Interviews] Could not backfill Teams meeting metadata from scheduled interview row:', error instanceof Error ? error.message : 'Unknown error');
    }
  }

  const canSearchCalendar = !!(
    itemForSync.teams.scheduledAt &&
    (itemForSync.teams.organizerEmail || itemForSync.teams.organizerUserId)
  );

  if (!itemForSync.teams.meetingUrl && !itemForSync.teams.meetingId && !canSearchCalendar) {
    return errorResponse(400, 'VALIDATION_ERROR', 'This workspace does not have a Teams meeting reference to sync.');
  }

  const now = Date.now();
  try {
    const transcript = await createTeamsIntegration('live').getTranscript({
      meetingUrl: itemForSync.teams.meetingUrl,
      meetingId: itemForSync.teams.meetingId,
      scheduledAt: itemForSync.teams.scheduledAt,
      candidateName: itemForSync.candidate.name,
      candidateEmail: itemForSync.candidate.email,
      jobTitle: itemForSync.job.title,
      organizerUserId: itemForSync.teams.organizerUserId,
      organizerEmail: itemForSync.teams.organizerEmail,
    });

    const updated: InterviewIntelligenceRecord = {
      ...itemForSync,
      updated_at: now,
      status: 'transcript_ready',
      teams: {
        ...itemForSync.teams,
        meetingId: transcript.meetingId || itemForSync.teams.meetingId,
        organizerUserId: transcript.organizerUserId || itemForSync.teams.organizerUserId,
        transcriptStatus: 'synced',
        transcriptSource: 'teams_transcript',
        lastSyncAt: now,
        error: undefined,
      },
      transcript: { rawText: transcript.rawText, source: 'teams_live', uploadedAt: now },
    };

    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
    return successResponse(updated);
  } catch (error) {
    const message = error instanceof TeamsIntegrationError
      ? error.message
      : 'Microsoft Teams transcript sync failed. Please try again or contact your administrator.';
    if (!(error instanceof TeamsIntegrationError) || !error.recordingFallbackAllowed) {
      const failed: InterviewIntelligenceRecord = {
        ...itemForSync,
        updated_at: now,
        teams: {
          ...itemForSync.teams,
          transcriptStatus: 'failed',
          lastSyncAt: now,
          error: message,
        },
      };
      await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: failed }));
      return errorResponse(502, 'TEAMS_SYNC_FAILED', message);
    }
    const queued: InterviewIntelligenceRecord = {
      ...itemForSync,
      updated_at: now,
      teams: {
        ...itemForSync.teams,
        transcriptStatus: 'transcribing',
        lastSyncAt: now,
        error: undefined,
      },
    };
    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: queued }));

    try {
      await lambdaClient.send(new InvokeCommand({
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
        InvocationType: 'Event',
        Payload: new TextEncoder().encode(JSON.stringify({
          __internalTask: 'teams-recording-transcription',
          intelligenceId: itemForSync.intelligence_id,
        })),
      }));
      return successResponse(queued);
    } catch (queueError) {
      console.error('Could not queue Teams recording transcription fallback:', queueError);
      const failed: InterviewIntelligenceRecord = {
        ...itemForSync,
        updated_at: now,
        teams: {
          ...itemForSync.teams,
          transcriptStatus: 'failed',
          lastSyncAt: now,
          error: `${message} Recording fallback could not be started.`,
        },
      };
      await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: failed }));
      return errorResponse(502, 'TEAMS_SYNC_FAILED', failed.teams.error || message);
    }
  }
}

async function runTeamsRecordingTranscriptionWorker(intelligenceId: string): Promise<APIGatewayProxyResult> {
  if (!intelligenceId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing intelligence workspace id.');

  const result = await ddbDocClient.send(new GetCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    Key: { intelligence_id: intelligenceId },
    ConsistentRead: true,
  }));
  const item = result.Item as InterviewIntelligenceRecord | undefined;
  if (!item) return errorResponse(404, 'NOT_FOUND', 'Intelligence workspace not found.');
  if (item.transcript?.rawText) return successResponse(item);

  const now = Date.now();
  const workerToken = uuidv4();
  const staleWorkerBefore = now - 16 * 60 * 1000;
  let recordingKey: string | undefined;
  let outputKey: string | undefined;
  let jobName: string | undefined;
  let transcribeStarted = false;

  try {
    const claim = await ddbDocClient.send(new UpdateCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      Key: { intelligence_id: intelligenceId },
      UpdateExpression: 'SET #teams.#workerToken = :workerToken, #teams.#workerStartedAt = :now, #teams.#lastSyncAt = :now, #updatedAt = :now',
      ConditionExpression: '#teams.#transcriptStatus = :transcribing AND attribute_not_exists(#transcript.#rawText) AND (attribute_not_exists(#teams.#workerToken) OR #teams.#workerStartedAt < :staleBefore)',
      ExpressionAttributeNames: {
        '#teams': 'teams',
        '#transcriptStatus': 'transcriptStatus',
        '#transcript': 'transcript',
        '#rawText': 'rawText',
        '#workerToken': 'recordingWorkerToken',
        '#workerStartedAt': 'recordingWorkerStartedAt',
        '#lastSyncAt': 'lastSyncAt',
        '#updatedAt': 'updated_at',
      },
      ExpressionAttributeValues: {
        ':transcribing': 'transcribing',
        ':workerToken': workerToken,
        ':now': now,
        ':staleBefore': staleWorkerBefore,
      },
      ReturnValues: 'ALL_NEW',
    }));
    const claimedItem = (claim.Attributes as InterviewIntelligenceRecord | undefined) || {
      ...item,
      updated_at: now,
      teams: {
        ...item.teams,
        recordingWorkerToken: workerToken,
        recordingWorkerStartedAt: now,
        lastSyncAt: now,
      },
    };

    const recording = await createTeamsIntegration('live').getRecording({
      meetingUrl: claimedItem.teams.meetingUrl,
      meetingId: claimedItem.teams.meetingId,
      scheduledAt: claimedItem.teams.scheduledAt,
      candidateName: claimedItem.candidate.name,
      candidateEmail: claimedItem.candidate.email,
      jobTitle: claimedItem.job.title,
      organizerUserId: claimedItem.teams.organizerUserId,
      organizerEmail: claimedItem.teams.organizerEmail,
    });

    const storageFolder = intelligenceStorageFolder(claimedItem);
    recordingKey = `users/${storageFolder}/intelligence/${claimedItem.intelligence_id}/teams-recordings/${Date.now()}-${recording.recordingId.replace(/[^a-zA-Z0-9._-]+/g, '-')}.${recording.extension}`;
    outputKey = `users/${storageFolder}/intelligence/${claimedItem.intelligence_id}/transcripts/${Date.now()}-aws-transcribe.json`;
    jobName = `mimo-${claimedItem.intelligence_id}-${Date.now()}`.replace(/[^0-9A-Za-z._-]+/g, '-').slice(0, 190);

    await saveFileContent(
      BUCKET_NAME,
      recordingKey,
      recording.stream,
      recording.contentType,
      recording.contentLength,
    );
    await transcribeClient.send(new StartTranscriptionJobCommand({
      TranscriptionJobName: jobName,
      LanguageCode: 'en-US',
      MediaFormat: transcribeMediaFormat(recording.extension),
      Media: { MediaFileUri: `s3://${BUCKET_NAME}/${recordingKey}` },
      OutputBucketName: BUCKET_NAME,
      OutputKey: outputKey,
      Settings: {
        ShowSpeakerLabels: true,
        MaxSpeakerLabels: 10,
      },
    }));
    transcribeStarted = true;

    const completedAt = Date.now();
    const update = await ddbDocClient.send(new UpdateCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      Key: { intelligence_id: intelligenceId },
      UpdateExpression: 'SET #teams.#meetingId = :meetingId, #teams.#organizerUserId = :organizerUserId, #teams.#transcriptStatus = :transcribing, #teams.#source = :source, #teams.#recordingId = :recordingId, #teams.#recordingKey = :recordingKey, #teams.#jobName = :jobName, #teams.#outputKey = :outputKey, #teams.#lastSyncAt = :now, #updatedAt = :now REMOVE #teams.#error, #teams.#workerToken, #teams.#workerStartedAt',
      ConditionExpression: '#teams.#workerToken = :workerToken AND #teams.#transcriptStatus = :transcribing AND attribute_not_exists(#transcript.#rawText)',
      ExpressionAttributeNames: {
        '#teams': 'teams', '#meetingId': 'meetingId', '#organizerUserId': 'organizerUserId',
        '#transcriptStatus': 'transcriptStatus', '#source': 'transcriptSource', '#recordingId': 'recordingId',
        '#recordingKey': 'recordingS3Key', '#jobName': 'transcribeJobName', '#outputKey': 'transcribeOutputKey',
        '#lastSyncAt': 'lastSyncAt', '#updatedAt': 'updated_at', '#error': 'error',
        '#workerToken': 'recordingWorkerToken', '#workerStartedAt': 'recordingWorkerStartedAt',
        '#transcript': 'transcript', '#rawText': 'rawText',
      },
      ExpressionAttributeValues: {
        ':meetingId': recording.meetingId || claimedItem.teams.meetingId || '',
        ':organizerUserId': recording.organizerUserId || claimedItem.teams.organizerUserId || '',
        ':transcribing': 'transcribing', ':source': 'teams_recording_transcribe',
        ':recordingId': recording.recordingId, ':recordingKey': recordingKey,
        ':jobName': jobName, ':outputKey': outputKey, ':now': completedAt,
        ':workerToken': workerToken,
      },
      ReturnValues: 'ALL_NEW',
    }));
    const updated = (update.Attributes as InterviewIntelligenceRecord | undefined) || {
      ...claimedItem,
      updated_at: completedAt,
      teams: {
        ...claimedItem.teams,
        meetingId: recording.meetingId || claimedItem.teams.meetingId,
        organizerUserId: recording.organizerUserId || claimedItem.teams.organizerUserId,
        transcriptStatus: 'transcribing',
        transcriptSource: 'teams_recording_transcribe',
        recordingId: recording.recordingId,
        recordingS3Key: recordingKey,
        transcribeJobName: jobName,
        transcribeOutputKey: outputKey,
        lastSyncAt: completedAt,
        error: undefined,
        recordingWorkerToken: undefined,
        recordingWorkerStartedAt: undefined,
      },
    };
    return successResponse(updated);
  } catch (error: any) {
    if (error?.name === 'ConditionalCheckFailedException') {
      if (transcribeStarted) await cancelTranscriptionJobIfStarted(jobName);
      await deleteS3ObjectIfExists(recordingKey);
      await deleteS3ObjectIfExists(outputKey);
      const latest = await ddbDocClient.send(new GetCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: intelligenceId },
        ConsistentRead: true,
      }));
      return successResponse((latest.Item as InterviewIntelligenceRecord | undefined) || item);
    }

    if (transcribeStarted) await cancelTranscriptionJobIfStarted(jobName);
    await deleteS3ObjectIfExists(recordingKey);
    await deleteS3ObjectIfExists(outputKey);
    const failedAt = Date.now();
    const message = error instanceof TeamsIntegrationError
      ? error.message
      : 'Teams recording fallback failed before AWS Transcribe could start.';
    try {
      await ddbDocClient.send(new UpdateCommand({
        TableName: INTELLIGENCE_TABLE_NAME,
        Key: { intelligence_id: intelligenceId },
        UpdateExpression: 'SET #teams.#transcriptStatus = :failed, #teams.#lastSyncAt = :now, #teams.#error = :error, #updatedAt = :now REMOVE #teams.#workerToken, #teams.#workerStartedAt',
        ConditionExpression: '#teams.recordingWorkerToken = :workerToken AND #teams.#transcriptStatus = :transcribing AND attribute_not_exists(#transcript.#rawText)',
        ExpressionAttributeNames: {
          '#teams': 'teams', '#transcriptStatus': 'transcriptStatus', '#lastSyncAt': 'lastSyncAt',
          '#error': 'error', '#updatedAt': 'updated_at', '#workerToken': 'recordingWorkerToken',
          '#workerStartedAt': 'recordingWorkerStartedAt', '#transcript': 'transcript', '#rawText': 'rawText',
        },
        ExpressionAttributeValues: {
          ':failed': 'failed', ':transcribing': 'transcribing', ':now': failedAt,
          ':error': message, ':workerToken': workerToken,
        },
      }));
    } catch (updateError: any) {
      if (updateError?.name !== 'ConditionalCheckFailedException') throw updateError;
    }
    return errorResponse(502, 'TEAMS_RECORDING_TRANSCRIBE_FAILED', message);
  }
}

async function updateIntelligenceScores(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event, {
    minTier: 'OWNER',
    auditAction: 'UPDATE_RECORD',
    targetType: 'intelligence',
  });
  if (response) return response;

  const body = parseBody(event);
  const scores = Array.isArray(body.panel) ? body.panel : [];
  const panel = item.panel.map((member) => {
    const score = scores.find((entry: any) => entry.interviewerId === member.interviewerId);
    if (!score) return member;
    const numericScore = Number(score.score);
    return {
      ...member,
      score: Number.isFinite(numericScore) ? Math.max(0, Math.min(10, numericScore)) : undefined,
      feedback: String(score.feedback || '').trim() || undefined,
      opinion: ['proceed', 'hold', 'reject', 'needs_review'].includes(score.opinion) ? score.opinion : undefined,
    };
  });

  const updated: InterviewIntelligenceRecord = {
    ...item,
    panel,
    status: 'scores_submitted',
    updated_at: Date.now(),
  };

  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
  return successResponse(updated);
}

function countRoleQuestionsAsked(transcript: string, member: IntelligencePanelist, skills: string[]): number {
  const name = member.name.split(' ')[0].toLowerCase();
  const segments = transcript.toLowerCase().split(/(?<=[.?!])\s+/);
  return segments.filter((segment) => {
    if (!segment.includes(name) || !segment.includes('?')) return false;
    return skills.some((skill) => segment.includes(skill.toLowerCase()));
  }).length;
}

function analyzeCoverage(skills: string[], transcript: string): IntelligenceCoverageMatrix {
  const lower = transcript.toLowerCase();
  return skills.map((skill) => {
    const found = lower.includes(skill.toLowerCase());
    return {
      jdSkill: skill,
      covered: found ? 'yes' : 'partial',
      evidence: found ? `Transcript contains discussion related to ${skill}.` : `No direct ${skill} keyword found; review manually for indirect evidence.`,
      askedBy: [],
    };
  });
}

async function legacyAnalyzeIntelligenceInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  if (!item.questionPlan) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Generate pre-interview questions before running analysis.');
  }
  if (!item.transcript?.rawText) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Transcript is required before analysis.');
  }

  const transcript = item.transcript.rawText;
  // Part B: assess coverage against the round's real competencies, consistent
  // with the guide and report (cache hit — the guide already resolved them).
  const skills = (await resolveRoleCompetencies(item)).map((competency) => competency.name);
  const coverageMatrix = analyzeCoverage(skills, transcript);
  const coveredCount = coverageMatrix.filter((entry) => entry.covered === 'yes').length;
  const coveragePercent = Math.round((coveredCount / Math.max(1, coverageMatrix.length)) * 100);
  const scores = item.panel.map((member) => member.score).filter((score): score is number => typeof score === 'number');
  const averageScore = scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : undefined;
  const recommendation = averageScore === undefined
    ? 'needs_review'
    : averageScore >= 7.5 && coveragePercent >= 50
      ? 'proceed'
      : averageScore >= 5.5
        ? 'hold'
        : 'reject';

  const interviewerEvaluations = item.panel.map((member) => {
    // Opening and resume questions are intentionally excluded: interviewer quality
    // is assessed from role-specific coverage only.
    const questionsAskedCount = countRoleQuestionsAsked(transcript, member, skills);
    const assignedRoleQuestions = item.questionPlan?.panelPlan
      .find((plan) => plan.interviewerId === member.interviewerId)?.questions
      .filter((question) => question.countsTowardPanelEvaluation !== false).length || 0;
    const jdCoveragePercent = assignedRoleQuestions ? Math.min(100, Math.round((questionsAskedCount / assignedRoleQuestions) * 100)) : coveragePercent;
    return {
      interviewerId: member.interviewerId,
      name: member.name,
      panelScore: Math.max(0, Math.min(10, Math.round((jdCoveragePercent / 10) + (questionsAskedCount >= 2 ? 1 : questionsAskedCount ? 0 : -1)))),
      panelScoreReason: 'Calculated from role-question coverage and transcript-visible follow-up depth.',
      questionsAskedCount,
      jdCoveragePercent,
      followUpQuality: questionsAskedCount >= 2 ? 'strong' as const : questionsAskedCount === 1 ? 'average' as const : 'not_enough_data' as const,
      scoreJustification: member.score === undefined
        ? 'not_available' as const
        : member.feedback && member.feedback.length > 40
          ? 'well_supported' as const
          : 'partially_supported' as const,
      observations: [
        questionsAskedCount > 0 ? `${member.name} asked transcript-visible questions.` : `${member.name} has limited visible question evidence in the transcript.`,
        member.feedback ? 'Manual feedback was provided for calibration.' : 'Manual feedback was not provided.',
      ],
      missedAreas: coverageMatrix.filter((entry) => entry.covered !== 'yes').slice(0, 3).map((entry) => entry.jdSkill),
    };
  });

  const panelCalibration = item.panel.length > 1 && scores.length > 1 ? (() => {
    const max = Math.max(...scores);
    const min = Math.min(...scores);
    const avg = scores.reduce((sum, score) => sum + score, 0) / scores.length;
    const outliers = item.panel
      .filter((member) => typeof member.score === 'number' && Math.abs(member.score - avg) >= 3)
      .map((member) => ({
        interviewerId: member.interviewerId,
        name: member.name,
        score: member.score!,
        reason: 'Score differs materially from the panel average and should be reviewed with transcript evidence.',
      }));
    return {
      panelSize: item.panel.length,
      scoreSpread: max - min,
      outliers,
      summary: max - min >= 4
        ? 'Panel scores show a wide spread. Human calibration discussion is recommended before a final decision.'
        : 'Panel scores are reasonably aligned. Review transcript evidence before final approval.',
      humanReviewRequired: outliers.length > 0 || max - min >= 4,
    };
  })() : undefined;

  const aiEvaluation: InterviewIntelligenceRecord['aiEvaluation'] = {
    generatedAt: Date.now(),
    candidateEvaluation: {
      summary: `${item.candidate.name} was evaluated for ${item.job.title}. The analysis compares JD coverage, transcript evidence, and human interviewer scoring.`,
      strengths: coverageMatrix.filter((entry) => entry.covered === 'yes').slice(0, 4).map((entry) => `Evidence found for ${entry.jdSkill}.`),
      concerns: coverageMatrix.filter((entry) => entry.covered !== 'yes').slice(0, 4).map((entry) => `${entry.jdSkill} requires more explicit evidence.`),
      skillScores: coverageMatrix.map((entry) => ({
        skill: entry.jdSkill,
        score: entry.covered === 'yes' ? 8 : 5,
        evidence: entry.evidence,
      })),
      recommendation,
      recommendationReason: averageScore === undefined
        ? 'Human scores were not fully available, so the final recommendation requires reviewer judgment.'
        : `Average panel score is ${averageScore.toFixed(1)}/10 with ${coveragePercent}% JD keyword coverage.`,
    },
    interviewerEvaluations,
    coverageMatrix,
    panelCalibration,
    finalReport: [
      `AI-assisted interview intelligence report for ${item.candidate.name} (${item.job.title}).`,
      `Recommendation: ${recommendation}. Final hiring decision requires human review.`,
      `JD coverage: ${coveragePercent}%.`,
      averageScore === undefined ? 'Panel score: not fully available.' : `Panel average score: ${averageScore.toFixed(1)}/10.`,
      panelCalibration?.summary || 'Single-interviewer mode: outlier comparison was not run; coverage and score justification were reviewed.',
    ].join('\n\n'),
  };

  const updated: InterviewIntelligenceRecord = {
    ...item,
    aiEvaluation,
    status: 'analysis_generated',
    updated_at: Date.now(),
  };

  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
  return successResponse(updated);
}

function cleanAiText(value: unknown, fallback: string): string {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function cleanAiList(value: unknown, limit = 8): string[] {
  return Array.isArray(value)
    ? value.map((entry) => String(entry ?? '').trim()).filter(Boolean).slice(0, limit)
    : [];
}

function cleanAiEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const candidate = String(value ?? '').trim() as T;
  return allowed.includes(candidate) ? candidate : fallback;
}

function cleanAiScore(value: unknown): number {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(10, Math.round(score * 10) / 10)) : 0;
}

function cleanAiPercent(value: unknown): number {
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.max(0, Math.min(100, Math.round(percent))) : 0;
}

function sanitizeProfessionalConcern(value: string): string {
  return value
    .replace(/\b(divorce|medical|illness|health|family|personal)\b[^.]*\.?/gi, 'Additional role-related evidence should be reviewed.')
    .replace(/\s+/g, ' ')
    .trim();
}

const CANDIDATE_RECOMMENDATIONS = [
  'strongly_recommend',
  'recommend',
  'proceed_with_reservations',
  'additional_assessment_required',
  'not_recommended',
  'strongly_not_recommended',
  'proceed',
  'hold',
  'reject',
  'needs_review',
] as const;
const COMPETENCY_STATUSES = [
  'exceeds_standard',
  'meets_standard',
  'partially_demonstrated',
  'below_standard',
  'not_assessed',
] as const;
const EVIDENCE_CONFIDENCES = ['high', 'medium', 'low'] as const;

function normalizeCandidateRecommendation(value: unknown, fallback: CandidateRecommendation = 'additional_assessment_required'): CandidateRecommendation {
  const raw = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (raw === 'proceed') return 'recommend';
  if (raw === 'hold' || raw === 'needs_review') return 'additional_assessment_required';
  if (raw === 'reject') return 'not_recommended';
  return cleanAiEnum(raw, CANDIDATE_RECOMMENDATIONS, fallback);
}

function isMissingEvidenceText(value: string): boolean {
  return /\b(not assessed|not asked|no suitable question|missing evidence|insufficient evidence|not covered|not discussed|no explicit evidence)\b/i.test(value);
}

function competencyStatusFromCoverage(entry: { covered: 'yes' | 'partial' | 'no'; evidence: string }, scoreValue?: number): CompetencyRating['status'] {
  if (entry.covered === 'yes') return (scoreValue ?? 0) >= 8.5 ? 'exceeds_standard' : 'meets_standard';
  if (entry.covered === 'partial') return 'partially_demonstrated';
  return isMissingEvidenceText(entry.evidence) ? 'not_assessed' : 'below_standard';
}

function normalizeCompetencyRatings(value: unknown, coverageMatrix: IntelligenceCoverageMatrix): CompetencyRating[] {
  const source = Array.isArray(value) && value.length
    ? value.slice(0, 5)
    : coverageMatrix.slice(0, 5).map((entry) => ({
      competency: entry.jdSkill,
      requirement: entry.jdSkill,
      status: competencyStatusFromCoverage(entry),
      rating: entry.covered === 'yes' ? 8 : entry.covered === 'partial' ? 5 : null,
      questionAsked: entry.askedBy?.length ? `Question asked by ${entry.askedBy.join(', ')}` : 'Not assessed',
      relevantResponse: entry.evidence,
      followUpProbes: [],
      performanceBenchmark: `Demonstrates role-ready capability for ${entry.jdSkill} with concrete examples, trade-offs, and outcomes.`,
      ratingJustification: entry.evidence,
      evidenceConfidence: entry.covered === 'yes' ? 'high' : entry.covered === 'partial' ? 'medium' : 'low',
      requiredFollowUp: entry.covered === 'yes' ? 'None' : `Run a focused follow-up assessment for ${entry.jdSkill}.`,
    }));

  return source.map((entry: any, index: number) => {
    const fallback = coverageMatrix[index] || coverageMatrix[0];
    const status = cleanAiEnum(
      String(entry?.status ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_'),
      COMPETENCY_STATUSES,
      fallback ? competencyStatusFromCoverage(fallback) : 'not_assessed',
    );
    const rating = status === 'not_assessed'
      ? null
      : Number.isFinite(Number(entry?.rating))
        ? cleanAiScore(entry.rating)
        : fallback?.covered === 'yes'
          ? 8
          : fallback?.covered === 'partial'
            ? 5
            : 3;
    return {
      competency: cleanAiText(entry?.competency || fallback?.jdSkill, 'Role competency'),
      requirement: cleanAiText(entry?.requirement || fallback?.jdSkill, 'Role requirement'),
      status,
      rating,
      questionAsked: cleanAiText(entry?.questionAsked, status === 'not_assessed' ? 'Not assessed' : 'Question evidence was not returned.'),
      relevantResponse: cleanAiText(entry?.relevantResponse || fallback?.evidence, status === 'not_assessed' ? 'Not assessed' : 'Response evidence was not returned.'),
      followUpProbes: cleanAiList(entry?.followUpProbes, 4),
      performanceBenchmark: cleanAiText(entry?.performanceBenchmark, 'Candidate should provide a concrete, role-relevant example with ownership, trade-offs, validation, and outcome.'),
      ratingJustification: sanitizeProfessionalConcern(cleanAiText(entry?.ratingJustification || fallback?.evidence, 'Evidence was not sufficient for a firm rating.')),
      evidenceConfidence: cleanAiEnum(entry?.evidenceConfidence, EVIDENCE_CONFIDENCES, status === 'not_assessed' ? 'low' : 'medium'),
      requiredFollowUp: cleanAiText(entry?.requiredFollowUp, status === 'not_assessed' ? 'Ask a focused role-specific follow-up question before deciding.' : 'None'),
    };
  });
}

function coveragePercentFromMatrix(matrix: Array<{ covered: 'yes' | 'partial' | 'no' }>): number {
  if (!matrix.length) return 0;
  const points = matrix.reduce((sum, entry) => sum + (entry.covered === 'yes' ? 1 : entry.covered === 'partial' ? 0.5 : 0), 0);
  return Math.round((points / matrix.length) * 100);
}

function deriveCandidateScore(input: {
  modelScore: unknown;
  skillScores: Array<{ score: number }>;
  coverageMatrix: Array<{ covered: 'yes' | 'partial' | 'no' }>;
  competencyRatings?: Array<{ rating: number | null }>;
  recommendation: string;
}): number {
  const explicit = Number(input.modelScore);
  if (Number.isFinite(explicit)) return cleanAiScore(explicit);
  const assessedRatings = (input.competencyRatings || [])
    .map((entry) => Number(entry.rating))
    .filter((value) => Number.isFinite(value));
  if (assessedRatings.length) {
    return cleanAiScore(assessedRatings.reduce((sum, value) => sum + value, 0) / assessedRatings.length);
  }
  const averageSkillScore = input.skillScores.length
    ? input.skillScores.reduce((sum, entry) => sum + cleanAiScore(entry.score), 0) / input.skillScores.length
    : 0;
  const coverageScore = coveragePercentFromMatrix(input.coverageMatrix) / 10;
  const baseScore = averageSkillScore || coverageScore;
  const recommendationAdjustment =
    input.recommendation === 'strongly_recommend' ? 0.7 :
      input.recommendation === 'recommend' || input.recommendation === 'proceed' ? 0.4 :
        input.recommendation === 'not_recommended' || input.recommendation === 'strongly_not_recommended' || input.recommendation === 'reject' ? -0.8 :
          input.recommendation === 'proceed_with_reservations' || input.recommendation === 'hold' ? -0.3 :
          0;
  return cleanAiScore(baseScore + recommendationAdjustment);
}

async function analyzeIntelligenceInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  if (!item.questionPlan) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Generate pre-interview questions before running analysis.');
  }
  if (!item.transcript?.rawText) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Transcript is required before analysis.');
  }

  if (item.aiEvaluation) {
    return successResponse(item);
  }

  // Already running. Re-read so the caller always gets the stamped
  // analysis_started_at and the current stage — returning the pre-stamp item
  // here left the UI with no start time, freezing the elapsed timer at 0:00.
  if (item.status === 'analysis_processing') {
    const current = await ddbDocClient.send(new GetCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      Key: { intelligence_id: item.intelligence_id },
      ConsistentRead: true,
    }));
    return successResponse(current.Item || item);
  }

  const queuedAt = Date.now();
  const queued: InterviewIntelligenceRecord = {
    ...item,
    status: 'analysis_processing',
    analysisError: undefined,
    // Stamped once and never rewritten so the elapsed timer is stable across
    // refreshes; updated_at moves on every progress write and cannot be used.
    analysis_started_at: queuedAt,
    progress_stage: 'queued',
    progress_message: 'Queued for AI review...',
    // Fresh log per run — see setIntelligenceProgress.
    progress_events: [{ at: queuedAt, stage: 'queued', message: 'Queued for AI review...' }],
    updated_at: queuedAt,
  };
  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: queued }));

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify({
        __internalTask: 'intelligence-analysis',
        intelligenceId: item.intelligence_id,
      })),
    }));
    return successResponse(queued);
  } catch (error) {
    console.error('Could not queue intelligence AI review:', error);
    const failed: InterviewIntelligenceRecord = {
      ...queued,
      status: 'analysis_failed',
      analysisError: 'The AI review could not be started. Please retry.',
      updated_at: Date.now(),
    };
    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: failed }));
    return errorResponse(502, 'AI_ANALYSIS_QUEUE_FAILED', failed.analysisError || 'The AI review could not be started. Please retry.');
  }
}

/**
 * Records which phase the AI review is actually in.
 *
 * Best-effort by design: a failed progress write must never fail the analysis
 * itself, so errors are logged and swallowed. Only the progress attributes and
 * updated_at are touched — the record's status and results are untouched.
 *
 * Each transition is also appended to progress_events, which is what the UI
 * renders as an activity log. progress_stage/progress_message only ever hold the
 * current phase, so without the list there is no history to show. The list is
 * reset when a run is queued, so it stays bounded to one run rather than growing
 * across every re-analysis of the same record.
 */
async function setIntelligenceProgress(
  intelligenceId: string,
  stage: string,
  message: string,
): Promise<void> {
  const now = Date.now();
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: INTELLIGENCE_TABLE_NAME,
      Key: { intelligence_id: intelligenceId },
      UpdateExpression: 'SET progress_stage = :s, progress_message = :m, updated_at = :now, '
        + 'progress_events = list_append(if_not_exists(progress_events, :empty), :event)',
      ExpressionAttributeValues: {
        ':s': stage,
        ':m': message,
        ':now': now,
        ':empty': [] as ProgressEvent[],
        ':event': [{ at: now, stage, message }] as ProgressEvent[],
      },
    }));
  } catch (err) {
    console.warn(`Could not record progress (${stage}) for ${intelligenceId}:`, err);
  }
}

async function runIntelligenceAnalysisWorker(intelligenceId: string): Promise<APIGatewayProxyResult> {
  if (!intelligenceId) return errorResponse(400, 'VALIDATION_ERROR', 'Missing intelligence workspace id.');

  const result = await ddbDocClient.send(new GetCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    Key: { intelligence_id: intelligenceId },
    ConsistentRead: true,
  }));
  const item = result.Item as InterviewIntelligenceRecord | undefined;
  if (!item) return errorResponse(404, 'NOT_FOUND', 'Intelligence workspace not found.');
  if (!item.questionPlan || !item.transcript?.rawText) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Interview guide and transcript are required before analysis.');
  }

  try {
    await setIntelligenceProgress(
      intelligenceId,
      'preparing',
      'Reading transcript, resume, job description, and panel guide...',
    );
    await setIntelligenceProgress(
      intelligenceId,
      'evaluating',
      'AI is evaluating candidate responses against role competencies. This is the longest step.',
    );
    const aiEvaluation = await generateIntelligenceEvaluation(item, 300_000);

    await setIntelligenceProgress(intelligenceId, 'saving', 'Saving the completed review...');
    const updated: InterviewIntelligenceRecord = {
      ...item,
      aiEvaluation,
      analysisError: undefined,
      status: 'analysis_generated',
      progress_stage: 'done',
      progress_message: 'Review complete.',
      // Dropped on completion — see the question worker for why the spread copy
      // cannot carry the mid-run log.
      progress_events: undefined,
      updated_at: Date.now(),
    };
    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
    return successResponse({ intelligence_id: intelligenceId, status: updated.status });
  } catch (error) {
    console.error('Intelligence background AI review failed:', error);
    const message = error instanceof Error ? error.message : String(error || '');
    const analysisError = message.includes('AI_OUTPUT_TRUNCATED')
      ? 'The AI response was incomplete for this long interview. The review token budget has been increased; please retry.'
      : 'The AI review could not be completed. Please retry.';
    const failed: InterviewIntelligenceRecord = {
      ...item,
      status: 'analysis_failed',
      analysisError,
      updated_at: Date.now(),
    };
    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: failed }));
    return errorResponse(502, 'AI_ANALYSIS_FAILED', failed.analysisError || 'The AI review could not be completed. Please retry.');
  }
}

async function generateIntelligenceEvaluation(item: InterviewIntelligenceRecord, timeoutMs = 300_000): Promise<IntelligenceEvaluation> {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const { extractJson } = await import('../shared/utils.js');
  const modelId = process.env.BEDROCK_SONNET_5_PROFILE_ARN || SONNET_5_MODEL_ID;
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  // Keep the synchronous browser request inside API Gateway's response window.
  // The selected excerpts still cover the interview evidence, role context,
  // and guide without making Sonnet wait on a needlessly large prompt.
  // Part B: resolve once so the coverage-matrix fallback labels are real
  // competencies, consistent with the guide. Cache hit at analysis time (the
  // guide already resolved them), so no extra model call on the happy path.
  const competencyNames = (await resolveRoleCompetencies(item, { timeoutMs })).map((competency) => competency.name);
  const transcript = item.transcript?.rawText.slice(0, 26000) || '';
  const resume = (item.candidate.resumeText || '').slice(0, 9000);
  const jobDescription = item.job.description.slice(0, 12000);
  const questionPlan = JSON.stringify(item.questionPlan?.panelPlan || []).slice(0, 16000);
  const caseInterview = JSON.stringify(item.caseInterview || null).slice(0, 14000);
  const panel = JSON.stringify(item.panel.map((member) => ({
    interviewerId: member.interviewerId,
    name: member.name,
    role: member.role,
    focusArea: member.focusArea,
  }))).slice(0, 5000);
  const prompt = `
You are a senior hiring reviewer producing an evidence-based interview decision
report. Analyze one completed interview using only facts supported by the job
description, resume, approved interview guide, case pack, panel data, and
transcript. Return only valid JSON inside <intelligence_json>...</intelligence_json> tags.

Core evaluation rules:
1. Evaluate the candidate firmly and only against job-related competencies from
the supplied role context. Do not soften a negative conclusion when the
transcript contains adequate role-related evidence.
2. Do not treat missing evidence as candidate failure. If the panel did not ask
an adequate question or give a reasonable follow-up opportunity, mark that
competency "not_assessed", set rating to null, reduce JD coverage and decision
confidence, and explain what follow-up is required.
3. Candidate performance and interview-process quality are independent. A poor
interview can still support "not_recommended" when direct adequate evidence is
negative. A poor interview with missing coverage must produce
"additional_assessment_required".
4. Do not use personality impressions, career gaps, marital status, medical or
family history, age, accent, commute, or other non-job-related personal data as
negative evidence. Convert such material into neutral job-related verification
needs or omit it.
5. "Human review completed" is an audit status. Never convert it into
"Candidate approved". Human approval remains required.

Candidate recommendation must be exactly one of:
strongly_recommend, recommend, proceed_with_reservations,
additional_assessment_required, not_recommended, strongly_not_recommended.

Use these competency statuses exactly:
exceeds_standard, meets_standard, partially_demonstrated, below_standard,
not_assessed.

For every competency rating, record the applicable requirement, question asked,
relevant response, follow-up probes, performance benchmark, rating
justification, evidence confidence, and required follow-up.

Scoring framework for candidateScore, using only assessed competencies:
- Job requirement evidence and role competency coverage: 45%
- Depth of answers, ownership, and concrete examples: 25%
- Problem solving, trade-off reasoning, and validation: 15%
- Role-related communication, collaboration, and stakeholder orientation: 10%
- Risk awareness, production safety, compliance, or delivery discipline: 5%

candidateScore must be 0-10 and must not average "not_assessed" competencies as
zero. jdCoveragePercent is 0-100 and must include missing/not-assessed role
coverage. evidenceConfidence and decisionConfidence must be high, medium, or low.

For each interviewer, provide a panelScore from 0-10 for the quality of their
role-specific questioning, not for the candidate. Do not penalize opening,
introduction, or resume-walkthrough questions. Only questions with
countsTowardPanelEvaluation=true, or without that field, count toward coverage.

If a case interview pack is supplied, evaluate case performance separately.
Score only transcript-visible case evidence. If the case was not discussed,
say that clearly and mark case evidence as low.

Return exactly this shape:
{
  "candidateEvaluation": {
    "candidateScore":0,
    "candidateScoreReason":"one concise evidence-based scoring reason",
    "jdCoveragePercent":0,
    "evidenceConfidence":"high|medium|low",
    "decisionConfidence":"high|medium|low",
    "evidenceBullets":["up to 3 decisive evidence bullets"],
    "nextAction":"one clear next action for the reviewer",
    "validationWarnings":["missing or contradictory required data, otherwise []"],
    "summary": "3 concise executive-ready sentences",
    "strengths": ["up to 4 evidence-backed strengths"],
    "concerns": ["up to 4 evidence-backed concerns or missing evidence, job-related only"],
    "skillScores": [{"skill":"string","score":0,"evidence":"one concise evidence statement"}],
    "competencyRatings": [{
      "competency":"string",
      "requirement":"string",
      "status":"exceeds_standard|meets_standard|partially_demonstrated|below_standard|not_assessed",
      "rating":0,
      "questionAsked":"exact or concise question text, or Not assessed",
      "relevantResponse":"short transcript quote or precise paraphrase, or Not assessed",
      "followUpProbes":["follow-up questions asked, otherwise []"],
      "performanceBenchmark":"what good performance should show for this requirement",
      "ratingJustification":"why this status/rating is justified",
      "evidenceConfidence":"high|medium|low",
      "requiredFollowUp":"what must be checked next, or None"
    }],
    "recommendation":"strongly_recommend|recommend|proceed_with_reservations|additional_assessment_required|not_recommended|strongly_not_recommended",
    "recommendationReason":"45 words maximum"
  },
  "interviewerEvaluations": [{
    "interviewerId":"string","name":"string","panelScore":0,"panelScoreReason":"one concise evidence-based reason","questionsAskedCount":0,
    "jdCoveragePercent":0,"followUpQuality":"strong|average|weak|not_enough_data",
    "scoreJustification":"well_supported|partially_supported|weakly_supported|not_available",
    "observations":["up to 3 concise observations"],"missedAreas":["up to 3 concise missed areas"]
  }],
  "coverageMatrix": [{
    "jdSkill":"string","covered":"yes|partial|no","evidence":"string","askedBy":["string"]
  }],
  "panelCalibration": {
    "panelSize":0,"outliers":[],"summary":"string","humanReviewRequired":true
  },
  "caseEvaluation": {
    "overallScore": 0,
    "summary": "string",
    "competencyScores": [{"competency":"string","score":0,"evidence":"string","risk":"string"}],
    "strongSignals": ["up to 4 case-specific strengths"],
    "concerns": ["up to 4 case-specific concerns"],
    "missedProbes": ["up to 4 panel probes that were not covered"],
    "candidateApproach": "string",
    "recommendationImpact": "string"
  },
  "finalReport":"A concise structured summary under 250 words for the downloadable report"
}

Omit "caseEvaluation" only when CASE INTERVIEW PACK is null. If a case pack
exists but the transcript does not show a case discussion, include
caseEvaluation with a low evidence score and say the case was not covered.

Keep the response compact so it can be returned as one complete JSON document:
- Return at most 5 skillScores, 5 competencyRatings, and 5 coverageMatrix rows.
- Return at most 4 interviewer evaluations and at most 3 observations/missed areas per interviewer.
- Keep each evidence item to one sentence and avoid repeating the same transcript evidence.
- Every candidate skill and coverage evidence must include one short exact transcript quote in double quotation marks when one exists. Keep each quote under 18 words. If no direct quote exists, state that explicitly rather than inventing one.
- Evidence bullets must each be under 22 words.
- Return no Markdown, commentary, or text outside <intelligence_json> tags.

Candidate: ${item.candidate.name}
Role: ${item.job.title}

JOB DESCRIPTION:
${jobDescription}

RESUME:
${resume || 'No resume was supplied for this interview.'}

PANEL:
${panel}

APPROVED QUESTION PLAN:
${questionPlan}

CASE INTERVIEW PACK:
${caseInterview}

COMPLETED INTERVIEW TRANSCRIPT:
${transcript}
`;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await client.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify(anthropicRequestBody(modelId, prompt, BEDROCK_INTELLIGENCE_REVIEW_TOKENS, 0)),
      }), { abortSignal: abortController.signal });
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const rawText = getBedrockText(payload);
    const parsed = parseTaggedJson(rawText, 'intelligence_json', extractJson, payload.stop_reason);
    return normalizeIntelligenceEvaluation(parsed, item, competencyNames);
  } catch (error) {
    console.error('Intelligence AI review failed:', error);
    throw new Error('The AI interview review could not be completed. Please retry once Bedrock is available.');
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeIntelligenceEvaluation(value: any, item: InterviewIntelligenceRecord, competencyNames?: string[]): IntelligenceEvaluation {
  const skills = competencyNames?.length ? competencyNames : inferSkills(item.job);
  const candidate = value?.candidateEvaluation || {};
  const coverage = (Array.isArray(value?.coverageMatrix) ? value.coverageMatrix : []).map((entry: any) => ({
    jdSkill: cleanAiText(entry?.jdSkill, 'Unclassified requirement'),
    covered: cleanAiEnum(entry?.covered, ['yes', 'partial', 'no'] as const, 'partial'),
    evidence: cleanAiText(entry?.evidence, 'The transcript did not provide enough explicit evidence.'),
    askedBy: cleanAiList(entry?.askedBy, 10),
  }));
  const fallbackCoverage = skills.map((skill) => ({
    jdSkill: skill,
    covered: 'partial' as const,
    evidence: 'AI review did not return explicit evidence for this requirement.',
    askedBy: [],
  }));
  const interviewerEvaluations = item.panel.map((member) => {
    const found = Array.isArray(value?.interviewerEvaluations)
      ? value.interviewerEvaluations.find((entry: any) => String(entry?.interviewerId) === member.interviewerId)
      : undefined;
    return {
      interviewerId: member.interviewerId,
      name: cleanAiText(found?.name, member.name),
      panelScore: Number.isFinite(Number(found?.panelScore))
        ? cleanAiScore(found?.panelScore)
        : Math.max(0, Math.min(10, Math.round((Number(found?.jdCoveragePercent) || 0) / 10))),
      panelScoreReason: cleanAiText(found?.panelScoreReason, 'Based on role-question coverage visible in the transcript.'),
      questionsAskedCount: Math.max(0, Math.round(Number(found?.questionsAskedCount) || 0)),
      jdCoveragePercent: Math.max(0, Math.min(100, Math.round(Number(found?.jdCoveragePercent) || 0))),
      followUpQuality: cleanAiEnum(found?.followUpQuality, ['strong', 'average', 'weak', 'not_enough_data'] as const, 'not_enough_data'),
      scoreJustification: cleanAiEnum(found?.scoreJustification, ['well_supported', 'partially_supported', 'weakly_supported', 'not_available'] as const, 'not_available'),
      observations: cleanAiList(found?.observations, 6),
      missedAreas: cleanAiList(found?.missedAreas, 6),
    };
  });
  const rawCalibration = value?.panelCalibration;
  const panelCalibration = {
    panelSize: item.panel.length,
    outliers: Array.isArray(rawCalibration?.outliers) ? rawCalibration.outliers.map((entry: any) => ({
      interviewerId: cleanAiText(entry?.interviewerId, ''),
      name: cleanAiText(entry?.name, 'Panel member'),
      score: cleanAiScore(entry?.score),
      reason: cleanAiText(entry?.reason, 'Review this panel member against the transcript evidence.'),
    })).filter((entry: any) => entry.interviewerId) : [],
    summary: cleanAiText(rawCalibration?.summary, 'The panel was reviewed against the planned guide and completed transcript.'),
    humanReviewRequired: rawCalibration?.humanReviewRequired !== false,
  };
  const rawCaseEvaluation = value?.caseEvaluation;
  const caseEvaluation = item.caseInterview?.enabled ? {
    overallScore: cleanAiScore(rawCaseEvaluation?.overallScore),
    summary: cleanAiText(rawCaseEvaluation?.summary, 'The case interview requires human review against the transcript evidence.'),
    competencyScores: (Array.isArray(rawCaseEvaluation?.competencyScores)
      ? rawCaseEvaluation.competencyScores
      : item.caseInterview.interviewerGuide?.competencies || []
    ).slice(0, 6).map((entry: any) => ({
      competency: cleanAiText(entry?.competency || entry?.name, 'Case competency'),
      score: cleanAiScore(entry?.score),
      evidence: cleanAiText(entry?.evidence, 'No explicit case evidence was returned.'),
      risk: cleanAiText(entry?.risk || entry?.weakSignals, 'Review this competency manually.'),
    })),
    strongSignals: cleanAiList(rawCaseEvaluation?.strongSignals, 6),
    concerns: cleanAiList(rawCaseEvaluation?.concerns, 6),
    missedProbes: cleanAiList(rawCaseEvaluation?.missedProbes, 6),
    candidateApproach: cleanAiText(rawCaseEvaluation?.candidateApproach, 'The transcript did not provide enough structured case evidence.'),
    recommendationImpact: cleanAiText(rawCaseEvaluation?.recommendationImpact, 'Treat case performance as an additional signal during human review.'),
  } : undefined;
  const normalizedSkillScores = (Array.isArray(candidate.skillScores) ? candidate.skillScores : []).map((entry: any) => ({
    skill: cleanAiText(entry?.skill, 'Unclassified requirement'),
    score: cleanAiScore(entry?.score),
    evidence: cleanAiText(entry?.evidence, 'No explicit evidence was returned.'),
  }));
  const normalizedCoverage = coverage.length ? coverage : fallbackCoverage;
  const recommendation = normalizeCandidateRecommendation(candidate.recommendation);
  const competencyRatings = normalizeCompetencyRatings(candidate.competencyRatings, normalizedCoverage);
  const candidateScore = deriveCandidateScore({
    modelScore: candidate.candidateScore,
    skillScores: normalizedSkillScores,
    coverageMatrix: normalizedCoverage,
    competencyRatings,
    recommendation,
  });
  const jdCoveragePercent = Number.isFinite(Number(candidate.jdCoveragePercent))
    ? cleanAiPercent(candidate.jdCoveragePercent)
    : coveragePercentFromMatrix(normalizedCoverage);
  const evidenceBullets = cleanAiList(candidate.evidenceBullets, 3);
  return {
    generatedAt: Date.now(),
    candidateEvaluation: {
      candidateScore,
      candidateScoreReason: cleanAiText(
        candidate.candidateScoreReason,
        `The score reflects ${jdCoveragePercent}% JD coverage and transcript-visible evidence across the reviewed competencies.`,
      ),
      jdCoveragePercent,
      evidenceConfidence: cleanAiEnum(candidate.evidenceConfidence, EVIDENCE_CONFIDENCES, jdCoveragePercent >= 70 ? 'high' : jdCoveragePercent >= 35 ? 'medium' : 'low'),
      decisionConfidence: cleanAiEnum(candidate.decisionConfidence, EVIDENCE_CONFIDENCES, recommendation === 'additional_assessment_required' ? 'low' : jdCoveragePercent >= 70 ? 'high' : 'medium'),
      evidenceBullets: evidenceBullets.length
        ? evidenceBullets
        : [
          `JD coverage assessed at ${jdCoveragePercent}% from transcript-visible evidence.`,
          `Recommendation remains ${recommendation.replace('_', ' ')} pending panel approval.`,
        ],
      nextAction: cleanAiText(
        candidate.nextAction,
        recommendation === 'additional_assessment_required'
          ? 'Run a focused follow-up interview for not assessed critical competencies.'
          : 'Panel approver should review the evidence and record the final decision.',
      ),
      validationWarnings: cleanAiList(candidate.validationWarnings, 5),
      summary: cleanAiText(candidate.summary, `AI review completed for ${item.candidate.name}.`),
      strengths: cleanAiList(candidate.strengths),
      concerns: cleanAiList(candidate.concerns).map(sanitizeProfessionalConcern),
      skillScores: normalizedSkillScores,
      competencyRatings,
      recommendation,
      recommendationReason: cleanAiText(candidate.recommendationReason, 'Human review is required before a final decision.'),
    },
    interviewerEvaluations,
    coverageMatrix: normalizedCoverage,
    panelCalibration,
    caseEvaluation,
    finalReport: cleanAiText(value?.finalReport, [
      `AI interview review for ${item.candidate.name} (${item.job.title}).`,
      cleanAiText(candidate.recommendationReason, 'Human review is required before a final decision.'),
    ].join('\n\n')),
  };
}


async function approveIntelligenceInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, userId, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  if (!item.aiEvaluation) {
    return errorResponse(400, 'VALIDATION_ERROR', 'AI analysis must be generated before approval.');
  }

  const body = parseBody(event);
  const updated: InterviewIntelligenceRecord = {
    ...item,
    approved: {
      approvedBy: userId!,
      approvedAt: Date.now(),
      notes: String(body.notes || '').trim() || undefined,
    },
    status: 'approved',
    updated_at: Date.now(),
  };

  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
  return successResponse(updated);
}

function reportFileName(...parts: Array<string | undefined>): string {
  const base = parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join('-')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return `${base || 'interview-report'}.pdf`;
}

async function getIntelligenceReport(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event, {
    minTier: 'VIEWER',
    auditAction: 'DOWNLOAD_REPORT',
    targetType: 'intelligence',
  });
  if (response) return response;
  if (!item.aiEvaluation) {
    return errorResponse(404, 'NOT_FOUND', 'AI-assisted report is not available yet');
  }

  const storageFolder = intelligenceStorageFolder(item);
  const reportKey = `users/${storageFolder}/intelligence/${item.intelligence_id}/processed/report.pdf`;
  const report = await generateIntelligencePdfReport(item);
  await saveFileContent(BUCKET_NAME, reportKey, report, 'application/pdf');
  const downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: reportKey,
    ResponseContentDisposition: `attachment; filename="${reportFileName(item.candidate.name, item.job.title, 'interview-report')}"`,
  }), { expiresIn: 3600 });

  return successResponse({
    intelligence_id: item.intelligence_id,
    status: item.status,
    report: item.aiEvaluation.finalReport,
    approved: item.approved,
    download_url: downloadUrl,
  });
}

// --- NEW User Preference Handlers ---

async function getUserPreferences(event: APIGatewayProxyEvent) {
  const userId = event.requestContext.authorizer?.claims.sub;
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: 'PREFERENCES' },
  }));

  return successResponse({
    tour_completed: result.Item?.tour_completed === true,
    completed_tours: result.Item?.completed_tours || {},
  });
}

async function updateUserPreferences(event: APIGatewayProxyEvent) {
  const userId = event.requestContext.authorizer?.claims.sub;
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const { tour_completed, tour_key, completed_tours } = body;

  const existing = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `USER#${userId}`, SK: 'PREFERENCES' },
  }));

  const mergedTours = {
    ...(existing.Item?.completed_tours || {}),
    ...(completed_tours || {}),
  };

  if (typeof tour_key === 'string' && tour_key.trim()) {
    mergedTours[tour_key.trim()] = true;
  }

  await ddbDocClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `USER#${userId}`,
      SK: 'PREFERENCES',
      tour_completed: tour_completed === true || existing.Item?.tour_completed === true,
      completed_tours: mergedTours,
      updated_at: Date.now(),
    },
  }));

  return successResponse({ success: true });
}
