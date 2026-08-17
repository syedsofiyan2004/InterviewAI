import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEvent } from 'aws-lambda';
import { ddbDocClient } from '../lambdas/shared/aws';
import { handler } from '../lambdas/api-handler/index';

const ddbMock = mockClient(ddbDocClient);
const lambdaMock = mockClient(LambdaClient);

const record = (overrides: Record<string, unknown> = {}) => ({
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
  ...overrides,
});

function event(method: string, resource: string): APIGatewayProxyEvent {
  return {
    httpMethod: method,
    resource,
    pathParameters: { id: 'intelligence-1' },
    body: method === 'POST' ? JSON.stringify({ focus_areas: ['Migration planning'], question_count: 8 }) : null,
    requestContext: { authorizer: { claims: { sub: 'user-1', email: 'panel@minfytech.com' } } } as any,
  } as unknown as APIGatewayProxyEvent;
}

describe('question guide background queue state', () => {
  beforeEach(() => {
    ddbMock.reset();
    lambdaMock.reset();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('marks the saved request failed when Lambda self-invocation is rejected', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record() });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});
    lambdaMock.on(InvokeCommand).rejects(new Error('AccessDeniedException'));

    const response = await handler(event('POST', '/intelligence-interviews/{id}/generate-questions'));

    expect(response.statusCode).toBe(502);
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-intelligence',
      Key: { intelligence_id: 'intelligence-1' },
      ExpressionAttributeValues: expect.objectContaining({
        ':s': 'failed',
        ':m': 'The interview guide could not be started. Please retry.',
      }),
    });
  });

  test('a queued request older than the Lambda timeout becomes retryable on read', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record({
      progress_stage: 'queued',
      progress_message: 'Queued for question generation...',
      analysis_started_at: Date.now() - 17 * 60_000,
    }) });
    ddbMock.on(UpdateCommand).resolves({});

    const response = await handler(event('GET', '/intelligence-interviews/{id}'));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
      progress_stage: 'failed',
      progress_message: 'Question generation timed out before completing. Please retry.',
    }));
  });

  test('does not misclassify the separate AI review queue as question generation', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record({
      status: 'analysis_processing',
      progress_stage: 'queued',
      progress_message: 'Queued for AI review...',
      analysis_started_at: Date.now() - 17 * 60_000,
    }) });

    const response = await handler(event('GET', '/intelligence-interviews/{id}'));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({
      status: 'analysis_processing',
      progress_stage: 'queued',
    }));
    expect(ddbMock).not.toHaveReceivedCommand(UpdateCommand);
  });

  test('an orphaned recording fallback without a Transcribe job becomes retryable', async () => {
    ddbMock.on(GetCommand).resolves({ Item: record({
      teams: {
        mode: 'live',
        transcriptStatus: 'transcribing',
        lastSyncAt: Date.now() - 17 * 60_000,
      },
    }) });
    ddbMock.on(PutCommand).resolves({});
    ddbMock.on(UpdateCommand).resolves({});

    const response = await handler(event('GET', '/intelligence-interviews/{id}'));

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).teams).toEqual(expect.objectContaining({
      transcriptStatus: 'failed',
      error: 'Recording transcription did not start before the worker timeout. Please retry.',
    }));
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-intelligence',
      ConditionExpression: expect.stringContaining('attribute_not_exists'),
    });
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });
});
