/**
 * LIVE regression for large review plans.
 *
 * Reproduces the UI path that showed "This estimate has no review plan":
 * upload a large resource sheet, create a review plan, reload it through the
 * plan endpoint, confirm, run, and poll. The assertion is that the plan survives
 * even when it is too large to live inline on the DynamoDB row.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const region = process.argv[2] || 'ap-south-1';
const workbookPath = process.argv.find((arg, index) => index > 1 && !arg.startsWith('--') && arg !== region);
const account = process.env.MIMO_ACCOUNT || '996122083346';
const envName = process.env.MIMO_ENV || 'dev';
const rowCount = Number(process.env.MIMO_SPILL_ROWS || 420);
const shouldRun = process.argv.includes('--run');
const shouldPoll = process.argv.includes('--poll');
const apiHandler = `iep-${envName}-api-handler-${account}-${region}`;
const bucket = `iep-${envName}-files-${account}-${region}`;
const table = `iep-${envName}-calculations-${account}-${region}`;
const userId = 'e2e-plan-spill-0000-0000-000000000001';

const lambda = new LambdaClient({ region });
const s3 = new S3Client({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

function apiEvent({ method, resource, pathParameters = null, body = null }) {
  return {
    httpMethod: method,
    resource,
    path: resource,
    pathParameters,
    queryStringParameters: null,
    headers: { 'content-type': 'application/json' },
    requestContext: {
      authorizer: { claims: { sub: userId, email: 'plan-spill-e2e@example.invalid' } },
      requestId: randomUUID(),
    },
    body: body === null ? null : JSON.stringify(body),
    isBase64Encoded: false,
  };
}

async function callApi(spec) {
  const response = await lambda.send(new InvokeCommand({
    FunctionName: apiHandler,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify(apiEvent(spec))),
  }));
  const raw = new TextDecoder().decode(response.Payload);
  if (response.FunctionError) throw new Error(`${spec.method} ${spec.resource} -> ${response.FunctionError}: ${raw.slice(0, 800)}`);
  const envelope = JSON.parse(raw);
  const parsed = JSON.parse(envelope.body || '{}');
  if (envelope.statusCode >= 400) throw new Error(`${spec.method} ${spec.resource} -> HTTP ${envelope.statusCode}: ${JSON.stringify(parsed).slice(0, 800)}`);
  return { status: envelope.statusCode, body: parsed };
}

const rows = ['Environment,Service,Instance / Size,Qty,Region,Hours/Day,Notes'];
for (let i = 0; i < rowCount; i++) rows.push(`Production,S3,${100 + i} GB Standard,,ap-south-1,,spill regression row ${i + 1}`);
const fileName = workbookPath ? path.basename(workbookPath) : 'large-plan-spill.csv';
const contentType = workbookPath ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'text/csv';
const fileBody = workbookPath ? fs.readFileSync(workbookPath) : Buffer.from(rows.join('\n'), 'utf8');

console.log(`input       : ${workbookPath || `${rowCount} generated CSV rows`}`);
console.log(`api handler : ${apiHandler}`);

const upload = await callApi({
  method: 'POST',
  resource: '/calculator/upload-url',
  body: { file_name: fileName, content_type: contentType },
});
await s3.send(new PutObjectCommand({ Bucket: bucket, Key: upload.body.s3_key, Body: fileBody, ContentType: contentType }));
console.log(`upload      : ${upload.body.s3_key}`);

const created = await callApi({
  method: 'POST',
  resource: '/calculator/analyze',
  body: {
    name: `Plan spill regression ${new Date().toISOString()}`,
    region: 'ap-south-1',
    input_s3_key: upload.body.s3_key,
    prompt: 'Price each S3 storage row as stated. Treat the workbook evidence as complete.',
  },
});
const calculationId = created.body.calculation_id;
console.log(`created     : ${calculationId} status=${created.body.status} resources=${created.body.plan.detectedDimensions.resourceCount}`);

const stored = await ddb.send(new GetCommand({ TableName: table, Key: { calculation_id: calculationId } }));
console.log(`stored plan : inline=${Boolean(stored.Item?.plan_v2)} s3=${stored.Item?.plan_v2_s3_key || '(none)'}`);
if (!stored.Item?.plan_v2_s3_key) throw new Error('Expected large review plan to be stored in S3');

const loaded = await callApi({
  method: 'GET',
  resource: '/calculator/plans/{id}',
  pathParameters: { id: calculationId },
});
if (loaded.body.plan.currentRevisionId !== created.body.plan.currentRevisionId) throw new Error('Reloaded plan revision mismatch');
console.log(`plan reload : OK revision=${loaded.body.plan.currentRevisionId}`);

const confirmed = await callApi({
  method: 'POST',
  resource: '/calculator/plans/{id}/confirm',
  pathParameters: { id: calculationId },
  body: { revision_id: loaded.body.plan.currentRevisionId },
});
console.log(`confirm     : OK status=${confirmed.body.plan.status}`);

if (!shouldRun) {
  console.log('RESULT PASS');
  process.exit(0);
}

await callApi({
  method: 'POST',
  resource: '/calculator/plans/{id}/run',
  pathParameters: { id: calculationId },
});
console.log('run         : started');

if (!shouldPoll) {
  console.log('RESULT PASS');
  process.exit(0);
}

const deadline = Date.now() + Number(process.env.MIMO_SPILL_TIMEOUT_MS || 15 * 60_000);
let record;
while (Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 20_000));
  const polled = await callApi({
    method: 'GET',
    resource: '/calculator/{id}',
    pathParameters: { id: calculationId },
  });
  record = polled.body;
  console.log(`poll        : status=${record.status} stage=${record.progress_stage || '-'} tools=${record.tool_call_count || 0}`);
  if (['COMPLETED', 'FAILED', 'NEEDS_INPUT', 'REVIEW_REQUIRED', 'PARTIAL'].includes(record.status)) break;
}

if (record?.status !== 'COMPLETED') throw new Error(`Expected COMPLETED, got ${record?.status || 'unknown'}: ${record?.error_message || ''}`);
const url = record.calculator_url || record.result?.url;
if (!url?.includes('calculator.aws')) throw new Error('Missing calculator.aws URL');
console.log(`url         : ${url}`);
console.log('RESULT PASS');
