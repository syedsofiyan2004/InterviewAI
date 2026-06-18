import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { 
  PutCommand, 
  GetCommand, 
  UpdateCommand, 
  ScanCommand,
  DeleteCommand
} from '@aws-sdk/lib-dynamodb';
import { 
  ddbDocClient, 
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
  InterviewIntelligenceRecord,
  IntelligencePanelist,
  IntelligenceQuestion
} from './intelligence-integrations.js';

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

validateEnv(['TABLE_NAME', 'BUCKET_NAME', 'QUEUE_URL', 'MOM_TABLE_NAME', 'MOM_QUEUE_URL', 'INTELLIGENCE_TABLE_NAME']);

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const MOM_TABLE_NAME = process.env.MOM_TABLE_NAME!;
const MOM_QUEUE_URL = process.env.MOM_QUEUE_URL!;
const INTELLIGENCE_TABLE_NAME = process.env.INTELLIGENCE_TABLE_NAME!;

const sqsClient = new SQSClient({});


export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
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

    if (httpMethod === 'GET' && resource === '/intelligence-interviews') {
      return await listIntelligenceInterviews(event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews') {
      return await createIntelligenceInterview(event);
    }

    if (httpMethod === 'GET' && resource === '/intelligence-interviews/{id}') {
      return await getIntelligenceInterview(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/generate-questions') {
      return await generateIntelligenceQuestions(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/intelligence-interviews/{id}/transcript') {
      return await updateIntelligenceTranscript(pathParameters?.id, event);
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

function userInterviewPrefix(userId: string, interviewId: string): string {
  return `users/${userId}/interviews/${interviewId}`;
}

function userMomPrefix(userId: string, momId: string): string {
  return `users/${userId}/moms/${momId}`;
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


async function getUploadUrl(id: string | undefined, event: APIGatewayProxyEvent) {
  const owned = await getOwnedInterviewRecord(id, event);
  if (owned.response) return owned.response;
  const userId = owned.userId!;

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

  const s3Key = `${userInterviewPrefix(userId, id!)}/uploads/${file_type}-${Date.now()}.${extension}`;
  
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

  const body = JSON.parse(event.body || '{}');
  const result = ConfirmUploadSchema.safeParse(body);
  
  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const { file_type, s3_key } = result.data;
  const expectedPrefix = `${userInterviewPrefix(userId, id!)}/uploads/`;

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
        'nova-pro': process.env.BEDROCK_NOVA_PROFILE_ARN,
      };

      const finalModelId = mapping[selectedModel] || 
        (selectedModel === 'nova-pro' ? 'amazon.nova-pro-v1:0' : 'apac.anthropic.claude-3-7-sonnet-20250219-v1:0');
      
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

  const s3Key = `${userMomPrefix(userId, id!)}/uploads/transcript-${Date.now()}.${extension}`;
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

  const body = JSON.parse(event.body || '{}');
  const result = ConfirmMomUploadSchema.safeParse(body);

  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const { s3_key } = result.data;
  const expectedPrefix = `${userMomPrefix(userId, id!)}/uploads/`;
  if (!s3_key.startsWith(expectedPrefix)) {
    return errorResponse(403, 'ACCESS_DENIED', 'Upload key does not belong to this user');
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

  const reportKey = item.report_s3_key || `users/${item.owner_user_id}/moms/${id}/processed/report.pdf`;
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
      configured: kekaMode === 'live' && !!(process.env.KEKA_BASE_URL && (process.env.KEKA_API_KEY || process.env.KEKA_CLIENT_ID)),
    },
    teams: {
      mode: teamsMode,
      label: teamsMode === 'live' ? 'Teams live mode' : teamsMode === 'disabled' ? 'Teams disabled' : 'Teams mock mode',
      configured: teamsMode === 'live' && !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET),
    },
    message: kekaMode === 'mock' || teamsMode === 'mock'
      ? 'Real credentials not configured yet. Manual and mock workflows are available.'
      : 'Integration modes are configured from backend environment variables.',
  });
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

function buildQuestion(skill: string, roleTitle: string): IntelligenceQuestion & {
  expectedStrongAnswerSignals: string[];
  redFlags: string[];
} {
  return {
    question: `Describe a real project where you used ${skill} for a ${roleTitle} responsibility. What trade-offs did you make?`,
    followUps: [
      `What would you change if you had to solve the same ${skill} problem again?`,
      `How did you validate that the ${skill} approach worked in production?`,
    ],
    whatToEvaluate: [
      'Depth of hands-on experience',
      'Decision-making quality',
      'Ability to explain trade-offs clearly',
    ],
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
    return {
      interviewerId: interviewer.interviewerId,
      focusArea,
      questions: focusSkills.slice(0, panel.length === 1 ? 6 : 4).map((skill) => buildQuestion(skill, record.job.title || 'target role')),
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
  const sourceMode = body.source_mode === 'mock_keka' ? 'mock_keka' : 'manual';
  const now = Date.now();
  const id = uuidv4();
  const kekaMode = getIntegrationMode(process.env.KEKA_INTEGRATION_MODE);
  const teamsMode = getIntegrationMode(process.env.TEAMS_INTEGRATION_MODE);

  let integrationData: Awaited<ReturnType<ReturnType<typeof createKekaIntegration>['getInterviewData']>>;
  if (sourceMode === 'mock_keka') {
    integrationData = await createKekaIntegration('mock').getInterviewData({
      jobId: body.jobId,
      candidateId: body.candidateId,
      interviewId: body.interviewId,
    });
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
      mode: sourceMode === 'mock_keka' ? 'mock' : kekaMode,
      jobId: body.jobId,
      candidateId: body.candidateId,
      interviewId: body.interviewId,
      syncStatus: sourceMode === 'mock_keka' ? 'mocked' : 'not_connected',
      lastSyncAt: sourceMode === 'mock_keka' ? now : undefined,
    },
    teams: {
      mode: sourceMode === 'mock_keka' ? 'mock' : teamsMode,
      meetingUrl: integrationData.meetingUrl,
      transcriptStatus: integrationData.meetingUrl ? 'pending' : 'not_available',
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

function countQuestionsAsked(transcript: string, member: IntelligencePanelist): number {
  const name = member.name.split(' ')[0].toLowerCase();
  const matches = transcript.toLowerCase().match(new RegExp(`${name}[^.?!]*\\?`, 'g'));
  return matches?.length || 0;
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

async function analyzeIntelligenceInterview(id: string | undefined, event: APIGatewayProxyEvent) {
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
    const questionsAskedCount = countQuestionsAsked(transcript, member);
    const assignedSkills = item.questionPlan?.panelPlan.find((plan) => plan.interviewerId === member.interviewerId)?.questions.length || 0;
    const jdCoveragePercent = assignedSkills ? Math.min(100, Math.round((questionsAskedCount / assignedSkills) * 100)) : coveragePercent;
    return {
      interviewerId: member.interviewerId,
      name: member.name,
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
  const { item, response } = await getOwnedIntelligenceRecord(id, event);
  if (response) return response;
  if (!item.aiEvaluation) {
    return errorResponse(404, 'NOT_FOUND', 'AI-assisted report is not available yet');
  }
  return successResponse({
    intelligence_id: item.intelligence_id,
    status: item.status,
    report: item.aiEvaluation.finalReport,
    approved: item.approved,
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


