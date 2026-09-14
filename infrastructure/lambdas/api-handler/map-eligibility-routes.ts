import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { ddbDocClient, getFileBuffer } from '../shared/aws.js';
import { extractJson } from '../shared/utils.js';
import { errorResponse, successResponse } from '../shared/responses.js';
import { getCallerContext } from './authz.js';
import { v4 as uuidv4 } from 'uuid';
import { MapEligibilityInputSchema, MapEligibilityReportSchema, CalculationRecordSchema } from '../../schema/calculator.js';
import { DEFAULT_MAP_TCO_ELIGIBILITY_SKILL, LEGACY_MAP_RULES, MAP_FUNDING_REFERENCE, MAP_INCLUDED_SERVICES_REFERENCE } from '../shared/map-tco-eligibility-skill.js';

const TABLE_NAME = process.env.CALCULATOR_TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;
const MODEL_ID = process.env.BEDROCK_SONNET_5_PROFILE_ARN || 'global.anthropic.claude-sonnet-5';
const ADMIN_TABLE_NAME = process.env.ADMIN_TABLE_NAME!;
const lambdaClient = new LambdaClient({});
const DISCLAIMER = 'Estimate only — not a binding MAP/MAP Lite funding determination. Confirm against current AWS Partner Central terms.';

export const DEFAULT_MAP_RULES = DEFAULT_MAP_TCO_ELIGIBILITY_SKILL;

async function getConfiguredMapRules(): Promise<string> {
  if (!ADMIN_TABLE_NAME) return DEFAULT_MAP_TCO_ELIGIBILITY_SKILL;
  const response = await ddbDocClient.send(new GetCommand({ TableName: ADMIN_TABLE_NAME, Key: { PK: 'SOW_REVIEW#CONFIG', SK: 'PROMPT' } }));
  const configured = (response.Item as { map_instructions?: string } | undefined)?.map_instructions;
  if (!configured?.trim() || configured.trim() === LEGACY_MAP_RULES.trim()) return DEFAULT_MAP_TCO_ELIGIBILITY_SKILL;
  return configured;
}

export async function queueMapEligibility(id: string | undefined, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing calculation id');
  const inputResult = MapEligibilityInputSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!inputResult.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid MAP eligibility inputs.', inputResult.error.flatten());
  const existing = await ddbDocClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { calculation_id: id } }));
  const record = existing.Item as any;
  if (!record || record.owner_user_id !== caller.userId) return errorResponse(404, 'NOT_FOUND', 'Calculation not found');
  const jobId = uuidv4();
  const now = Date.now();
  await ddbDocClient.send(new UpdateCommand({ TableName: TABLE_NAME, Key: { calculation_id: id }, UpdateExpression: 'SET map_eligibility_job = :job, updated_at = :now', ExpressionAttributeValues: { ':job': { job_id: jobId, status: 'QUEUED', inputs: inputResult.data, created_at: now, updated_at: now }, ':now': now } }));
  await lambdaClient.send(new InvokeCommand({ FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify({ __internalTask: 'map-eligibility', calculationId: id, userId: caller.userId, jobId, body: event.body || '{}' })) }));
  return successResponse({ calculation_id: id, job_id: jobId, status: 'QUEUED' });
}

export async function getMapEligibilityStatus(id: string | undefined, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  const record = id ? await loadFullRecord(id, caller.userId) : null;
  if (!record) return errorResponse(404, 'NOT_FOUND', 'Calculation not found');
  return successResponse({ calculation_id: id, ...(record.map_eligibility_job || { status: record.map_eligibility ? 'COMPLETED' : 'NOT_STARTED' }), map_eligibility: record.map_eligibility || null });
}

function getUserId(event: APIGatewayProxyEvent): string | null {
  return event.requestContext.authorizer?.claims?.sub || event.requestContext.authorizer?.jwt?.claims?.sub || null;
}

async function loadFullRecord(id: string, userId: string): Promise<any> {
  const response = await ddbDocClient.send(new GetCommand({ TableName: TABLE_NAME, Key: { calculation_id: id } }));
  const record = response.Item as any;
  if (!record || record.owner_user_id !== userId) return null;
  let result = record.result;
  if (record.result_s3_key) {
    try { result = JSON.parse((await getFileBuffer(BUCKET_NAME, record.result_s3_key)).toString('utf8')); } catch { /* compact inline result remains usable */ }
  }
  let resources = record.resources || [];
  if (record.resources_s3_key) {
    try { resources = JSON.parse((await getFileBuffer(BUCKET_NAME, record.resources_s3_key)).toString('utf8')); } catch { /* bounded inline sample remains usable */ }
  }
  return { ...record, result, resources };
}

export async function generateMapEligibility(id: string | undefined, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const internal = Boolean((event as any).__internalTask);
  const caller = internal ? { userId: String((event as any).userId || ''), email: '' } : await getCallerContext(event);
  const userId = getUserId(event) || caller?.userId;
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  if (!id) return errorResponse(400, 'VALIDATION_ERROR', 'Missing calculation id');
  const inputResult = MapEligibilityInputSchema.safeParse(JSON.parse(event.body || '{}'));
  if (!inputResult.success) return errorResponse(400, 'VALIDATION_ERROR', 'Invalid MAP eligibility inputs.', inputResult.error.flatten());
  const record = await loadFullRecord(id, userId);
  if (!record) return errorResponse(404, 'NOT_FOUND', 'Calculation not found');
  const parsedRecord = CalculationRecordSchema.safeParse(record);
  if (!parsedRecord.success) return errorResponse(409, 'CONFLICT', 'The estimate is not ready for MAP eligibility analysis.');
  const result = record.result;
  if (!result || (!result.url && !(result.scenarios || []).some((scenario: any) => scenario.url))) {
    return errorResponse(409, 'CONFLICT', 'Generate a completed AWS Pricing Calculator link before running MAP eligibility.');
  }

  const monthly = Number(result.monthlyTotal || 0);
  const arr = monthly > 0 ? monthly * 12 : null;
  // Completed estimates can carry their priced line items in the result, while
  // uploaded/project estimates may only retain the original inventory rows. Feed
  // both shapes to the analyst so MAP never reports "no line items" when the
  // Calculator has usable resource evidence.
  const resultLines = Array.isArray(result.lineItems) ? result.lineItems : [];
  const resourceLines = Array.isArray(record.resources) ? record.resources.map((resource: any) => {
    const monthlyCost = typeof resource.reported_monthly === 'number' ? resource.reported_monthly : null;
    return {
      service: resource.service || resource.name || 'Unclassified workload',
      detail: resource.size || resource.raw || resource.name || null,
      environment: resource.environment || null,
      region: resource.region || null,
      quantity: resource.quantity || null,
      monthly: monthlyCost,
      annual: monthlyCost === null ? null : monthlyCost * 12,
      source: resource.sheet && resource.row ? `${resource.sheet} row ${resource.row}` : null,
    };
  }) : [];
  const lines = (resultLines.length ? resultLines : resourceLines).map((line: any) => ({
    service: line.service || line.productCode || line.name || 'Unclassified workload',
    productCode: line.productCode,
    detail: line.detail || line.description || line.raw || null,
    environment: line.environment || null,
    region: line.region || null,
    quantity: line.quantity || null,
    monthly: typeof line.monthly === 'number' ? line.monthly : (typeof line.monthlyCost === 'number' ? line.monthlyCost : null),
    annual: typeof line.annual === 'number' ? line.annual : (typeof line.monthly === 'number' ? line.monthly * 12 : (typeof line.monthlyCost === 'number' ? line.monthlyCost * 12 : null)),
    source: line.source || null,
  }));
  const configuredRules = await getConfiguredMapRules();
  const prompt = `You are the MAP eligibility analyst inside an AWS cost-estimation workflow. Use only the estimate evidence and explicit modifier inputs below. Return only one JSON object matching this shape:
{"status":"COMPLETED","arr":number|null,"tier":"string","eligibleAnnualSpend":number|null,"estimatedPartnerCash":number|null,"estimatedCredits":number|null,"assessCash":number|null,"mobilizeCash":number|null,"migrateModernizeCredits":number|null,"modifierInputs":{},"findings":[{"service":"string","productCode":"string","category":"General|DB&A|SAP & Oracle","monthlyCost":number|null,"annualCost":number|null,"eligibility":"Eligible|Partially eligible|Not eligible|Needs manual review","notes":"string"}],"openQuestions":["string"],"assumptions":["string"],"disclaimer":"${DISCLAIMER}"}

Administrator-managed MAP/TCO eligibility skill:
${configuredRules}

Funding reference:
${MAP_FUNDING_REFERENCE}

Included-services reference:
${MAP_INCLUDED_SERVICES_REFERENCE}

Explicit modifier inputs (missing means unclaimed, never guessed): ${JSON.stringify(inputResult.data)}
Estimate name: ${record.name}
Estimate ARR derived from monthly total: ${arr}
Estimate evidence (${lines.length} rows; resources fallback used when priced line items were not retained): ${JSON.stringify(lines).slice(0, 180000)}
AWS Calculator links: ${JSON.stringify((result.scenarios || []).map((scenario: any) => ({ label: scenario.label, url: scenario.url, monthly: scenario.monthly })))}
Return a funding estimate only; state that it is not binding.`;

  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'ap-south-1' });
  const response = await client.send(new InvokeModelCommand({
    modelId: MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({ anthropic_version: 'bedrock-2023-05-31', max_tokens: 12000, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }),
  }));
  const payload = JSON.parse(new TextDecoder().decode(response.body));
  const rawText = Array.isArray(payload?.content) ? payload.content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') : '';
  const jsonText = extractJson(rawText);
  if (!jsonText) return errorResponse(502, 'MAP_ANALYSIS_FAILED', 'The MAP model returned no structured report.');
  let report: any;
  try { report = MapEligibilityReportSchema.parse({ ...JSON.parse(jsonText), generatedAt: Date.now(), disclaimer: DISCLAIMER, modifierInputs: inputResult.data }); }
  catch { return errorResponse(502, 'MAP_ANALYSIS_FAILED', 'The MAP model returned an invalid report.'); }

  await ddbDocClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { calculation_id: id },
    UpdateExpression: 'SET map_eligibility = :map, map_eligibility_job = :job, updated_at = :now',
    ExpressionAttributeValues: { ':map': report, ':job': { job_id: (event as any).jobId || null, status: 'COMPLETED', updated_at: Date.now() }, ':now': Date.now() },
  }));
  return successResponse({ calculation_id: id, map_eligibility: report });
}
