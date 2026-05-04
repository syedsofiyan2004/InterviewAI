import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, HeadObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { BatchGetBuildsCommand, CodeBuildClient, StartBuildCommand } from '@aws-sdk/client-codebuild';
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
  ConfirmMomUploadSchema,
  CreateMomProjectSchema,
  CreateMomSchema,
  MomResultSchema,
  MomUploadUrlSchema
} from '../../schema/mom.js';
import { generateMomPdfReport } from '../shared/mom-report.js';
import { generateInterviewPdfReport } from '../processor/index.js';

validateEnv(['TABLE_NAME', 'BUCKET_NAME', 'QUEUE_URL', 'MOM_TABLE_NAME', 'MOM_QUEUE_URL']);

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const QUEUE_URL = process.env.QUEUE_URL!;
const MOM_TABLE_NAME = process.env.MOM_TABLE_NAME!;
const MOM_QUEUE_URL = process.env.MOM_QUEUE_URL!;
const TERRAFORM_RUNNER_PROJECT_NAME = process.env.TERRAFORM_RUNNER_PROJECT_NAME || '';

const sqsClient = new SQSClient({});
const codeBuildClient = new CodeBuildClient({});

interface TfJobFileInput {
  filename: string;
  content: string;
}


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

    if (httpMethod === 'POST' && resource === '/tf-jobs') {
      return await createTfJob(event);
    }

    if (httpMethod === 'GET' && resource === '/tf-jobs/{id}') {
      return await getTfJob(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/tf-jobs/{id}/plan') {
      return await runTfPlan(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/tf-jobs/{id}/approve') {
      return await approveTfJob(pathParameters?.id, event);
    }

    if (httpMethod === 'POST' && resource === '/tf-jobs/{id}/apply') {
      return await runTfApply(pathParameters?.id, event);
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

function userTfJobPrefix(userId: string, jobId: string): string {
  return `users/${userId}/tf-jobs/${jobId}`;
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

async function getOwnedTfJobRecord(id: string | undefined, event: APIGatewayProxyEvent) {
  if (!id) {
    return { response: errorResponse(400, 'VALIDATION_ERROR', 'Missing id') };
  }

  const userId = getAuthenticatedUserId(event);
  if (!userId) {
    return { response: errorResponse(401, 'ACCESS_DENIED', 'Unauthorized') };
  }

  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFJOB#${id}`, SK: 'METADATA' },
  }));

  const item = result.Item;
  if (!item) {
    return { response: errorResponse(404, 'NOT_FOUND', 'Terraform job not found') };
  }

  if (!isOwnedBy(item, userId)) {
    return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this Terraform job') };
  }

  return { item, userId };
}

const TF_DEPLOY_ROLE_PATTERN = /^arn:aws:iam::\d{12}:role\/(TerraformDeployRole|MinfyTerraformDeployRole)$/;
const TF_FILE_NAME_PATTERN = /^[a-zA-Z0-9._-]+\.tf$/;
const TF_MAX_FILES = 20;
const TF_MAX_TOTAL_BYTES = 600 * 1024;

async function createTfJob(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  if (!TERRAFORM_RUNNER_PROJECT_NAME) {
    return errorResponse(503, 'RUNNER_NOT_CONFIGURED', 'Terraform deployment runner is not configured yet.');
  }

  const body = JSON.parse(event.body || '{}');
  const deploymentName = sanitizeText(body.deployment_name, 120) || 'Terraform deployment';
  const primaryRegion = sanitizeText(body.primary_region, 40) || 'us-east-1';
  const roleArn = sanitizeText(body.role_arn, 180);
  const files = Array.isArray(body.files) ? body.files : [];

  if (!TF_DEPLOY_ROLE_PATTERN.test(roleArn)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Use arn:aws:iam::<account-id>:role/TerraformDeployRole or arn:aws:iam::<account-id>:role/MinfyTerraformDeployRole.');
  }

  if (!files.length || files.length > TF_MAX_FILES) {
    return errorResponse(400, 'VALIDATION_ERROR', `Upload between 1 and ${TF_MAX_FILES} Terraform files.`);
  }

  const normalizedFiles = files.map((file: any) => ({
    filename: sanitizeText(file?.filename, 120),
    content: typeof file?.content === 'string' ? file.content : '',
  }));
  const totalBytes = Buffer.byteLength(JSON.stringify(normalizedFiles), 'utf8');

  if (totalBytes > TF_MAX_TOTAL_BYTES) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Terraform bundle is too large for the controlled runner.');
  }

  const invalidFile = normalizedFiles.find((file: TfJobFileInput) => !TF_FILE_NAME_PATTERN.test(file.filename) || !file.content.trim());
  if (invalidFile) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Only non-empty .tf files with simple file names are accepted.');
  }

  const jobId = uuidv4();
  const now = Date.now();
  const prefix = userTfJobPrefix(userId, jobId);
  const backendTf = `terraform {\n  backend "s3" {}\n}\n`;
  const tfvars = JSON.stringify({
    deployment_name: deploymentName,
    primary_region: primaryRegion,
    role_arn: roleArn,
    environment: 'dev',
    common_tags: {
      Project: deploymentName,
      ManagedBy: 'Terraform',
      GeneratedBy: 'Minfy AI TF Generator',
    },
  }, null, 2);

  await Promise.all([
    ...normalizedFiles.map((file: TfJobFileInput) => saveFileContent(BUCKET_NAME, `${prefix}/${file.filename}`, file.content, 'text/plain')),
    saveFileContent(BUCKET_NAME, `${prefix}/backend.tf`, backendTf, 'text/plain'),
    saveFileContent(BUCKET_NAME, `${prefix}/terraform.auto.tfvars.json`, tfvars, 'application/json'),
  ]);

  await ddbDocClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: {
      PK: `TFJOB#${jobId}`,
      SK: 'METADATA',
      owner_user_id: userId,
      item_type: 'TF_JOB',
      job_id: jobId,
      status: 'CREATED',
      deployment_name: deploymentName,
      primary_region: primaryRegion,
      role_arn: roleArn,
      s3_prefix: prefix,
      file_count: normalizedFiles.length,
      created_at: now,
      updated_at: now,
    },
  }));

  return createdResponse(await formatTfJob({ job_id: jobId, status: 'CREATED', s3_prefix: prefix, deployment_name: deploymentName, primary_region: primaryRegion, role_arn: roleArn, file_count: normalizedFiles.length, created_at: now, updated_at: now }));
}

async function getTfJob(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedTfJobRecord(id, event);
  if (response) return response;

  const refreshed = await refreshTfJobStatus(item);
  return successResponse(await formatTfJob(refreshed));
}

async function runTfPlan(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedTfJobRecord(id, event);
  if (response) return response;

  const refreshed = await refreshTfJobStatus(item);
  if (isTfBuildInFlight(refreshed.status)) {
    return errorResponse(409, 'JOB_IN_PROGRESS', 'A Terraform run is already in progress for this job.');
  }

  const buildId = await startTfBuild(refreshed, 'PLAN');
  const now = Date.now();
  const updated = await updateTfJob(id!, 'SET #st = :status, plan_build_id = :build, updated_at = :now, error_message = :null', {
    '#st': 'status',
  }, {
    ':status': 'PLAN_QUEUED',
    ':build': buildId,
    ':now': now,
    ':null': null,
  });

  return acceptedResponse(await formatTfJob(updated));
}

async function approveTfJob(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response, userId } = await getOwnedTfJobRecord(id, event);
  if (response) return response;

  const refreshed = await refreshTfJobStatus(item);
  if (refreshed.status !== 'PLAN_SUCCEEDED') {
    return errorResponse(400, 'VALIDATION_ERROR', 'Run a successful Terraform plan before approval.');
  }

  const now = Date.now();
  const updated = await updateTfJob(id!, 'SET #st = :status, approved_at = :now, approved_by = :user, updated_at = :now', {
    '#st': 'status',
  }, {
    ':status': 'APPROVED',
    ':now': now,
    ':user': userId,
  });

  return successResponse(await formatTfJob(updated));
}

async function runTfApply(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedTfJobRecord(id, event);
  if (response) return response;

  const refreshed = await refreshTfJobStatus(item);
  if (isTfBuildInFlight(refreshed.status)) {
    return errorResponse(409, 'JOB_IN_PROGRESS', 'A Terraform run is already in progress for this job.');
  }

  if (!refreshed.approved_at || !['APPROVED', 'APPLY_FAILED'].includes(refreshed.status)) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Approve the latest successful plan before applying.');
  }

  const buildId = await startTfBuild(refreshed, 'APPLY');
  const now = Date.now();
  const updated = await updateTfJob(id!, 'SET #st = :status, apply_build_id = :build, updated_at = :now, error_message = :null', {
    '#st': 'status',
  }, {
    ':status': 'APPLY_QUEUED',
    ':build': buildId,
    ':now': now,
    ':null': null,
  });

  return acceptedResponse(await formatTfJob(updated));
}

async function startTfBuild(job: any, action: 'PLAN' | 'APPLY'): Promise<string> {
  const response = await codeBuildClient.send(new StartBuildCommand({
    projectName: TERRAFORM_RUNNER_PROJECT_NAME,
    environmentVariablesOverride: [
      { name: 'TF_ACTION', value: action, type: 'PLAINTEXT' },
      { name: 'TF_BUCKET', value: BUCKET_NAME, type: 'PLAINTEXT' },
      { name: 'TF_PREFIX', value: job.s3_prefix, type: 'PLAINTEXT' },
      { name: 'TF_JOB_ID', value: job.job_id, type: 'PLAINTEXT' },
      { name: 'TF_OWNER_ID', value: job.owner_user_id, type: 'PLAINTEXT' },
    ],
  }));

  if (!response.build?.id) {
    throw new Error('Terraform runner did not return a build id');
  }

  return response.build.id;
}

async function refreshTfJobStatus(job: any) {
  const buildIds = [job.plan_build_id, job.apply_build_id].filter(Boolean);
  if (!buildIds.length) return job;

  const builds = await codeBuildClient.send(new BatchGetBuildsCommand({ ids: buildIds }));
  const planBuild = builds.builds?.find((build) => build.id === job.plan_build_id);
  const applyBuild = builds.builds?.find((build) => build.id === job.apply_build_id);

  let status = job.status;
  let errorMessage = job.error_message || null;

  if (applyBuild && ['IN_PROGRESS', 'QUEUED'].includes(applyBuild.buildStatus || '')) {
    status = 'APPLY_RUNNING';
  } else if (applyBuild?.buildStatus === 'SUCCEEDED') {
    status = 'APPLY_SUCCEEDED';
  } else if (applyBuild && ['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(applyBuild.buildStatus || '')) {
    status = 'APPLY_FAILED';
    errorMessage = applyBuild.buildStatus;
  } else if (planBuild && ['IN_PROGRESS', 'QUEUED'].includes(planBuild.buildStatus || '')) {
    status = 'PLAN_RUNNING';
  } else if (planBuild?.buildStatus === 'SUCCEEDED' && ['PLAN_QUEUED', 'PLAN_RUNNING', 'CREATED', 'PLAN_FAILED'].includes(status)) {
    status = 'PLAN_SUCCEEDED';
  } else if (planBuild && ['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT'].includes(planBuild.buildStatus || '')) {
    status = 'PLAN_FAILED';
    errorMessage = planBuild.buildStatus;
  }

  if (status === job.status && errorMessage === (job.error_message || null)) {
    return job;
  }

  return await updateTfJob(job.job_id, 'SET #st = :status, error_message = :error, updated_at = :now', {
    '#st': 'status',
  }, {
    ':status': status,
    ':error': errorMessage,
    ':now': Date.now(),
  });
}

async function updateTfJob(jobId: string, updateExpression: string, names: Record<string, string>, values: Record<string, any>) {
  const result = await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFJOB#${jobId}`, SK: 'METADATA' },
    UpdateExpression: updateExpression,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: 'ALL_NEW',
  }));
  return result.Attributes;
}

async function formatTfJob(job: any) {
  const [plan_output, apply_output] = await Promise.all([
    readOptionalTfOutput(job.s3_prefix, 'plan.txt'),
    readOptionalTfOutput(job.s3_prefix, 'apply.txt'),
  ]);

  return {
    job_id: job.job_id,
    status: job.status,
    deployment_name: job.deployment_name,
    primary_region: job.primary_region,
    role_arn: job.role_arn,
    file_count: job.file_count || 0,
    created_at: job.created_at,
    updated_at: job.updated_at,
    approved_at: job.approved_at || null,
    plan_build_id: job.plan_build_id || null,
    apply_build_id: job.apply_build_id || null,
    plan_output,
    apply_output,
    error_message: job.error_message || null,
  };
}

async function readOptionalTfOutput(prefix: string, filename: string): Promise<string | null> {
  try {
    return await getFileContent(BUCKET_NAME, `${prefix}/${filename}`);
  } catch {
    return null;
  }
}

function isTfBuildInFlight(status: string): boolean {
  return ['PLAN_QUEUED', 'PLAN_RUNNING', 'APPLY_QUEUED', 'APPLY_RUNNING'].includes(status);
}

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
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
    FilterExpression: 'SK = :sk AND owner_user_id = :owner',
    ExpressionAttributeValues: { ':sk': 'METADATA', ':owner': userId },
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


