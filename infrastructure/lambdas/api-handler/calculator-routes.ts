import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { PutCommand, GetCommand, ScanCommand, UpdateCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'crypto';

import { ddbDocClient, s3Client, getFileBuffer, getPresignedUploadUrl, saveFileContent } from '../shared/aws';
import { successResponse, createdResponse, errorResponse } from '../shared/responses';
import { extractTableFromBuffer } from '../shared/utils';
import { generateCalculatorPdfReport } from '../shared/calculator-report';
import {
  CreateCalculationSchema,
  CalculationResultSchema,
  DEFAULT_ENVIRONMENT_HOURS,
  type CalculationRecord,
  type CalculationResource,
  type CalculationSummary,
  type EnvironmentHours,
} from '../../schema/calculator';

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
const BUCKET_NAME = process.env.BUCKET_NAME!;

const lambdaClient = new LambdaClient({});

const SHEET_EXTENSIONS = ['xlsx', 'csv'];

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

/** Header aliases, so a hand-made sheet does not have to match the template exactly. */
const COLUMN_ALIASES: Record<keyof Omit<CalculationResource, 'raw' | 'hoursPerDay'> | 'hours', string[]> = {
  environment: ['environment', 'env', 'stage', 'tier'],
  service: ['service', 'aws service', 'resource', 'component'],
  size: ['instance / size', 'instance/size', 'instance', 'size', 'instance type', 'type', 'spec'],
  quantity: ['qty', 'quantity', 'count', 'number', 'nos'],
  region: ['region', 'aws region', 'location'],
  hours: ['hours/day', 'hours per day', 'hours', 'uptime', 'runtime', 'hrs/day'],
  notes: ['notes', 'note', 'comment', 'comments', 'remarks', 'description'],
};

const normaliseHeader = (value: string) => value.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Maps a parsed sheet onto resource rows.
 *
 * Header matching is deliberately loose — capitalisation, extra spaces and common
 * synonyms all resolve — because the promise to the user was that a sheet which is
 * not the template still works. When a header row cannot be identified at all, every
 * row is still returned with its full text in `raw`: the model reads that as a table
 * and interprets it, which is strictly better than rejecting the upload.
 */
export function normaliseResourceTable(rows: string[][]): {
  resources: CalculationResource[];
  warnings: string[];
} {
  if (!rows.length) return { resources: [], warnings: ['The uploaded sheet had no rows.'] };

  const warnings: string[] = [];
  const header = rows[0].map(normaliseHeader);
  const columnFor = (aliases: string[]) => header.findIndex((cell) => aliases.includes(cell));

  const index = {
    environment: columnFor(COLUMN_ALIASES.environment),
    service: columnFor(COLUMN_ALIASES.service),
    size: columnFor(COLUMN_ALIASES.size),
    quantity: columnFor(COLUMN_ALIASES.quantity),
    region: columnFor(COLUMN_ALIASES.region),
    hours: columnFor(COLUMN_ALIASES.hours),
    notes: columnFor(COLUMN_ALIASES.notes),
  };

  // A sheet with no recognisable service column is not the template. Keep every
  // row as text rather than guessing which column means what.
  const recognised = index.service !== -1;
  if (!recognised) {
    warnings.push('No recognisable column headers were found, so the sheet was read as free text. Use the template for a structured breakdown.');
    return {
      resources: rows.map((row) => ({ raw: row.filter(Boolean).join(' | ') })).filter((r) => r.raw),
      warnings,
    };
  }

  const cell = (row: string[], at: number) => (at === -1 ? '' : String(row[at] ?? '').trim());
  const resources: CalculationResource[] = [];

  for (const row of rows.slice(1)) {
    const raw = row.filter(Boolean).join(' | ');
    if (!raw) continue;

    const service = cell(row, index.service);
    if (!service) {
      // A row with notes but no service is a comment line in someone's sheet.
      warnings.push(`Skipped a row with no service: "${raw.slice(0, 80)}"`);
      continue;
    }

    const hoursText = cell(row, index.hours);
    const hoursValue = Number(hoursText.replace(/[^0-9.]/g, ''));
    const hoursPerDay = hoursText && Number.isFinite(hoursValue) && hoursValue >= 1 && hoursValue <= 24
      ? Math.round(hoursValue)
      : undefined;
    if (hoursText && hoursPerDay === undefined) {
      warnings.push(`Ignored an unreadable Hours/Day value ("${hoursText}") for ${service}; the environment default applies.`);
    }

    resources.push({
      environment: cell(row, index.environment) || undefined,
      service,
      size: cell(row, index.size) || undefined,
      quantity: cell(row, index.quantity) || undefined,
      region: cell(row, index.region) || undefined,
      hoursPerDay,
      notes: cell(row, index.notes) || undefined,
      raw,
    });
  }

  if (!resources.length) warnings.push('The sheet had headers but no resource rows below them.');
  // Keep the record small and the prompt bounded; 12 is more than a reader needs.
  return { resources, warnings: warnings.slice(0, 12) };
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

export async function createCalculation(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
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

  // Parse the sheet HERE rather than in the orchestrator: it takes milliseconds,
  // and it means an unreadable file is rejected on submit with a message the user
  // can act on, instead of surfacing two minutes later as a failed estimate.
  let resources: CalculationResource[] = [];
  let inputWarnings: string[] = [];
  let inputFileName: string | undefined;

  if (input.input_s3_key) {
    // The key is built server-side in getCalculationUploadUrl and namespaced per
    // user; re-check that prefix so a caller cannot name someone else's object.
    if (!input.input_s3_key.startsWith(`users/${userId}/calculator/uploads/`)) {
      return errorResponse(400, 'VALIDATION_ERROR', 'That upload does not belong to this account.');
    }
    inputFileName = input.input_s3_key.split('/').pop();
    try {
      const buffer = await getFileBuffer(BUCKET_NAME, input.input_s3_key);
      const table = await extractTableFromBuffer(buffer, input.input_s3_key);
      const normalised = normaliseResourceTable(table);
      resources = normalised.resources;
      inputWarnings = normalised.warnings;
    } catch (error) {
      const code = (error as Error).message;
      const message = code === 'LEGACY_XLS_UNSUPPORTED'
        ? 'The older .xls format cannot be read. Open it in Excel, save as .xlsx, and upload again.'
        : code === 'XLSX_PARSE_FAILED'
          ? 'That spreadsheet could not be read. Re-save it as .xlsx or .csv and try again.'
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
  }

  const now = Date.now();
  const record: CalculationRecord = {
    calculation_id: randomUUID(),
    owner_user_id: userId,
    owner_email: getUserEmail(event),
    name: input.name,
    prompt,
    region: input.region,
    status: 'PROCESSING',
    environment_hours: resolveEnvironmentHours(input.environment_hours),
    resources,
    input_s3_key: input.input_s3_key,
    input_file_name: inputFileName,
    input_warnings: inputWarnings,
    created_at: now,
    updated_at: now,
    progress_stage: 'queued',
    progress_message: 'Starting estimate',
  };

  await ddbDocClient.send(new PutCommand({ TableName: CALCULATOR_TABLE_NAME, Item: record }));

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

export async function listCalculations(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  // Scan + owner filter, consistent with the other list endpoints in index.ts.
  // Volume here is per-user and small; revisit with a GSI if that changes.
  const result = await ddbDocClient.send(new ScanCommand({
    TableName: CALCULATOR_TABLE_NAME,
    FilterExpression: 'owner_user_id = :owner',
    ExpressionAttributeValues: { ':owner': userId },
  }));

  const items: CalculationSummary[] = (result.Items || [])
    .map(item => ({
      calculation_id: item.calculation_id,
      name: item.name,
      status: item.status,
      created_at: item.created_at,
      updated_at: item.updated_at,
      monthly_total: item.result?.monthlyTotal ?? null,
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
  if (item.status !== 'PROCESSING') return item;
  const lastTouched = Number(item.updated_at || item.created_at || 0);
  if (!lastTouched || Date.now() - lastTouched <= CALCULATION_STALE_AFTER_MS) return item;

  const error_message = 'The estimate worker stopped before finishing. Please retry.';
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: CALCULATOR_TABLE_NAME,
      Key: { calculation_id: item.calculation_id },
      UpdateExpression: 'SET #status = :failed, error_message = :error, progress_stage = :stage, '
        + 'progress_message = :message, updated_at = :now',
      ConditionExpression: '#status = :processing AND updated_at = :lastTouched',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':failed': 'FAILED',
        ':processing': 'PROCESSING',
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

/**
 * Poll target. Always 200 with the current status so the frontend can drive its
 * loop off the body rather than having to treat a 404/425 as "still working".
 */
export async function getCalculationResult(
  id: string | undefined,
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> {
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  const { item, error } = await loadOwned(id, userId);
  if (error) return error;

  return successResponse({
    calculation_id: item!.calculation_id,
    status: item!.status,
    result: item!.result ?? null,
    error_message: item!.error_message ?? null,
    progress_stage: item!.progress_stage ?? null,
    progress_message: item!.progress_message ?? null,
    environment_hours: item!.environment_hours ?? [],
    input_file_name: item!.input_file_name ?? null,
    input_warnings: item!.input_warnings ?? [],
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

  const keys = [
    item!.input_s3_key,
    `users/${userId}/calculator/${item!.calculation_id}/estimate.pdf`,
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

  return successResponse({ deleted: true, calculation_id: item!.calculation_id });
}

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
  const userId = getUserId(event);
  if (!userId) return errorResponse(401, 'ACCESS_DENIED', 'Not authenticated');

  const { item, error } = await loadOwned(id, userId);
  if (error) return error;

  if (item!.status !== 'COMPLETED' || !item!.result) {
    return errorResponse(409, 'VALIDATION_ERROR', 'This estimate has not finished yet, so there is nothing to download.');
  }

  const validation = CalculationResultSchema.safeParse(item!.result);
  if (!validation.success) {
    return errorResponse(500, 'INTERNAL_ERROR', 'The stored estimate could not be converted to a PDF.');
  }

  const pdf = await generateCalculatorPdfReport(validation.data, {
    name: item!.name,
    environmentHours: item!.environment_hours || [],
    createdAt: item!.created_at,
    region: item!.region,
  });

  const reportKey = `users/${userId}/calculator/${item!.calculation_id}/estimate.pdf`;
  await saveFileContent(BUCKET_NAME, reportKey, pdf, 'application/pdf');

  const safeName = (item!.name || 'aws-cost-estimate').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: reportKey,
    ResponseContentDisposition: `attachment; filename="aws-cost-estimate-${safeName}.pdf"`,
  });
  const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

  return successResponse({ download_url: downloadUrl });
}
