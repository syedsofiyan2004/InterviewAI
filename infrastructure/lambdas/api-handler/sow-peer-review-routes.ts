import { APIGatewayProxyEvent } from 'aws-lambda';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ddbDocClient, getFileBuffer, getPresignedUploadUrl, saveFileContent, s3Client } from '../shared/aws.js';
import { extractJson, extractTextFromBuffer } from '../shared/utils.js';
import { successResponse, errorResponse } from '../shared/responses.js';
import { getCallerContext, requireAdminTier } from './authz.js';
import { writeAuditLog } from './audit.js';
import { v4 as uuidv4 } from 'uuid';
import { generateSowPeerReviewDocx } from '../shared/sow-peer-review-docx.js';
import { DEFAULT_SOW_PEER_REVIEW_SKILL, SOW_REVIEW_JSON_CONTRACT } from '../shared/sow-peer-review-skill.js';
import { DEFAULT_MAP_TCO_ELIGIBILITY_SKILL, LEGACY_MAP_RULES } from '../shared/map-tco-eligibility-skill.js';
import {
  SowPeerReviewContextConfirmSchema,
  SowPeerReviewReviewSchema,
  SowPeerReviewUploadSchema,
  UpdateSowPeerReviewConfigSchema,
} from '../../schema/admin.js';

const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const CALCULATOR_TABLE_NAME = process.env.CALCULATOR_TABLE_NAME!;
const CONFIG_PK = 'SOW_REVIEW#CONFIG';
const CONFIG_SK = 'PROMPT';
const CONTEXT_PREFIX = 'CONTEXT#';
const REVIEW_UPLOAD_PREFIX = 'sow-peer-review';
const STALE_REVIEW_AFTER_MS = 8 * 60 * 1000;
const MODEL_TIMEOUT_MS = 4 * 60 * 1000;
const EXTRACTION_TIMEOUT_MS = 90 * 1000;
const STORAGE_TIMEOUT_MS = 45 * 1000;
const lambdaClient = new LambdaClient({});
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_TIMEOUT`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}
const LEGACY_DEFAULT_INSTRUCTIONS = `You are an independent senior reviewer of a completed Statement of Work or proposal.
Review the supplied document and any approved reference context. Do not rewrite it.
Return only JSON with this shape:
{"overview":"string","openQuestions":[{"location":"string","question":"string","whyItMatters":"string"}],"blockers":[{"location":"string","finding":"string","whyItMatters":"string"}],"majors":[{"location":"string","finding":"string","whyItMatters":"string"}],"minors":[{"location":"string","finding":"string","whyItMatters":"string"}]}
Check structure, scope-to-effort alignment, commercial consistency, funding claims, risk coverage, client/project/date/version consistency, and professional tone. If the document does not contain enough evidence, raise an open question instead of guessing.`;

function allowedDocument(fileName: string): boolean {
  return /\.(pdf|docx)$/i.test(fileName);
}

function getSowModelText(payload: any): string {
  const content = payload?.content ?? payload?.message?.content ?? payload?.output?.[0]?.content;
  if (typeof payload?.output_text === 'string') return payload.output_text.trim();
  if (typeof payload?.completion === 'string') return payload.completion.trim();
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((block: any) => {
    if (typeof block === 'string') return block;
    if (typeof block?.text === 'string') return block.text;
    if (typeof block?.content === 'string') return block.content;
    return '';
  }).filter(Boolean).join('\n').trim();
}

function userPrefix(userId: string): string {
  return `${REVIEW_UPLOAD_PREFIX}/${userId}`;
}

function isStaleReview(item: any): boolean {
  return (item?.status === 'QUEUED' || item?.status === 'PROCESSING')
    && Number(item?.updated_at || item?.created_at || 0) < Date.now() - STALE_REVIEW_AFTER_MS;
}

async function markStaleReviewFailed(item: any) {
  const errorMessage = 'This review exceeded the 8-minute processing limit before a result was saved. Start a new review to run it with stage-specific timeouts.';
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: item.PK, SK: item.SK },
    UpdateExpression: 'SET #status = :status, error_message = :error, updated_at = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'FAILED', ':error': errorMessage, ':now': Date.now() },
  }));
  return { ...item, status: 'FAILED', error_message: errorMessage, updated_at: Date.now() };
}

async function failReview(jobId: string, message: string): Promise<void> {
  if (!jobId) return;
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: `SOW_REVIEW#JOB#${jobId}`, SK: 'META' },
    UpdateExpression: 'SET #status = :status, error_message = :error, updated_at = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: { ':status': 'FAILED', ':error': message, ':now': Date.now() },
  }));
}

function downloadName(fileName: unknown): string {
  const base = String(fileName || 'sow-peer-review').replace(/\.(pdf|docx)$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
  return `${base}-peer-review.docx`;
}

async function ensureReviewDocx(item: any): Promise<string | undefined> {
  if (item.docx_s3_key) return item.docx_s3_key;
  if (item.status !== 'COMPLETED' || !item.report || !item.review_id) return undefined;
  const docxKey = `${REVIEW_UPLOAD_PREFIX}/${item.owner_user_id}/${item.review_id}-review.docx`;
  await saveFileContent(
    BUCKET_NAME,
    docxKey,
    await generateSowPeerReviewDocx(item.report, item.file_name),
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );
  await ddbDocClient.send(new UpdateCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: item.PK, SK: item.SK },
    UpdateExpression: 'SET docx_s3_key = :docx, updated_at = :now',
    ExpressionAttributeValues: { ':docx': docxKey, ':now': Date.now() },
  }));
  return docxKey;
}

async function getConfig() {
  const response = await ddbDocClient.send(new GetCommand({
    TableName: ADMIN_TABLE_NAME,
    Key: { PK: CONFIG_PK, SK: CONFIG_SK },
  }));
  const item = response.Item as { instructions?: string; map_instructions?: string; updated_at?: number; updated_by?: string } | undefined;
  if (!item) return {
    instructions: DEFAULT_SOW_PEER_REVIEW_SKILL,
    map_instructions: DEFAULT_MAP_TCO_ELIGIBILITY_SKILL,
  };
  const instructions = !item.instructions?.trim() || item.instructions.trim() === LEGACY_DEFAULT_INSTRUCTIONS.trim()
    ? DEFAULT_SOW_PEER_REVIEW_SKILL
    : item.instructions;
  const mapInstructions = !item.map_instructions?.trim() || item.map_instructions.trim() === LEGACY_MAP_RULES.trim()
    ? DEFAULT_MAP_TCO_ELIGIBILITY_SKILL
    : item.map_instructions;
  return { ...item, instructions, map_instructions: mapInstructions };
}

async function getContextDocuments() {
  const response = await ddbDocClient.send(new QueryCommand({
    TableName: ADMIN_TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: { ':pk': CONFIG_PK, ':prefix': CONTEXT_PREFIX },
    ScanIndexForward: false,
  }));
  return (response.Items || []) as Array<{ document_id: string; file_name: string; text: string; created_at: number; created_by?: string }>;
}

export async function getSowPeerReviewConfig(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'UNAUTHORIZED', 'Sign in to use SOW Peer Review.');
  const config = await getConfig();
  return successResponse({ instructions: config.instructions || DEFAULT_SOW_PEER_REVIEW_SKILL });
}

export async function getAdminSowPeerReview(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  const [config, documents] = await Promise.all([getConfig(), getContextDocuments()]);
  return successResponse({
    instructions: config.instructions || DEFAULT_SOW_PEER_REVIEW_SKILL,
    map_instructions: config.map_instructions || '',
    documents: documents.map(({ text, ...document }) => ({ ...document, character_count: text.length })),
  });
}

export async function updateAdminSowPeerReview(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  const parsed = UpdateSowPeerReviewConfigSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!parsed.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid SOW Peer Review instructions.', parsed.error.flatten());
  const now = Date.now();
  await ddbDocClient.send(new PutCommand({
    TableName: ADMIN_TABLE_NAME,
    Item: { PK: CONFIG_PK, SK: CONFIG_SK, entity_type: 'SOW_REVIEW_CONFIG', instructions: parsed.data.instructions, map_instructions: parsed.data.map_instructions || '', updated_at: now, updated_by: caller!.userId },
  }));
  await writeAuditLog({ actorUserId: caller!.userId, actorEmail: caller!.email, action: 'SOW_REVIEW_UPDATE', targetType: 'sow_peer_review_config', targetId: CONFIG_PK, detail: 'instructions updated' });
  return successResponse({ instructions: parsed.data.instructions, updated_at: now });
}

export async function getSowPeerReviewUploadUrl(event: APIGatewayProxyEvent, adminOnly = false) {
  const caller = await getCallerContext(event);
  if (adminOnly) {
    const denied = requireAdminTier(caller, 'OWNER');
    if (denied) return denied;
  } else if (!caller) return errorResponse(401, 'UNAUTHORIZED', 'Sign in to use SOW Peer Review.');
  const parsed = SowPeerReviewUploadSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!parsed.success || !allowedDocument(parsed.data.file_name)) return errorResponse(400, 'VALIDATION_ERROR', 'Upload a PDF or DOCX document.');
  const prefix = adminOnly ? `${REVIEW_UPLOAD_PREFIX}/context/${caller!.userId}` : userPrefix(caller!.userId);
  const safeName = parsed.data.file_name.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const s3Key = `${prefix}/${Date.now()}-${safeName}`;
  const uploadUrl = await getPresignedUploadUrl(BUCKET_NAME, s3Key, parsed.data.content_type);
  return successResponse({ upload_url: uploadUrl, s3_key: s3Key, file_name: parsed.data.file_name });
}

export async function confirmAdminSowPeerReviewContext(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'OWNER');
  if (denied) return denied;
  const parsed = SowPeerReviewContextConfirmSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!parsed.success || !parsed.data.s3_key.startsWith(`${REVIEW_UPLOAD_PREFIX}/context/${caller!.userId}/`)) return errorResponse(403, 'ACCESS_DENIED', 'The uploaded context document does not belong to this admin.');
  const text = (await extractTextFromBuffer(await getFileBuffer(BUCKET_NAME, parsed.data.s3_key), parsed.data.file_name)).slice(0, 120000);
  const documentId = `${Date.now()}`;
  await ddbDocClient.send(new PutCommand({
    TableName: ADMIN_TABLE_NAME,
    Item: { PK: CONFIG_PK, SK: `${CONTEXT_PREFIX}${documentId}`, entity_type: 'SOW_REVIEW_CONTEXT', document_id: documentId, file_name: parsed.data.file_name, text, created_at: Date.now(), created_by: caller!.userId },
  }));
  await writeAuditLog({ actorUserId: caller!.userId, actorEmail: caller!.email, action: 'SOW_REVIEW_UPDATE', targetType: 'sow_peer_review_context', targetId: documentId, detail: `context document added: ${parsed.data.file_name}` });
  return successResponse({ document_id: documentId, file_name: parsed.data.file_name, character_count: text.length });
}

export async function reviewSow(event: APIGatewayProxyEvent) {
  const internal = Boolean((event as any).__internalTask);
  const caller = internal ? { userId: String((event as any).userId || ''), email: '' } : await getCallerContext(event);
  if (!caller) return errorResponse(401, 'UNAUTHORIZED', 'Sign in to use SOW Peer Review.');
  const body = JSON.parse(event.body || '{}');
  if (body.action === 'LIST') {
    const jobs: any[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await ddbDocClient.send(new ScanCommand({
        TableName: ADMIN_TABLE_NAME,
        FilterExpression: 'entity_type = :type AND owner_user_id = :owner',
        ExpressionAttributeValues: { ':type': 'SOW_REVIEW_JOB', ':owner': caller.userId },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      jobs.push(...(response.Items || []));
      exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    const items = await Promise.all(jobs.sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0)).slice(0, 100).map(async (rawItem) => {
      const item = isStaleReview(rawItem) ? await markStaleReviewFailed(rawItem) : rawItem;
      let download_url: string | undefined;
      if (item.docx_s3_key) download_url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: item.docx_s3_key, ResponseContentDisposition: `attachment; filename="${downloadName(item.file_name)}"` }), { expiresIn: 3600 });
      return {
        review_id: item.review_id,
        file_name: item.file_name,
        status: item.status,
        created_at: item.created_at,
        updated_at: item.updated_at,
        completed_at: item.completed_at,
        project_id: item.project_id || null,
        calculation_id: item.calculation_id || null,
        overview: String(item.report?.overview || '').slice(0, 240),
        counts: {
          blockers: item.report?.blockers?.length || 0,
          majors: item.report?.majors?.length || 0,
          openQuestions: item.report?.openQuestions?.length || 0,
          minors: item.report?.minors?.length || 0,
        },
        error_message: item.error_message,
        has_report: Boolean(item.report),
        download_url,
      };
    }));
    return successResponse({ items, count: items.length });
  }
  if (body.action === 'DELETE') {
    if (!body.review_id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing review id.');
    const key = { PK: `SOW_REVIEW#JOB#${body.review_id}`, SK: 'META' };
    const job = await ddbDocClient.send(new GetCommand({ TableName: ADMIN_TABLE_NAME, Key: key }));
    const item = job.Item as any;
    if (!item || item.owner_user_id !== caller.userId) return errorResponse(404, 'NOT_FOUND', 'Review job not found.');
    if (item.status === 'QUEUED' || item.status === 'PROCESSING') return errorResponse(409, 'REVIEW_IN_PROGRESS', 'Wait for the active review to finish before deleting it.');
    const artifactKeys = [...new Set([item.source_s3_key, item.docx_s3_key].filter((value): value is string => typeof value === 'string' && value.startsWith(`${userPrefix(caller.userId)}/`)))];
    await Promise.all(artifactKeys.map((artifactKey) => s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: artifactKey }))));
    await ddbDocClient.send(new DeleteCommand({ TableName: ADMIN_TABLE_NAME, Key: key }));
    return successResponse({ deleted: true, review_id: body.review_id, deleted_artifacts: artifactKeys.length });
  }
  if (body.action === 'STATUS') {
    if (!body.review_id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing review id.');
    const job = await ddbDocClient.send(new GetCommand({ TableName: ADMIN_TABLE_NAME, Key: { PK: `SOW_REVIEW#JOB#${body.review_id}`, SK: 'META' } }));
    let item = job.Item as any;
    if (!item || item.owner_user_id !== caller.userId) return errorResponse(404, 'NOT_FOUND', 'Review job not found.');
    if (isStaleReview(item)) item = await markStaleReviewFailed(item);
    let download_url: string | undefined;
    const docxKey = await ensureReviewDocx(item);
    if (docxKey) {
      download_url = await getSignedUrl(s3Client, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: docxKey, ResponseContentDisposition: `attachment; filename="${downloadName(item.file_name)}"` }), { expiresIn: 3600 });
    }
    return successResponse({ status: item.status, report: item.report, error_message: item.error_message, file_name: item.file_name, reviewed_at: item.completed_at, download_url, has_calculator_context: Boolean(item.project_id || item.calculation_id), has_reference_context: Boolean(item.include_reference_context) });
  }
  const parsed = SowPeerReviewReviewSchema.safeParse(body);
  if (!parsed.success || !parsed.data.s3_key.startsWith(`${userPrefix(caller.userId)}/`)) return errorResponse(403, 'ACCESS_DENIED', 'The uploaded SOW does not belong to this user.');
  if (!internal) {
    const reviewId = uuidv4();
    const now = Date.now();
    await ddbDocClient.send(new PutCommand({
      TableName: ADMIN_TABLE_NAME,
      Item: { PK: `SOW_REVIEW#JOB#${reviewId}`, SK: 'META', entity_type: 'SOW_REVIEW_JOB', review_id: reviewId, owner_user_id: caller.userId, file_name: parsed.data.file_name, source_s3_key: parsed.data.s3_key, project_id: parsed.data.project_id || null, calculation_id: parsed.data.calculation_id || null, include_reference_context: parsed.data.include_reference_context, status: 'QUEUED', created_at: now, updated_at: now },
    }));
    await lambdaClient.send(new InvokeCommand({
      FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: Buffer.from(JSON.stringify({ __internalTask: 'sow-peer-review', reviewId, userId: caller.userId, body: JSON.stringify(body) })),
    }));
    return successResponse({ job_id: reviewId, status: 'QUEUED', file_name: parsed.data.file_name });
  }
  const jobId = String((event as any).reviewId || body.review_id || '');
  if (jobId) await ddbDocClient.send(new UpdateCommand({ TableName: ADMIN_TABLE_NAME, Key: { PK: `SOW_REVIEW#JOB#${jobId}`, SK: 'META' }, UpdateExpression: 'SET #status = :status, updated_at = :now, started_at = :now', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':status': 'PROCESSING', ':now': Date.now() } }));
  console.info(`[SOW ${jobId}] loading skill, optional context, and source document`);
  const [config, contextDocuments, sowText] = await Promise.all([
    getConfig(),
    parsed.data.include_reference_context ? getContextDocuments() : Promise.resolve([]),
    withTimeout(getFileBuffer(BUCKET_NAME, parsed.data.s3_key), STORAGE_TIMEOUT_MS, 'SOW_SOURCE_DOWNLOAD').then((buffer) => withTimeout(extractTextFromBuffer(buffer, parsed.data.file_name), EXTRACTION_TIMEOUT_MS, 'SOW_TEXT_EXTRACTION')),
  ]);
  if (!sowText.trim()) throw new Error('SOW_TEXT_EMPTY');
  console.info(`[SOW ${jobId}] source extracted (${sowText.length} chars); optional context ${contextDocuments.length ? 'enabled' : 'disabled'}`);
  const loadEstimateContext = async (raw: any) => {
    if (!raw || raw.owner_user_id !== caller.userId) return null;
    let result = raw.result;
    if (raw.result_s3_key) {
      try { result = JSON.parse((await getFileBuffer(BUCKET_NAME, raw.result_s3_key)).toString('utf8')); } catch { /* compact result is still useful */ }
    }
    let resources = raw.resources || [];
    if (raw.resources_s3_key) {
      try { resources = JSON.parse((await getFileBuffer(BUCKET_NAME, raw.resources_s3_key)).toString('utf8')); } catch { /* bounded inline sample remains useful */ }
    }
    const lineItems = result?.lineItems || [];
    return {
      calculation_id: raw.calculation_id,
      name: raw.name,
      status: raw.status,
      created_at: raw.created_at,
      updated_at: raw.updated_at,
      monthly_total: result?.monthlyTotal ?? raw.monthly_total ?? null,
      annual_total: typeof result?.monthlyTotal === 'number' ? result.monthlyTotal * 12 : null,
      calculator_urls: (result?.scenarios || []).map((scenario: any) => ({ label: scenario.label, url: scenario.url, monthly: scenario.monthly })),
      line_items: lineItems.length ? lineItems : resources,
      resources_truncated: raw.resources_truncated === true,
      resource_count: raw.resource_count ?? resources.length,
      assumptions: result?.assumptions || raw.workbook?.assumptions || [],
      warnings: result?.warnings || [],
      map_eligibility: raw.map_eligibility || null,
    };
  };

  const estimates: any[] = [];
  if (parsed.data.project_id) {
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await ddbDocClient.send(new ScanCommand({
        TableName: CALCULATOR_TABLE_NAME,
        FilterExpression: 'owner_user_id = :owner AND project_id = :project',
        ExpressionAttributeValues: { ':owner': caller.userId, ':project': parsed.data.project_id },
        ExclusiveStartKey: exclusiveStartKey,
      }));
      for (const item of response.Items || []) {
        const contextItem = await loadEstimateContext(item);
        if (contextItem) estimates.push(contextItem);
      }
      exclusiveStartKey = response.LastEvaluatedKey as Record<string, unknown> | undefined;
    } while (exclusiveStartKey);
    if (!estimates.length) {
      const message = 'Calculator project not found or has no estimates.';
      await failReview(jobId, message);
      return errorResponse(404, 'NOT_FOUND', message);
    }
  } else if (parsed.data.calculation_id) {
    const calculation = await ddbDocClient.send(new GetCommand({ TableName: CALCULATOR_TABLE_NAME, Key: { calculation_id: parsed.data.calculation_id } }));
    const contextItem = await loadEstimateContext(calculation.Item);
    if (!contextItem) {
      const message = 'Calculation not found.';
      await failReview(jobId, message);
      return errorResponse(404, 'NOT_FOUND', message);
    }
    estimates.push(contextItem);
  }
  const calculatorContext = estimates.length ? `Connected AWS Calculator context. This is evidence for the selected ${parsed.data.project_id ? 'project and all of its estimates' : 'estimate'}; do not invent missing values:\n${JSON.stringify({ project_id: parsed.data.project_id || null, estimates }).slice(0, 60000)}` : '(no Calculator project or estimate linked; review the SOW independently)';
  const context = parsed.data.include_reference_context ? contextDocuments.map((item) => `REFERENCE: ${item.file_name}\n${item.text}`).join('\n\n').slice(0, 40000) : '(no approved reference context selected)';
  const mapGuidance = estimates.length && config.map_instructions ? `\n\nMAP guidance for funding claims:\n${config.map_instructions.slice(0, 30000)}` : '';
  const prompt = `Administrator-managed SOW Peer Review skill:\n${config.instructions || DEFAULT_SOW_PEER_REVIEW_SKILL}\n\n${SOW_REVIEW_JSON_CONTRACT}\n\nSkill runtime adapter: references to /mnt skill files mean the approved reference documents and MAP guidance explicitly supplied below. Do not claim to have read an unavailable file.\n\nApproved reference context (optional):\n${context}\n\n${calculatorContext}${mapGuidance}\n\nWhen Calculator context is present, reconcile the SOW's project name, estimate names, AWS Calculator links, scope/line items, totals, assumptions, warnings, and MAP eligibility findings. Flag mismatches, unsupported funding claims, missing service detail, and estimates whose MAP report has not yet been generated. Keep the SOW as the document under review; Calculator data is supporting context only.\n\nSOW under review (${parsed.data.file_name}):\n${sowText.slice(0, 100000)}`;
  console.info(`[SOW ${jobId}] invoking Sonnet 5 with ${prompt.length} prompt chars`);
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  const modelId = process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5';
  const modelAbort = new AbortController();
  const modelTimeout = setTimeout(() => modelAbort.abort(), MODEL_TIMEOUT_MS);
  let response;
  try {
    response = await client.send(new InvokeModelCommand({
      modelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 12000, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }),
    }), { abortSignal: modelAbort.signal });
  } finally {
    clearTimeout(modelTimeout);
  }
  console.info(`[SOW ${jobId}] model response received`);
  const payload = JSON.parse(new TextDecoder().decode(response.body));
  console.info(`[SOW ${jobId}] model payload decoded`);
  const rawText = getSowModelText(payload);
  console.info(`[SOW ${jobId}] model output: ${rawText.length} chars, stop_reason=${String(payload?.stop_reason || 'unknown')}, content_type=${Array.isArray(payload?.content) ? payload.content.map((block: any) => block?.type || typeof block).join(',') : typeof payload?.content}`);
  const jsonText = extractJson(rawText);
  console.info(`[SOW ${jobId}] structured JSON extracted (${jsonText.length} chars)`);
  if (!jsonText) {
    const message = 'The review model returned no structured findings. The document was extracted, but the model response was not valid review JSON.';
    await failReview(jobId, message);
    return errorResponse(502, 'AI_REVIEW_FAILED', message);
  }
  try {
    const report = JSON.parse(jsonText);
    console.info(`[SOW ${jobId}] report JSON parsed`);
    const completedAt = Date.now();
    let docxKey: string | undefined;
    if (jobId) {
      docxKey = `${REVIEW_UPLOAD_PREFIX}/${caller.userId}/${jobId}-review.docx`;
      await ddbDocClient.send(new UpdateCommand({ TableName: ADMIN_TABLE_NAME, Key: { PK: `SOW_REVIEW#JOB#${jobId}`, SK: 'META' }, UpdateExpression: 'SET #status = :status, report = :report, completed_at = :completed, updated_at = :completed REMOVE error_message', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':status': 'COMPLETED', ':report': report, ':completed': completedAt } }));
      console.info(`[SOW ${jobId}] structured report saved; generating DOCX report`);
      try {
        const docxBuffer = await withTimeout(generateSowPeerReviewDocx(report, parsed.data.file_name), EXTRACTION_TIMEOUT_MS, 'SOW_DOCX_GENERATION');
        console.info(`[SOW ${jobId}] DOCX generated (${docxBuffer.length} bytes); uploading`);
        await withTimeout(saveFileContent(BUCKET_NAME, docxKey, docxBuffer, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'), STORAGE_TIMEOUT_MS, 'SOW_REPORT_UPLOAD');
        await ddbDocClient.send(new UpdateCommand({ TableName: ADMIN_TABLE_NAME, Key: { PK: `SOW_REVIEW#JOB#${jobId}`, SK: 'META' }, UpdateExpression: 'SET docx_s3_key = :docx, updated_at = :now', ExpressionAttributeValues: { ':docx': docxKey, ':now': Date.now() } }));
        console.info(`[SOW ${jobId}] DOCX uploaded and linked`);
      } catch (docxError: any) {
        console.error(`[SOW ${jobId}] DOCX artifact failed after report completion:`, docxError);
        await ddbDocClient.send(new UpdateCommand({ TableName: ADMIN_TABLE_NAME, Key: { PK: `SOW_REVIEW#JOB#${jobId}`, SK: 'META' }, UpdateExpression: 'SET error_message = :error, updated_at = :now', ExpressionAttributeValues: { ':error': `Review completed, but the DOCX could not be generated: ${docxError?.message || 'DOCX_OUTPUT_FAILED'}`, ':now': Date.now() } }));
      }
    }
    return successResponse({ report, file_name: parsed.data.file_name, reviewed_at: completedAt });
  } catch {
    if (jobId) await ddbDocClient.send(new UpdateCommand({ TableName: ADMIN_TABLE_NAME, Key: { PK: `SOW_REVIEW#JOB#${jobId}`, SK: 'META' }, UpdateExpression: 'SET #status = :status, error_message = :error, updated_at = :now', ExpressionAttributeNames: { '#status': 'status' }, ExpressionAttributeValues: { ':status': 'FAILED', ':error': 'The review model returned an invalid report.', ':now': Date.now() } }));
    return errorResponse(502, 'AI_REVIEW_FAILED', 'The review model returned an invalid report.');
  }
}
