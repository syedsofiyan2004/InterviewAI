import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { ddbDocClient } from '../lambdas/shared/aws';
import {
  createCalculation,
  getCalculationDocument,
  reviseCalculation,
  runCalculationPlan,
} from '../lambdas/api-handler/calculator-routes';
import type { EstimatePlan } from '../schema/estimate-plan';
import { buildInitialPlan, confirmPlan } from '../lambdas/shared/estimate-planning';

/**
 * The Word download route, and the requested band matrix that outlives a revision.
 *
 * These two belong in one file because they are the same feature seen from both ends. A real
 * request — five fiscal years priced at three pricing models, then the lower environments again
 * on the same terms — is eighteen calculator.aws links for one workload. The matrix is what says
 * eighteen bands were asked for; the Word document is the only format that can carry eighteen
 * links to a reader. Losing either silently produces something that still looks finished:
 *
 *  - A revision that drops its parent's bands because the follow-up message only said "make the
 *    web tier smaller" re-prices one estimate and returns 201. Nothing errors, every figure is
 *    correct, and seventeen of the eighteen deliverables have gone.
 *  - A document uploaded under a key the delete path does not know leaves a client-facing cost
 *    document in the bucket after its estimate has been deleted.
 */

/**
 * The presigner signs from resolved credentials rather than through the client's `send`, so
 * aws-sdk-client-mock never reaches it: left real it would either sign with whatever
 * credentials the machine happens to carry or throw for want of any, neither of which is a
 * property of this route. Mocked so the assertions can read the command it was handed instead of
 * picking a filename back out of a signed URL's query string.
 */
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(async () => 'https://signed.example/estimate?sig=x'),
}));

const ddbMock = mockClient(ddbDocClient);
const s3Mock = mockClient(S3Client);
const lambdaMock = mockClient(LambdaClient);
const presign = getSignedUrl as jest.MockedFunction<typeof getSignedUrl>;

const OWNER = 'user-owner';
const OTHER = 'user-other';
const ID = 'calc-1';

const MODELS = ['On-Demand', '1-Year Reserved Instances', '3-Year Reserved Instances'];
const YEARS = ['FY26-27', 'FY27-28', 'FY28-29', 'FY29-30', 'FY30-31'];

/** The mix sentence a run records for a band that reserves only part of its service list. */
const RI_MIX = 'RI scope: Amazon Aurora + Amazon ElastiCache at 1-year Reserved Instances (No '
  + 'Upfront); non-RI services remain On-Demand (Amazon ECS on Fargate).';
const ON_DEMAND_MIX = 'Every service in this estimate is priced at On-Demand rates, as the '
  + 'pricing model for this scenario.';

/**
 * The eighteen priced bands, as the pipeline stores them: the two axes recorded as fields, the
 * committed scope recorded per band, and a twelve-month total only where it is not MRR x 12.
 */
function eighteenPricedScenarios() {
  const bands: Record<string, unknown>[] = [];
  YEARS.forEach((year, yearIndex) => {
    MODELS.forEach((model, modelIndex) => {
      bands.push({
        key: `${year}-${modelIndex}`,
        label: `${year} | ${model}`,
        kind: 'period',
        scope: year,
        pricing_model: model,
        pricing_mix: modelIndex === 0 ? ON_DEMAND_MIX : RI_MIX,
        monthly: 19688.31 + yearIndex * 30000 - modelIndex * 450,
        url: `https://calculator.aws/#/estimate?id=prod${yearIndex}${modelIndex}`,
        // Only the committed bands carry one: an On-Demand year genuinely is twelve equal bills,
        // while a Partial Upfront reservation bills a lump sum inside its first twelve months.
        ...(modelIndex === 2 && yearIndex === 0 ? { total_12_months: 231772.56 } : {}),
      });
    });
  });
  MODELS.forEach((model, modelIndex) => {
    bands.push({
      key: `lower-${modelIndex}`,
      label: `Dev + QA + UAT | ${model}`,
      kind: 'environment',
      scope: 'Dev + QA + UAT',
      pricing_model: model,
      pricing_mix: modelIndex === 0 ? ON_DEMAND_MIX : RI_MIX,
      monthly: 26248.92 - modelIndex * 250,
      url: `https://calculator.aws/#/estimate?id=lower${modelIndex}`,
    });
  });
  return bands;
}

/** The same eighteen bands as a REQUEST: what was asked for, before anything was priced. */
function eighteenBandPlan(): EstimatePlan {
  const models = ['on-demand', 'ri-1yr-no-upfront', 'ri-3yr-partial-upfront'] as const;
  return {
    scenarios: [
      ...YEARS.flatMap((year) => models.map((model) => ({
        label: `${year} | ${model}`,
        pricing_model: model,
        scope: year,
        environments: [],
      }))),
      ...models.map((model) => ({
        label: `Dev + QA + UAT | ${model}`,
        pricing_model: model,
        scope: 'Lower environments',
        environments: ['Dev', 'QA', 'UAT'],
      })),
    ],
    deliverables: { formats: ['docx', 'xlsx'], link_per_scenario: true },
    rationale: 'The client budgets by fiscal year and has not chosen a purchase model yet, so '
      + 'every year is quoted at all three.',
  };
}

const record = (overrides: Record<string, unknown> = {}) => ({
  calculation_id: ID,
  owner_user_id: OWNER,
  owner_email: 'owner@minfytech.com',
  name: 'Digital Assets Migration',
  prompt: 'Price the five-year capacity model at three pricing models.',
  region: 'eu-central-1',
  status: 'COMPLETED',
  environment_hours: [],
  resources: [],
  input_warnings: [],
  created_at: Date.UTC(2026, 7, 16),
  updated_at: Date.now(),
  result: {
    url: 'https://calculator.aws/#/estimate?id=primary',
    currency: 'USD',
    monthlyTotal: 19688.31,
    lineItems: [],
    environments: [],
    scenarios: eighteenPricedScenarios(),
    assumptions: ['ECS Fargate: tasks PER DAY; average duration = 730 HOURS'],
    warnings: [],
  },
  ...overrides,
});

function event(userId: string | null, body?: unknown): APIGatewayProxyEvent {
  return {
    httpMethod: body === undefined ? 'GET' : 'POST',
    resource: '/calculator/{id}/document',
    pathParameters: { id: ID },
    body: body === undefined ? null : JSON.stringify(body),
    requestContext: {
      authorizer: { claims: userId ? { sub: userId, email: 'owner@minfytech.com' } : {} },
    },
  } as unknown as APIGatewayProxyEvent;
}

/** The .docx the route uploaded, as the visible text a reader would see in Word. */
async function uploadedDocumentText(): Promise<string> {
  const upload = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(upload.Body as Buffer);
  const xml = await zip.file('word/document.xml')!.async('string');
  return xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** The record the route wrote, whichever of the two write paths put it there. */
const written = () => ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as Record<string, any>;

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  lambdaMock.reset();
  presign.mockClear();
  ddbMock.on(PutCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
  lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });
});

describe('Starting a confirmed estimate plan', () => {
  test('aliases reserved DynamoDB attributes while clearing an earlier result', async () => {
    const draft = buildInitialPlan({
      workbookId: 'generic-workbook',
      defaultRegion: 'ap-south-1',
      resources: [{ raw: 'EC2,m7i.large', service: 'EC2', size: 'm7i.large' }],
    });
    const plan = confirmPlan(draft, draft.currentRevisionId);
    ddbMock.on(GetCommand).resolves({
      Item: record({
        status: 'REVIEW_REQUIRED',
        plan_v2: plan,
        confirmed_plan_revision_id: plan.currentRevisionId,
      }),
    });
    ddbMock.on(UpdateCommand).resolves({});

    const response = await runCalculationPlan(ID, event(OWNER, {}));

    expect(response.statusCode).toBe(200);
    const update = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(update.UpdateExpression).toContain('REMOVE #result, result_s3_key, error_message');
    expect(update.ExpressionAttributeNames).toMatchObject({ '#status': 'status', '#result': 'result' });
    expect(lambdaMock).toHaveReceivedCommandWith(InvokeCommand, {
      FunctionName: expect.any(String),
      InvocationType: 'Event',
    });
  });
});

describe('Downloading an estimate as a Word document', () => {
  test('an unauthenticated caller is refused before the estimate is read at all', async () => {
    const response = await getCalculationDocument(ID, event(null));

    expect(response.statusCode).toBe(401);
    expect(ddbMock).not.toHaveReceivedCommand(GetCommand);
  });

  test('a caller who does not own the estimate gets the same 404 the PDF and workbook give', async () => {
    // The point of the shared access check: three formats, one ownership gate, and it answers
    // 404 rather than 403 so this route cannot be used to discover that an id exists.
    ddbMock.on(GetCommand).resolves({ Item: record() });

    const response = await getCalculationDocument(ID, event(OTHER));

    expect(response.statusCode).toBe(404);
    expect(s3Mock).not.toHaveReceivedCommand(PutObjectCommand);
    expect(presign).not.toHaveBeenCalled();
  });

  test('an estimate with no stored result produces no document, whether it is still running or finished without one', async () => {
    // A Word file generated from nothing would be a client-facing cost document with no costs
    // in it, which is worse than the download being refused.
    ddbMock.on(GetCommand).resolves({ Item: record({ status: 'PROCESSING', result: undefined }) });
    const running = await getCalculationDocument(ID, event(OWNER));

    ddbMock.on(GetCommand).resolves({ Item: record({ result: undefined }) });
    const resultless = await getCalculationDocument(ID, event(OWNER));

    expect([running.statusCode, resultless.statusCode]).toEqual([409, 409]);
    expect(s3Mock).not.toHaveReceivedCommand(PutObjectCommand);
  });

  test('the document is uploaded under the same estimate.docx key the delete path removes, and handed back as a presigned URL', async () => {
    // The key is load-bearing rather than cosmetic: deleteCalculation derives what to remove
    // from `<prefix>/estimate.<ext>`, so a document stored anywhere else survives its own
    // estimate and sits in the bucket with nothing pointing at it.
    ddbMock.on(GetCommand).resolves({ Item: record() });

    const response = await getCalculationDocument(ID, event(OWNER));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).download_url).toBe('https://signed.example/estimate?sig=x');

    const upload = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
    expect(upload.Bucket).toBe('test-bucket');
    expect(upload.Key).toBe(`users/${OWNER}/calculator/${ID}/estimate.docx`);
    expect(upload.ContentType)
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    // A real OOXML package, not an empty buffer that happens to have been uploaded.
    expect((upload.Body as Buffer).subarray(0, 2).toString()).toBe('PK');

    const signed = presign.mock.calls[0][1] as GetObjectCommand;
    expect(signed.input.Key).toBe(`users/${OWNER}/calculator/${ID}/estimate.docx`);
    expect(signed.input.ResponseContentDisposition)
      .toBe('attachment; filename="aws-cost-estimate-Digital-Assets-Migration.docx"');
  });

  test('downloads hydrate the lossless S3 result instead of exporting the compact DynamoDB copy', async () => {
    const resultKey = `users/${OWNER}/calculator/${ID}/result.json`;
    const fullResult = {
      ...record().result,
      assumptions: ['This assumption exists only in the lossless S3 result.'],
    };
    ddbMock.on(GetCommand).resolves({
      Item: record({
        result_s3_key: resultKey,
        result: { ...record().result, assumptions: [] },
      }),
    });
    s3Mock.on(GetObjectCommand, { Bucket: 'test-bucket', Key: resultKey }).resolves({
      Body: { transformToString: async () => JSON.stringify(fullResult) } as any,
    });

    const response = await getCalculationDocument(ID, event(OWNER));

    expect(response.statusCode).toBe(200);
    expect(s3Mock).toHaveReceivedCommandWith(GetObjectCommand, {
      Bucket: 'test-bucket',
      Key: resultKey,
    });
    expect(await uploadedDocumentText()).toContain('This assumption exists only in the lossless S3 result.');
  });

  test('every one of the eighteen priced bands reaches the document as a working hyperlink', async () => {
    // Blue underlined text that goes nowhere passes a visual review and fails the only job this
    // format has, so this counts the relationship entries rather than the visible wording.
    ddbMock.on(GetCommand).resolves({ Item: record() });

    await getCalculationDocument(ID, event(OWNER));

    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input.Body as Buffer);
    const rels = await zip.file('word/_rels/document.xml.rels')!.async('string');
    const external = (rels.match(/<Relationship [^>]*TargetMode="External"[^>]*>/g) || []);

    expect(external).toHaveLength(18);
  });

  test('the committed-rate scope the run recorded is stated in the document instead of the renderer admitting a gap', async () => {
    // The renderer states "committed-rate scope was not recorded" when a caller supplies
    // nothing. On an estimate that DID record it per band, that sentence would confess a gap
    // which does not exist — and the reader would go looking for information already in hand.
    ddbMock.on(GetCommand).resolves({ Item: record() });

    await getCalculationDocument(ID, event(OWNER));
    const text = await uploadedDocumentText();

    expect(text).toContain('non-RI services remain On-Demand (Amazon ECS on Fargate)');
    expect(text).not.toContain('Committed-rate scope was not recorded');
    // Two different mixes across the bands, so the per-band sentences carry the detail and the
    // headline statement points at them rather than picking one and describing the rest wrongly.
    expect(text).toContain('differs by pricing model');
    expect(text).toContain(`1-Year Reserved Instances — ${RI_MIX.slice(0, 40)}`);
  });

  test('a recorded twelve-month total is printed rather than MRR multiplied by twelve', async () => {
    // FY26-27 at 3-Year RI: $18,788.31 a month, but $231,772.56 over the first twelve months
    // because of the upfront charge. Deriving that row would understate the year by ~$6,300 and
    // nothing in the document would say so.
    ddbMock.on(GetCommand).resolves({ Item: record() });

    await getCalculationDocument(ID, event(OWNER));
    const text = await uploadedDocumentText();

    expect(text).toContain('$231,772.56');
    expect(text).not.toContain('$225,459.72');
  });

  test('the two axes come from the recorded fields, so a band is never split back out of its label', async () => {
    // Recovering the grid by splitting a label works until a label is prose. The pipeline
    // records both axes, and a document built from those fields cannot misread one.
    ddbMock.on(GetCommand).resolves({
      Item: record({
        result: {
          ...record().result,
          scenarios: [{
            key: 'baseline',
            label: 'Lift and shift - as the sheet specifies',
            kind: 'sizing',
            scope: 'Lift and shift',
            pricing_model: 'On-Demand',
            monthly: 1000,
            url: 'https://calculator.aws/#/estimate?id=baseline',
          }],
        },
      }),
    });

    await getCalculationDocument(ID, event(OWNER));
    const text = await uploadedDocumentText();

    expect(text).toContain('Lift and shift ');
    expect(text).not.toContain('as the sheet specifies');
  });

  test('the plan\'s rationale is stated with the assumptions, where it can still change how the tables are read', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record({ requested_plan: eighteenBandPlan() }) });

    await getCalculationDocument(ID, event(OWNER));
    const text = await uploadedDocumentText();

    expect(text).toContain('has not chosen a purchase model yet');
    // And not instead of the estimate's own assumptions.
    expect(text).toContain('average duration = 730 HOURS');
  });
});

describe('The requested band matrix, from creation through revision', () => {
  const revision = (body: Record<string, unknown>) => reviseCalculation(ID, event(OWNER, body));

  test('a plan submitted with a new estimate is stored as structure on the row', async () => {
    // Stored rather than left inside the prompt: a re-run prices the same bands without
    // re-reading an English sentence, and a revision has something to inherit.
    const plan = eighteenBandPlan();

    const response = await createCalculation(event(OWNER, {
      name: 'Digital Assets Migration',
      prompt: 'Price the five-year capacity model at three pricing models.',
      plan,
    }));

    expect(response.statusCode).toBe(201);
    expect(written().requested_plan).toEqual(plan);
    expect(written().requested_plan.scenarios).toHaveLength(18);
  });

  test('an estimate created without a plan stores no empty one', async () => {
    // Absent means "the bands are whatever the sheet turns out to hold", which is the ordinary
    // flow. An empty plan on the row would read as "eighteen bands were asked for and none
    // survived", which is a different claim.
    const response = await createCalculation(event(OWNER, {
      name: 'Two web servers',
      prompt: 'Two m5.large web servers in ap-south-1, running all month.',
    }));

    expect(response.statusCode).toBe(201);
    expect(written()).not.toHaveProperty('requested_plan');
  });

  test('a revision that states no scenarios keeps its parent\'s eighteen bands', async () => {
    // THE failure this guards. "Make the web tier smaller" says nothing about the matrix, and
    // reading that silence as "drop the bands" would return 201 with every figure correct and
    // seventeen of the eighteen deliverables gone.
    const plan = eighteenBandPlan();
    ddbMock.on(GetCommand).resolves({ Item: record({ requested_plan: plan }) });

    const response = await revision({ instruction: 'Make the web tier smaller.' });

    expect(response.statusCode).toBe(201);
    expect(written().requested_plan).toEqual(plan);
  });

  test('a revision that states its own scenarios replaces the parent\'s bands', async () => {
    // The other half: when the follow-up DOES restate the matrix, the parent's is what it is
    // replacing, and carrying both would price bands nobody asked for a second time.
    ddbMock.on(GetCommand).resolves({ Item: record({ requested_plan: eighteenBandPlan() }) });

    const response = await revision({
      instruction: 'Only quote FY26-27, on-demand.',
      scenarios: [{
        label: 'FY26-27 | on-demand',
        pricing_model: 'on-demand',
        scope: 'FY26-27',
        environments: [],
      }],
    });

    expect(response.statusCode).toBe(201);
    expect(written().requested_plan.scenarios).toEqual([{
      label: 'FY26-27 | on-demand',
      pricing_model: 'on-demand',
      scope: 'FY26-27',
      environments: [],
    }]);
    // The parent said which formats to produce and this revision did not, so the formats stand.
    expect(written().requested_plan.deliverables)
      .toEqual({ formats: ['docx', 'xlsx'], link_per_scenario: true });
    expect(written().requested_plan.rationale).toBe(eighteenBandPlan().rationale);
  });

  test('a chat-applied scenario matrix updates the worker-facing plan revision', async () => {
    const plan = eighteenBandPlan();
    const planV2 = buildInitialPlan({
      workbookId: 'digital-assets',
      resources: [
        { raw: 'Fargate 26-27', service: 'AWS Fargate', scenario: '26-27', quantity: '10', vcpu: 1, ram_gb: 2 },
        { raw: 'Fargate dev', service: 'AWS Fargate', scenario: 'dev', quantity: '5', vcpu: 1, ram_gb: 2 },
      ],
      workbook: {
        bands: [
          { key: '26-27', label: '26-27', kind: 'period', sheet: 'Digital Assets', resource_count: 1 },
          { key: 'dev', label: 'Dev', kind: 'environment', sheet: 'Digital Assets', resource_count: 1 },
        ],
      } as any,
      requestedPlan: plan,
      defaultRegion: 'ap-south-1',
    });
    ddbMock.on(GetCommand).resolves({ Item: record({ requested_plan: plan, plan_v2: planV2 }) });

    const response = await revision({
      instruction: 'Only quote FY26-27, on-demand.',
      scenarios: [{
        label: 'FY26-27 | on-demand',
        pricing_model: 'on-demand',
        scope: 'FY26-27',
        environments: [],
      }],
    });

    expect(response.statusCode).toBe(201);
    const current = written().plan_v2.revisions.find(
      (entry: any) => entry.revisionId === written().plan_v2.currentRevisionId,
    );
    expect(current.scenarios).toEqual([{
      label: 'FY26-27 | on-demand',
      pricing_model: 'on-demand',
      scope: 'FY26-27',
      environments: [],
    }]);
  });

  test('a revision that names only formats keeps the bands it did not mention', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record({ requested_plan: eighteenBandPlan() }) });

    const response = await revision({
      instruction: 'Send the workbook as well.',
      deliverables: ['pdf', 'xlsx'],
    });

    expect(response.statusCode).toBe(201);
    expect(written().requested_plan.scenarios).toHaveLength(18);
    expect(written().requested_plan.deliverables.formats).toEqual(['pdf', 'xlsx']);
  });

  test('a revision of a parent that never had a plan does not invent one', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record() });

    const response = await revision({ instruction: 'Make the web tier smaller.' });

    expect(response.statusCode).toBe(201);
    // Undefined rather than absent, exactly as `result` is on the same row: the document client
    // is configured with removeUndefinedValues, so neither reaches DynamoDB as an attribute.
    expect(written().requested_plan).toBeUndefined();
  });

  test('a revision still drops its parent\'s priced result while keeping the matrix', async () => {
    // The two travel in opposite directions on purpose. The request is inherited because it is
    // still the request; the parent's numbers are not, because a revision that failed to start
    // would otherwise read as one that succeeded with the old figures.
    ddbMock.on(GetCommand).resolves({ Item: record({ requested_plan: eighteenBandPlan() }) });

    const response = await revision({ instruction: 'Make the web tier smaller.' });

    expect(response.statusCode).toBe(201);
    expect(written().result).toBeUndefined();
    expect(written().revision_of).toBe(ID);
    expect(written().requested_plan.scenarios).toHaveLength(18);
  });

  test('a matrix of thirty-one bands is refused by validation rather than stored', async () => {
    // The cap is a runaway guard: every band is a full pricing pass plus a save call against a
    // worker already near the Lambda ceiling, so an unbounded request has to be refused at the
    // edge rather than time out having produced nothing.
    const tooMany = Array.from({ length: 31 }, (unused, index) => ({
      label: `Band ${index + 1}`,
      pricing_model: 'on-demand',
      environments: [],
    }));
    ddbMock.on(GetCommand).resolves({ Item: record() });

    const created = await createCalculation(event(OWNER, {
      name: 'Too many bands',
      prompt: 'Price every fiscal year at every purchase model we have.',
      plan: { scenarios: tooMany },
    }));
    const revised = await revision({ instruction: 'Add every band.', scenarios: tooMany });

    expect([created.statusCode, revised.statusCode]).toEqual([400, 400]);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
    expect(lambdaMock).not.toHaveReceivedCommand(InvokeCommand);
  });

  test('a pricing model outside the closed set is refused, so no downstream code has to match a spelling', async () => {
    // "1yr RI", "1-Year Reserved" and "one year reserved" are all the same thing and none of
    // them is a member. Accepting free text here would make every reader of the plan responsible
    // for normalising it forever.
    const response = await createCalculation(event(OWNER, {
      name: 'Loose spelling',
      prompt: 'Price the landscape at a one year reservation.',
      plan: { scenarios: [{ label: 'FY26-27', pricing_model: '1yr RI', environments: [] }] },
    }));

    expect(response.statusCode).toBe(400);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });
});
