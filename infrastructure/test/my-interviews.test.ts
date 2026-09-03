import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import { keys } from '../schema/admin';
import type { APIGatewayProxyEvent } from 'aws-lambda';

/**
 * Part A — the My Interviews privilege boundary.
 *
 * POST /my-interviews/{schedId}/open carries NO tier gate, so the only thing
 * standing between a caller and someone else's interview is that a SCHED row
 * exists in the caller's own partition — which the sync worker writes only for
 * emails on that interview's panel. These tests hold that boundary, and hold the
 * idempotency that stops a double click from creating two rounds.
 *
 * Keka is stubbed: the boundary is about which rows the caller can address, not
 * about talking to Keka. Both integrations must read 'live' for the route to get
 * past its readiness guard, so the env is set before the handler is imported.
 */

process.env.KEKA_INTEGRATION_MODE = 'live';
process.env.TEAMS_INTEGRATION_MODE = 'live';

const getInterviewData = jest.fn();

jest.mock('../lambdas/api-handler/intelligence-integrations', () => ({
  ...jest.requireActual('../lambdas/api-handler/intelligence-integrations'),
  createKekaIntegration: () => ({ getInterviewData }),
}));

// Imported after the mock is registered so index.ts picks up the stub.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { handler } = require('../lambdas/api-handler/index') as typeof import('../lambdas/api-handler/index');

const ddbMock = mockClient(ddbDocClient);

const PANELIST = 'panelist@minfytech.com';
const OUTSIDER = 'outsider@minfytech.com';
const INTERVIEW_ID = 'keka-int-9';

function schedRow(overrides: Partial<Record<string, unknown>> = {}) {
  const scheduledAt = Date.UTC(2026, 7, 20, 9, 30);
  return {
    PK: keys.schedPk(PANELIST),
    SK: keys.schedSk(scheduledAt, INTERVIEW_ID),
    entity_type: 'ScheduledInterview',
    keka_interview_id: INTERVIEW_ID,
    keka_job_id: 'job-1',
    keka_candidate_id: 'cand-1',
    job_title: 'Migration Architect',
    candidate_name: 'Asha Rao',
    candidate_email: 'asha@example.com',
    scheduled_at: scheduledAt,
    panel: [{ interviewerId: 'p1', name: 'Panelist', email: PANELIST }],
    keka_status: 'Scheduled',
    synced_at: scheduledAt,
    ...overrides,
  };
}

function openEvent(email: string, interviewId = INTERVIEW_ID): Partial<APIGatewayProxyEvent> {
  return {
    httpMethod: 'POST',
    resource: '/my-interviews/{schedId}/open',
    pathParameters: { schedId: interviewId },
    body: null,
    requestContext: { authorizer: { claims: { sub: 'user-panelist', email } } } as any,
  } as any;
}

/**
 * Rows only ever come back for PANELIST's partition — exactly how DynamoDB
 * behaves, and what makes the outsider case a real 404 rather than a stub.
 */
function partitionHas(rows: any[]) {
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = input.ExpressionAttributeValues?.[':pk'];
    if (pk === keys.schedPk(PANELIST)) return { Items: rows };
    // Grant lookups and other partitions: empty.
    return { Items: [] };
  });
}

beforeEach(() => {
  ddbMock.reset();
  getInterviewData.mockReset();
  // A plain member with no admin membership row and no grant: proves the route
  // needs no tier.
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  getInterviewData.mockResolvedValue({
    job: { title: 'Migration Architect', description: 'Lead large migrations.', requiredSkills: [], preferredSkills: [] },
    candidate: { name: 'Asha Rao', email: 'asha@example.com', resumeText: 'Ten years of migration work.' },
    panel: [{ interviewerId: 'p1', name: 'Panelist', email: PANELIST }],
    meetingUrl: 'https://teams.microsoft.com/l/meetup-join/x',
    scheduledAt: '2026-08-20T09:30:00Z',
    organizerEmail: PANELIST,
  });
});

describe('POST /my-interviews/{schedId}/open — panel membership is the boundary', () => {
  test('a panelist with no admin tier at all can open their own interview', async () => {
    partitionHas([schedRow()]);

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(201);
    const payload = JSON.parse(response.body);
    expect(payload.intelligence_id).toBeTruthy();
    // The round was really written, and the SCHED row stamped so the next open
    // short-circuits.
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, { TableName: 'test-intelligence' });
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-admin',
      Key: { PK: keys.schedPk(PANELIST), SK: schedRow().SK },
      ConditionExpression: expect.stringContaining('provisioning_token = :token'),
    });
  });

  test('someone not on the panel gets 404 and provisions nothing', async () => {
    // The row exists in the org, just not in this caller's partition.
    partitionHas([schedRow()]);

    const response = await handler(openEvent(OUTSIDER) as any);

    expect(response.statusCode).toBe(404);
    expect(response.body).toContain('No scheduled interview found for you');
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
    expect(getInterviewData).not.toHaveBeenCalled();
  });

  test('an id the caller has no row for is a 404, not a lookup of someone else', async () => {
    partitionHas([schedRow()]);

    const response = await handler(openEvent(PANELIST, 'keka-int-does-not-exist') as any);

    expect(response.statusCode).toBe(404);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  test('a caller with no email on the token is refused rather than matched loosely', async () => {
    partitionHas([schedRow()]);

    const response = await handler({
      httpMethod: 'POST',
      resource: '/my-interviews/{schedId}/open',
      pathParameters: { schedId: INTERVIEW_ID },
      requestContext: { authorizer: { claims: { sub: 'user-noemail' } } },
    } as any);

    expect(response.statusCode).toBe(403);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  test('a cancelled interview cannot be opened', async () => {
    partitionHas([schedRow({ cancelled_at: Date.now() })]);

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('INTERVIEW_CANCELLED');
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });
});

describe('Opening twice does not create a second round', () => {
  test('a second open returns the same intelligence_id and writes nothing', async () => {
    partitionHas([schedRow({ intelligence_id: 'intel-existing', workspace_id: 'ws-existing' })]);
    ddbMock.on(GetCommand, {
      TableName: 'test-intelligence',
      Key: { intelligence_id: 'intel-existing' },
      ProjectionExpression: 'intelligence_id, deleted_at',
    }).resolves({ Item: { intelligence_id: 'intel-existing' } });

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      intelligence_id: 'intel-existing',
      workspace_id: 'ws-existing',
      already_provisioned: true,
    });
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
    expect(getInterviewData).not.toHaveBeenCalled();
  });

  test('a stale provisioned pointer is cleared and the interview opens a fresh round', async () => {
    partitionHas([schedRow({ intelligence_id: 'intel-deleted', workspace_id: 'ws-deleted' })]);

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(201);
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-admin',
      Key: { PK: keys.schedPk(PANELIST), SK: schedRow().SK },
      UpdateExpression: expect.stringContaining('REMOVE intelligence_id'),
    });
    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, { TableName: 'test-intelligence' });
    expect(getInterviewData).toHaveBeenCalledTimes(1);
  });

  test('when a concurrent open wins the conditional stamp, the loser returns the winner\'s round', async () => {
    // First lookup: unprovisioned. The stamp then fails the condition because
    // another open got there first, and the re-read shows the winner's id.
    let lookups = 0;
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.ExpressionAttributeValues?.[':pk'] !== keys.schedPk(PANELIST)) return { Items: [] };
      lookups += 1;
      return { Items: [lookups === 1 ? schedRow() : schedRow({ intelligence_id: 'intel-winner', workspace_id: 'ws-winner' })] };
    });
    ddbMock.on(UpdateCommand).rejects(
      Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }),
    );

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).intelligence_id).toBe('intel-winner');
    expect(JSON.parse(response.body).already_provisioned).toBe(true);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
    expect(getInterviewData).not.toHaveBeenCalled();
  });

  test('an in-flight open returns a conflict without provisioning a competing round', async () => {
    let lookups = 0;
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.ExpressionAttributeValues?.[':pk'] !== keys.schedPk(PANELIST)) return { Items: [] };
      lookups += 1;
      return {
        Items: [schedRow({
          provisioning_token: 'winner-token',
          provisioning_expires_at: Date.now() + 60_000,
        })],
      };
    });
    ddbMock.on(UpdateCommand).rejects(
      Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' }),
    );

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('INTERVIEW_PROVISIONING');
    expect(lookups).toBeGreaterThanOrEqual(2);
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
    expect(getInterviewData).not.toHaveBeenCalled();
  });

  test('a Keka failure releases the provisioning lease so the interviewer can retry', async () => {
    partitionHas([schedRow()]);
    getInterviewData.mockRejectedValueOnce(new Error('Keka unavailable'));

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(502);
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-admin',
      UpdateExpression: 'REMOVE provisioning_token, provisioning_expires_at, provisioning_by',
      ConditionExpression: 'provisioning_token = :token',
    });
    expect(ddbMock).not.toHaveReceivedCommand(PutCommand);
  });

  test('a final stamp failure removes the created intelligence record before releasing the lease', async () => {
    partitionHas([schedRow()]);
    ddbMock.on(UpdateCommand).callsFake((input) => {
      if (input.ConditionExpression === 'attribute_not_exists(intelligence_id) AND provisioning_token = :token') {
        throw new Error('DynamoDB unavailable during final stamp');
      }
      return {};
    });

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(500);
    const intelligencePut = ddbMock.commandCalls(PutCommand)
      .map((call) => call.args[0].input as any)
      .find((input) => input.TableName === 'test-intelligence');
    expect(intelligencePut).toBeTruthy();
    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      TableName: 'test-intelligence',
      Key: { intelligence_id: intelligencePut.Item.intelligence_id },
    });
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-admin',
      UpdateExpression: 'REMOVE provisioning_token, provisioning_expires_at, provisioning_by',
    });
  });

  test('an ambiguous stamp is preserved when the strongly consistent verification read fails', async () => {
    let scheduleReads = 0;
    ddbMock.on(QueryCommand).callsFake((input) => {
      if (input.ExpressionAttributeValues?.[':pk'] !== keys.schedPk(PANELIST)) return { Items: [] };
      scheduleReads += 1;
      if (scheduleReads === 1) return { Items: [schedRow()] };
      throw new Error('DynamoDB unavailable during verification');
    });
    ddbMock.on(UpdateCommand).callsFake((input) => {
      if (input.ConditionExpression === 'attribute_not_exists(intelligence_id) AND provisioning_token = :token') {
        throw new Error('Stamp response was ambiguous');
      }
      return {};
    });

    const response = await handler(openEvent(PANELIST) as any);

    expect(response.statusCode).toBe(500);
    expect(ddbMock).not.toHaveReceivedCommand(DeleteCommand);
    expect(ddbMock).not.toHaveReceivedCommandWith(UpdateCommand, {
      UpdateExpression: 'REMOVE provisioning_token, provisioning_expires_at, provisioning_by',
    });
  });
});

describe('GET /my-interviews reads only the caller\'s own partition', () => {
  test('the query is keyed on the caller email, and rows come back in schedule order', async () => {
    const early = schedRow({ keka_interview_id: 'a', SK: keys.schedSk(Date.UTC(2026, 7, 18), 'a') });
    const late = schedRow({ keka_interview_id: 'b', SK: keys.schedSk(Date.UTC(2026, 7, 22), 'b') });
    partitionHas([early, late]);

    const response = await handler({
      httpMethod: 'GET',
      resource: '/my-interviews',
      pathParameters: {},
      requestContext: { authorizer: { claims: { sub: 'user-panelist', email: PANELIST } } },
    } as any);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).items.map((i: any) => i.keka_interview_id)).toEqual(['a', 'b']);
    expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
      TableName: 'test-admin',
      ExpressionAttributeValues: { ':pk': keys.schedPk(PANELIST) },
      ScanIndexForward: true,
      ConsistentRead: true,
    });
  });

  test('a mixed-case token email still finds the lowercased partition', async () => {
    partitionHas([schedRow()]);

    const response = await handler({
      httpMethod: 'GET',
      resource: '/my-interviews',
      pathParameters: {},
      requestContext: { authorizer: { claims: { sub: 'user-panelist', email: 'Panelist@Minfytech.com' } } },
    } as any);

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body).items).toHaveLength(1);
  });
});
