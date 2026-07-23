import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
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
  IntelligenceQuestion
} from './intelligence-integrations.js';
import { selectQuestionsFromBank, SelectedBankQuestion } from './manual-question-bank.js';
import { getMinfyCareerJob, listMinfyCareerJobs } from './minfy-careers.js';

type IntelligenceQuestionPlan = NonNullable<InterviewIntelligenceRecord['questionPlan']>;
type IntelligenceEvaluation = NonNullable<InterviewIntelligenceRecord['aiEvaluation']>;
type IntelligenceCoverageMatrix = IntelligenceEvaluation['coverageMatrix'];
import {
  ConfirmMomUploadSchema,
  CreateMomProjectSchema,
  CreateMomSchema,
  MomResultSchema,
  MomUploadUrlSchema
} from '../../schema/mom.js';
import { generateMomPdfReport } from '../shared/mom-report.js';
import { generateInterviewPdfReport } from '../processor/index.js';
import { generateIntelligencePdfReport } from '../shared/intelligence-report.js';

validateEnv(['TABLE_NAME', 'BUCKET_NAME', 'QUEUE_URL', 'MOM_TABLE_NAME', 'MOM_QUEUE_URL', 'INTELLIGENCE_TABLE_NAME']);

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const MOM_TABLE_NAME = process.env.MOM_TABLE_NAME!;
const MOM_QUEUE_URL = process.env.MOM_QUEUE_URL!;
const INTELLIGENCE_TABLE_NAME = process.env.INTELLIGENCE_TABLE_NAME!;

const sqsClient = new SQSClient({});
const lambdaClient = new LambdaClient({});


export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if ((event as any).__internalTask === 'intelligence-analysis') {
    return await runIntelligenceAnalysisWorker(String((event as any).intelligenceId || ''));
  }
  const { httpMethod, resource, pathParameters } = event;
  console.log(`Request: ${httpMethod} ${resource} (ID: ${pathParameters?.id || 'N/A'})`);

  try {
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

function getUserStorageFolder(event: APIGatewayProxyEvent, fallbackUserId: string): string {
  const email = getAuthenticatedUserEmail(event);
  return email ? normalizeUserFolder(email) : fallbackUserId;
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

async function getOwnedInterviewRecord(id: string | undefined, event: APIGatewayProxyEvent) {
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

  if (!isOwnedBy(item, userId)) {
    return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this interview') };
  }

  const userEmail = getAuthenticatedUserEmail(event);
  if (!item.owner_email && userEmail) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
      UpdateExpression: 'SET owner_email = :email',
      ExpressionAttributeValues: { ':email': userEmail },
    }));
    item.owner_email = userEmail;
  }

  return { item, userId };
}

async function getOwnedMomRecord(id: string | undefined, event: APIGatewayProxyEvent) {
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

  if (!isOwnedBy(item, userId)) {
    return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this MOM') };
  }

  const userEmail = getAuthenticatedUserEmail(event);
  if (!item.owner_email && userEmail) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: MOM_TABLE_NAME,
      Key: { mom_id: id },
      UpdateExpression: 'SET owner_email = :email',
      ExpressionAttributeValues: { ':email': userEmail },
    }));
    item.owner_email = userEmail;
  }

  return { item, userId };
}

async function getOwnedMomProjectRecord(id: string | undefined, event: APIGatewayProxyEvent) {
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

  if (!isOwnedBy(item, userId)) {
    return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this MOM project') };
  }

  return { item, userId };
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
    model_id: result.data.model_id || 'claude-3-sonnet',
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
    FilterExpression: 'begins_with(PK, :pkPrefix) AND SK = :sk AND owner_user_id = :owner',
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
  const { item, response } = await getOwnedInterviewRecord(id, event);
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

  const interviewerQuestion = (value: unknown) => {
    const question = String(value || '').trim();
    if (!question) {
      return `Could you walk me through a situation relevant to this ${roleTitle} role where ${bankQuestion.focusArea} was important? Please explain the context, the decision you made, and the outcome.`;
    }
    if (/\b(could you|can you|would you|tell me about|walk me through|imagine)\b/i.test(question)) return question;
    return `Let’s use a practical ${bankQuestion.focusArea} situation relevant to this ${roleTitle} role. ${question} Please talk me through the context, your decision-making, and the outcome.`;
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
  };
}

async function optimizeQuestionBankSelection(input: {
  roleTitle: string;
  level: string;
  jdText: string;
  resumeText: string;
  questions: SelectedBankQuestion[];
}): Promise<{ status: 'optimized' | 'bank_only'; questions: ManualInterviewQuestionGuide['questions'] }> {
  const fallback = input.questions.map((question) => normalizeOptimizedQuestion(question, null, input.roleTitle));

  try {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
    const { extractJson } = await import('../shared/utils.js');
    const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
    const modelId = process.env.BEDROCK_SONNET_46_PROFILE_ARN || 'global.anthropic.claude-sonnet-4-6';
    const prompt = `
You are editing an interview guide selected from an approved question bank.
You are NOT allowed to generate, add, remove, merge, split, or reorder questions.

Your only task is to convert each approved question into a fair, current,
scenario-based question grounded in the supplied role, seniority, job
description, and resume context. Preserve each question's competency, intent,
ID, category, and focus area. Do not assume facts about the candidate, reveal
private resume details in the question, or include an answer.

Write as an experienced interviewer speaking naturally to a candidate: clear,
specific, and conversational rather than academic, scripted, or AI-generated.
Each question must sound natural when read aloud in a real interview. Use direct
interviewer language such as "Could you walk me through...", "Tell me about a
time when...", or "Imagine you were responsible for...". Frame a realistic
work situation from the JD and invite the candidate to explain their decisions,
trade-offs, and outcome. Do not use meta-language such as "assess", "evaluate",
"as an AI", "based on the prompt", or explain why the question was selected.
For every role-specific question, include a concrete situation or operational
constraint and end with a natural invitation to explain the candidate's own
approach. Avoid textbook wording such as "What is", "Define", or "Explain the
concept of" unless the approved bank explicitly requires foundational knowledge.
Write follow-ups as short interviewer prompts that deepen the same scenario,
for example by testing ownership, trade-offs, failure handling, validation, or
stakeholder communication.
Current practices may shape the scenario only where they are relevant to the JD;
never add fashionable tools, trends, or requirements that are not supported by it.

Return only valid JSON inside <question_guide> tags using this shape:
{
  "questions": [
    {
      "id": "REC-01",
      "question": "string",
      "follow_ups": ["string"],
      "what_to_listen_for": ["string"]
    }
  ]
}

Every supplied ID must appear exactly once and in the same order.

Role: ${input.roleTitle}
Detected level: ${input.level}
Job description excerpt:
${input.jdText.slice(0, 12000)}

Resume excerpt (context only; do not expose private details in questions):
${input.resumeText.slice(0, 12000) || 'No resume uploaded'}

Approved bank selection:
${JSON.stringify(input.questions)}
`;

    // This route is browser-facing. The approved-bank wording is already a
    // complete guide, so refinement must never hold the request long enough
    // for API Gateway or the browser to time out.
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 12_000);
    let response;
    try {
      response = await client.send(new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 2600,
          temperature: 0,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        }),
      }), { abortSignal: abortController.signal });
    } finally {
      clearTimeout(timeout);
    }

    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const rawText = payload.content?.[0]?.text || '';
    const tagged = rawText.match(/<question_guide>([\s\S]*?)<\/question_guide>/i)?.[1];
    const jsonText = tagged || extractJson(rawText);
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed.questions) || parsed.questions.length !== input.questions.length) {
      throw new Error('Question optimizer changed the approved question count');
    }

    const optimizedById = new Map(parsed.questions.map((question: any) => [String(question?.id || ''), question]));
    const expectedIds = input.questions.map((question) => question.id);
    if (expectedIds.some((questionId) => !optimizedById.has(questionId))) {
      throw new Error('Question optimizer changed approved question IDs');
    }

    return {
      status: 'optimized',
      questions: input.questions.map((question) => normalizeOptimizedQuestion(question, optimizedById.get(question.id), input.roleTitle)),
    };
  } catch (error) {
    console.warn('[Question Guide] Bedrock refinement failed; using curated bank wording.', error);
    return { status: 'bank_only', questions: fallback };
  }
}

async function generateInterviewQuestionGuide(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedInterviewRecord(id, event);
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
    const selection = selectQuestionsFromBank({
      interviewId: id!,
      roleTitle,
      jdText,
      count: 8,
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
  const userFolder = getUserStorageFolder(event, userId);

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
  const owned = await getOwnedInterviewRecord(id, event);
  if (owned.response) return owned.response;
  const item = owned.item!;
  const userId = owned.userId!;
  const userFolder = getUserStorageFolder(event, userId);

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
      
      const selectedModel = item.model_id || 'claude-3-sonnet';
      const mapping: Record<string, string | undefined> = {
        'claude-3-sonnet': process.env.BEDROCK_SONNET_PROFILE_ARN,
        'claude-sonnet-4-6': process.env.BEDROCK_SONNET_46_PROFILE_ARN || 'arn:aws:bedrock:ap-south-1::inference-profile/global.anthropic.claude-sonnet-4-6',
        'nova-pro': process.env.BEDROCK_NOVA_PROFILE_ARN,
      };

      const finalModelId = mapping[selectedModel] || 
        (selectedModel === 'nova-pro'
          ? 'amazon.nova-pro-v1:0'
          : selectedModel === 'claude-sonnet-4-6'
            ? 'global.anthropic.claude-sonnet-4-6'
            : 'apac.anthropic.claude-3-7-sonnet-20250219-v1:0');
      
      const bedrockResp = await client.send(new InvokeModelCommand({
        modelId: finalModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 600,
          messages: [{ 
            role: 'user', 
            content: [{ type: 'text', text: inferPrompt + '\n\nIMPORTANT: Wrap your final JSON result inside <jd_check> tags.' }] 
          }],
          temperature: 0
        })
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
  const { item, response } = await getOwnedInterviewRecord(id, event);
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
  await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `INTERVIEW#${id}`, SK: 'METADATA' },
    UpdateExpression: 'SET #st = :status, updated_at = :now',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':status': 'QUEUED',
      ':now': Date.now(),
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
  const { item, response } = await getOwnedInterviewRecord(id, event);
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
  const { item, response } = await getOwnedInterviewRecord(id, event);
  if (response) return response;

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
  const { item, response } = await getOwnedInterviewRecord(id, event);
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
  const { item: project, response, userId } = await getOwnedMomProjectRecord(id, event);
  if (response) return response;

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
    FilterExpression: 'owner_user_id = :owner',
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
  const { item, response } = await getOwnedMomRecord(id, event);
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
    error: item.error_message ? { message: item.error_message } : null,
  });
}

async function getMomUploadUrl(id: string | undefined, event: APIGatewayProxyEvent) {
  const owned = await getOwnedMomRecord(id, event);
  if (owned.response) return owned.response;
  const userId = owned.userId!;
  const userFolder = getUserStorageFolder(event, userId);

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
  const userFolder = getUserStorageFolder(event, userId);

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

  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: BUCKET_NAME, Key: item.transcript_s3_key }));
  } catch {
    return errorResponse(400, 'UPLOAD_ERROR', 'Transcript file is missing in storage. Please upload again.');
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: MOM_TABLE_NAME,
    Key: { mom_id: id! },
    UpdateExpression: 'SET #st = :status, updated_at = :now, error_message = :null',
    ExpressionAttributeNames: { '#st': 'status' },
    ExpressionAttributeValues: {
      ':status': 'PROCESSING',
      ':now': Date.now(),
      ':null': null,
    },
  }));

  await sqsClient.send(new SendMessageCommand({
    QueueUrl: MOM_QUEUE_URL,
    MessageBody: JSON.stringify({ mom_id: id, owner_user_id: item.owner_user_id }),
  }));

  return acceptedResponse({ status: 'PROCESSING' });
}

async function getMomResult(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedMomRecord(id, event);
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
  const { item, response } = await getOwnedMomRecord(id, event);
  if (response) return response;

  if (!item.result_s3_key) {
    return errorResponse(404, 'NOT_FOUND', 'MOM result not found or not yet available');
  }

  const jsonContent = await getFileContent(BUCKET_NAME, item.result_s3_key);
  const parsed = JSON.parse(jsonContent);
  const validation = MomResultSchema.safeParse(parsed);
  if (!validation.success) {
    return errorResponse(500, 'INTERNAL_ERROR', 'Stored MOM result could not be converted to PDF');
  }

  const reportFolder = item.owner_email ? normalizeUserFolder(item.owner_email) : item.owner_user_id;
  const reportKey = item.report_s3_key || `users/${reportFolder}/moms/${id}/processed/report.pdf`;
  const pdfReport = await generateMomPdfReport(validation.data, {
    projectTitle: item.project_title || 'General',
  });
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

  const safeProject = (item.project_title || 'General').replace(/[^a-zA-Z0-9]/g, '-');
  const safeName = (item.title || 'mom-report').replace(/[^a-zA-Z0-9]/g, '-');
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: reportKey,
    ResponseContentDisposition: `attachment; filename="mom-report-${safeProject}-${safeName}.pdf"`,
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  return successResponse({ download_url: url });
}

async function deleteMom(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedMomRecord(id, event);
  if (response) return response;

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

  return successResponse({ message: 'MOM deleted successfully' });
}

async function getOwnedIntelligenceRecord(id: string | undefined, event: APIGatewayProxyEvent) {
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

  if (!isOwnedBy(item, userId)) {
    return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this intelligence interview') };
  }

  return { item, userId };
}

function getIntegrationMode(value: string | undefined): 'mock' | 'disabled' | 'live' {
  if (value === 'live') return 'live';
  if (value === 'disabled') return 'disabled';
  return 'mock';
}

async function getIntegrationStatus() {
  const kekaMode = getIntegrationMode(process.env.KEKA_INTEGRATION_MODE);
  const teamsMode = getIntegrationMode(process.env.TEAMS_INTEGRATION_MODE);

  return successResponse({
    keka: {
      mode: kekaMode,
      label: kekaMode === 'live' ? 'Keka live mode' : kekaMode === 'disabled' ? 'Keka disabled' : 'Keka mock mode',
      configured: kekaMode === 'live' && !!(
        process.env.KEKA_SECRET_ARN ||
        (process.env.KEKA_BASE_URL && process.env.KEKA_CLIENT_ID && process.env.KEKA_CLIENT_SECRET && process.env.KEKA_API_KEY)
      ),
      credentialSource: kekaMode === 'live' && process.env.KEKA_SECRET_ARN ? 'AWS Secrets Manager' : undefined,
    },
    teams: {
      mode: teamsMode,
      label: teamsMode === 'live' ? 'Teams live mode' : teamsMode === 'disabled' ? 'Teams disabled' : 'Teams mock mode',
      configured: teamsMode === 'live' && !!process.env.MS_TEAMS_SECRET_ARN,
      credentialSource: teamsMode === 'live' && process.env.MS_TEAMS_SECRET_ARN ? 'AWS Secrets Manager' : undefined,
    },
    message: kekaMode === 'mock' || teamsMode === 'mock'
      ? 'Real credentials not configured yet. Manual and mock workflows are available.'
      : 'Integration modes are configured from backend environment variables.',
  });
}

function ensureLiveKeka(event: APIGatewayProxyEvent): APIGatewayProxyResult | undefined {
  if (!getAuthenticatedUserId(event)) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (getIntegrationMode(process.env.KEKA_INTEGRATION_MODE) !== 'live') {
    return errorResponse(503, 'INTEGRATION_NOT_READY', 'Keka Hire is not configured for live interview selection yet.');
  }
  return undefined;
}

async function listKekaJobs(event: APIGatewayProxyEvent) {
  const response = ensureLiveKeka(event);
  if (response) return response;
  try {
    return successResponse({ items: await createKekaIntegration('live').listJobs() });
  } catch (error: any) {
    console.warn('[Keka Hire] Could not list jobs:', error instanceof Error ? error.message : 'Unknown error');
    return errorResponse(502, 'KEKA_SYNC_FAILED', error instanceof KekaIntegrationError ? error.message : 'Keka Hire could not load jobs.');
  }
}

async function listKekaCandidates(jobId: string | undefined, event: APIGatewayProxyEvent) {
  const response = ensureLiveKeka(event);
  if (response) return response;
  try {
    return successResponse({ items: await createKekaIntegration('live').listCandidates(String(jobId || '')) });
  } catch (error: any) {
    console.warn('[Keka Hire] Could not list candidates:', error instanceof Error ? error.message : 'Unknown error');
    return errorResponse(502, 'KEKA_SYNC_FAILED', error instanceof KekaIntegrationError ? error.message : 'Keka Hire could not load candidates.');
  }
}

async function listKekaInterviews(jobId: string | undefined, candidateId: string | undefined, event: APIGatewayProxyEvent) {
  const response = ensureLiveKeka(event);
  if (response) return response;
  try {
    return successResponse({ items: await createKekaIntegration('live').listInterviews(String(jobId || ''), String(candidateId || '')) });
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
    const storageFolder = getUserStorageFolder(event, userId!);
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

function buildQuestion(skill: string, roleTitle: string, seniority?: string): IntelligenceQuestion & {
  expectedStrongAnswerSignals: string[];
  redFlags: string[];
} {
  return {
    question: `Imagine you are working as ${seniority ? `a ${seniority} ` : 'a '}${roleTitle} and a delivery or production decision depends on ${skill}. Could you walk me through a comparable situation you have handled, the options you considered, the decision you made, and how you measured the outcome?`,
    followUps: [
      `What information did you gather before deciding how to approach the ${skill} problem?`,
      `What trade-off did you make, and how did you validate that the ${skill} approach worked?`,
    ],
    whatToEvaluate: [
      'Depth of hands-on experience',
      'Decision-making quality',
      'Ability to explain trade-offs clearly',
    ],
    questionType: 'role',
    countsTowardPanelEvaluation: true,
    expectedStrongAnswerSignals: [
      'Specific project context and measurable outcome',
      'Clear explanation of constraints, alternatives, and validation',
      'Ownership of mistakes or operational lessons',
    ],
    redFlags: [
      'Only theoretical explanation with no real example',
      'Cannot explain why the chosen approach was appropriate',
      'Avoids follow-up detail on failure handling or validation',
    ],
  };
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

function buildQuestionPlan(record: InterviewIntelligenceRecord): IntelligenceQuestionPlan {
  const skills = inferSkills(record.job);
  const panel = record.panel.length ? record.panel : [{ interviewerId: 'interviewer-1', name: 'Interviewer' }];
  const skillAreas = skills.map((skill, index) => ({
    skill,
    priority: index < 3 ? 'high' as const : index < 6 ? 'medium' as const : 'low' as const,
    reason: `${skill} is relevant to ${record.job.title || 'the role'} based on the JD${record.candidate.resumeText ? ' and candidate resume' : ''}.`,
  }));

  const panelPlan = panel.map((interviewer, index) => {
    const assigned = panel.length === 1
      ? skills
      : skills.filter((_, skillIndex) => skillIndex % panel.length === index);
    const focusSkills = assigned.length ? assigned : [skills[index % skills.length] || 'Role fit'];
    const focusArea = interviewer.focusArea || focusSkills.slice(0, 2).join(' / ');
    const roleQuestions = focusSkills.slice(0, panel.length === 1 ? 6 : 4).map((skill) => buildQuestion(skill, record.job.title || 'target role', record.job.seniority));
    const contextQuestions = index === 0
      ? [buildIntroductionQuestion(), ...resumeTopics(record, skills).map((topic) => buildResumeQuestion(topic))]
      : [];
    return {
      interviewerId: interviewer.interviewerId,
      focusArea: contextQuestions.length ? `${focusArea} / candidate experience` : focusArea,
      questions: [...contextQuestions, ...roleQuestions],
    };
  });

  return {
    generatedAt: Date.now(),
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

async function listIntelligenceInterviews(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner',
    ExpressionAttributeValues: { ':owner': userId },
  }));

  const items = (result.Items || [])
    .map((item) => item as InterviewIntelligenceRecord)
    .sort((a, b) => b.created_at - a.created_at);

  return successResponse({ items, count: items.length });
}

async function createIntelligenceInterview(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = parseBody(event);
  const sourceMode = body.source_mode === 'mock_keka'
    ? 'mock_keka'
    : body.source_mode === 'keka_live'
      ? 'keka_live'
      : body.source_mode === 'teams_live'
        ? 'teams_live'
        : 'manual';
  const now = Date.now();
  const id = uuidv4();
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
  if (sourceMode === 'mock_keka' || sourceMode === 'keka_live') {
    try {
      integrationData = await createKekaIntegration(sourceMode === 'mock_keka' ? 'mock' : 'live').getInterviewData({
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
      organizerUserId: String(body.organizerUserId || '').trim() || undefined,
      organizerEmail: String(body.organizerEmail || '').trim() || undefined,
    };
  }

  if (!integrationData.job.title || !integrationData.job.description || !integrationData.candidate.name) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Job title, job description, and candidate name are required.');
  }

  const record: InterviewIntelligenceRecord = {
    intelligence_id: id,
    owner_user_id: userId,
    created_at: now,
    updated_at: now,
    source_mode: sourceMode,
    status: 'data_ready',
    keka: {
      mode: sourceMode === 'mock_keka' ? 'mock' : sourceMode === 'keka_live' ? 'live' : kekaMode,
      jobId: body.jobId,
      candidateId: body.candidateId,
      interviewId: body.interviewId,
      syncStatus: sourceMode === 'mock_keka' ? 'mocked' : sourceMode === 'keka_live' ? 'synced' : 'not_connected',
      lastSyncAt: sourceMode === 'mock_keka' || sourceMode === 'keka_live' ? now : undefined,
    },
    teams: {
      mode: sourceMode === 'mock_keka' ? 'mock' : teamsMode,
      meetingUrl: integrationData.meetingUrl,
      meetingId: integrationData.meetingId,
      organizerUserId: integrationData.organizerUserId,
      organizerEmail: integrationData.organizerEmail,
      transcriptStatus: integrationData.meetingUrl || integrationData.meetingId ? 'pending' : 'not_available',
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
  return createdResponse({ intelligence_id: id, item: record });
}

async function getIntelligenceInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;
  return successResponse(item);
}

async function deleteIntelligenceInterview(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, userId, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  const storageFolder = getUserStorageFolder(event, userId!);
  try {
    await deleteS3Prefix(`users/${storageFolder}/intelligence/${item.intelligence_id}/`);
  } catch (error) {
    console.warn('Intelligence workspace objects could not be removed:', error);
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: INTELLIGENCE_TABLE_NAME,
    Key: { intelligence_id: item.intelligence_id },
  }));
  return successResponse({ message: 'Interview intelligence workspace deleted successfully' });
}

async function updateIntelligenceDetails(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
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

  const userFolder = getUserStorageFolder(event, userId!);
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
  const userFolder = getUserStorageFolder(event, userId!);
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

async function generateIntelligenceQuestions(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  const questionPlan = buildQuestionPlan(item);
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
    updated_at: Date.now(),
  };

  await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
  return successResponse(updated);
}

async function updateIntelligenceTranscript(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;

  const body = parseBody(event);
  let rawText = String(body.rawText || '').trim();
  let source: 'manual' | 'mock_teams' | 'teams_live' = body.source === 'mock_teams' ? 'mock_teams' : 'manual';
  let meetingId = item.teams.meetingId;

  if (body.useMockTeams === true || source === 'mock_teams') {
    const transcript = await createTeamsIntegration('mock').getTranscript({
      meetingUrl: item.teams.meetingUrl,
      meetingId: item.teams.meetingId,
    });
    rawText = transcript.rawText;
    meetingId = transcript.meetingId;
    source = 'mock_teams';
  }

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
      transcriptStatus: source === 'mock_teams' ? 'mocked' : 'synced',
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

  if (!item.teams.meetingUrl && !item.teams.meetingId) {
    return errorResponse(400, 'VALIDATION_ERROR', 'This workspace does not have a Teams meeting reference to sync.');
  }

  const now = Date.now();
  try {
    const transcript = await createTeamsIntegration('live').getTranscript({
      meetingUrl: item.teams.meetingUrl,
      meetingId: item.teams.meetingId,
      organizerUserId: item.teams.organizerUserId,
      organizerEmail: item.teams.organizerEmail,
    });

    const updated: InterviewIntelligenceRecord = {
      ...item,
      updated_at: now,
      status: 'transcript_ready',
      teams: {
        ...item.teams,
        meetingId: transcript.meetingId || item.teams.meetingId,
        organizerUserId: transcript.organizerUserId || item.teams.organizerUserId,
        transcriptStatus: 'synced',
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
    const failed: InterviewIntelligenceRecord = {
      ...item,
      updated_at: now,
      teams: {
        ...item.teams,
        transcriptStatus: 'failed',
        lastSyncAt: now,
        error: message,
      },
    };
    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: failed }));
    return errorResponse(502, 'TEAMS_SYNC_FAILED', message);
  }
}

async function updateIntelligenceScores(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
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
  const skills = inferSkills(item.job);
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
  return Number.isFinite(score) ? Math.max(0, Math.min(10, Math.round(score))) : 0;
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

  if (item.aiEvaluation && item.status === 'analysis_generated') {
    return successResponse(item);
  }

  if (item.status === 'analysis_processing') {
    return successResponse(item);
  }

  const queued: InterviewIntelligenceRecord = {
    ...item,
    status: 'analysis_processing',
    analysisError: undefined,
    updated_at: Date.now(),
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
    const aiEvaluation = await generateIntelligenceEvaluation(item, 105_000);
    const updated: InterviewIntelligenceRecord = {
      ...item,
      aiEvaluation,
      analysisError: undefined,
      status: 'analysis_generated',
      updated_at: Date.now(),
    };
    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: updated }));
    return successResponse({ intelligence_id: intelligenceId, status: updated.status });
  } catch (error) {
    console.error('Intelligence background AI review failed:', error);
    const failed: InterviewIntelligenceRecord = {
      ...item,
      status: 'analysis_failed',
      analysisError: 'The AI review could not be completed. Please retry.',
      updated_at: Date.now(),
    };
    await ddbDocClient.send(new PutCommand({ TableName: INTELLIGENCE_TABLE_NAME, Item: failed }));
    return errorResponse(502, 'AI_ANALYSIS_FAILED', failed.analysisError || 'The AI review could not be completed. Please retry.');
  }
}

async function generateIntelligenceEvaluation(item: InterviewIntelligenceRecord, timeoutMs = 105_000): Promise<IntelligenceEvaluation> {
  const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const { extractJson } = await import('../shared/utils.js');
  const modelId = process.env.BEDROCK_SONNET_46_PROFILE_ARN || 'global.anthropic.claude-sonnet-4-6';
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  // Keep the synchronous browser request inside API Gateway's response window.
  // The selected excerpts still cover the interview evidence, role context,
  // and guide without making Sonnet wait on a needlessly large prompt.
  const transcript = item.transcript?.rawText.slice(0, 26000) || '';
  const resume = (item.candidate.resumeText || '').slice(0, 9000);
  const jobDescription = item.job.description.slice(0, 12000);
  const questionPlan = JSON.stringify(item.questionPlan?.panelPlan || []).slice(0, 16000);
  const panel = JSON.stringify(item.panel.map((member) => ({
    interviewerId: member.interviewerId,
    name: member.name,
    role: member.role,
    focusArea: member.focusArea,
  }))).slice(0, 5000);
  const prompt = `
You are a senior interview reviewer. Analyze one completed interview using only
facts supported by the supplied job description, resume, approved interview
question plan, panel, and transcript. Do not invent candidate achievements,
questions, scores, names, or decisions. Return only valid JSON inside
<intelligence_json>...</intelligence_json> tags.

Evaluate BOTH:
1. The candidate against the job description. Use transcript evidence and short
quotes or precise paraphrases for every skill conclusion.
2. Each interviewer. Identify which planned questions were actually asked,
whether follow-ups probed the answer, whether questions covered the assigned
JD focus, and whether the question quality was fair and relevant.

For each interviewer, provide a panelScore from 0-10. This is a score for the
quality of the interviewer's role-specific questioning, not a score for the
candidate. Weight JD coverage, meaningful follow-ups, fairness, and depth.
Do not penalise opening, introduction, or resume-walkthrough questions.

Introduction and resume/background questions are useful for the panel but must
be excluded from interviewer JD coverage and question-quality scoring. Only
questions with countsTowardPanelEvaluation=true (or without that field) count.
Do not use human panel scores because this workflow is AI-led. Set
scoreJustification to "not_available" unless a score is explicitly present in
this input. The final recommendation is an evidence-based recommendation, not
an irreversible hiring decision; human approval remains required.

Return exactly this shape:
{
  "candidateEvaluation": {
    "summary": "3 concise executive-ready sentences",
    "strengths": ["up to 4 evidence-backed strengths"],
    "concerns": ["up to 4 evidence-backed concerns or missing evidence"],
    "skillScores": [{"skill":"string","score":0,"evidence":"one concise evidence statement"}],
    "recommendation":"proceed|hold|reject|needs_review",
    "recommendationReason":"string"
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
  "finalReport":"A concise structured summary under 250 words for the downloadable report"
}

Keep the response compact so it can be returned as one complete JSON document:
- Return at most 5 skillScores and 5 coverageMatrix rows.
- Return at most 4 interviewer evaluations and at most 3 observations/missed areas per interviewer.
- Keep each evidence item to one sentence and avoid repeating the same transcript evidence.
- Every candidate skill and coverage evidence must include one short exact transcript quote in double quotation marks when one exists. Keep each quote under 18 words. If no direct quote exists, state that explicitly rather than inventing one.
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
      body: JSON.stringify({
        anthropic_version: 'bedrock-2023-05-31',
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      }),
    }), { abortSignal: abortController.signal });
    const payload = JSON.parse(new TextDecoder().decode(response.body));
    const rawText = payload.content?.[0]?.text || '';
    const tagged = rawText.match(/<intelligence_json>([\s\S]*?)<\/intelligence_json>/i)?.[1];
    const parsed = JSON.parse(tagged || extractJson(rawText));
    return normalizeIntelligenceEvaluation(parsed, item);
  } catch (error) {
    console.error('Intelligence AI review failed:', error);
    throw new Error('The AI interview review could not be completed. Please retry once Bedrock is available.');
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeIntelligenceEvaluation(value: any, item: InterviewIntelligenceRecord): IntelligenceEvaluation {
  const skills = inferSkills(item.job);
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
  return {
    generatedAt: Date.now(),
    candidateEvaluation: {
      summary: cleanAiText(candidate.summary, `AI review completed for ${item.candidate.name}.`),
      strengths: cleanAiList(candidate.strengths),
      concerns: cleanAiList(candidate.concerns),
      skillScores: (Array.isArray(candidate.skillScores) ? candidate.skillScores : []).map((entry: any) => ({
        skill: cleanAiText(entry?.skill, 'Unclassified requirement'),
        score: cleanAiScore(entry?.score),
        evidence: cleanAiText(entry?.evidence, 'No explicit evidence was returned.'),
      })),
      recommendation: cleanAiEnum(candidate.recommendation, ['proceed', 'hold', 'reject', 'needs_review'] as const, 'needs_review'),
      recommendationReason: cleanAiText(candidate.recommendationReason, 'Human review is required before a final decision.'),
    },
    interviewerEvaluations,
    coverageMatrix: coverage.length ? coverage : fallbackCoverage,
    panelCalibration,
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

async function getIntelligenceReport(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, userId, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;
  if (!item.aiEvaluation) {
    return errorResponse(404, 'NOT_FOUND', 'AI-assisted report is not available yet');
  }

  const storageFolder = getUserStorageFolder(event, userId!);
  const reportKey = `users/${storageFolder}/intelligence/${item.intelligence_id}/processed/report.pdf`;
  const report = await generateIntelligencePdfReport(item);
  await saveFileContent(BUCKET_NAME, reportKey, report, 'application/pdf');
  const downloadUrl = await getSignedUrl(s3Client, new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: reportKey,
    ResponseContentDisposition: `attachment; filename="interview-intelligence-${item.intelligence_id}.pdf"`,
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


