import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const region = 'ap-south-1';
const bucket = 'iep-dev-files-996122083346-ap-south-1';
const table = 'iep-dev-calculations-996122083346-ap-south-1';
const validator = 'iep-dev-calculator-browser-validator-996122083346-ap-south-1';
const records = [
  {
    id: '87dbfb2b-44d3-4b0e-88b2-ee20aea7be91',
    url: 'https://calculator.aws/#/estimate?id=63125868c584e77884ddbb759c4fcb7fa65d696e',
    key: 'users/e2e-plan-spill-0000-0000-000000000001/calculator/87dbfb2b-44d3-4b0e-88b2-ee20aea7be91/result.json',
  },
  {
    id: '62550abb-3935-472c-b165-1a556bb1667b',
    url: 'https://calculator.aws/#/estimate?id=f8347c414d0938d70cba4589cb5bcb9ffa2bfab0',
    key: 'users/61f3cd5a-2031-7084-4466-eaa83ab5b034/calculator/62550abb-3935-472c-b165-1a556bb1667b/result.json',
  },
  {
    id: 'bda8cbb9-0645-4737-acaf-a05530388869',
    url: 'https://calculator.aws/#/estimate?id=d96e28911775c2edc37f35ce894874944596a5b7',
    key: 'users/e2e-agentcore-0000-0000-000000000001/calculator/bda8cbb9-0645-4737-acaf-a05530388869/result.json',
  },
];

const lambda = new LambdaClient({ region });
const s3 = new S3Client({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

async function bodyToString(body) {
  if (!body) return '';
  if (typeof body.transformToString === 'function') return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

for (const record of records) {
  const invoked = await lambda.send(new InvokeCommand({
    FunctionName: validator,
    InvocationType: 'RequestResponse',
    Payload: new TextEncoder().encode(JSON.stringify({ url: record.url })),
  }));
  const validatorRaw = new TextDecoder().decode(invoked.Payload);
  const totals = JSON.parse(validatorRaw);
  if (!totals.validUrl || typeof totals.monthly !== 'number') {
    throw new Error(`${record.id} validator did not return totals: ${validatorRaw}`);
  }

  const existingRaw = await bodyToString((await s3.send(new GetObjectCommand({ Bucket: bucket, Key: record.key }))).Body);
  const result = JSON.parse(existingRaw);
  result.monthlyTotal = totals.monthly;
  result.diagnostics = { ...(result.diagnostics || {}), renderedTotals: totals };
  result.warnings = (result.warnings || []).filter((message) => !/monthly cost not available/i.test(String(message)));

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: record.key,
    Body: JSON.stringify(result),
    ContentType: 'application/json',
  }));

  await ddb.send(new UpdateCommand({
    TableName: table,
    Key: { calculation_id: record.id },
    UpdateExpression: 'SET monthly_total = :monthly, upfront_total = :upfront, total_12_months = :total12, #result.monthlyTotal = :monthly, #result.#diagnostics.renderedTotals = :rendered, updated_at = :now',
    ExpressionAttributeNames: { '#result': 'result', '#diagnostics': 'diagnostics' },
    ExpressionAttributeValues: {
      ':monthly': totals.monthly,
      ':upfront': totals.upfront ?? null,
      ':total12': totals.total12Months ?? null,
      ':rendered': totals,
      ':now': Date.now(),
    },
  }));
  console.log(`${record.id}: monthly=${totals.monthly} total12=${totals.total12Months}`);
}

