import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import { S3Client, HeadObjectCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
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
import sodium from 'libsodium-wrappers';

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

interface GithubRepoInfo {
  owner: string;
  repo: string;
}

class GithubRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'GithubRequestError';
    this.status = status;
  }
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

    if (httpMethod === 'GET' && resource === '/tf-projects') {
      return await listTfProjects(event);
    }

    if (httpMethod === 'POST' && resource === '/tf-projects') {
      return await createTfProject(event);
    }

    if (httpMethod === 'GET' && resource === '/tf-projects/{id}') {
      return await getTfProject(pathParameters?.id, event);
    }

    if (httpMethod === 'PATCH' && resource === '/tf-projects/{id}') {
      return await updateTfProject(pathParameters?.id, event);
    }

    if (httpMethod === 'DELETE' && resource === '/tf-projects/{id}') {
      return await deleteTfProject(pathParameters?.id, event);
    }

    if (httpMethod === 'GET' && resource === '/tf-workspaces') {
      return await listTfWorkspaces(event);
    }

    if (httpMethod === 'POST' && resource === '/tf-workspaces') {
      return await createTfWorkspace(event);
    }

    if (httpMethod === 'GET' && resource === '/tf-workspaces/{id}') {
      return await getTfWorkspace(pathParameters?.id, event);
    }

    if (httpMethod === 'PATCH' && resource === '/tf-workspaces/{id}') {
      return await updateTfWorkspace(pathParameters?.id, event);
    }

    if (httpMethod === 'DELETE' && resource === '/tf-workspaces/{id}') {
      return await deleteTfWorkspace(pathParameters?.id, event);
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

    if (httpMethod === 'POST' && resource === '/tf-github-pr') {
      return await createTfGithubPullRequest(event);
    }

    if (httpMethod === 'POST' && resource === '/tf-github-apply') {
      return await dispatchTfGithubApply(event);
    }

    if (httpMethod === 'POST' && resource === '/tf-github-destroy') {
      return await dispatchTfGithubDestroy(event);
    }

    if (httpMethod === 'POST' && resource === '/tf-github-token/verify') {
      return await verifyTfGithubToken(event);
    }

    if (httpMethod === 'POST' && resource === '/tf-github-secrets') {
      return await updateTfGithubSecrets(event);
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

async function getOwnedTfProjectRecord(id: string | undefined, event: APIGatewayProxyEvent) {
  if (!id) {
    return { response: errorResponse(400, 'VALIDATION_ERROR', 'Missing project id') };
  }

  const userId = getAuthenticatedUserId(event);
  if (!userId) {
    return { response: errorResponse(401, 'ACCESS_DENIED', 'Unauthorized') };
  }

  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFPROJECT#${id}`, SK: 'METADATA' },
  }));

  const item = result.Item;
  if (!item) {
    return { response: errorResponse(404, 'NOT_FOUND', 'Terraform project not found') };
  }

  if (!isOwnedBy(item, userId)) {
    return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this Terraform project') };
  }

  return { item, userId };
}

async function getOwnedTfWorkspaceRecord(id: string | undefined, event: APIGatewayProxyEvent) {
  if (!id) {
    return { response: errorResponse(400, 'VALIDATION_ERROR', 'Missing workspace id') };
  }

  const userId = getAuthenticatedUserId(event);
  if (!userId) {
    return { response: errorResponse(401, 'ACCESS_DENIED', 'Unauthorized') };
  }

  const result = await ddbDocClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFWORKSPACE#${id}`, SK: 'METADATA' },
  }));

  const item = result.Item;
  if (!item) {
    return { response: errorResponse(404, 'NOT_FOUND', 'Terraform workspace not found') };
  }

  if (!isOwnedBy(item, userId)) {
    return { response: errorResponse(403, 'ACCESS_DENIED', 'You do not have access to this Terraform workspace') };
  }

  return { item, userId };
}

const TF_DEPLOY_ROLE_PATTERN = /^arn:aws:iam::\d{12}:role\/(TerraformDeployRole|MinfyTerraformDeployRole)$/;
const TF_FILE_NAME_PATTERN = /^[a-zA-Z0-9._-]+\.tf$/;
const TF_MAX_FILES = 20;
const TF_MAX_TOTAL_BYTES = 600 * 1024;
const TF_MAX_MANIFEST_BYTES = 300 * 1024;

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
      GeneratedBy: 'Terraform Generator',
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

async function createTfProject(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const projectName = sanitizeText(body.project_name, 120);
  const description = sanitizeText(body.description, 240);

  if (!projectName) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Project name is required.');
  }

  const projectId = uuidv4();
  const now = Date.now();
  const item = {
    PK: `TFPROJECT#${projectId}`,
    SK: 'METADATA',
    owner_user_id: userId,
    item_type: 'TF_PROJECT',
    project_id: projectId,
    project_name: projectName,
    description: description || null,
    workspace_count: 0,
    created_at: now,
    updated_at: now,
  };

  await ddbDocClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  return createdResponse(formatTfProject(item));
}

async function listTfProjects(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'SK = :sk AND item_type = :type AND owner_user_id = :owner',
    ExpressionAttributeValues: {
      ':sk': 'METADATA',
      ':type': 'TF_PROJECT',
      ':owner': userId,
    },
    Limit: 50,
  }));

  const items = (result.Items || [])
    .map(formatTfProject)
    .sort((a, b) => b.updated_at - a.updated_at);

  return successResponse({ items, count: items.length });
}

async function getTfProject(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedTfProjectRecord(id, event);
  if (response) return response;

  return successResponse(formatTfProject(item));
}

async function updateTfProject(id: string | undefined, event: APIGatewayProxyEvent) {
  const { response } = await getOwnedTfProjectRecord(id, event);
  if (response) return response;

  const body = JSON.parse(event.body || '{}');
  const projectName = sanitizeText(body.project_name, 120);
  const description = sanitizeText(body.description, 240);
  if (!projectName) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Project name is required.');
  }

  const result = await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFPROJECT#${id}`, SK: 'METADATA' },
    UpdateExpression: 'SET project_name = :name, description = :description, updated_at = :now',
    ExpressionAttributeValues: {
      ':name': projectName,
      ':description': description || null,
      ':now': Date.now(),
    },
    ReturnValues: 'ALL_NEW',
  }));

  return successResponse(formatTfProject(result.Attributes));
}

async function deleteTfProject(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item: project, response, userId } = await getOwnedTfProjectRecord(id, event);
  if (response) return response;

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: 'SK = :sk AND item_type = :type AND owner_user_id = :owner AND project_id = :project',
    ExpressionAttributeValues: {
      ':sk': 'METADATA',
      ':type': 'TF_WORKSPACE',
      ':owner': userId,
      ':project': project.project_id,
    },
  }));
  const projectWorkspaces = result.Items || [];

  await Promise.all(projectWorkspaces.map((workspace) => deleteTfWorkspaceByItem(workspace)));
  await ddbDocClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFPROJECT#${project.project_id}`, SK: 'METADATA' },
  }));

  return successResponse({ message: 'Terraform project deleted', deleted_workspaces: projectWorkspaces.length });
}

async function createTfWorkspace(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const projectId = sanitizeText(body.project_id, 80);
  const deploymentName = sanitizeText(body.deployment_name, 120) || 'Terraform deployment';
  const primaryRegion = sanitizeText(body.primary_region, 40) || 'us-east-1';
  const repositoryUrl = sanitizeText(body.repository_url, 240);
  const branch = sanitizeBranchName(body.branch || '');
  const files = Array.isArray(body.files) ? body.files : [];
  const summary = typeof body.summary === 'object' && body.summary ? body.summary : {};
  const sourceManifest = typeof body.source_manifest === 'object' && body.source_manifest ? body.source_manifest : null;

  if (!projectId) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Create or select a Terraform project before saving a workspace.');
  }

  const projectResult = await getOwnedTfProjectRecord(projectId, event);
  if (projectResult.response) return projectResult.response;

  if (!files.length || files.length > TF_MAX_FILES) {
    return errorResponse(400, 'VALIDATION_ERROR', `Save between 1 and ${TF_MAX_FILES} Terraform files.`);
  }

  const normalizedFiles = files.map((file: any) => ({
    filename: sanitizeText(file?.filename, 120),
    content: typeof file?.content === 'string' ? file.content : '',
  }));
  const totalBytes = Buffer.byteLength(JSON.stringify(normalizedFiles), 'utf8');
  if (totalBytes > TF_MAX_TOTAL_BYTES) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Terraform workspace is too large to store.');
  }
  const manifestBytes = Buffer.byteLength(JSON.stringify(sourceManifest || {}), 'utf8');
  if (manifestBytes > TF_MAX_MANIFEST_BYTES) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Workbook manifest is too large to store with this workspace.');
  }

  const invalidFile = normalizedFiles.find((file: TfJobFileInput) => !TF_FILE_NAME_PATTERN.test(file.filename) || !file.content.trim());
  if (invalidFile) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Only non-empty .tf files with simple file names are accepted.');
  }

  const workspaceId = uuidv4();
  const now = Date.now();
  const prefix = `users/${userId}/tf-projects/${projectId}/workspaces/${workspaceId}`;
  await Promise.all([
    ...normalizedFiles.map((file: TfJobFileInput) => saveFileContent(BUCKET_NAME, `${prefix}/files/${file.filename}`, file.content, 'text/plain')),
    saveFileContent(BUCKET_NAME, `${prefix}/manifest.json`, JSON.stringify({
      project_id: projectId,
      deployment_name: deploymentName,
      primary_region: primaryRegion,
      repository_url: repositoryUrl || null,
      branch: branch || null,
      summary,
      source_manifest: sourceManifest,
      files: normalizedFiles.map((file: TfJobFileInput) => file.filename),
      saved_at: now,
    }, null, 2), 'application/json'),
  ]);

  const item = {
    PK: `TFWORKSPACE#${workspaceId}`,
    SK: 'METADATA',
    owner_user_id: userId,
    item_type: 'TF_WORKSPACE',
    workspace_id: workspaceId,
    project_id: projectId,
    deployment_name: deploymentName,
    primary_region: primaryRegion,
    repository_url: repositoryUrl || null,
    branch: branch || null,
    s3_prefix: prefix,
    file_count: normalizedFiles.length,
    summary,
    created_at: now,
    updated_at: now,
  };

  await ddbDocClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: item,
  }));

  await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFPROJECT#${projectId}`, SK: 'METADATA' },
    UpdateExpression: 'SET updated_at = :now ADD workspace_count :one',
    ExpressionAttributeValues: {
      ':now': now,
      ':one': 1,
    },
  }));

  return createdResponse(formatTfWorkspace(item));
}

async function listTfWorkspaces(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');
  const projectId = sanitizeText(event.queryStringParameters?.project_id, 80);

  const result = await ddbDocClient.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: projectId
      ? 'SK = :sk AND item_type = :type AND owner_user_id = :owner AND project_id = :project'
      : 'SK = :sk AND item_type = :type AND owner_user_id = :owner',
    ExpressionAttributeValues: {
      ':sk': 'METADATA',
      ':type': 'TF_WORKSPACE',
      ':owner': userId,
      ...(projectId ? { ':project': projectId } : {}),
    },
    Limit: 50,
  }));

  const items = (result.Items || [])
    .map(formatTfWorkspace)
    .sort((a, b) => b.updated_at - a.updated_at);

  return successResponse({ items, count: items.length });
}

async function getTfWorkspace(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedTfWorkspaceRecord(id, event);
  if (response) return response;

  const manifestText = await readOptionalTfOutput(item.s3_prefix, 'manifest.json');
  const manifest = manifestText ? JSON.parse(manifestText) : {};
  const fileNames = Array.isArray(manifest.files) ? manifest.files : [];
  const files = await Promise.all(fileNames.map(async (filename: string) => ({
    filename,
    content: await readOptionalTfOutput(`${item.s3_prefix}/files`, filename) || '',
  })));

  return successResponse({
    ...formatTfWorkspace(item),
    manifest,
    files: files.filter((file) => file.filename && file.content),
  });
}

async function updateTfWorkspace(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedTfWorkspaceRecord(id, event);
  if (response) return response;

  const body = JSON.parse(event.body || '{}');
  const deploymentName = sanitizeText(body.deployment_name, 120) || item.deployment_name;
  const repositoryUrl = sanitizeText(body.repository_url, 240);
  const branch = sanitizeBranchName(body.branch || '');
  const now = Date.now();

  const result = await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFWORKSPACE#${id}`, SK: 'METADATA' },
    UpdateExpression: 'SET deployment_name = :name, repository_url = :repo, branch = :branch, updated_at = :now',
    ExpressionAttributeValues: {
      ':name': deploymentName,
      ':repo': repositoryUrl || null,
      ':branch': branch || null,
      ':now': now,
    },
    ReturnValues: 'ALL_NEW',
  }));

  const manifestText = await readOptionalTfOutput(item.s3_prefix, 'manifest.json');
  if (manifestText) {
    try {
      const manifest = JSON.parse(manifestText);
      manifest.deployment_name = deploymentName;
      manifest.repository_url = repositoryUrl || null;
      manifest.branch = branch || null;
      manifest.updated_at = now;
      await saveFileContent(BUCKET_NAME, `${item.s3_prefix}/manifest.json`, JSON.stringify(manifest, null, 2), 'application/json');
    } catch (err) {
      console.warn('Unable to update Terraform workspace manifest file:', err);
    }
  }

  return successResponse(formatTfWorkspace(result.Attributes));
}

async function deleteTfWorkspace(id: string | undefined, event: APIGatewayProxyEvent) {
  const { item, response } = await getOwnedTfWorkspaceRecord(id, event);
  if (response) return response;

  await deleteTfWorkspaceByItem(item);
  if (item.project_id) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: TABLE_NAME,
      Key: { PK: `TFPROJECT#${item.project_id}`, SK: 'METADATA' },
      UpdateExpression: 'SET updated_at = :now ADD workspace_count :minusOne',
      ExpressionAttributeValues: {
        ':now': Date.now(),
        ':minusOne': -1,
      },
    })).catch((err) => console.warn('Unable to decrement Terraform project workspace count:', err));
  }

  return successResponse({ message: 'Terraform workspace deleted' });
}

async function deleteTfWorkspaceByItem(item: any) {
  if (item.s3_prefix) {
    await deleteS3Prefix(item.s3_prefix);
  }
  await ddbDocClient.send(new DeleteCommand({
    TableName: TABLE_NAME,
    Key: { PK: `TFWORKSPACE#${item.workspace_id}`, SK: 'METADATA' },
  }));
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

function formatTfProject(item: any) {
  return {
    project_id: item.project_id,
    project_name: item.project_name,
    description: item.description || null,
    workspace_count: item.workspace_count || 0,
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

function formatTfWorkspace(item: any) {
  return {
    workspace_id: item.workspace_id,
    project_id: item.project_id || null,
    deployment_name: item.deployment_name,
    primary_region: item.primary_region,
    repository_url: item.repository_url || null,
    branch: item.branch || null,
    file_count: item.file_count || 0,
    summary: item.summary || {},
    created_at: item.created_at,
    updated_at: item.updated_at,
  };
}

async function readOptionalTfOutput(prefix: string, filename: string): Promise<string | null> {
  try {
    return await getFileContent(BUCKET_NAME, `${prefix}/${filename}`);
  } catch {
    return null;
  }
}

async function deleteS3Prefix(prefix: string) {
  let continuationToken: string | undefined;
  do {
    const listed = await s3Client.send(new ListObjectsV2Command({
      Bucket: BUCKET_NAME,
      Prefix: prefix.endsWith('/') ? prefix : `${prefix}/`,
      ContinuationToken: continuationToken,
    }));

    const objects = (listed.Contents || [])
      .map((object) => object.Key)
      .filter(Boolean)
      .map((Key) => ({ Key: Key! }));

    if (objects.length) {
      await s3Client.send(new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: { Objects: objects },
      }));
    }

    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
}

function isTfBuildInFlight(status: string): boolean {
  return ['PLAN_QUEUED', 'PLAN_RUNNING', 'APPLY_QUEUED', 'APPLY_RUNNING'].includes(status);
}

function sanitizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

async function createTfGithubPullRequest(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const token = sanitizeText(body.github_token, 300);
  const repoInfo = parseGithubRepository(sanitizeText(body.repository_url, 240));
  const branch = sanitizeBranchName(body.branch || 'terraform-network');
  const baseBranch = sanitizeBranchName(body.base_branch || '');
  const deploymentName = githubDeploymentLabel(sanitizeText(body.deployment_name, 120));
  const primaryRegion = sanitizeText(body.primary_region, 40) || 'us-east-1';
  const files = Array.isArray(body.files) ? body.files : [];

  if (!token) {
    return errorResponse(400, 'VALIDATION_ERROR', 'GitHub token is required to create a branch and pull request.');
  }
  if (!repoInfo) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Enter a valid GitHub repository URL such as https://github.com/org/repo.');
  }
  if (!branch) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Branch name is required.');
  }
  if (!files.length || files.length > TF_MAX_FILES) {
    return errorResponse(400, 'VALIDATION_ERROR', `Upload between 1 and ${TF_MAX_FILES} Terraform files before creating a pull request.`);
  }

  const normalizedFiles = files.map((file: any) => ({
    filename: sanitizeText(file?.filename, 120),
    content: typeof file?.content === 'string' ? file.content : '',
  }));
  const invalidFile = normalizedFiles.find((file: TfJobFileInput) => !TF_FILE_NAME_PATTERN.test(file.filename) || !file.content.trim());
  if (invalidFile) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Only non-empty .tf files with simple file names are accepted.');
  }

  const packageFiles = buildGithubTerraformPackage(normalizedFiles, {
    deploymentName,
    primaryRegion,
  });
  const result = await pushGithubPullRequest({
    token,
    repo: repoInfo,
    branch,
    baseBranch,
    files: packageFiles,
    deploymentName,
  });

  return successResponse(result);
}

async function verifyTfGithubToken(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const token = sanitizeText(body.github_token, 300);
  const repoInfo = parseGithubRepository(sanitizeText(body.repository_url, 240));

  if (!token) {
    return errorResponse(400, 'VALIDATION_ERROR', 'GitHub token is required.');
  }
  if (!repoInfo) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Enter a valid GitHub repository URL such as https://github.com/org/repo.');
  }

  const headers = githubHeaders(token);
  const repoPath = githubRepoPath(repoInfo);
  const missingPermissions: string[] = [];
  const checks = {
    repository: false,
    contents_write: false,
    pull_requests_write: false,
    workflows_write: false,
    secrets_access: false,
    actions_write: false,
  };
  let existingRequiredSecrets: string[] = [];

  let repo: any;
  try {
    repo = await githubRequest<any>('GET', repoPath, headers);
    checks.repository = true;
  } catch (error: any) {
    const message = githubTokenAccessMessage(error);
    return successResponse({
      valid: false,
      repository: null,
      default_branch: null,
      is_empty: false,
      checks,
      missing_permissions: ['Repository access'],
      message,
    });
  }

  const defaultBranch = repo.default_branch || 'main';
  let isEmpty = false;
  try {
    await githubRequest<any>('GET', `${repoPath}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, headers);
  } catch (error: any) {
    isEmpty = error instanceof GithubRequestError && (error.status === 409 || error.status === 404);
  }

  const contentsProbe = await githubPermissionProbe('POST', `${repoPath}/git/trees`, headers, {
    tree: [{
      path: `.minfy-token-check-${Date.now()}.txt`,
      mode: '100644',
      type: 'blob',
      content: 'Minfy AI token permission check\n',
    }],
  }, [201]);
  checks.contents_write = contentsProbe.ok;
  if (!contentsProbe.ok) missingPermissions.push('Repository permissions > Contents: Read and write');

  const workflowProbe = await githubPermissionProbe('PUT', `${repoPath}/contents/.github/workflows/minfy-token-check.yml`, headers, {
    message: 'Minfy token permission check',
    branch: `minfy-token-check-${Date.now()}`,
    content: Buffer.from('name: Minfy token check\non: workflow_dispatch\njobs:\n  check:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n').toString('base64'),
  }, [404, 409, 422]);
  checks.workflows_write = workflowProbe.ok;
  if (!workflowProbe.ok) missingPermissions.push('Repository permissions > Workflows: Read and write');

  const pullProbe = await githubPermissionProbe('POST', `${repoPath}/pulls`, headers, {
    title: 'Minfy token permission check',
    head: `minfy-token-check-${Date.now()}`,
    base: defaultBranch,
    body: 'Permission check only. This request should fail validation and must not create a pull request.',
  }, [422]);
  checks.pull_requests_write = pullProbe.ok;
  if (!pullProbe.ok) missingPermissions.push('Repository permissions > Pull requests: Read and write');

  const actionsProbe = await githubPermissionProbe('POST', `${repoPath}/actions/workflows/minfy-token-check.yml/dispatches`, headers, {
    ref: defaultBranch,
  }, [404, 422]);
  checks.actions_write = actionsProbe.ok;

  const secretsProbe = await githubPermissionProbe('GET', `${repoPath}/actions/secrets?per_page=100`, headers, undefined, [200]);
  checks.secrets_access = secretsProbe.ok;
  if (checks.secrets_access) {
    const secretsData = secretsProbe.data as { secrets?: Array<{ name?: string }> } | null;
    existingRequiredSecrets = (secretsData?.secrets || [])
      .map((secret: any) => secret?.name)
      .filter((name: string) => ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'].includes(name));
  } else {
    missingPermissions.push('Repository permissions > Secrets: Read and write');
  }

  const requiredSecretsPresent = existingRequiredSecrets.includes('AWS_ACCESS_KEY_ID') && existingRequiredSecrets.includes('AWS_SECRET_ACCESS_KEY');
  const valid = checks.repository && checks.contents_write && checks.pull_requests_write && checks.workflows_write && checks.secrets_access;
  return successResponse({
    valid,
    repository: repo.html_url,
    default_branch: defaultBranch,
    is_empty: isEmpty,
    checks,
    required_secrets_present: requiredSecretsPresent,
    existing_required_secrets: existingRequiredSecrets,
    missing_permissions: missingPermissions,
    message: valid
      ? requiredSecretsPresent
        ? 'Token is valid and required AWS secrets are already present in this repository.'
        : (isEmpty ? 'Token is valid. This empty repository will be initialized before the PR is created.' : 'Token is valid for this repository.')
      : `Token can read the repository, but ${missingPermissions.length} required permission${missingPermissions.length === 1 ? ' is' : 's are'} missing.`,
  });
}

async function updateTfGithubSecrets(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const token = sanitizeText(body.github_token, 300);
  const repoInfo = parseGithubRepository(sanitizeText(body.repository_url, 240));
  const accessKeyId = sanitizeText(body.aws_access_key_id, 180);
  const secretAccessKey = sanitizeText(body.aws_secret_access_key, 260);

  if (!token) {
    return errorResponse(400, 'VALIDATION_ERROR', 'GitHub token is required.');
  }
  if (!repoInfo) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Enter a valid GitHub repository URL such as https://github.com/org/repo.');
  }
  if (!accessKeyId || !secretAccessKey) {
    return errorResponse(400, 'VALIDATION_ERROR', 'AWS access key ID and secret access key are required.');
  }

  const headers = githubHeaders(token);
  const repoPath = githubRepoPath(repoInfo);
  try {
    const publicKey = await githubRequest<any>('GET', `${repoPath}/actions/secrets/public-key`, headers);
    if (!publicKey?.key || !publicKey?.key_id) {
      throw new Error('GitHub repository public key was not available. Check token access to Actions secrets.');
    }

    await putGithubActionsSecret(repoPath, headers, publicKey, 'AWS_ACCESS_KEY_ID', accessKeyId);
    await putGithubActionsSecret(repoPath, headers, publicKey, 'AWS_SECRET_ACCESS_KEY', secretAccessKey);
  } catch (error: any) {
    if (error instanceof GithubRequestError && [401, 403, 404].includes(error.status)) {
      return errorResponse(400, 'GITHUB_SECRET_ACCESS_ERROR', 'GitHub token needs repository access plus Secrets: Read and write permission to update Actions secrets.');
    }
    throw error;
  }

  return successResponse({
    repository: `https://github.com/${repoInfo.owner}/${repoInfo.repo}`,
    updated_secrets: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'],
    message: 'AWS secrets were encrypted and updated in the GitHub repository.',
  });
}

async function dispatchTfGithubApply(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const token = sanitizeText(body.github_token, 300);
  const repoInfo = parseGithubRepository(sanitizeText(body.repository_url, 240));
  const requestedRef = sanitizeBranchName(body.ref || '');

  if (!token) {
    return errorResponse(400, 'VALIDATION_ERROR', 'GitHub token is required to trigger apply.');
  }
  if (!repoInfo) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Enter a valid GitHub repository URL such as https://github.com/org/repo.');
  }

  const headers = githubHeaders(token);
  const repoPath = githubRepoPath(repoInfo);
  const repo = await githubRequest<any>('GET', repoPath, headers);
  const ref = requestedRef || repo.default_branch || 'main';

  try {
    await githubRequest<any>('POST', `${repoPath}/actions/workflows/terraform-apply.yml/dispatches`, headers, {
      ref,
    });
  } catch (error: any) {
    if (error instanceof GithubRequestError && [401, 403].includes(error.status)) {
      return errorResponse(400, 'GITHUB_APPLY_PERMISSION_ERROR', 'GitHub token needs Repository permissions > Actions: Read and write to start the Terraform Apply workflow from the app.');
    }
    if (error instanceof GithubRequestError && [404, 422].includes(error.status)) {
      return errorResponse(400, 'GITHUB_APPLY_NOT_READY', 'Terraform apply workflow was not found on the selected branch. Merge the generated PR first, then trigger apply from the app.');
    }
    throw error;
  }

  return successResponse({
    repository: repo.html_url,
    ref,
    workflow: 'terraform-apply.yml',
    actions_url: `${repo.html_url}/actions/workflows/terraform-apply.yml`,
    message: 'Terraform apply workflow was started in GitHub Actions.',
  });
}

async function dispatchTfGithubDestroy(event: APIGatewayProxyEvent) {
  const userId = getAuthenticatedUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const body = JSON.parse(event.body || '{}');
  const token = sanitizeText(body.github_token, 300);
  const repoInfo = parseGithubRepository(sanitizeText(body.repository_url, 240));
  const requestedRef = sanitizeBranchName(body.ref || '');
  const confirmation = sanitizeText(body.confirmation, 80);

  if (confirmation !== 'DESTROY') {
    return errorResponse(400, 'DESTROY_CONFIRMATION_REQUIRED', 'Type DESTROY to confirm this destructive Terraform workflow.');
  }
  if (!token) {
    return errorResponse(400, 'VALIDATION_ERROR', 'GitHub token is required to trigger destroy.');
  }
  if (!repoInfo) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Enter a valid GitHub repository URL such as https://github.com/org/repo.');
  }

  const headers = githubHeaders(token);
  const repoPath = githubRepoPath(repoInfo);
  const repo = await githubRequest<any>('GET', repoPath, headers);
  const ref = requestedRef || repo.default_branch || 'main';

  try {
    await githubRequest<any>('POST', `${repoPath}/actions/workflows/terraform-destroy.yml/dispatches`, headers, {
      ref,
      inputs: { confirmation: 'DESTROY' },
    });
  } catch (error: any) {
    if (error instanceof GithubRequestError && [401, 403].includes(error.status)) {
      return errorResponse(400, 'GITHUB_DESTROY_PERMISSION_ERROR', 'GitHub token needs Repository permissions > Actions: Read and write to start the Terraform Destroy workflow from the app.');
    }
    if (error instanceof GithubRequestError && [404, 422].includes(error.status)) {
      return errorResponse(400, 'GITHUB_DESTROY_NOT_READY', 'Terraform destroy workflow was not found on the selected branch. Create and merge the latest generated PR first.');
    }
    throw error;
  }

  return successResponse({
    repository: repo.html_url,
    ref,
    workflow: 'terraform-destroy.yml',
    actions_url: `${repo.html_url}/actions/workflows/terraform-destroy.yml`,
    message: 'Terraform destroy workflow was started in GitHub Actions.',
  });
}

function parseGithubRepository(value: string): GithubRepoInfo | null {
  const trimmed = value.trim().replace(/\.git$/, '');
  const httpsMatch = trimmed.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)$/i);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };

  const shorthandMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (shorthandMatch) return { owner: shorthandMatch[1], repo: shorthandMatch[2] };

  return null;
}

function sanitizeBranchName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-zA-Z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/^[-/.]+|[-/.]+$/g, '')
    .slice(0, 120);
}

function buildGithubTerraformPackage(files: TfJobFileInput[], context: { deploymentName: string; primaryRegion: string }): TfJobFileInput[] {
  const environmentPath = 'environments/network';
  const deploymentName = githubDeploymentLabel(context.deploymentName);
  const transformedTerraformFiles = files.map((file) => ({
    filename: `${environmentPath}/${file.filename}`,
    content: terraformFileForGithubActions(file),
  }));

  return [
    { filename: 'README.md', content: terraformRepoReadme(deploymentName) },
    { filename: '.github/workflows/terraform-plan.yml', content: terraformGithubWorkflow(environmentPath, context.primaryRegion) },
    { filename: '.github/workflows/terraform-apply.yml', content: terraformGithubApplyWorkflow(environmentPath, context.primaryRegion) },
    { filename: '.github/workflows/terraform-destroy.yml', content: terraformGithubDestroyWorkflow(environmentPath, context.primaryRegion) },
    { filename: 'scripts/preflight-existing-resources.sh', content: terraformExistingResourceGuardScript(transformedTerraformFiles) },
    { filename: `${environmentPath}/backend.tf`, content: terraformBackendTf() },
    { filename: `${environmentPath}/backend.hcl.example`, content: terraformBackendExample() },
    { filename: `${environmentPath}/terraform.tfvars`, content: terraformTfvars({ ...context, deploymentName }) },
    ...transformedTerraformFiles,
  ];
}

function githubDeploymentLabel(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64) return 'Terraform network deployment';
  return trimmed;
}

function providerForGithubActions(content: string): string {
  return content.replace(/\n\s*assume_role\s*\{\s*\n\s*role_arn\s*=\s*var\.role_arn\s*\n\s*\}\s*\n/g, '\n');
}

function terraformFileForGithubActions(file: TfJobFileInput): string {
  if (file.filename === 'provider.tf') return providerForGithubActions(file.content);
  if (file.filename === 'variables.tf') {
    return file.content.replace(/variable "role_arn" \{\n\s*type = string\n\}/, 'variable "role_arn" {\n  type    = string\n  default = ""\n}');
  }
  return file.content;
}

function terraformRepoReadme(deploymentName: string): string {
  return `# ${deploymentName}

Terraform workspace for AWS network infrastructure.

## Workflow

1. Review the Terraform files under \`environments/network\`.
2. Configure GitHub Actions with AWS access keys from the target account.
3. Add repository secrets:
   - \`AWS_ACCESS_KEY_ID\`
   - \`AWS_SECRET_ACCESS_KEY\`
4. Open a pull request and review the Terraform plan output.
5. Merge only after review, then trigger the manual Terraform Apply workflow.

## Safety controls

- Pull request plans fail when Terraform proposes update, delete, or replacement actions.
- Apply runs a fresh plan and uses the same update/delete/replace guard before applying.
- Destroy is a separate manual workflow and should not be used for client environments unless explicitly approved.

## Notes

- Resource names are preserved from the Excel workbook where the workbook provides names.
- Existing resources should be imported before apply if they already exist in the target AWS account.
- The workflows bootstrap an encrypted S3 backend and DynamoDB lock table in the target AWS account.
- Terraform state is kept in the target AWS account.
`;
}

function terraformGithubWorkflow(environmentPath: string, fallbackRegion: string): string {
  return `name: Terraform Plan

on:
  pull_request:
    paths:
      - '${environmentPath}/**'
      - '.github/workflows/terraform-plan.yml'
      - 'scripts/**'
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

jobs:
  terraform-plan:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${environmentPath}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Check required GitHub secrets
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          missing=0
          for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
            if [ -z "\${!name}" ]; then
              echo "::error title=Missing GitHub secret::$name is required before Terraform plan can run."
              missing=1
            fi
          done
          if [ "$missing" -eq 1 ]; then
            echo "Add the missing values in GitHub repository Settings > Secrets and variables > Actions."
            exit 1
          fi

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${fallbackRegion}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.8.5

      - name: Terraform fmt
        run: terraform fmt -recursive

      - name: Prepare S3 backend
        run: |
${terraformBackendBootstrapScript(fallbackRegion)}

      - name: Terraform init
        run: terraform init -backend-config=backend.hcl

      - name: Detect unmanaged existing resources
        run: bash ../../scripts/preflight-existing-resources.sh

      - name: Terraform validate
        run: terraform validate

      - name: Terraform plan
        run: terraform plan -input=false -var-file=terraform.tfvars -out=tfplan

      - name: Block update/delete/replace actions
        run: |
${terraformPlanSafetyGuardScript()}
`;
}

function terraformGithubApplyWorkflow(environmentPath: string, fallbackRegion: string): string {
  return `name: Terraform Apply

on:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: terraform-apply
  cancel-in-progress: false

jobs:
  terraform-apply:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${environmentPath}
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Check required GitHub secrets
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          missing=0
          for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
            if [ -z "\${!name}" ]; then
              echo "::error title=Missing GitHub secret::$name is required before Terraform apply can run."
              missing=1
            fi
          done
          if [ "$missing" -eq 1 ]; then
            echo "Add the missing values in GitHub repository Settings > Secrets and variables > Actions."
            exit 1
          fi

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${fallbackRegion}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.8.5

      - name: Terraform fmt
        run: terraform fmt -recursive

      - name: Prepare S3 backend
        run: |
${terraformBackendBootstrapScript(fallbackRegion)}

      - name: Terraform init
        run: terraform init -backend-config=backend.hcl

      - name: Detect unmanaged existing resources
        run: bash ../../scripts/preflight-existing-resources.sh

      - name: Terraform validate
        run: terraform validate

      - name: Terraform plan
        run: terraform plan -input=false -var-file=terraform.tfvars -out=tfplan

      - name: Block update/delete/replace actions
        run: |
${terraformPlanSafetyGuardScript()}

      - name: Terraform apply
        run: terraform apply -input=false -auto-approve tfplan

      - name: Verify remote state
        run: |
${terraformStateVerificationScript()}
`;
}

function terraformGithubDestroyWorkflow(environmentPath: string, fallbackRegion: string): string {
  return `name: Terraform Destroy

on:
  workflow_dispatch:
    inputs:
      confirmation:
        description: 'Type DESTROY to confirm this destructive run'
        required: true

permissions:
  contents: read

concurrency:
  group: terraform-destroy
  cancel-in-progress: false

jobs:
  terraform-destroy:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: ${environmentPath}
    steps:
      - name: Confirm destructive workflow
        if: \${{ github.event.inputs.confirmation != 'DESTROY' }}
        run: |
          echo "::error title=Destroy confirmation missing::Type DESTROY to run this workflow."
          exit 1

      - name: Checkout
        uses: actions/checkout@v4

      - name: Check required GitHub secrets
        env:
          AWS_ACCESS_KEY_ID: \${{ secrets.AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
        run: |
          missing=0
          for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
            if [ -z "\${!name}" ]; then
              echo "::error title=Missing GitHub secret::$name is required before Terraform destroy can run."
              missing=1
            fi
          done
          if [ "$missing" -eq 1 ]; then
            echo "Add the missing values in GitHub repository Settings > Secrets and variables > Actions."
            exit 1
          fi

      - name: Configure AWS credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          aws-access-key-id: \${{ secrets.AWS_ACCESS_KEY_ID }}
          aws-secret-access-key: \${{ secrets.AWS_SECRET_ACCESS_KEY }}
          aws-region: ${fallbackRegion}

      - name: Setup Terraform
        uses: hashicorp/setup-terraform@v3
        with:
          terraform_version: 1.8.5

      - name: Remove runtime prevent_destroy guards
        run: |
          find . -name "*.tf" -type f -print0 | xargs -0 perl -0pi -e 's/\\n\\s*lifecycle\\s*\\{\\s*prevent_destroy\\s*=\\s*true\\s*\\}\\s*//g'

      - name: Prepare S3 backend
        run: |
${terraformBackendBootstrapScript(fallbackRegion)}

      - name: Terraform init
        run: terraform init -backend-config=backend.hcl

      - name: Terraform validate
        run: terraform validate

      - name: Terraform destroy plan
        run: terraform plan -destroy -input=false -var-file=terraform.tfvars -out=tfdestroy

      - name: Terraform destroy
        run: terraform apply -input=false -auto-approve tfdestroy
`;
}

function terraformStateVerificationScript(): string {
  return `          set -euo pipefail
          STATE_BUCKET=$(awk -F '"' '/bucket/ { print $2 }' backend.hcl)
          STATE_KEY=$(awk -F '"' '/key/ { print $2 }' backend.hcl)
          if [ -z "$STATE_BUCKET" ] || [ -z "$STATE_KEY" ]; then
            echo "::error title=Terraform state check failed::The generated backend.hcl did not contain bucket and key values."
            exit 1
          fi
          if ! aws s3api head-object --bucket "$STATE_BUCKET" --key "$STATE_KEY" >/dev/null 2>&1; then
            echo "::error title=Terraform state file was not written::Apply finished without finding s3://$STATE_BUCKET/$STATE_KEY. Check the apply logs for backend initialization or provider errors."
            exit 1
          fi
          echo "Terraform state is stored at s3://$STATE_BUCKET/$STATE_KEY"`;
}

function terraformPlanSafetyGuardScript(): string {
  return `          terraform show -json tfplan > tfplan.json
          blocked=$(jq -r '[.resource_changes[]? | select((.change.actions | index("delete")) or (.change.actions | index("update"))) | "\\(.address): \\(.change.actions | join(","))"] | .[]' tfplan.json)
          if [ -n "$blocked" ]; then
            echo "::error title=Terraform plan blocked::This workflow only permits create/no-op actions. Import existing resources or open a reviewed change workflow before modifying or destroying infrastructure."
            echo "$blocked"
            exit 1
          fi`;
}

function terraformExistingResourceGuardScript(files: TfJobFileInput[]): string {
  const fileMap = new Map(files.map((file) => [file.filename, file.content]));
  const vpcs = extractTerraformNamedResources(fileMap.get('environments/network/vpc.tf') || '', 'aws_vpc')
    .map((resource) => ({
      id: resource.name,
      cidr: extractHclString(resource.body, 'cidr_block'),
      awsName: extractHclMapString(resource.body, 'Name'),
    }))
    .filter((resource) => resource.cidr && resource.awsName);
  const subnets = extractTerraformNamedResources(fileMap.get('environments/network/subnets.tf') || '', 'aws_subnet')
    .map((resource) => ({
      id: resource.name,
      cidr: extractHclString(resource.body, 'cidr_block'),
      awsName: extractHclMapString(resource.body, 'Name'),
    }))
    .filter((resource) => resource.cidr && resource.awsName);

  const vpcChecks = vpcs
    .map((resource) => `check_vpc ${shellSingleQuote(`aws_vpc.${resource.id}`)} ${shellSingleQuote(resource.awsName)} ${shellSingleQuote(resource.cidr)}`)
    .join('\n');
  const subnetChecks = subnets
    .map((resource) => `check_subnet ${shellSingleQuote(`aws_subnet.${resource.id}`)} ${shellSingleQuote(resource.awsName)} ${shellSingleQuote(resource.cidr)}`)
    .join('\n');

  return `#!/usr/bin/env bash
set -euo pipefail

blocked=0

is_managed() {
  terraform state show "$1" >/dev/null 2>&1
}

check_vpc() {
  local address="$1"
  local name="$2"
  local cidr="$3"
  if is_managed "$address"; then
    return 0
  fi

  local existing
  existing=$(aws ec2 describe-vpcs \\
    --filters "Name=tag:Name,Values=$name" "Name=cidr-block,Values=$cidr" \\
    --query 'Vpcs[0].VpcId' \\
    --output text 2>/dev/null || true)

  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    echo "::error title=Existing VPC is not in Terraform state::$address matches existing VPC $existing (Name=$name, CIDR=$cidr). Import it into this workspace state before applying, otherwise Terraform may create duplicate infrastructure."
    blocked=1
  fi
}

check_subnet() {
  local address="$1"
  local name="$2"
  local cidr="$3"
  if is_managed "$address"; then
    return 0
  fi

  local existing
  existing=$(aws ec2 describe-subnets \\
    --filters "Name=tag:Name,Values=$name" "Name=cidr-block,Values=$cidr" \\
    --query 'Subnets[0].SubnetId' \\
    --output text 2>/dev/null || true)

  if [ -n "$existing" ] && [ "$existing" != "None" ]; then
    echo "::error title=Existing subnet is not in Terraform state::$address matches existing subnet $existing (Name=$name, CIDR=$cidr). Import it into this workspace state before applying."
    blocked=1
  fi
}

${vpcChecks || '# No generated VPC resources to preflight.'}
${subnetChecks || '# No generated subnet resources to preflight.'}

if [ "$blocked" -eq 1 ]; then
  echo "Detected existing AWS resources that are not managed by this Terraform state. Import them first, or use a clean workbook/name range."
  exit 1
fi
`;
}

function extractTerraformNamedResources(content: string, type: string): Array<{ name: string; body: string }> {
  const resources: Array<{ name: string; body: string }> = [];
  const regex = new RegExp(`resource\\s+"${type}"\\s+"([^"]+)"\\s+\\{`, 'g');
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content))) {
    const bodyStart = regex.lastIndex;
    let depth = 1;
    let cursor = bodyStart;
    while (cursor < content.length && depth > 0) {
      const char = content[cursor++];
      if (char === '{') depth++;
      if (char === '}') depth--;
    }
    resources.push({ name: match[1], body: content.slice(bodyStart, cursor - 1) });
    regex.lastIndex = cursor;
  }
  return resources;
}

function extractHclString(content: string, key: string): string {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = content.match(new RegExp(`${escapedKey}\\s*=\\s*"([^"]+)"`));
  return match?.[1] || '';
}

function extractHclMapString(content: string, key: string): string {
  return extractHclString(content, key);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function terraformBackendBootstrapScript(region: string): string {
  return `          set -euo pipefail
          TF_REGION="${region}"
          ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
          REPO_SAFE=$(echo "\${GITHUB_REPOSITORY#*/}" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed 's/^-//;s/-$//' | cut -c1-28)
          STATE_BUCKET="tf-state-\${ACCOUNT_ID}-\${TF_REGION}-\${REPO_SAFE}"
          LOCK_TABLE="tf-lock-\${REPO_SAFE}"

          if ! aws s3api head-bucket --bucket "\${STATE_BUCKET}" 2>/dev/null; then
            if [ "\${TF_REGION}" = "us-east-1" ]; then
              aws s3api create-bucket --bucket "\${STATE_BUCKET}" --region "\${TF_REGION}"
            else
              aws s3api create-bucket --bucket "\${STATE_BUCKET}" --region "\${TF_REGION}" --create-bucket-configuration LocationConstraint="\${TF_REGION}"
            fi
          fi

          aws s3api put-public-access-block --bucket "\${STATE_BUCKET}" --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
          aws s3api put-bucket-versioning --bucket "\${STATE_BUCKET}" --versioning-configuration Status=Enabled
          aws s3api put-bucket-encryption --bucket "\${STATE_BUCKET}" --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

          if ! aws dynamodb describe-table --table-name "\${LOCK_TABLE}" --region "\${TF_REGION}" >/dev/null 2>&1; then
            aws dynamodb create-table \\
              --table-name "\${LOCK_TABLE}" \\
              --attribute-definitions AttributeName=LockID,AttributeType=S \\
              --key-schema AttributeName=LockID,KeyType=HASH \\
              --billing-mode PAY_PER_REQUEST \\
              --region "\${TF_REGION}"
            aws dynamodb wait table-exists --table-name "\${LOCK_TABLE}" --region "\${TF_REGION}"
          fi

          {
            echo "bucket         = \\"\${STATE_BUCKET}\\""
            echo "key            = \\"network/terraform.tfstate\\""
            echo "region         = \\"\${TF_REGION}\\""
            echo "dynamodb_table = \\"\${LOCK_TABLE}\\""
            echo "encrypt        = true"
          } > backend.hcl`;
}

function terraformBackendExample(): string {
  return `bucket = "client-terraform-state-bucket"
key    = "network/terraform.tfstate"
region = "us-east-1"
dynamodb_table = "client-terraform-locks"
encrypt = true
`;
}

function terraformBackendTf(): string {
  return `terraform {
  backend "s3" {}
}
`;
}

function terraformTfvars(context: { deploymentName: string; primaryRegion: string }): string {
  return `deployment_name = ${JSON.stringify(context.deploymentName)}
primary_region  = ${JSON.stringify(context.primaryRegion)}
environment     = "prod"

common_tags = {
  ManagedBy   = "Terraform"
  GeneratedBy = "Terraform Generator"
}
`;
}

function githubHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'Minfy-AI-TF-Generator',
  };
}

function githubRepoPath(repo: GithubRepoInfo) {
  return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`;
}

async function pushGithubPullRequest(params: {
  token: string;
  repo: GithubRepoInfo;
  branch: string;
  baseBranch: string;
  files: TfJobFileInput[];
  deploymentName: string;
}) {
  const headers = githubHeaders(params.token);

  const repoPath = githubRepoPath(params.repo);
  const repo = await githubRequest<any>('GET', repoPath, headers);
  const baseBranch = params.baseBranch || repo.default_branch;
  if (params.branch === baseBranch) {
    throw new Error('Use a feature branch name that is different from the repository default branch.');
  }

  let baseRef: any;
  try {
    baseRef = await githubRequest<any>('GET', `${repoPath}/git/ref/heads/${encodeURIComponent(baseBranch)}`, headers);
  } catch (error: any) {
    if (error instanceof GithubRequestError && error.status === 409 && /empty/i.test(error.message)) {
      baseRef = await initializeEmptyGithubRepository(repoPath, headers, baseBranch);
    } else {
      throw error;
    }
  }
  let targetRef = await githubRequest<any>('GET', `${repoPath}/git/ref/heads/${encodeURIComponent(params.branch)}`, headers, undefined, { allowNotFound: true });

  if (!targetRef) {
    targetRef = await githubRequest<any>('POST', `${repoPath}/git/refs`, headers, {
      ref: `refs/heads/${params.branch}`,
      sha: baseRef.object.sha,
    });
  }

  const targetCommitSha = targetRef.object.sha;
  const targetCommit = await githubRequest<any>('GET', `${repoPath}/git/commits/${targetCommitSha}`, headers);
  const tree = await githubRequest<any>('POST', `${repoPath}/git/trees`, headers, {
    base_tree: targetCommit.tree.sha,
    tree: params.files.map((file) => ({
      path: file.filename,
      mode: '100644',
      type: 'blob',
      content: file.content,
    })),
  });
  const commit = await githubRequest<any>('POST', `${repoPath}/git/commits`, headers, {
    message: `Add Terraform network package for ${params.deploymentName}`,
    tree: tree.sha,
    parents: [targetCommitSha],
  });

  await githubRequest<any>('PATCH', `${repoPath}/git/refs/heads/${encodeURIComponent(params.branch)}`, headers, {
    sha: commit.sha,
    force: false,
  });

  const pull = await githubRequest<any>('POST', `${repoPath}/pulls`, headers, {
    title: `Add Terraform network package for ${params.deploymentName}`,
    head: params.branch,
    base: baseBranch,
    body: githubPullRequestBody(params.deploymentName),
  }, { allowValidationError: true });

  if (pull?.html_url) {
    return {
      repository: repo.html_url,
      branch: params.branch,
      commit_url: commit.html_url,
      pull_request_url: pull.html_url,
      pull_request_number: pull.number,
    };
  }

  const existingPulls = await githubRequest<any[]>('GET', `${repoPath}/pulls?head=${encodeURIComponent(`${params.repo.owner}:${params.branch}`)}&base=${encodeURIComponent(baseBranch)}&state=open`, headers);
  const existingPull = existingPulls?.[0];
  return {
    repository: repo.html_url,
    branch: params.branch,
    commit_url: commit.html_url,
    pull_request_url: existingPull?.html_url || null,
    pull_request_number: existingPull?.number || null,
  };
}

async function initializeEmptyGithubRepository(repoPath: string, headers: Record<string, string>, baseBranch: string) {
  const tree = await githubRequest<any>('POST', `${repoPath}/git/trees`, headers, {
    tree: [{
      path: 'README.md',
      mode: '100644',
      type: 'blob',
      content: '# Terraform Infrastructure\n\nRepository initialized for infrastructure-as-code workflows.\n',
    }],
  });
  const commit = await githubRequest<any>('POST', `${repoPath}/git/commits`, headers, {
    message: 'Initialize Terraform repository',
    tree: tree.sha,
    parents: [],
  });
  return await githubRequest<any>('POST', `${repoPath}/git/refs`, headers, {
    ref: `refs/heads/${baseBranch}`,
    sha: commit.sha,
  });
}

function githubPullRequestBody(deploymentName: string): string {
  return `## Terraform network package

Generated by Minfy AI TF Generator for **${deploymentName}**.

### Review checklist

- [ ] Confirm VPC, subnet, and route table names match the approved workbook.
- [ ] Confirm CIDR ranges do not overlap existing client networks.
- [ ] Confirm AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY Actions secrets point to the intended target account.
- [ ] Review Terraform plan output before merge.
- [ ] Trigger Terraform Apply from the Minfy app only after the PR is merged.
`;
}

function githubTokenAccessMessage(error: any) {
  if (error instanceof GithubRequestError) {
    if (error.status === 401) return 'Token is invalid or expired. Generate a new token and try again.';
    if (error.status === 403) return 'Token is valid, but it is not allowed to access this repository.';
    if (error.status === 404) return 'Repository was not found or this fine-grained token was not granted access to it.';
  }
  return error?.message || 'Unable to verify GitHub token.';
}

async function putGithubActionsSecret(
  repoPath: string,
  headers: Record<string, string>,
  publicKey: { key: string; key_id: string },
  name: string,
  value: string,
) {
  const encryptedValue = await encryptGithubSecret(value, publicKey.key);
  await githubRequest<any>('PUT', `${repoPath}/actions/secrets/${encodeURIComponent(name)}`, headers, {
    encrypted_value: encryptedValue,
    key_id: publicKey.key_id,
  });
}

async function encryptGithubSecret(value: string, publicKey: string): Promise<string> {
  await sodium.ready;
  const publicKeyBytes = sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL);
  const valueBytes = sodium.from_string(value);
  const encryptedBytes = sodium.crypto_box_seal(valueBytes, publicKeyBytes);
  return sodium.to_base64(encryptedBytes, sodium.base64_variants.ORIGINAL);
}

async function githubPermissionProbe(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: any,
  acceptableStatuses: number[],
) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: JSON.stringify(body),
  });
  if (acceptableStatuses.includes(response.status)) {
    const data = await response.json().catch(() => null);
    return { ok: true, status: response.status, message: null, data };
  }
  const error: any = await response.json().catch(() => ({}));
  return {
    ok: false,
    status: response.status,
    message: error?.message || `GitHub API request failed with ${response.status}`,
    data: null,
  };
}

async function githubRequest<T>(
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: any,
  options?: { allowNotFound?: boolean; allowValidationError?: boolean },
): Promise<T | null> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (options?.allowNotFound && response.status === 404) return null;
  if (options?.allowValidationError && response.status === 422) return null;

  if (!response.ok) {
    const error: any = await response.json().catch(() => ({}));
    const message = error?.message || `GitHub API request failed with ${response.status}`;
    throw new GithubRequestError(response.status, message);
  }

  if (response.status === 204) return null;
  return await response.json() as T;
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


