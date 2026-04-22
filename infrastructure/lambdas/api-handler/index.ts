import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
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

validateEnv(['TABLE_NAME', 'BUCKET_NAME', 'QUEUE_URL']);

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;

const sqsClient = new SQSClient({});


export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { httpMethod, resource, pathParameters } = event;
  console.log(`Request: ${httpMethod} ${resource} (ID: ${pathParameters?.id || 'N/A'})`);

  try {
    if (httpMethod === 'POST' && resource === '/interviews') {
      return await createInterview(event);
    }

    if (httpMethod === 'GET' && resource === '/interviews') {
      return await listInterviews();
    }

    if (httpMethod === 'GET' && resource === '/interviews/{id}') {
      return await getInterview(pathParameters?.id);
    }

    if (httpMethod === 'DELETE' && resource === '/interviews/{id}') {
      return await deleteInterview(pathParameters?.id);
    }

    if (httpMethod === 'POST' && resource === '/interviews/{id}/upload-url') {
      return await getUploadUrl(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/interviews/{id}/confirm-upload') {
      return await confirmUpload(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/interviews/{id}/analyze') {
      return await runAnalysis(pathParameters?.id);
    }

    if (httpMethod === 'GET' && resource === '/interviews/{id}/result') {
      return await getEvaluationResult(pathParameters?.id);
    }

    if (httpMethod === 'GET' && resource === '/interviews/{id}/report') {
      return await getInterviewReport(pathParameters?.id);
    }



    return errorResponse(404, 'NOT_FOUND', 'Route not found');
  } catch (err: any) {
    console.error('Handler Error:', err);
    return errorResponse(500, 'INTERNAL_ERROR', err.message || 'An internal error occurred');
  }
};

async function createInterview(event: APIGatewayProxyEvent) {
  const body = JSON.parse(event.body || '{}');
  const result = CreateInterviewSchema.safeParse(body);
  
  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const interviewId = uuidv4();
  const now = Date.now();
  
  const item = {
    interview_id: interviewId,
    status: 'CREATED',
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

async function listInterviews() {
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    Limit: 50,
  }));

  // Map to structured output
  const items = (result.Items || []).map(item => ({
    interview_id: item.interview_id,
    status: item.status,
    candidate_name: item.metadata?.candidate_name,
    position: item.metadata?.position,
    created_at: item.created_at,
    model_id: item.model_id,
  }));

  return successResponse({ 
    items,
    count: items.length,
    last_evaluated_key: result.LastEvaluatedKey ? Buffer.from(JSON.stringify(result.LastEvaluatedKey)).toString('base64') : null
  });
}


async function getInterview(id?: string) {
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { interview_id: id },
  }));

  const item = result.Item;
  if (!item) {
    return errorResponse(404, 'NOT_FOUND', 'Interview not found');
  }

  // Return structured contract shape
  return successResponse({
    interview_id: item.interview_id,
    status: item.status,
    created_at: item.created_at,
    updated_at: item.updated_at,
    metadata: item.metadata,
    transcript_uploaded: !!item.transcript_s3_key,
    jd_uploaded: !!item.jd_s3_key,
    jd_s3_key: item.jd_s3_key,
    transcript_s3_key: item.transcript_s3_key,
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
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

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

  const s3Key = `uploads/${id}/${file_type}-${Date.now()}.${extension}`;
  
  const uploadUrl = await getPresignedUploadUrl(BUCKET_NAME, s3Key, content_type);

  return successResponse({ 
    upload_url: uploadUrl, 
    s3_key: s3Key,
    file_type
  });
}

async function confirmUpload(id: string | undefined, event: APIGatewayProxyEvent) {
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const body = JSON.parse(event.body || '{}');
  const result = ConfirmUploadSchema.safeParse(body);
  
  if (!result.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', result.error.format());
  }

  const { file_type, s3_key } = result.data;

  // 1. Verify object exists in S3
  try {
    await s3Client.send(new HeadObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3_key,
    }));
  } catch (err) {
    return errorResponse(404, 'UPLOAD_ERROR', 'File not found in storage. Please upload first.');
  }

  // 2. Fetch current record to check other file
  const interviewResult = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { interview_id: id },
  }));
  const item = interviewResult.Item;
  if (!item) return errorResponse(404, 'NOT_FOUND', 'Interview not found');

  // 3. Map file type and determine status
  const attrName = file_type === 'transcript' ? 'transcript_s3_key' : 'jd_s3_key';
  const otherAttr = file_type === 'transcript' ? 'jd_s3_key' : 'transcript_s3_key';
  
  const hasOtherFile = !!item[otherAttr];
  const finalStatus = hasOtherFile ? 'FILES_UPLOADED' : item.status;

  // --- NEW: Dynamic Role Alignment Inference ---
  let inferredRole = item.inferred_role;
  let isMismatched = item.is_mismatched;

  if (file_type === 'jd') {
    console.log('Automated JD check triggered...');
    
    // ATOMIC RESET: Clear old mismatch state immediately to prevent stale UI warnings
    try {
      await ddbDocClient.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: { interview_id: id },
        UpdateExpression: `SET inferred_role = :null, is_mismatched = :false, alignment_reason = :null`,
        ExpressionAttributeValues: {
          ':null': null,
          ':false': false
        }
      }));
    } catch (resetErr) {
      console.warn('Pre-emptive state reset failed (non-blocking):', resetErr);
    }

    try {
      const { getFileBuffer } = await import('../shared/aws.js');
      const { extractTextFromBuffer, extractJson } = await import('../shared/utils.js');
      
      const jdBuffer = await getFileBuffer(BUCKET_NAME, s3_key);
      const jdText = await extractTextFromBuffer(jdBuffer, s3_key);
      
      // 3. Perform Semantic Alignment Check
      const enteredRole = item.metadata?.position || 'N/A';
      const inferPrompt = `
        You are a Taxonomical Role Matcher. Compare the "Requirement" with the "Job Description".
        
        LOGIC RULES:
        1. **Professional Ecosystems**: Categorize the roles into broad domains (e.g., Information Technology, Healthcare, Finance, Human Resources, Defense/Military, Legal).
        2. **Ecosystem Clash**: If the roles belong to fundamentally different professional ecosystems (e.g., Active Military vs. Corporate Commercial), they are NOT ALIGNED.
        3. **Functional Inclusion**: Within the same ecosystem (e.g. IT), allow flexibility between specific titles (e.g. Lead Dev vs Architect).
        4. **Keyword Shield**: Do NOT match based on shared generic jargon (like "management" or "leadership") if the industrial domains clash.
        
        Return ONLY a JSON object: { "aligned": boolean, "inferred_role": "professional title", "reason": "1-sentence justification" }
        
        Requirement (Title): "${enteredRole}"
        JD Content (READING CLEAN TEXT):
        ${jdText.substring(0, 4000)}
      `;

      const { BedrockRuntimeClient, InvokeModelCommand } = await import('@aws-sdk/client-bedrock-runtime');
      const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
      
      // Resolve Model for Gate Check (Respect User Selection)
      const selectedModel = item.model_id || 'claude-3-sonnet';
      const mapping: Record<string, string | undefined> = {
        'claude-3-sonnet': process.env.BEDROCK_SONNET_PROFILE_ARN,
        'nova-pro': process.env.BEDROCK_NOVA_PROFILE_ARN,
      };

      const finalModelId = mapping[selectedModel] || 
        (selectedModel === 'nova-pro' ? 'amazon.nova-pro-v1:0' : 'apac.anthropic.claude-3-7-sonnet-20250219-v1:0');
      
      console.info(`[JD Alignment] Using User-Selected Model (${selectedModel}):`, finalModelId);

      const bedrockResp = await client.send(new InvokeModelCommand({
        modelId: finalModelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: 600,
          messages: [{ 
            role: 'user', 
            content: [{ 
              type: 'text', 
              text: inferPrompt + '\n\nIMPORTANT: Wrap your final JSON result inside <jd_check> tags.' 
            }] 
          }],
          temperature: 0
        })
      }));

      const resData = JSON.parse(new TextDecoder().decode(bedrockResp.body));
      const rawText = resData.content?.[0]?.text || '';
      
      // Robust extraction
      const xmlMatch = rawText.match(/<jd_check>([\s\S]*?)<\/jd_check>/i);
      const jsonStr = xmlMatch ? xmlMatch[1] : extractJson(rawText);
      
      if (jsonStr) {
        const result = JSON.parse(jsonStr);
        inferredRole = result.inferred_role;
        isMismatched = !result.aligned;
        const alignmentReason = result.reason || '';
        console.log(`[Bedrock Alignment Success] ${result.aligned ? 'MATCH' : 'MISMATCH'} - ${alignmentReason}`);

        // Update the item with the alignment data
        item.inferred_role = inferredRole;
        item.is_mismatched = isMismatched;
      } else {
        console.warn('[Bedrock Alignment] No extractable JSON found in response:', rawText);
      }
    } catch (err: any) {
      console.error('[CRITICAL] JD Alignment Inference SILENTLY Failed (Non-Blocking):', {
        name: err.name,
        message: err.message,
        stack: err.stack
      });
      // Fallback: We proceed without the mismatch flag to ensure the process isn't blocked
    }
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { interview_id: id },
    UpdateExpression: `SET #attr = :key, #st = :status, inferred_role = :ir, is_mismatched = :im, updated_at = :now`,
    ExpressionAttributeNames: { 
      '#attr': attrName,
      '#st': 'status' 
    },
    ExpressionAttributeValues: {
      ':key': s3_key,
      ':status': finalStatus,
      ':ir': inferredRole || null,
      ':im': isMismatched || false,
      ':now': Date.now(),
    },
  }));

  return successResponse({ status: finalStatus, inferred_role: inferredRole, is_mismatched: isMismatched });
}



async function runAnalysis(id?: string) {
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const interviewResult = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { interview_id: id },
  }));

  const item = interviewResult.Item;
  if (!item) return errorResponse(404, 'NOT_FOUND', 'Interview not found');
  
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
    Key: { interview_id: id },
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
    MessageBody: JSON.stringify({ interview_id: id }),
  }));
  
  return acceptedResponse({ status: 'QUEUED' });
}

async function getEvaluationResult(id?: string) {
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { interview_id: id },
  }));

  const item = result.Item;
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

async function deleteInterview(id?: string) {
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  // 1. Fetch metadata to get S3 keys
  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { interview_id: id },
  }));

  const item = result.Item;
  if (!item) {
    return errorResponse(404, 'NOT_FOUND', 'Interview not found');
  }

  // 2. Identify potential S3 objects to delete
  const keysToDelete = [
    item.transcript_s3_key,
    item.jd_s3_key,
    item.result_s3_key
  ].filter(Boolean);

  // 3. Delete from S3 (Fail-safe: ignore "Not Found" errors)
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

  // 4. Delete from DynamoDB
  await ddbDocClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { interview_id: id },
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

async function getInterviewReport(id?: string) {
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing id');

  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { interview_id: id },
  }));

  const item = result.Item;
  if (!item) return errorResponse(404, 'NOT_FOUND', 'Interview not found');
  if (!item.report_s3_key) return errorResponse(404, 'NOT_FOUND', 'Report not found or not yet available');

  const safeName = item.metadata?.candidate_name?.replace(/[^a-zA-Z0-9]/g, '-') || 'Candidate';
  const filename = `interview-report-${safeName}.pdf`;

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: item.report_s3_key,
    ResponseContentDisposition: `attachment; filename="${filename}"`
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
  
  return successResponse({ download_url: url });
}


