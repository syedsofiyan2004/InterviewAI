import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutCommand, GetCommand, ScanCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

import { ddbDocClient, s3Client, getFileBuffer, getFileContent, getPresignedUploadUrl, saveFileContent } from '../shared/aws';
import { successResponse, createdResponse, errorResponse } from '../shared/responses';
import { generateCalculatorPdfReport } from '../shared/calculator-report';
import {
  categoryForService,
  configSummaryFragments,
  generateCalculatorExportWorkbook,
  type CalculatorExportLine,
} from '../shared/calculator-export-workbook';
import { calculationExportKey } from '../shared/calculator-result-storage';
import { generateCalculatorDocxReport, type CalculatorDocxOptions } from '../shared/calculator-docx';
import { estimateProgress } from '../shared/progress-eta';
import { calculationResultKey, loadFullCalculationResult } from '../shared/calculator-result-storage';
import { analyseWorkbook } from './calculator-workbook';
import { McpSidecarClient } from '../calculator-orchestrator/mcp-client';
import { enrichPlanWithCalculatorPreflight } from './calculator-preflight';
import { parseServiceCatalog } from '../calculator-orchestrator/calculator-catalog';
import {
  applyRequirementPatches,
  applyPlanProposal,
  buildInitialPlan,
  confirmPlan,
  createPlanProposal,
} from '../shared/estimate-planning';
import {
  CreateCalculationSchema,
  CreateCalculationProjectSchema,
  DEFAULT_ENVIRONMENT_HOURS,
  type CalculationProjectSummary,
  type CalculationRecord,
  type CalculationResource,
  type CalculationResult,
  type CalculationScenario,
  type CalculationSummary,
  type EnvironmentHours,
  type WorkbookInsights,
} from '../../schema/calculator';
import {
  ApplyPlanProposalSchema,
  ConfirmPlanSchema,
  CreatePlanProposalSchema,
  EstimatePlanV2Schema,
  PlanProposalSchema,
  type EstimatePlan,
} from '../../schema/estimate-plan';
import { markProposalApplied } from '../chat/store';
import { chatThreadId, ReviseCalculationSchema, type ReviseCalculation } from '../../schema/chat';

/**
 * Cost Calculator routes.
 *
 * A separate module so the feature adds only a small dispatch block to the very
 * large (and concurrently-edited) api-handler/index.ts, following the same
 * split already used by manual-question-bank.ts and intelligence-integrations.ts.
 *
 * Estimate building is a multi-turn Bedrock tool-use loop, which routinely runs
 * far longer than API Gateway's 29s ceiling. So POST /calculator only writes a
 * PROCESSING row and fires the orchestrator asynchronously; the client polls
 * GET /calculator/{id}/result. This mirrors the existing intelligence-analysis
 * handshake in index.ts.
 */

const CALCULATOR_TABLE_NAME = process.env.CALCULATOR_TABLE_NAME!;
const ORCHESTRATOR_FUNCTION_NAME = process.env.CALCULATOR_ORCHESTRATOR_FUNCTION_NAME!;
const SIDECAR_FUNCTION_NAME = process.env.CALCULATOR_SIDECAR_FUNCTION_NAME || '';
const BUCKET_NAME = process.env.BUCKET_NAME!;

const lambdaClient = new LambdaClient({});

const SHEET_EXTENSIONS = ['xlsx', 'csv'];

/**
 * Projects live in the estimates table under a reserved partition key, exactly as MOM
 * projects do in the MOM table (`momProjectKey` in index.ts). A prefixed key rather than
 * a seventh DynamoDB table: it costs one filter on the two list paths and saves a table,
 * a stack change, an IAM grant and a second ownership gate for a row that holds nothing
 * but a title.
 *
 * The prefix is what makes the two kinds of row distinguishable, so nothing else may
 * write a calculation_id that starts with it — every id is a randomUUID().
 */
function calculationProjectKey(projectId: string): string {
  return `PROJECT#${projectId}`;
}

/** True for the project rows that share the estimates table. */
function isProjectRow(item: { item_type?: string; calculation_id?: string }): boolean {
  return item.item_type === 'PROJECT' || String(item.calculation_id || '').startsWith('PROJECT#');
}

function getUserId(event: APIGatewayProxyEvent): string | null {
  return event.requestContext.authorizer?.claims?.sub || null;
}

/** Stored on the row so the admin list can name an owner rather than a Cognito sub. */
function getUserEmail(event: APIGatewayProxyEvent): string | undefined {
  const email = event.requestContext.authorizer?.claims?.email;
  return email ? String(email).trim().toLowerCase() : undefined;
}

/**
 * Presigned PUT for a resource list. Mirrors getIntelligenceResumeUploadUrl:
 * extension allowlist, per-user key prefix, browser uploads straight to S3 so the
 * file never passes through API Gateway's payload limit.
 *
 * Keyed by a fresh uuid rather than a calculation id because the estimate does not
 * exist yet — the sheet is chosen before the row is created.
 */
export async function getCalculationUploadUrl(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body');
  }

  const fileName = String(body.file_name || '').trim();
  const contentType = String(body.content_type || 'application/octet-stream').trim();
  const extension = fileName.split('.').pop()?.toLowerCase();

  if (!fileName || !extension || !SHEET_EXTENSIONS.includes(extension)) {
    return errorResponse(
      400,
      'VALIDATION_ERROR',
      extension === 'xls'
        ? 'The older .xls format cannot be read. Open it in Excel and save as .xlsx, then upload again.'
        : 'Upload the resource list as an .xlsx or .csv file.',
    );
  }

  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-80);
  const s3Key = `users/${userId}/calculator/uploads/${randomUUID()}-${safeName}`;
  const uploadUrl = await getPresignedUploadUrl(BUCKET_NAME, s3Key, contentType);
  return successResponse({ upload_url: uploadUrl, s3_key: s3Key, file_name: fileName });
}

/**
 * How many bytes of parsed rows may live on the DynamoDB item.
 *
 * An item is capped at 400KB in total, and this one also has to hold the workbook
 * insights (~100KB at their own ceilings), the prompt, and later the priced result
 * with all its line items. 120KB of rows leaves room for every one of those and still
 * carries a few hundred machines inline, which is the whole of most uploads.
 */
const RESOURCE_BYTES_ON_ITEM = 120_000;

/** Input warnings kept on the record. Enough to explain a parse, short of a wall. */
const MAX_INPUT_WARNINGS = 16;

/**
 * Splits parsed rows into what fits on the item and whether the rest must spill to S3.
 *
 * Measured in bytes rather than counted in rows because row size varies by an order of
 * magnitude: a `Service | Size | Qty` line is a hundred bytes, a fully-populated
 * migration row with its raw text is well over a thousand. A fixed row count would
 * either spill uploads that fit comfortably or fail to spill ones that do not.
 */
function splitResourcesForItem(resources: CalculationResource[]): {
  sample: CalculationResource[];
  spilled: boolean;
} {
  let budget = RESOURCE_BYTES_ON_ITEM;
  const sample: CalculationResource[] = [];

  for (const resource of resources) {
    const size = Buffer.byteLength(JSON.stringify(resource), 'utf8') + 1;
    // At least one row always survives, so the UI has something to show even in the
    // pathological case of a single enormous row.
    if (size > budget && sample.length) return { sample, spilled: true };
    budget -= size;
    sample.push(resource);
  }

  return { sample, spilled: false };
}

/**
 * How many high-impact questions in a plan are still unresolved.
 *
 * Stored on the record so the "Build Estimates" button can be disabled without loading
 * the full plan on every poll. Zero means the plan is executable; any positive number
 * blocks execution until the reviewer supplies values.
 */
function countUnresolvedCritical(plan: { unresolved?: Array<{ impact: string; resolved: boolean }> } | undefined): number {
  return (plan?.unresolved || []).filter((q) => q.impact === 'high' && !q.resolved).length;
}

/** Submitted hours, cleaned; falls back to the documented defaults. */
function resolveEnvironmentHours(input: EnvironmentHours[] | undefined): EnvironmentHours[] {
  const cleaned = (input || [])
    .map((entry) => ({
      name: String(entry?.name || '').trim(),
      hoursPerDay: Math.min(24, Math.max(1, Math.round(Number(entry?.hoursPerDay)))),
    }))
    .filter((entry) => entry.name && Number.isFinite(entry.hoursPerDay));
  return cleaned.length ? cleaned : DEFAULT_ENVIRONMENT_HOURS;
}

async function createCalculationInternal(
  event: APIGatewayProxyEvent,
  startWorker: boolean,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  let input;
  try {
    input = CreateCalculationSchema.parse(JSON.parse(event.body || '{}'));
  } catch (error) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', (error as Error).message);
  }

  const prompt = String(input.prompt || '').trim();
  if (!prompt && !input.input_s3_key) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Describe the workload, upload a resource list, or both.');
  }
  if (prompt && !input.input_s3_key && prompt.length < 10) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Please describe the workload in a bit more detail.');
  }

  // Resolved before anything is written. A project id that is not this user's is
  // refused rather than silently dropped: filing an estimate under someone else's
  // project is the failure this check exists for, and quietly ignoring the field
  // would leave the user thinking it had been grouped.
  let projectTitle: string | undefined;
  if (input.project_id) {
    const project = await ddbDocClient.send(new GetCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Key: { calculation_id: calculationProjectKey(input.project_id) },
    }));
    const row = project.Item;
    if (!row || row.owner_user_id !== userId || row.deleted_at) {
      return errorResponse(404, 'NOT_FOUND', 'That project was not found.');
    }
    projectTitle = row.project_title;
  }

  // Parse the sheet HERE rather than in the orchestrator: it takes milliseconds,
  // and it means an unreadable file is rejected on submit with a message the user
  // can act on, instead of surfacing two minutes later as a failed estimate.
  const calculationId = randomUUID();
  let resources: CalculationResource[] = [];
  let inputWarnings: string[] = [];
  let inputFileName: string | undefined;
  let workbook: WorkbookInsights | undefined;
  let resourceCount: number | undefined;
  let resourcesS3Key: string | undefined;
  let resourcesTruncated: boolean | undefined;
  let planResources: CalculationResource[] = [];
  let workbookIrS3Key: string | undefined;
  let workbookHash: string | undefined;
  let canonicalModelS3Key: string | undefined;

  if (input.input_s3_key) {
    // The key is built server-side in getCalculationUploadUrl and namespaced per
    // user; re-check that prefix so a caller cannot name someone else's object.
    if (!input.input_s3_key.startsWith(`users/${userId}/calculator/uploads/`)) {
      return errorResponse(400, 'VALIDATION_ERROR', 'That upload does not belong to this account.');
    }
    inputFileName = input.input_s3_key.split('/').pop();
    try {
      const buffer = await getFileBuffer(BUCKET_NAME, input.input_s3_key);
      // The file NAME decides the reader (.xlsx vs .csv), so pass the original rather
      // than the key: the key's uuid prefix is noise, but its extension is not.
      const analysis = await analyseWorkbook(buffer, inputFileName || input.input_s3_key);
      resources = analysis.legacyResources;
      inputWarnings = analysis.warnings.slice(0, MAX_INPUT_WARNINGS);
      workbook = analysis.insights;
      workbookHash = analysis.workbookIR.fileHash;
      workbookIrS3Key = `users/${userId}/calculator/analysis/${workbookHash}/workbook-ir.json`;
      canonicalModelS3Key = `users/${userId}/calculator/analysis/${workbookHash}/canonical-cost-model.json`;
      try {
        await Promise.all([
          saveFileContent(BUCKET_NAME, workbookIrS3Key, JSON.stringify(analysis.workbookIR), 'application/json'),
          saveFileContent(BUCKET_NAME, canonicalModelS3Key, JSON.stringify(analysis.canonicalModel), 'application/json'),
        ]);
      } catch (error) {
        console.error('[createCalculation] could not store analysis artifacts:', error);
        return errorResponse(500, 'INTERNAL_ERROR', 'The workbook was analyzed but its audit data could not be stored. Please try again.');
      }
    } catch (error) {
      const code = (error as Error).message;
      const message = code === 'LEGACY_XLS_UNSUPPORTED'
        ? 'The older .xls format cannot be read. Open it in Excel, save as .xlsx, and upload again.'
        : code === 'XLSX_PARSE_FAILED'
          ? 'That spreadsheet could not be read. Re-save it as .xlsx or .csv and try again.'
          : code.startsWith('UNSUPPORTED_TABLE_FORMAT')
            ? 'That file type cannot be read as a resource list. Upload an .xlsx or .csv file.'
            : 'The uploaded resource list could not be read.';
      return errorResponse(400, 'VALIDATION_ERROR', message);
    }

    if (!resources.length) {
      return errorResponse(
        400,
        'VALIDATION_ERROR',
        'No resource rows were found in that file. Download the template to see the expected columns.',
      );
    }

    resourceCount = resources.length;
    planResources = resources;

    // A large landscape does not fit on a DynamoDB item, so the full list goes to S3
    // and the item keeps a bounded sample. Written BEFORE the row is created: if that
    // write fails the user is told now, instead of the orchestrator later finding a
    // key that points at nothing and failing an estimate the user believes is running.
    const split = splitResourcesForItem(resources);
    if (split.spilled) {
      resourcesS3Key = `users/${userId}/calculator/parsed/${calculationId}.json`;
      try {
        await saveFileContent(BUCKET_NAME, resourcesS3Key, JSON.stringify(resources), 'application/json');
      } catch (error) {
        console.error('[createCalculation] could not store parsed rows:', error);
        return errorResponse(500, 'INTERNAL_ERROR', 'The resource list was read but could not be stored. Please try again.');
      }
      resources = split.sample;
      resourcesTruncated = true;
      inputWarnings = [
        `All ${resourceCount} rows are priced; this page lists the first ${split.sample.length}.`,
        ...inputWarnings,
      ].slice(0, MAX_INPUT_WARNINGS);
    }
  }

  const now = Date.now();
  const initialPlan = buildInitialPlan({
    workbookId: workbookHash || `manual:${calculationId}`,
    resources: planResources.length ? planResources : resources,
    workbook,
    requestedPlan: input.plan,
    defaultRegion: input.region,
  });
  // Before a review, the Calculator's own schema is asked what each resource still lacks, so
  // the reviewer answers those questions here rather than reading them off a PARTIAL estimate.
  // Time-boxed and non-fatal: a slow or unreachable sidecar costs the extra questions only.
  let planV2 = initialPlan;
  if (!startWorker && SIDECAR_FUNCTION_NAME) {
    try {
      const enriched = await enrichPlanWithCalculatorPreflight(
        initialPlan,
        planResources.length ? planResources : resources,
        input.region || workbook?.primary_region || 'ap-south-1',
        new McpSidecarClient(SIDECAR_FUNCTION_NAME),
        resolveEnvironmentHours(input.environment_hours),
      );
      planV2 = enriched.plan;
      if (enriched.added || enriched.unapplied.length) {
        console.log(`[createCalculation] calculator preflight added ${enriched.added} question(s); ${enriched.unapplied.length} Calculator input(s) have no plan field yet.`);
      }
    } catch (error) {
      console.warn('[createCalculation] calculator preflight skipped:', (error as Error).message);
    }
  }
  const record: CalculationRecord = {
    calculation_id: calculationId,
    owner_user_id: userId,
    owner_email: getUserEmail(event),
    name: input.name,
    prompt,
    region: input.region,
    status: startWorker ? 'PROCESSING' : 'REVIEW_REQUIRED',
    environment_hours: resolveEnvironmentHours(input.environment_hours),
    resources,
    ...(resourcesS3Key ? { resources_s3_key: resourcesS3Key } : {}),
    ...(resourcesTruncated ? { resources_truncated: true } : {}),
    ...(resourceCount === undefined ? {} : { resource_count: resourceCount }),
    ...(workbook ? { workbook } : {}),
    ...(workbookIrS3Key ? { workbook_ir_s3_key: workbookIrS3Key } : {}),
    ...(workbookHash ? { workbook_hash: workbookHash } : {}),
    ...(canonicalModelS3Key ? { canonical_model_s3_key: canonicalModelS3Key } : {}),
    // The bands as structure, beside the prose in `prompt` that also describes them. Both are
    // needed and neither replaces the other: the prompt is what the model reads, while this is
    // what a revision inherits and what the view page counts priced bands against. Recovering
    // "five fiscal years at three pricing models, then the lower environments" from an English
    // sentence on every read is exactly where a band goes missing without anyone noticing.
    ...(input.plan ? { requested_plan: input.plan } : {}),
    plan_v2: planV2,
    input_s3_key: input.input_s3_key,
    input_file_name: inputFileName,
    input_warnings: inputWarnings,
    ...(input.project_id ? { project_id: input.project_id } : {}),
    ...(projectTitle ? { project_title: projectTitle } : {}),
    created_at: now,
    updated_at: now,
    progress_stage: startWorker ? 'queued' : 'review',
    progress_message: startWorker ? 'Starting estimate' : 'Analysis ready for review and customization',
    unresolved_critical_count: countUnresolvedCritical(planV2),
  };

  await ddbDocClient.send(new PutCommand({ TableName: CALCULATOR_TABLE_NAME, Item: record }));

  if (!startWorker) {
    return createdResponse({
      calculation_id: record.calculation_id,
      status: record.status,
      plan: planV2,
    });
  }

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: ORCHESTRATOR_FUNCTION_NAME,
      InvocationType: 'Event', // fire-and-forget; the client polls for the result
      Payload: new TextEncoder().encode(JSON.stringify({
        calculationId: record.calculation_id,
      })),
    }));
  } catch (error) {
    // The row exists but nothing will ever process it, so fail it now rather than
    // leaving the UI polling a job that does not run.
    await ddbDocClient.send(new PutCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Item: {
        ...record,
        status: 'FAILED',
        error_message: `Could not start the estimate worker: ${(error as Error).message}`,
        updated_at: Date.now(),
      },
    }));
    return errorResponse(502, 'INTERNAL_ERROR', 'Could not start the estimate worker. Please retry.');
  }

  return createdResponse({ calculation_id: record.calculation_id, status: record.status });
}

/** Legacy immediate-build endpoint retained for existing callers. */
export async function createCalculation(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return createCalculationInternal(event, true);
}

/** Analysis-only endpoint used by the Review / Customize flow. */
export async function analyzeCalculation(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  return createCalculationInternal(event, false);
}

export async function listCalculations(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  /**
   * `?project_id=<uuid>` narrows the list to one project; `?project_id=none` returns the
   * estimates that belong to no project. Absent means every estimate, so the existing
   * callers of this route are unaffected.
   */
  const rawProject = event.queryStringParameters?.project_id;
  const projectFilter: string | null | undefined = rawProject === undefined
    ? undefined
    : rawProject === 'none' || rawProject === ''
      ? null
      : rawProject;

  // Scan + owner filter, consistent with the other list endpoints in index.ts.
  // Volume here is per-user and small; revisit with a GSI if that changes.
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: CALCULATOR_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner',
    ExpressionAttributeValues: { ':owner': userId },
  }));

  const items: CalculationSummary[] = (result.Items || [])
    // Project rows share this table, so they are filtered out of the estimate list.
    .filter(item => !isProjectRow(item))
    .filter(item => (projectFilter === undefined
      ? true
      : projectFilter === null
        ? !item.project_id
        : item.project_id === projectFilter))
    .map(item => ({
      calculation_id: item.calculation_id,
      name: item.name,
      status: item.status,
      created_at: item.created_at,
      updated_at: item.updated_at,
      monthly_total: item.result?.monthlyTotal ?? null,
      // Present only on a revision, so the list can label it rather than showing two
      // estimates with the same name and no way to tell which is current.
      ...(item.revision_of ? { revision_of: item.revision_of } : {}),
      ...(item.revision_number ? { revision_number: item.revision_number } : {}),
      ...(item.project_id ? { project_id: item.project_id } : {}),
      ...(item.project_title ? { project_title: item.project_title } : {}),
    }))
    .sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  return successResponse({ items, count: items.length });
}

/**
 * How long a PROCESSING row can go untouched before it is presumed dead.
 *
 * The loop's own budget is 8 minutes and the orchestrator Lambda is configured
 * above that, so past this point nothing will ever write to the row again: the
 * worker either finished (and would have written a terminal status) or was killed
 * by its timeout, an OOM, or a lost async invoke. Without this the row stays
 * PROCESSING forever and the view page polls it every 3s for the life of the tab.
 * Mirrors recoverStaleQuestionGeneration in index.ts, which exists for exactly the
 * same failure.
 */
const CALCULATION_STALE_AFTER_MS = 11 * 60 * 1000;

/**
 * Flips a presumed-dead PROCESSING row to FAILED, on read.
 *
 * Conditional on the row still being PROCESSING and still carrying the same
 * updated_at, so a worker that comes back to life a moment later cannot have its
 * genuine result overwritten by this. Best-effort: if the write loses that race the
 * caller simply reports what it already read.
 */
async function failIfStale(item: CalculationRecord): Promise<CalculationRecord> {
  // BUILDING and VALIDATING are sub-states of the execution run; they go stale for
  // the same reason PROCESSING does (worker killed or timed out).
  if (!['PROCESSING', 'BUILDING', 'VALIDATING'].includes(item.status)) return item;
  const lastTouched = Number(item.updated_at || item.created_at || 0);
  if (!lastTouched || Date.now() - lastTouched <= CALCULATION_STALE_AFTER_MS) return item;

  const error_message = 'The estimate worker stopped before finishing. Please retry.';
  try {
    // Condition: only flip when updated_at matches what was read. A worker that just wrote
    // COMPLETED (and a new updated_at) will not be overwritten by this stale detection.
    // The status is NOT in the condition because BUILDING and VALIDATING must also be caught.
    await ddbDocClient.send(new UpdateCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Key: { calculation_id: item.calculation_id },
      UpdateExpression: 'SET #status = :failed, error_message = :error, progress_stage = :stage, '
        + 'progress_message = :message, updated_at = :now',
      ConditionExpression: 'updated_at = :lastTouched',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':failed': 'FAILED',
        ':error': error_message,
        ':stage': 'failed',
        ':message': 'Estimate failed',
        ':now': Date.now(),
        ':lastTouched': lastTouched,
      },
    }));
  } catch (err: any) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err;
    return item;
  }

  return { ...item, status: 'FAILED', error_message, progress_stage: 'failed', progress_message: 'Estimate failed' };
}

async function loadOwned(id: string | undefined, userId: string) {
  if (!id) return { error: errorResponse(400, 'VALIDATION_ERROR', 'Missing calculation id') };

  const result = await ddbDocClient.send(new GetCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: id },
  }));
  const item = result.Item as CalculationRecord | undefined;

  if (!item) return { error: errorResponse(404, 'NOT_FOUND', 'Calculation not found') };
  // Same code and status as a genuine miss, so this cannot be used to probe for
  // the existence of other users' calculations.
  if (item.owner_user_id !== userId) {
    return { error: errorResponse(404, 'NOT_FOUND', 'Calculation not found') };
  }
  return { item: await failIfStale(item) };
}

export async function getCalculation(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  const { item, error } = await loadOwned(id, userId);
  if (error) return error;
  return successResponse(item);
}

export async function getCalculationPlan(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  const { item, error } = await loadOwned(id, userId);
  if (error) return error;
  if (!item!.plan_v2) return errorResponse(409, 'CONFLICT', 'This estimate predates the review plan workflow.');
  return successResponse({ calculation_id: item!.calculation_id, plan: item!.plan_v2 });
}

const REVIEW_CATALOG_SERVICES: Record<string, string> = {
  'sagemaker.inference_configuration': 'AmazonSageMaker',
  'lambda.execution_profile': 'AWSLambda',
  'bedrock.model': 'AmazonBedrock',
  'bedrock.tokens_per_call': 'AmazonBedrock',
  'nat_gateway.configuration': 'AmazonVPC',
  'quicksight.subscription_profile': 'AmazonQuickSight',
  'database.engine': 'AmazonRDS',
};

export async function getCalculatorReviewCatalog(
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  if (!SIDECAR_FUNCTION_NAME) {
    return successResponse({
      supported: false,
      message: 'The AWS Pricing Calculator MCP sidecar is not configured for review catalogs.',
      fields: {},
    });
  }

  const mcp = new McpSidecarClient(SIDECAR_FUNCTION_NAME);
  const fields: Record<string, Array<{ id: string; label: string; calculatorField: string }>> = {};
  const serviceCache = new Map<string, ReturnType<typeof parseServiceCatalog>>();
  await Promise.all(Object.entries(REVIEW_CATALOG_SERVICES).map(async ([requirement, serviceCode]) => {
    try {
      let catalog = serviceCache.get(serviceCode);
      if (!catalog) {
        catalog = parseServiceCatalog(await mcp.getServiceCatalog(serviceCode));
        serviceCache.set(serviceCode, catalog);
      }
      fields[requirement] = catalog.fields
        .filter((field) => field.type === 'dropdown' && field.options?.length)
        .flatMap((field) => (field.options || []).map((option) => ({
          id: String(option.id),
          label: String(option.label || option.id),
          calculatorField: field.id,
        })))
        .slice(0, 500);
    } catch (catalogError) {
      console.warn(`[calculator] review catalog lookup failed for ${serviceCode}:`, catalogError);
      fields[requirement] = [];
    }
  }));

  return successResponse({
    supported: true,
    source: 'live-mcp-get_service_fields',
    fields,
  });
}

export async function proposeCalculationPlan(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  const { item, error } = await loadOwned(id, userId);
  if (error) return error;
  if (!item!.plan_v2) return errorResponse(409, 'CONFLICT', 'This estimate has no review plan.');
  let input;
  try {
    input = CreatePlanProposalSchema.parse(JSON.parse(event.body || '{}'));
  } catch (parseError) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid customization request', (parseError as Error).message);
  }
  const proposal = PlanProposalSchema.parse(createPlanProposal(item!.plan_v2, input));
  return successResponse({ proposal });
}

export async function createCalculationPlanRevision(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  const { item, error } = await loadOwned(id, userId);
  if (error) return error;
  if (!item!.plan_v2) return errorResponse(409, 'CONFLICT', 'This estimate has no review plan.');
  let proposal;
  try {
    proposal = ApplyPlanProposalSchema.parse(JSON.parse(event.body || '{}')).proposal;
  } catch (parseError) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid reviewed proposal', (parseError as Error).message);
  }
  try {
    const plan = EstimatePlanV2Schema.parse(applyPlanProposal(item!.plan_v2, proposal));
    const unresolvedCriticalCount = countUnresolvedCritical(plan);
    await ddbDocClient.send(new UpdateCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Key: { calculation_id: item!.calculation_id },
      UpdateExpression: 'SET plan_v2 = :plan, #status = :status, unresolved_critical_count = :count, updated_at = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':plan': plan, ':status': 'REVIEW_REQUIRED', ':count': unresolvedCriticalCount, ':now': Date.now() },
    }));
    return createdResponse({ calculation_id: item!.calculation_id, plan });
  } catch (applyError) {
    const code = (applyError as Error).message;
    if (code === 'PLAN_REVISION_CONFLICT') {
      return errorResponse(409, 'CONFLICT', 'The plan changed after this proposal was created. Review it again.');
    }
    if (code === 'PLAN_PROPOSAL_NEEDS_INPUT') {
      return errorResponse(409, 'CONFLICT', 'This proposal still contains an unresolved high-impact requirement.');
    }
    throw applyError;
  }
}

export async function confirmCalculationPlan(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  const { item, error } = await loadOwned(id, userId);
  if (error) return error;
  if (!item!.plan_v2) return errorResponse(409, 'CONFLICT', 'This estimate has no review plan.');
  let revisionId: string;
  try {
    revisionId = ConfirmPlanSchema.parse(JSON.parse(event.body || '{}')).revision_id;
  } catch (parseError) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid plan confirmation', (parseError as Error).message);
  }
  try {
    const plan = EstimatePlanV2Schema.parse(confirmPlan(item!.plan_v2, revisionId));
    // A confirmed plan has no unresolved critical inputs — confirmPlan throws PLAN_NEEDS_INPUT
    // when any remain, so reaching here means count is definitively 0.
    // Status transitions to CONFIRMED: plan is locked and execution can start. This lets
    // the UI show a clear "plan confirmed, ready to build" state before runPlan is called.
    await ddbDocClient.send(new UpdateCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Key: { calculation_id: item!.calculation_id },
      UpdateExpression: 'SET plan_v2 = :plan, confirmed_plan_revision_id = :revision, unresolved_critical_count = :zero, #status = :confirmed, updated_at = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':plan': plan, ':revision': revisionId, ':zero': 0, ':confirmed': 'CONFIRMED', ':now': Date.now() },
    }));
    return successResponse({ calculation_id: item!.calculation_id, plan });
  } catch (confirmError) {
    const code = (confirmError as Error).message;
    return errorResponse(409, 'CONFLICT', code === 'PLAN_NEEDS_INPUT'
      ? 'Resolve the high-impact questions before confirming this plan.'
      : 'Confirm the current plan revision, not an older revision.');
  }
}

export async function runCalculationPlan(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');
  const { item, error } = await loadOwned(id, userId);
  if (error) return error;
  const plan = item!.plan_v2;
  if (!plan || plan.status !== 'CONFIRMED' || item!.confirmed_plan_revision_id !== plan.currentRevisionId) {
    return errorResponse(409, 'CONFLICT', 'Confirm the current plan revision before building estimates.');
  }
  if (['PROCESSING', 'BUILDING', 'VALIDATING'].includes(item!.status)) {
    return errorResponse(409, 'CONFLICT', 'This estimate is already running.');
  }

  await ddbDocClient.send(new UpdateCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: item!.calculation_id },
    UpdateExpression: 'SET #status = :status, progress_stage = :stage, progress_message = :message, updated_at = :now REMOVE #result, result_s3_key, error_message, scenario_summaries',
    ExpressionAttributeNames: { '#status': 'status', '#result': 'result' },
    ExpressionAttributeValues: {
      ':status': 'PROCESSING', ':stage': 'queued', ':message': 'Building confirmed plan', ':now': Date.now(),
    },
  }));
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: ORCHESTRATOR_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify({
        calculationId: item!.calculation_id,
        planRevisionId: plan.currentRevisionId,
      })),
    }));
  } catch (invokeError) {
    await ddbDocClient.send(new UpdateCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Key: { calculation_id: item!.calculation_id },
      UpdateExpression: 'SET #status = :status, error_message = :error, updated_at = :now',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'FAILED', ':error': `Could not start the estimate worker: ${(invokeError as Error).message}`,
        ':now': Date.now(),
      },
    }));
    return errorResponse(502, 'INTERNAL_ERROR', 'Could not start the estimate worker. Please retry.');
  }
  return successResponse({ calculation_id: item!.calculation_id, status: 'PROCESSING', plan_revision_id: plan.currentRevisionId });
}

/**
 * Every file an estimate generates, as one list.
 *
 * There are three callers that need to delete these and they had already diverged: the
 * single-estimate delete removed only the PDF while the project delete removed the PDF and
 * the workbook, so deleting one estimate left its .xlsx in the bucket with nothing pointing
 * at it. That is the failure mode of a literal key list repeated per call site, and adding
 * a third format would have produced a third version of the same near-miss. The generated
 * formats live here; the uploaded sheet and the spilled row list stay with their callers
 * because those keys are stored on the record rather than derived.
 */
function generatedArtifactKeys(userId: string, calculationId: string): string[] {
  const prefix = `users/${userId}/calculator/${calculationId}`;
  return [
    // Legacy paths (pre-spec-refactor) and current paths — both tried so cleanup
    // succeeds regardless of when the estimate was created.
    ...['pdf', 'xlsx', 'docx'].map((extension) => `${prefix}/estimate.${extension}`),
    // Spec-compliant export path (post-refactor)
    calculationExportKey(userId, calculationId),
    calculationResultKey(userId, calculationId),
  ];
}

function calculatorEstimateUrls(result: CalculationResult | null | undefined): string[] {
  const urls = [
    result?.url,
    ...(result?.scenarios || []).map((scenario) => scenario.url),
  ].filter((url): url is string => !!url && /^https:\/\/[^/]*calculator\.aws\//i.test(url));
  return [...new Set(urls)];
}

async function cleanupRemoteCalculatorEstimates(urls: string[]): Promise<{
  requested: number;
  deleted: number;
  supported: boolean;
  warnings: string[];
}> {
  if (!urls.length) return { requested: 0, deleted: 0, supported: true, warnings: [] };
  if (!SIDECAR_FUNCTION_NAME) {
    return {
      requested: urls.length,
      deleted: 0,
      supported: false,
      warnings: ['Remote AWS Pricing Calculator deletion is not configured for this environment.'],
    };
  }
  const mcp = new McpSidecarClient(SIDECAR_FUNCTION_NAME);
  let supported = true;
  let deleted = 0;
  const warnings: string[] = [];
  for (const url of urls) {
    try {
      const outcome = await mcp.deleteEstimate(url);
      supported = supported && outcome.supported;
      if (outcome.deleted) deleted += 1;
      if (!outcome.supported || !outcome.deleted) warnings.push(outcome.message || `Remote estimate was not deleted: ${url}`);
    } catch (remoteError) {
      warnings.push(`Remote estimate cleanup failed for ${url}: ${(remoteError as Error).message}`);
    }
  }
  return { requested: urls.length, deleted, supported, warnings };
}

/**
 * Poll target. Always 200 with the current status so the frontend can drive its
 * loop off the body rather than having to treat a 404/425 as "still working".
 *
 * It also returns the derived time estimate rather than leaving the browser to compute
 * one. The calculation depends on per-stage weights and an in-run recalibration that the
 * frontend has no business duplicating — and if it did duplicate them, the number shown
 * while polling would eventually disagree with the number the chat reports for the same
 * run, which is worse than either being slightly off.
 */
export async function getCalculationResult(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  const { item, error } = await loadOwned(id, userId);
  if (error) return error;

  // When the result is too large to store inline, load it from S3 for terminal states.
  // During execution (PROCESSING, BUILDING, VALIDATING) there is nothing to load yet, so
  // only do the S3 round-trip when the run has finished. The view page shows blank when
  // the inline result is null and the S3 key is not consulted.
  const TERMINAL = new Set(['COMPLETED', 'NEEDS_REVIEW', 'PARTIAL', 'FAILED']);
  let result = item!.result ?? null;
  if (!result && item!.result_s3_key && TERMINAL.has(item!.status)) {
    try {
      result = await loadFullCalculationResult(BUCKET_NAME, item!);
    } catch (loadErr) {
      console.warn(`[calculator] could not load result from S3 for ${item!.calculation_id}:`, loadErr);
    }
  }

  return successResponse({
    calculation_id: item!.calculation_id,
    status: item!.status,
    result,
    error_message: item!.error_message ?? null,
    progress_stage: item!.progress_stage ?? null,
    progress_message: item!.progress_message ?? null,
    progress: estimateProgress(item!, Date.now()),
    environment_hours: item!.environment_hours ?? [],
    input_file_name: item!.input_file_name ?? null,
    input_warnings: item!.input_warnings ?? [],
    // Per-scenario summaries available without S3 roundtrip — written by the orchestrator
    // when each scenario completes. Used by the frontend to show per-scenario Calculator
    // URLs and cost totals while polling, before the full result is loaded.
    scenario_summaries: item!.scenario_summaries ?? null,
    unresolved_critical_count: item!.unresolved_critical_count ?? null,
  });
}

/**
 * DELETE /calculator/{id} — removes an estimate and everything it produced.
 *
 * A hard delete, unlike the admin soft-delete on interview records: an estimate is
 * a disposable working document with no audit obligation, and leaving tombstones
 * would clutter the only list the owner has. Owner-only — loadOwned already returns
 * 404 rather than 403 for someone else's row, so this cannot be used to probe.
 *
 * The uploaded sheet and the generated PDF go too. They are useless without the row
 * and would otherwise accumulate in the bucket forever with nothing pointing at them.
 * S3 cleanup is best-effort: failing the delete because a stray object would not
 * remove would leave the user unable to tidy their own list.
 */
export async function deleteCalculation(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  const { item, error } = await loadOwned(id, userId);
  if (error) return error;

  let storedResult: CalculationResult | null = item!.result ?? null;
  if (!storedResult && item!.result_s3_key) {
    try {
      storedResult = await loadFullCalculationResult(BUCKET_NAME, item!);
    } catch (loadError) {
      console.warn(`[calculator] could not load result for remote estimate cleanup ${item!.calculation_id}:`, loadError);
    }
  }
  const remoteCleanup = await cleanupRemoteCalculatorEstimates(calculatorEstimateUrls(storedResult));

  const keys = [
    item!.input_s3_key,
    item!.resources_s3_key,
    item!.workbook_ir_s3_key,
    item!.canonical_model_s3_key,
    item!.result_s3_key,
    ...generatedArtifactKeys(userId, item!.calculation_id),
  ].filter((key): key is string => !!key);

  for (const key of keys) {
    try {
      await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
    } catch (err) {
      console.warn(`Could not delete calculator object ${key} (it may never have existed):`, err);
    }
  }

  await ddbDocClient.send(new DeleteCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: item!.calculation_id },
  }));

  return successResponse({ deleted: true, calculation_id: item!.calculation_id, remote_estimates: remoteCleanup });
}

/**
 * The ownership gate and the parse, once, for every downloadable form of an estimate.
 *
 * Shared rather than cloned per format: an access check that exists in two places is one
 * that can be fixed in one place, and a second document format is not a reason to have a
 * second copy of it.
 */
async function loadDownloadable(
  id: string | undefined,
  event: APIGatewayProxyEvent,
  format: string,
): Promise<
  | { error: APIGatewayProxyResult }
  | { userId: string; item: CalculationRecord; result: CalculationResult }
> {
  const userId = getUserId(event);
  if (!userId) return { error: errorResponse(401, 'ACCESS_DENIED', 'Not authenticated') };

  const { item, error } = await loadOwned(id, userId);
  if (error) return { error };

  // PARTIAL is allowed because a partial estimate still has a validated AWS Calculator
  // result for the services that were successfully configured — the Excel is just clearly
  // marked as a subset. COMPLETED and NEEDS_REVIEW are the normal happy-path states.
  // Any other state (PROCESSING, BUILDING, VALIDATING, FAILED, REVIEW_REQUIRED) has no
  // validated Calculator result to export from.
  const downloadableStatuses = ['COMPLETED', 'NEEDS_REVIEW', 'PARTIAL'];
  if (!downloadableStatuses.includes(item!.status) || (!item!.result && !item!.result_s3_key)) {
    return {
      error: errorResponse(409, 'VALIDATION_ERROR',
        item!.status === 'FAILED'
          ? 'No Excel was generated because the AWS Pricing Calculator estimate failed. Retry the estimate first.'
          : 'This estimate has not finished yet, so there is nothing to download.'),
    };
  }

  try {
    const result = await loadFullCalculationResult(BUCKET_NAME, item!);
    if (!result) throw new Error('Stored result is missing.');
    return { userId, item: item!, result };
  } catch (loadError) {
    console.error(`[calculator] could not load full result for ${item!.calculation_id}:`, loadError);
    return {
      error: errorResponse(500, 'INTERNAL_ERROR', `The stored estimate could not be converted to ${format}.`),
    };
  }
}

/** A filename a client can find on their desktop, with nothing in it a filesystem dislikes. */
const downloadName = (item: CalculationRecord, extension: string) =>
  `aws-cost-estimate-${(item.name || 'aws-cost-estimate').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '')}.${extension}`;

/**
 * Client-facing PDF. Mirrors getMomReport in index.ts: regenerate from the stored
 * result, save to S3, hand back a presigned GET with a download filename.
 *
 * Regenerated on every request rather than cached at completion, so a change to the
 * renderer applies to estimates built before it — the same reason the MOM report
 * works this way.
 */
export async function getCalculationReport(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const loaded = await loadDownloadable(id, event, 'a PDF');
  if ('error' in loaded) return loaded.error;
  const { userId, item, result } = loaded;

  const pdf = await generateCalculatorPdfReport(result, {
    name: item.name,
    environmentHours: item.environment_hours || [],
    createdAt: item.created_at,
    region: item.region,
  });

  const reportKey = `users/${userId}/calculator/${item.calculation_id}/estimate.pdf`;
  await saveFileContent(BUCKET_NAME, reportKey, pdf, 'application/pdf');

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: reportKey,
    ResponseContentDisposition: `attachment; filename="${downloadName(item, 'pdf')}"`,
  });
  const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

  return successResponse({ download_url: downloadUrl });
}

/**
 * The same estimate as a spreadsheet in the AWS Pricing Calculator's own export layout.
 *
 * The PDF is the document you send; this is the one a client holds next to the export
 * they downloaded from their own calculator.aws estimate link. Matching that layout --
 * one sheet, Estimate summary / Detailed Estimate / Acknowledgement stacked vertically --
 * means the two files can be read or diffed row for row, which the multi-sheet TCO
 * workbook this route used to produce could never offer. (That workbook remains
 * available to whatever else wants it; only this download slot changed format.)
 *
 * Regenerated per request for the same reason the PDF is: an estimate priced months ago
 * gets today's rendering, including layout fixes made after it ran.
 */

/**
 * One Detailed Estimate row per stored line item.
 *
 * The stored result does not carry everything the real export's rows carry, and the gaps
 * are deliberate rather than silent:
 *
 *  - `upfront` is always 0. The line items store one monthly figure per line; a committed
 *    term's lump sum is never split out per line, and the only upfront-bearing figure in
 *    the stored shape (`CalculationScenario.total_12_months`, which embeds a Partial
 *    Upfront payment) is per scenario band, not per line. Attributing any of it to an
 *    individual line would be a guess dressed as a figure, so the column says 0 and the
 *    estimate summary foots to monthly x 12.
 *  - Configuration summary carries only recorded facts -- schedule, billing basis, rate
 *    workings. The real export's Tenancy/OS/EBS/data-transfer fragments are
 *    calculator.aws's own configuration metadata, which our result never stored.
 */
function exportLinesFromResult(result: CalculationResult): CalculatorExportLine[] {
  return (result.lineItems || []).map((item) => ({
    environment: (item.environment || '').trim() || 'Unassigned',
    category: categoryForService(item.service || ''),
    description: (item.detail || '').trim() || (item.service || '').trim(),
    service: (item.service || '').trim(),
    upfront: 0,
    monthly: item.monthly ?? 0,
    configSummary: configSummaryFragments(item),
  }));
}

export async function getCalculationWorkbook(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const loaded = await loadDownloadable(id, event, 'an Excel workbook');
  if ('error' in loaded) return loaded.error;
  const { userId, item, result } = loaded;

  const workbook = await generateCalculatorExportWorkbook({
    estimateName: item.name || 'AWS cost estimate',
    currency: result.currency || 'USD',
    region: item.region,
    lines: exportLinesFromResult(result),
  });

  // Use the spec-compliant exports/ prefix so all generated artifacts are under one
  // path and can be lifecycle-managed together. Falls back gracefully for old records.
  const key = calculationExportKey(userId, item.calculation_id);
  await saveFileContent(
    BUCKET_NAME,
    key,
    workbook,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  );

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${downloadName(item, 'xlsx')}"`,
  });
  const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

  return successResponse({ download_url: downloadUrl });
}

/**
 * The prose and the recorded figures a Word deliverable needs, read off the stored estimate.
 *
 * The renderer will not leave the committed-rate question unanswered: given no statement it
 * says the scope was not recorded. For an estimate that DID record it — band by band, in
 * `CalculationScenario.pricing_mix` — that would be an admission of a gap that does not exist,
 * and it is the one sentence in the document whose absence changes what every figure means. So
 * the recorded sentences are carried across rather than left to the fallback.
 *
 * The twelve-month totals travel for the opposite reason: they are the figures the renderer
 * cannot derive. A reservation taken Partial Upfront bills a lump sum inside its first twelve
 * months on top of the reduced rate, so MRR x 12 understates that row by exactly the upfront
 * amount, and `total_12_months` is the only place the invoice figure exists.
 */
function docxOptions(item: CalculationRecord, result: CalculationResult): CalculatorDocxOptions {
  const scenarios = result.scenarios || [];
  const mixOf = (scenario: CalculationScenario) => (scenario.pricing_mix || '').trim();
  const modelOf = (scenario: CalculationScenario) => (scenario.pricing_model || '').trim();

  /**
   * One closing note per (pricing model, mix) pair, in the order the bands were priced.
   *
   * Keyed on the pair rather than on the model alone: a lower-environment band can commit a
   * different set of services than the production band bought on the same terms, and folding
   * those two into one note would print one of them as though it covered both.
   */
  const notes = new Map<string, string>();
  for (const scenario of scenarios) {
    const mix = mixOf(scenario);
    if (!mix) continue;
    const model = modelOf(scenario);
    notes.set(`${model}\n${mix}`, model ? `${model} — ${mix}` : mix);
  }

  const mixes = [...new Set(scenarios.map(mixOf).filter(Boolean))];

  const annualByScenarioKey: Record<string, number> = {};
  for (const scenario of scenarios) {
    const recorded = scenario.total_12_months;
    if (typeof recorded === 'number' && Number.isFinite(recorded)) {
      annualByScenarioKey[scenario.key] = recorded;
    }
  }

  const rationale = (item.requested_plan?.rationale || '').trim();

  return {
    // Why the matrix has the shape it has, first: it is the line that explains why there are
    // fifteen rows rather than one, and schema/estimate-plan.ts records it for this section.
    assumptions: rationale ? [rationale, ...result.assumptions] : result.assumptions,
    // One recorded sentence is the statement. Several mean the committed scope genuinely
    // differs band by band, and picking one of them would describe the others wrongly, so the
    // reader is sent to the per-model notes instead of being handed a sentence that is only
    // sometimes true. Named without quoting the renderer's own heading, which is its to change.
    mixedPricingStatement: mixes.length === 1
      ? mixes[0]
      : mixes.length
        ? 'Which services are bought at a committed rate differs by pricing model in this '
          + 'estimate, so it is stated per model in the closing notes rather than summarised '
          + 'here. Any service a commitment does not cover remains On-Demand at the full '
          + 'published rate.'
        : undefined,
    pricingModelNotes: [...notes.values()],
    annualByScenarioKey,
    /**
     * The two axes the tables are built on, read off the record instead of split back out of a
     * label. The pipeline knows both at the moment it prices a band, so the renderer's own
     * derivation is a fallback for rows stored before it recorded them — and returning null
     * leaves exactly those rows to it.
     *
     * Each key is set only when it was recorded: the renderer reads an absent `pricingModel`
     * as "derive it" and a present-but-empty one as "there is no pricing model", and a legacy
     * band needs the first of those.
     */
    facetOf: (scenario) => {
      const scope = (scenario.scope || '').trim();
      const pricingModel = modelOf(scenario);
      if (!scope && !pricingModel) return null;
      return {
        ...(scope ? { scope } : {}),
        ...(pricingModel ? { pricingModel } : {}),
      };
    },
  };
}

/**
 * The same estimate as a Word document — the only one of the three formats that can carry a
 * matrix of estimate links.
 *
 * A real request is not one estimate. Five fiscal years priced at three pricing models, then
 * the lower environments again on the same terms, is eighteen calculator.aws links for one
 * workload, and the PDF cannot hold them: it prints a URL as ink, so eighteen of them are
 * eighteen strings a client has to retype, and a five-column table with a 90-character URL in
 * one cell has no readable widths left for the other four. OOXML has real hyperlink
 * relationships, so the link cell reads as prose and is still one click.
 *
 * Regenerated per request for the same reason the other two are: an estimate priced months ago
 * gets today's renderer.
 */
export async function getCalculationDocument(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const loaded = await loadDownloadable(id, event, 'a Word document');
  if ('error' in loaded) return loaded.error;
  const { userId, item, result } = loaded;

  // The renderer takes the whole record, because the title, region and created date it prints
  // live there rather than on the result. The VALIDATED result is put back over the stored one:
  // it is the same data with the schema's defaults applied, and a record written before
  // `currency` had one would otherwise reach the money formatter as undefined.
  const document = await generateCalculatorDocxReport({ ...item, result }, docxOptions(item, result));

  const key = `users/${userId}/calculator/${item.calculation_id}/estimate.docx`;
  await saveFileContent(
    BUCKET_NAME,
    key,
    document,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  );

  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${downloadName(item, 'docx')}"`,
  });
  const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

  return successResponse({ download_url: downloadUrl });
}

/**
 * Numeric fields on a resource row, so a chat edit sent as text lands as a number.
 *
 * The model gives every value as a string because one tool schema has to cover
 * "m5.xlarge" and "8"; storing "8" where the pipeline expects 8 would make the row
 * fail validation on the way into the orchestrator, one stage too late to explain.
 */
const NUMERIC_EDIT_FIELDS = new Set(['vcpu', 'ram_gb', 'disk_gb', 'hoursPerMonth']);

/**
 * Applies chat-proposed edits to a resource list, returning a new array.
 *
 * Row indices come from the inventory listing the chat was shown, which is built from
 * the same array in the same order — see lambdas/chat/context/calculator.ts. An index
 * outside the array is skipped rather than rejected: the useful half of a two-row
 * proposal is worth more than an error, and the instruction text still describes the
 * whole change to the pipeline.
 */
function applyResourceEdits(
  resources: CalculationResource[],
  edits: ReviseCalculation['resource_edits'],
): { resources: CalculationResource[]; applied: number; skipped: number } {
  const next = resources.map((resource) => ({ ...resource }));
  let applied = 0;
  let skipped = 0;

  for (const edit of edits) {
    const target = next[edit.row];
    if (!target) {
      skipped += 1;
      continue;
    }

    if (NUMERIC_EDIT_FIELDS.has(edit.field)) {
      const parsed = Number(String(edit.value).replace(/[^0-9.]/g, ''));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        skipped += 1;
        continue;
      }
      (target as Record<string, unknown>)[edit.field] = parsed;
    } else {
      (target as Record<string, unknown>)[edit.field] = String(edit.value).trim();
    }

    // `raw` is what the sheet said, and the orchestrator falls back to it for rows it
    // cannot read structurally. Left alone deliberately: rewriting it would put an
    // edited value in the field that exists to record the original.
    applied += 1;
  }

  return { resources: next, applied, skipped };
}

/**
 * The band matrix a revision carries, from what the revision stated and what its parent held.
 *
 * Empty is silence, not an instruction. A follow-up message reading "make the web tier smaller"
 * carries no scenarios and no formats at all, and reading that as "drop the bands" would turn an
 * eighteen-link deliverable into a single estimate with nobody having asked and nothing saying
 * so: every figure would still be right, and the document the client is waiting for would have
 * quietly stopped existing. So the two fields fall back to the parent independently — a new
 * matrix with no formats named keeps the parent's formats, and new formats alone keep the
 * parent's matrix.
 *
 * `rationale` and `link_per_scenario` are always the parent's. ReviseCalculationSchema has no
 * field for either, so silence about them cannot mean "clear them" — and a rationale explains
 * the shape of the request, which a revision that restates the bands is still working within.
 */
function revisedPlan(
  parent: EstimatePlan | undefined,
  input: Pick<ReviseCalculation, 'scenarios' | 'deliverables'>,
): EstimatePlan | undefined {
  if (!input.scenarios.length && !input.deliverables.length) return parent;

  const linkPerScenario = parent?.deliverables?.link_per_scenario;

  return {
    scenarios: input.scenarios.length ? input.scenarios : parent?.scenarios || [],
    deliverables: {
      formats: input.deliverables.length ? input.deliverables : parent?.deliverables?.formats || [],
      ...(linkPerScenario === undefined ? {} : { link_per_scenario: linkPerScenario }),
    },
    ...(parent?.rationale ? { rationale: parent.rationale } : {}),
  };
}

function revisedPlanV2(
  parent: CalculationRecord['plan_v2'],
  input: ReviseCalculation,
): CalculationRecord['plan_v2'] {
  if (!parent) return parent;
  if (!input.requirement_patches.length && !input.scenarios.length) return parent;
  const { plan } = applyRequirementPatches(parent, input.requirement_patches, {
    scenarios: input.scenarios,
    createdBy: 'chat',
    sourceInstruction: input.instruction,
  });
  return EstimatePlanV2Schema.parse(plan);
}

/**
 * POST /calculator/{id}/revise — applies a chat-proposed change as a NEW estimate.
 *
 * A new row rather than an edit of the existing one, and that is the whole design:
 * a PDF or workbook already sent to a client cannot change underneath it, and the
 * before/after comparison — the reason anyone asks for a revision — needs both sets of
 * numbers to survive.
 *
 * Nothing here trusts a price. The instruction is appended to the original prompt and
 * the normal orchestrator runs, so every rate in the revision comes from the AWS Price
 * List Query API exactly as it did the first time. The chat can change what is priced;
 * it can never change what something costs.
 */
export async function reviseCalculation(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  const { item, error } = await loadOwned(id, userId);
  if (error) return error;
  const original = item!;

  if (original.status === 'PROCESSING') {
    return errorResponse(409, 'CONFLICT', 'This estimate is still running. Wait for it to finish, then revise it.');
  }

  let input: ReviseCalculation;
  try {
    input = ReviseCalculationSchema.parse(JSON.parse(event.body || '{}'));
  } catch (err) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', (err as Error).message);
  }
  if (!input.requirement_patches.length
    && !input.resource_edits.length
    && !input.scenarios.length
    && !input.deliverables.length) {
    return errorResponse(
      400,
      'VALIDATION_ERROR',
      'This proposal only contains audit text. Ask the assistant to prepare typed calculator changes before applying it.',
    );
  }

  // The full list, not the item's bounded sample: a row index in an edit refers to the
  // list as parsed, and a spilled upload keeps only its first rows on the item.
  let resources: CalculationResource[] = original.resources || [];
  if (original.resources_s3_key) {
    try {
      const raw = await getFileContent(BUCKET_NAME, original.resources_s3_key);
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) resources = parsed as CalculationResource[];
    } catch (err) {
      console.error('[reviseCalculation] could not read parsed rows:', err);
      return errorResponse(500, 'INTERNAL_ERROR', 'The original resource list could not be read. Please try again.');
    }
  }

  const edited = applyResourceEdits(resources, input.resource_edits);
  if (input.resource_edits.length && !edited.applied) {
    return errorResponse(
      400,
      'VALIDATION_ERROR',
      'None of the proposed row changes could be applied to this estimate. Try describing the change instead.',
    );
  }

  let planV2: CalculationRecord['plan_v2'];
  try {
    planV2 = revisedPlanV2(original.plan_v2, input);
  } catch (err) {
    const message = (err as Error).message === 'PLAN_PROPOSAL_NEEDS_INPUT'
      ? 'The proposed calculator change needs another required value before it can be applied.'
      : 'The proposed calculator change could not be converted into typed calculator requirements.';
    return errorResponse(409, 'PLAN_PROPOSAL_NEEDS_INPUT', message, (err as Error).message);
  }

  const revisionId = randomUUID();
  const now = Date.now();

  // Re-split for the new row: an edit can change a row's size, so what fitted on the
  // original item is not guaranteed to fit on this one.
  const split = splitResourcesForItem(edited.resources);
  let resourcesS3Key: string | undefined;
  if (split.spilled) {
    resourcesS3Key = `users/${userId}/calculator/parsed/${revisionId}.json`;
    try {
      await saveFileContent(BUCKET_NAME, resourcesS3Key, JSON.stringify(edited.resources), 'application/json');
    } catch (err) {
      console.error('[reviseCalculation] could not store parsed rows:', err);
      return errorResponse(500, 'INTERNAL_ERROR', 'The revised resource list could not be stored. Please try again.');
    }
  }

  const warnings = [
    ...(edited.skipped
      ? [`${edited.skipped} proposed row change(s) did not match a row and were skipped.`]
      : []),
    ...(original.input_warnings || []),
  ].slice(0, MAX_INPUT_WARNINGS);

  const record: CalculationRecord = {
    ...original,
    calculation_id: revisionId,
    // The chain always points at the first estimate, not the immediate parent, so the
    // whole history is one query rather than a walk back through every revision.
    revision_of: original.revision_of || original.calculation_id,
    // Parent + 1. Two revisions of the same parent would share a number; they are
    // separate rows with separate ids, and a scan for the true maximum on every revise
    // would cost more than the label is worth.
    revision_number: (original.revision_number || 0) + 1,
    revision_instruction: input.instruction,
    status: 'PROCESSING',
    // Appended, not replaced: the revision has to price the whole workload, and the
    // original prompt is the only place the rest of it is described.
    prompt: `${original.prompt}\n\nRevision requested: ${input.instruction}`.trim(),
    // Stated outright even though `...original` above already carries the parent's plan forward:
    // a matrix surviving a revision is the entire reason it is stored as structure, and leaving
    // that to a spread makes it one carelessly-added key in this literal away from being lost.
    // See revisedPlan for why an empty request inherits rather than clears.
    requested_plan: revisedPlan(original.requested_plan, input),
    plan_v2: planV2,
    resources: split.spilled ? split.sample : edited.resources,
    ...(resourcesS3Key ? { resources_s3_key: resourcesS3Key } : {}),
    ...(split.spilled ? { resources_truncated: true } : {}),
    ...(edited.resources.length ? { resource_count: edited.resources.length } : {}),
    input_warnings: warnings,
    created_at: now,
    updated_at: now,
    progress_stage: 'queued',
    progress_message: 'Starting revised estimate',
    // The parent's output, deliberately dropped: carrying it would make a revision that
    // fails to start look like one that succeeded with the old numbers.
    result: undefined,
    result_s3_key: undefined,
    error_message: undefined,
    iterations: undefined,
    tool_call_count: undefined,
  };

  if (!split.spilled) {
    delete record.resources_s3_key;
    delete record.resources_truncated;
  }
  delete record.result_s3_key;

  await ddbDocClient.send(new PutCommand({ TableName: CALCULATOR_TABLE_NAME, Item: record }));

  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: ORCHESTRATOR_FUNCTION_NAME,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify({ calculationId: revisionId })),
    }));
  } catch (err) {
    await ddbDocClient.send(new PutCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Item: {
        ...record,
        status: 'FAILED',
        error_message: `Could not start the estimate worker: ${(err as Error).message}`,
        updated_at: Date.now(),
      },
    }));
    return errorResponse(502, 'INTERNAL_ERROR', 'Could not start the estimate worker. Please retry.');
  }

  // The revision row is written and the worker is running, so the proposal has been
  // applied even though the numbers are still being priced. Marked from here rather than
  // from the chat, which cannot know whether the user ever pressed apply.
  //
  // The thread id is built from the CALLER'S own userId, which is what makes this safe
  // without a second ownership check: the owner is part of the partition key, so a caller
  // can only ever stamp a turn in a thread they own. Awaited rather than fired and
  // forgotten — it cannot throw, and the drawer refetches its history immediately, which
  // would race an unawaited write.
  if (input.chat_seq) {
    await markProposalApplied(chatThreadId('calculator', original.calculation_id, userId), input.chat_seq);
  }

  return createdResponse({
    calculation_id: revisionId,
    status: record.status,
    revision_number: record.revision_number,
    applied_edits: edited.applied,
    skipped_edits: edited.skipped,
  });
}

/* ------------------------------------------------------------------------- *
 * Projects
 *
 * An estimate belongs to at most one project, the same way a MOM belongs to at most one
 * MOM project, so the Cost Calculator opens on a list of projects rather than a flat
 * list of every estimate anyone ever ran.
 *
 * Two deliberate carry-overs from the MOM implementation, because the two lists sit
 * beside each other in the same product and must behave the same way:
 *
 *  - Membership is optional. Every estimate created before this change has no
 *    project_id, and those group under a synthetic "Ungrouped" row rather than
 *    disappearing from the UI.
 *  - Creating a project that already exists returns the existing one instead of a
 *    duplicate, matched on the title case-insensitively. The MOM flow types the project
 *    name into the same box as the meeting, so a second "Rainbow Migration" is far more
 *    likely to be a repeat than a genuinely separate project.
 * ------------------------------------------------------------------------- */

/**
 * The ownership gate for a project row.
 *
 * Deliberately not `loadOwned`: that one runs `failIfStale`, which reads a status a
 * project row does not have. Same 404-for-someone-else's-row behaviour, so this cannot
 * be used to probe which project ids exist.
 */
async function loadOwnedProject(id: string | undefined, userId: string) {
  if (!id) return { error: errorResponse(400, 'VALIDATION_ERROR', 'Missing project id') };

  const result = await ddbDocClient.send(new GetCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: calculationProjectKey(id) },
  }));
  const item = result.Item;

  if (!item || item.item_type !== 'PROJECT' || item.deleted_at) {
    return { error: errorResponse(404, 'NOT_FOUND', 'Project not found') };
  }
  if (item.owner_user_id !== userId) {
    return { error: errorResponse(404, 'NOT_FOUND', 'Project not found') };
  }
  return { item };
}

export async function createCalculationProject(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  let parsed;
  try {
    parsed = CreateCalculationProjectSchema.safeParse(JSON.parse(event.body || '{}'));
  } catch {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body');
  }
  if (!parsed.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Invalid request body', parsed.error.format());
  }

  const existing = await ddbDocClient.send(new ScanCommand({
    TableName: CALCULATOR_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner AND item_type = :type',
    ExpressionAttributeValues: { ':owner': userId, ':type': 'PROJECT' },
    Limit: 200,
  }));

  const normalized = parsed.data.project_title.trim().toLowerCase();
  const match = (existing.Items || []).find(item =>
    !item.deleted_at && String(item.project_title || '').trim().toLowerCase() === normalized
  );

  // 200, not 201: nothing was created. The frontend only needs the id either way.
  if (match?.project_id) {
    return successResponse({
      project_id: match.project_id,
      project_title: match.project_title || parsed.data.project_title,
    });
  }

  const projectId = randomUUID();
  const now = Date.now();

  await ddbDocClient.send(new PutCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Item: {
      calculation_id: calculationProjectKey(projectId),
      project_id: projectId,
      item_type: 'PROJECT',
      owner_user_id: userId,
      project_title: parsed.data.project_title,
      created_at: now,
      updated_at: now,
    },
  }));

  return createdResponse({ project_id: projectId, project_title: parsed.data.project_title });
}

export async function listCalculationProjects(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  // One Scan for both kinds of row. Two calls would be one Scan each over the same
  // partition set, and the counts have to be computed from the estimates anyway.
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: CALCULATOR_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner',
    ExpressionAttributeValues: { ':owner': userId },
  }));

  /** Reserved bucket key for estimates with no project. Cannot collide with a uuid. */
  const UNGROUPED = 'UNGROUPED';
  const projects = new Map<string, CalculationProjectSummary>();
  const counts = new Map<string, { count: number; completed: number; monthly: number; updated_at: number }>();

  const ungroupedRow = (updated: number, created: number): CalculationProjectSummary => ({
    project_id: null,
    project_title: 'Ungrouped estimates',
    created_at: created,
    updated_at: updated,
    estimate_count: 0,
    completed_count: 0,
    monthly_total: null,
  });

  for (const item of result.Items || []) {
    if (isProjectRow(item)) {
      if (item.deleted_at || !item.project_id) continue;
      projects.set(item.project_id, {
        project_id: item.project_id,
        project_title: item.project_title || 'Untitled project',
        created_at: item.created_at || item.updated_at || 0,
        updated_at: item.updated_at || item.created_at || 0,
        estimate_count: 0,
        completed_count: 0,
        monthly_total: null,
      });
      continue;
    }

    const key = item.project_id || UNGROUPED;
    const bucket = counts.get(key) || { count: 0, completed: 0, monthly: 0, updated_at: 0 };
    bucket.count += 1;
    if (item.status === 'COMPLETED') {
      bucket.completed += 1;
      bucket.monthly += Number(item.result?.monthlyTotal || 0);
    }
    bucket.updated_at = Math.max(bucket.updated_at, item.updated_at || item.created_at || 0);
    counts.set(key, bucket);

    if (!item.project_id && !projects.has(UNGROUPED)) {
      projects.set(UNGROUPED, ungroupedRow(
        item.updated_at || item.created_at || 0,
        item.created_at || item.updated_at || 0,
      ));
    }
  }

  const applyBucket = (
    target: CalculationProjectSummary,
    bucket: { count: number; completed: number; monthly: number; updated_at: number },
  ) => {
    target.estimate_count += bucket.count;
    target.completed_count += bucket.completed;
    // null rather than 0 while nothing has priced yet: "$0.00/mo" reads as a priced
    // answer, and an all-failed or still-running project has not produced one.
    const monthly = (target.monthly_total || 0) + bucket.monthly;
    target.monthly_total = target.completed_count ? monthly : null;
    target.updated_at = Math.max(target.updated_at, bucket.updated_at);
  };

  for (const [key, bucket] of counts.entries()) {
    let target = projects.get(key);
    if (!target) {
      // No project row for this id — the project was deleted while its estimates were
      // not, or the row is mid-write. Those estimates fall into Ungrouped rather than
      // vanishing from every list in the app.
      target = projects.get(UNGROUPED) || ungroupedRow(bucket.updated_at, bucket.updated_at);
      projects.set(UNGROUPED, target);
    }
    applyBucket(target, bucket);
  }

  const items = [...projects.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

  return successResponse({ items, count: items.length });
}

export async function getCalculationProject(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  const { item, error } = await loadOwnedProject(id, userId);
  if (error) return error;

  return successResponse({
    project_id: item!.project_id,
    project_title: item!.project_title || 'Untitled project',
    created_at: item!.created_at,
    updated_at: item!.updated_at,
  });
}

/**
 * Deletes a project and every estimate in it, with the estimates' S3 objects.
 *
 * A hard delete of the children, matching deleteCalculation and deleteMomProject — the
 * calculator has never had a recycle bin, and leaving the rows behind would move them
 * into the Ungrouped bucket, which reads as a bug rather than as a deletion.
 */
export async function deleteCalculationProject(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  const { item: project, error } = await loadOwnedProject(id, userId);
  if (error) return error;

  const owned = await ddbDocClient.send(new ScanCommand({
    TableName: CALCULATOR_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner',
    ExpressionAttributeValues: { ':owner': userId },
  }));

  const estimates = (owned.Items || []).filter(row => !isProjectRow(row) && row.project_id === id);
  const remoteUrls: string[] = [];

  for (const estimate of estimates) {
    let storedResult: CalculationResult | null = estimate.result ?? null;
    if (!storedResult && estimate.result_s3_key) {
      try {
        storedResult = await loadFullCalculationResult(BUCKET_NAME, estimate as CalculationRecord);
      } catch (loadError) {
        console.warn(`[calculator] could not load result for remote estimate cleanup ${estimate.calculation_id}:`, loadError);
      }
    }
    remoteUrls.push(...calculatorEstimateUrls(storedResult));
  }

  const remoteCleanup = await cleanupRemoteCalculatorEstimates([...new Set(remoteUrls)]);

  for (const estimate of estimates) {
    const keys = [
      estimate.input_s3_key,
      estimate.resources_s3_key,
      estimate.workbook_ir_s3_key,
      estimate.canonical_model_s3_key,
      estimate.result_s3_key,
      ...generatedArtifactKeys(userId, estimate.calculation_id),
    ].filter((key): key is string => !!key);

    for (const key of keys) {
      try {
        await s3Client.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: key }));
      } catch (err) {
        console.warn(`Could not delete calculator object ${key} (it may never have existed):`, err);
      }
    }

    await ddbDocClient.send(new DeleteCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Key: { calculation_id: estimate.calculation_id },
    }));
  }

  // Last, so a failure part-way through leaves the project row pointing at whatever
  // survived rather than orphaning it.
  await ddbDocClient.send(new DeleteCommand({
    TableName: CALCULATOR_TABLE_NAME,
    Key: { calculation_id: project!.calculation_id },
  }));

  return successResponse({
    deleted: true,
    project_id: id,
    deleted_estimates: estimates.length,
    remote_estimates: remoteCleanup,
  });
}
