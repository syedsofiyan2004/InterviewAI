import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ddbDocClient } from '../lambdas/shared/aws';
import { apiResponse, successResponse, errorResponse } from '../lambdas/shared/responses';
import { handler } from '../lambdas/api-handler/index';

/**
 * The progress surface: the clock the UI measures elapsed time against, and the
 * stage history it renders as an activity log.
 *
 * Both exist because of the same class of bug. Elapsed time used to be
 * `Date.now() - analysis_started_at`, which compares the browser's clock to
 * Lambda's; a workstation a minute behind produced a negative value and pinned
 * the timer to 0:00. And progress used to be a single overwritten sentence, so a
 * long-running job could only ever show one line with no way to see what had
 * already happened.
 */

const ddbMock = mockClient(ddbDocClient);
const lambdaMock = mockClient(LambdaClient);

beforeEach(() => {
  ddbMock.reset();
  lambdaMock.reset();
  ddbMock.on(UpdateCommand).resolves({});
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('Every response publishes the server clock', () => {
  test('X-Server-Time is a plausible epoch-ms stamp', () => {
    const before = Date.now();
    const response = apiResponse(200, { ok: true });
    const after = Date.now();

    const stamp = Number(response.headers['X-Server-Time']);
    expect(Number.isFinite(stamp)).toBe(true);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
  });

  test('the header is exposed to browser JS, or the client cannot read it', () => {
    // CORS hides every response header but a safelisted handful. Without this the
    // client silently falls back to its own clock and the bug returns.
    const exposed = String(apiResponse(200, {}).headers['Access-Control-Expose-Headers'] || '');
    expect(exposed.split(',').map((name) => name.trim())).toContain('X-Server-Time');
  });

  test('success and error responses both carry it', () => {
    // The client learns the offset from whatever response arrives first, which is
    // not necessarily a 200.
    expect(successResponse({}).headers['X-Server-Time']).toBeTruthy();
    expect(errorResponse(403, 'ACCESS_DENIED', 'Admin access required').headers['X-Server-Time']).toBeTruthy();
  });

  test('the body is untouched — the clock rides in the headers', () => {
    // Deliberately not merged into the payload: response bodies include bare
    // arrays and typed contracts that an injected key would corrupt.
    expect(JSON.parse(successResponse({ items: [1, 2] }).body)).toEqual({ items: [1, 2] });
    expect(JSON.parse(apiResponse(200, [1, 2]).body)).toEqual([1, 2]);
  });
});

describe('Progress writes append to the log instead of replacing it', () => {
  const record = {
    intelligence_id: 'intelligence-1',
    owner_user_id: 'user-1',
    owner_email: 'panel@minfytech.com',
    created_at: Date.now() - 60_000,
    updated_at: Date.now() - 60_000,
    source_mode: 'keka_live',
    status: 'data_ready',
    keka: { mode: 'live', syncStatus: 'synced' },
    teams: { mode: 'live', transcriptStatus: 'not_available' },
    job: { title: 'Migration Architect', description: 'Lead cloud migrations.' },
    candidate: { name: 'Candidate' },
    panel: [{ interviewerId: 'employee-1', name: 'Panel Member' }],
    // A log left over from a previous attempt, which the new run must not inherit.
    progress_events: [
      { at: 1, stage: 'queued', message: 'Queued for question generation...' },
      { at: 2, stage: 'failed', message: 'The interview guide could not be generated. Please retry.' },
    ],
  };

  function queueEvent(): APIGatewayProxyEvent {
    return {
      httpMethod: 'POST',
      resource: '/intelligence-interviews/{id}/generate-questions',
      pathParameters: { id: 'intelligence-1' },
      body: JSON.stringify({ question_count: 8 }),
      requestContext: { authorizer: { claims: { sub: 'user-1', email: 'panel@minfytech.com' } } } as any,
    } as unknown as APIGatewayProxyEvent;
  }

  test('queueing a run starts a fresh log rather than extending the last attempt', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record });
    ddbMock.on(PutCommand).resolves({});
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });

    await handler(queueEvent());

    const queued = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as any;
    // Exactly one entry: the previous run's two are gone, so a re-generated guide
    // does not show stages that did not happen this time — and the list cannot
    // grow without bound across repeated attempts.
    expect(queued.progress_events).toEqual([
      { at: expect.any(Number), stage: 'queued', message: 'Queued for question generation...' },
    ]);
    expect(queued.progress_events[0].at).toBe(queued.analysis_started_at);
  });

  test('the queued stamp is the same value the elapsed timer reads', async () => {
    // analysis_started_at is what the banner measures against; if the log's first
    // entry and the timer disagreed, the log would look like it began before the
    // task did.
    ddbMock.on(GetCommand).resolves({ Item: record });
    ddbMock.on(PutCommand).resolves({});
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 202 });

    const before = Date.now();
    await handler(queueEvent());
    const after = Date.now();

    const queued = ddbMock.commandCalls(PutCommand)[0].args[0].input.Item as any;
    expect(queued.analysis_started_at).toBeGreaterThanOrEqual(before);
    expect(queued.analysis_started_at).toBeLessThanOrEqual(after);
    expect(queued.progress_stage).toBe('queued');
  });

  test('a stage transition appends without reading the row first', async () => {
    // list_append over if_not_exists is what makes stage one work (list_append
    // against a missing attribute fails) and keeps later stages from clobbering
    // each other — no read-modify-write, so two writes landing together cannot
    // lose one. Driven through the real worker's failure path, which is the
    // cheapest route to a progress write.
    ddbMock.on(GetCommand).resolves({ Item: record });
    ddbMock.on(PutCommand).resolves({});
    lambdaMock.on(InvokeCommand).rejects(new Error('AccessDeniedException'));
    jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await handler(queueEvent());

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-intelligence',
      Key: { intelligence_id: 'intelligence-1' },
      UpdateExpression: expect.stringContaining('list_append(if_not_exists(progress_events, :empty), :event)'),
      ExpressionAttributeValues: expect.objectContaining({
        ':empty': [],
        ':event': [expect.objectContaining({
          stage: 'failed',
          at: expect.any(Number),
          message: 'The interview guide could not be started. Please retry.',
        })],
      }),
    });
    // GetCommand was the ownership read, not a read of the log to rewrite it.
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });
});
