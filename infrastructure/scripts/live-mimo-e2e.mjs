/**
 * Step 15 — LIVE end-to-end through the ACTUAL MIMO request path.
 *
 * This is the acceptance test that standalone Runtime/Gateway/Harness probes cannot give
 * you. It drives the deployed api-handler Lambda with real API Gateway events, so the code
 * under test is the real route: createCalculation → confirm plan → run → poll result.
 *
 *   MIMO API (api-handler)
 *     → WorkbookEvidence / index / chunks written to S3
 *       → Step Functions execution
 *         → AgentCore Harness  → Gateway → Runtime MCP → AWS Pricing Calculator
 *
 * It also proves what is NOT in the path: the invocation counts of calculator-agent,
 * calculator-mcp-proxy, calculator-mcp-sidecar and calculator-orchestrator are sampled
 * from CloudWatch before and after. Any increase means the cutover is incomplete.
 *
 * A synthetic authorizer claim stands in for a Cognito login. Everything downstream of
 * `getUserId(event)` is the production code path; only the sign-in is simulated.
 *
 *   node scripts/live-mimo-e2e.mjs ap-south-1 [workbook.xlsx]
 *
 * With no workbook it uses a tiny generated CSV: Amazon S3, 100 GB, ap-south-1.
 */
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { SFNClient, DescribeExecutionCommand, GetExecutionHistoryCommand } from '@aws-sdk/client-sfn';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

const region = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'ap-south-1';
const workbookPath = process.argv[3];

const ACCOUNT = process.env.MIMO_ACCOUNT || '996122083346';
const ENV = process.env.MIMO_ENV || 'dev';
const API_HANDLER = `iep-${ENV}-api-handler-${ACCOUNT}-${region}`;
const BUCKET = `iep-${ENV}-files-${ACCOUNT}-${region}`;

/** The legacy components that must stay untouched. */
const LEGACY_FUNCTIONS = [
  `iep-${ENV}-calculator-agent-orchestrator-${ACCOUNT}-${region}`,
  `iep-${ENV}-calculator-mcp-proxy-${ACCOUNT}-${region}`,
  `iep-${ENV}-calculator-mcp-sidecar-${ACCOUNT}-${region}`,
  `iep-${ENV}-calculator-orchestrator-${ACCOUNT}-${region}`,
];

const lambda = new LambdaClient({ region });
const s3 = new S3Client({ region });
const cloudwatch = new CloudWatchClient({ region });
const sfn = new SFNClient({ region });

// A stable synthetic user, so repeat runs share one S3 prefix rather than littering.
const USER_ID = process.env.MIMO_TEST_USER || 'e2e-agentcore-0000-0000-000000000001';
const USER_EMAIL = 'agentcore-e2e@example.invalid';

const apiEvent = ({ method, resource, pathParameters = null, body = null }) => ({
  httpMethod: method,
  resource,
  path: resource,
  pathParameters,
  queryStringParameters: null,
  headers: { 'content-type': 'application/json' },
  requestContext: {
    // Exactly what getUserId/getUserEmail read. Everything past this point is production code.
    authorizer: { claims: { sub: USER_ID, email: USER_EMAIL } },
    requestId: randomUUID(),
  },
  body: body === null ? null : JSON.stringify(body),
  isBase64Encoded: false,
});

async function callApi(spec) {
  const response = await lambda.send(new InvokeCommand({
    FunctionName: API_HANDLER,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify(apiEvent(spec))),
  }));
  const raw = new TextDecoder().decode(response.Payload);
  if (response.FunctionError) throw new Error(`${spec.method} ${spec.resource} → ${response.FunctionError}: ${raw.slice(0, 800)}`);
  const envelope = JSON.parse(raw);
  let parsed;
  try { parsed = JSON.parse(envelope.body ?? '{}'); } catch { parsed = { raw: envelope.body }; }
  return { status: envelope.statusCode, body: parsed };
}

/**
 * Lambda Invocations since `since`.
 *
 * Read AFTER a settling delay, never immediately. Lambda publishes these metrics 1-3
 * minutes late, and sampling straight after the run produced a confident false pass: the
 * first version of this script reported "Legacy infrastructure untouched: YES" while the
 * legacy orchestrator had in fact run and stamped its own result over the record. A check
 * that can only report success is worse than no check.
 */
async function invocationCount(functionName, since) {
  const stats = await cloudwatch.send(new GetMetricStatisticsCommand({
    Namespace: 'AWS/Lambda',
    MetricName: 'Invocations',
    Dimensions: [{ Name: 'FunctionName', Value: functionName }],
    StartTime: since,
    EndTime: new Date(Date.now() + 60_000),
    Period: 60,
    Statistics: ['Sum'],
  }));
  return (stats.Datapoints ?? []).reduce((total, point) => total + (point.Sum ?? 0), 0);
}

/**
 * Corroborates the metric with the record's own account of who finished it.
 *
 * These progress messages belong to the legacy workers
 * (calculator-orchestrator/index.ts and calculator-agent/index.ts). The AgentCore driver
 * never writes them, so seeing one is direct evidence that a legacy worker touched this
 * calculation — available immediately, unlike the metrics.
 */
const LEGACY_PROGRESS_FINGERPRINTS = [
  'Validated estimate ready',
  'Estimate did not pass saved-link validation',
  'Agent could not complete the estimate',
  'Workbook baseline:',
  'Starting estimate',
];

const legacyFingerprint = (record) => {
  const haystack = [
    record?.progress_message,
    record?.progress_stage,
    ...(record?.progress_history ?? []).map((entry) => entry?.message),
  ].filter(Boolean).join(' | ');
  return LEGACY_PROGRESS_FINGERPRINTS.filter((phrase) => haystack.includes(phrase));
};

// ─── the workload ────────────────────────────────────────────────────────────

let fileName;
let fileBody;
if (workbookPath) {
  fileName = path.basename(workbookPath);
  fileBody = fs.readFileSync(workbookPath);
} else {
  fileName = 'agentcore-e2e-s3.csv';
  fileBody = Buffer.from(
    'Service,Size,Quantity,Region\n'
    + 'Amazon S3,100 GB,1,ap-south-1\n',
    'utf8',
  );
}

console.log(`region      : ${region}`);
console.log(`api handler : ${API_HANDLER}`);
console.log(`workload    : ${fileName} (${fileBody.length} bytes)`);
console.log('');

const runStartedAt = new Date(Date.now() - 60_000);
const legacyBefore = {};
for (const fn of LEGACY_FUNCTIONS) legacyBefore[fn] = await invocationCount(fn, runStartedAt);

// 1. upload-url through the real route, then PUT the bytes.
const upload = await callApi({
  method: 'POST',
  resource: '/calculator/upload-url',
  body: { file_name: fileName, content_type: 'application/octet-stream' },
});
if (upload.status !== 200) throw new Error(`upload-url → ${upload.status} ${JSON.stringify(upload.body)}`);
const inputS3Key = upload.body.s3_key;
console.log(`upload-url  OK  ${inputS3Key}`);

await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: inputS3Key, Body: fileBody }));
console.log('upload      OK');

// 2. create the calculation — the real parse, evidence and plan path.
const created = await callApi({
  method: 'POST',
  resource: '/calculator',
  body: {
    name: `AgentCore E2E ${new Date().toISOString()}`,
    region: 'ap-south-1',
    input_s3_key: inputS3Key,
    input_file_name: fileName,
    prompt: 'Price this workload as stated. Treat the evidence as complete.',
  },
});
if (![200, 201].includes(created.status)) throw new Error(`POST /calculator → ${created.status} ${JSON.stringify(created.body).slice(0, 900)}`);
const calculationId = created.body.calculation_id || created.body.calculationId;
console.log(`create      OK  calculation_id=${calculationId}  status=${created.body.status}`);

// 3. POST /calculator is the immediate-build entry point: it has already dispatched an
// execution and the record is ANALYZING. Confirming a plan now would reset the status and
// let a second execution start on the same record — two agents, one calculation. So the
// review workflow is only exercised when create did NOT start anything.
const alreadyRunning = ['ANALYZING', 'PROCESSING', 'BUILDING', 'VALIDATING'].includes(created.body.status);
if (alreadyRunning) {
  console.log('confirm/run skipped — create already started the execution (immediate-build path)');
}

const planResponse = alreadyRunning
  ? { status: 0, body: {} }
  : await callApi({ method: 'GET', resource: '/calculator/plans/{id}', pathParameters: { id: calculationId } });
if (planResponse.status === 200) {
  const revisionId = planResponse.body.plan?.currentRevisionId;
  const confirmed = await callApi({
    method: 'POST',
    resource: '/calculator/plans/{id}/confirm',
    pathParameters: { id: calculationId },
    body: { revision_id: revisionId },
  });
  console.log(`confirm     ${confirmed.status === 200 ? 'OK' : `HTTP ${confirmed.status} ${JSON.stringify(confirmed.body).slice(0, 300)}`}`);
}

// POST /calculator already dispatched an execution (status ANALYZING), so this run call is
// expected to be refused with 409 "already running". That refusal is the correct behaviour
// — a second execution on the same record would mean two agents mutating one calculation —
// so it is accepted here rather than treated as a failure.
if (!alreadyRunning) {
  const run = await callApi({ method: 'POST', resource: '/calculator/plans/{id}/run', pathParameters: { id: calculationId } });
  console.log(`run         HTTP ${run.status}  ${JSON.stringify(run.body).slice(0, 200)}`);
  if (run.status === 409) {
    console.log('            (already running — correct, not a second execution)');
  } else if (run.status !== 200) {
    throw new Error(`run did not start: HTTP ${run.status}`);
  }
}

// 4. poll the real result route until terminal.
const TERMINAL = ['COMPLETED', 'FAILED', 'REVIEW_REQUIRED', 'NEEDS_INPUT'];
let record;
let executionArn;
const pollStarted = Date.now();
const POLL_TIMEOUT_MS = Number(process.env.MIMO_E2E_TIMEOUT_MS) || 45 * 60_000;

while (Date.now() - pollStarted < POLL_TIMEOUT_MS) {
  await new Promise((resolve) => setTimeout(resolve, 20_000));
  const polled = await callApi({ method: 'GET', resource: '/calculator/{id}', pathParameters: { id: calculationId } });
  record = polled.body;
  executionArn = record.state_machine_execution_arn || executionArn;
  const elapsed = Math.round((Date.now() - pollStarted) / 1000);
  console.log(`  ${String(elapsed).padStart(5)}s  status=${record.status}  stage=${record.progress_stage ?? '-'}  "${record.progress_message ?? ''}"  tools=${record.tool_call_count ?? 0}`);
  if (TERMINAL.includes(record.status)) break;
}

console.log('');
console.log(`final status     : ${record?.status}`);
console.log(`executionArn     : ${executionArn ?? '(none recorded)'}`);
console.log(`agent session    : ${record?.agent_session_id ?? '-'}`);
console.log(`evidence index   : ${record?.evidence_index_s3_key ?? '-'}`);
console.log(`evidence chunks  : ${record?.evidence_chunk_count ?? '-'}  rows=${record?.evidence_row_count ?? '-'}`);
console.log(`calculator URL   : ${record?.calculator_url ?? record?.result?.url ?? '(none)'}`);
console.log(`mcp tools used   : ${(record?.mcp_tools_used ?? []).join(', ') || '-'}`);

// 5. DynamoDB item size, measured on what the API actually returns.
const itemBytes = Buffer.byteLength(JSON.stringify(record ?? {}), 'utf8');
console.log(`record bytes     : ${itemBytes}`);

// 6. Step Functions history, to show the segments and that no Claude loop lives in MIMO.
if (executionArn) {
  const described = await sfn.send(new DescribeExecutionCommand({ executionArn }));
  console.log(`sfn status       : ${described.status}`);
  const history = await sfn.send(new GetExecutionHistoryCommand({ executionArn, maxResults: 200 }));
  const segments = (history.events ?? []).filter((e) => e.type === 'LambdaFunctionScheduled').length;
  console.log(`sfn segments     : ${segments}`);
}

// 7. the architectural assertion, from two independent sources.
console.log('');
const fingerprints = legacyFingerprint(record);
if (fingerprints.length) {
  console.log(`LEGACY FINGERPRINT in progress text: ${fingerprints.join(', ')}`);
} else {
  console.log('No legacy progress fingerprint in the record.');
}

// Lambda metrics publish 1-3 minutes late, so this waits rather than reporting a
// comfortable zero. Skipped only if the caller explicitly opts out.
if (process.env.MIMO_E2E_SKIP_METRIC_WAIT !== '1') {
  console.log('waiting 180s for Lambda invocation metrics to publish...');
  await new Promise((resolve) => setTimeout(resolve, 180_000));
}

let legacyTouched = fingerprints.length > 0;
for (const fn of LEGACY_FUNCTIONS) {
  const after = await invocationCount(fn, runStartedAt);
  const delta = after - legacyBefore[fn];
  const short = fn.replace(`iep-${ENV}-`, '').replace(`-${ACCOUNT}-${region}`, '');
  console.log(`${short.padEnd(34)} invocations during run: ${delta}`);
  if (delta > 0) legacyTouched = true;
}

const url = record?.calculator_url || record?.result?.url;
const gotUrl = Boolean(url && String(url).includes('calculator.aws'));

console.log('');
console.log(`COMPLETED with a real calculator.aws URL : ${gotUrl ? 'YES' : 'NO'}`);
console.log(`Legacy infrastructure untouched          : ${legacyTouched ? 'NO' : 'YES'}`);
console.log(`DynamoDB record under 100 KB             : ${itemBytes < 100_000 ? 'YES' : 'NO'}`);
if (gotUrl) console.log(`\nREAL calculator.aws URL: ${url}\n`);

if (!gotUrl || legacyTouched || record?.status !== 'COMPLETED') {
  console.log('RESULT: FAILED');
  process.exit(1);
}
console.log('RESULT: PASSED — the actual MIMO request path produced a real Calculator estimate through AgentCore.');
