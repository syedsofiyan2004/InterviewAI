import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddbDocClient } from '../lambdas/shared/aws';
import { keys } from '../schema/admin';

/**
 * Part A — the Keka schedule sweep.
 *
 * The sweep is the only writer of the SCHED partitions that My Interviews reads,
 * and it runs unattended every few hours. Its dangerous behaviours are all about
 * what it does to rows it did NOT see this run: cancelling a completed round, or
 * leaving a rescheduled one behind so opening it creates a duplicate. Those are
 * the cases pinned here.
 */

const listJobs = jest.fn();
const listCandidates = jest.fn();
const listInterviews = jest.fn();
const findMeetingLink = jest.fn();

jest.mock('../lambdas/api-handler/intelligence-integrations', () => ({
  ...jest.requireActual('../lambdas/api-handler/intelligence-integrations'),
  createKekaIntegration: () => ({ listJobs, listCandidates, listInterviews }),
  createTeamsIntegration: () => ({ findMeetingLink }),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runKekaScheduleSyncWorker } = require('../lambdas/api-handler/keka-schedule-sync') as typeof import('../lambdas/api-handler/keka-schedule-sync');

const ddbMock = mockClient(ddbDocClient);

const ALICE = 'alice@minfytech.com';
const BOB = 'bob@minfytech.com';
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/** In-window, and far enough from either bound that clock drift cannot matter. */
const soonIso = () => new Date(Date.now() + 3 * DAY_MS).toISOString();

function kekaInterview(overrides: Record<string, any> = {}) {
  return {
    id: 'int-1',
    title: 'Technical Round 1',
    scheduledAt: soonIso(),
    status: 'Scheduled',
    panel: [{ interviewerId: 'p1', name: 'Alice', email: ALICE }],
    ...overrides,
  };
}

/**
 * Routes the two different Query shapes the worker makes: the GSI1 window scan
 * used for cancellation, and the per-panelist partition read used for reschedule
 * detection.
 */
function mockQueries(opts: { windowRows?: any[]; partitionRows?: any[] } = {}) {
  ddbMock.on(QueryCommand).callsFake((input) => (
    input.IndexName === 'GSI1_OrgRecency'
      ? { Items: opts.windowRows || [] }
      : { Items: opts.partitionRows || [] }
  ));
}

beforeEach(() => {
  ddbMock.reset();
  listJobs.mockReset();
  listCandidates.mockReset();
  listInterviews.mockReset();
  findMeetingLink.mockReset();
  findMeetingLink.mockResolvedValue({});
  ddbMock.on(GetCommand).resolves({});
  ddbMock.on(UpdateCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
  mockQueries();
  process.env.KEKA_INTERVIEW_ACTIVE_STATUSES = 'interview scheduled,in interview';
  process.env.TEAMS_INTEGRATION_MODE = 'live';
  delete process.env.KEKA_SYNC_STATUS_MODE;

  listJobs.mockResolvedValue([{ id: 'job-1', title: 'Migration Architect', department: 'Cloud' }]);
  listCandidates.mockResolvedValue([{ id: 'cand-1', name: 'Asha Rao', email: 'asha@example.com', status: 'Interview Scheduled' }]);
  listInterviews.mockResolvedValue([kekaInterview()]);
});

afterAll(() => {
  delete process.env.KEKA_INTERVIEW_ACTIVE_STATUSES;
  delete process.env.KEKA_SYNC_STATUS_MODE;
  delete process.env.TEAMS_INTEGRATION_MODE;
});

describe('The sweep fails closed without a status vocabulary', () => {
  test('no configured statuses means 409 and not a single Keka call', async () => {
    delete process.env.KEKA_INTERVIEW_ACTIVE_STATUSES;

    const response = await runKekaScheduleSyncWorker('test');

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain('KEKA_STATUS_VOCABULARY_REQUIRED');
    expect(listJobs).not.toHaveBeenCalled();
  });

  test('KEKA_SYNC_STATUS_MODE=all is the documented escape hatch and walks everyone', async () => {
    delete process.env.KEKA_INTERVIEW_ACTIVE_STATUSES;
    process.env.KEKA_SYNC_STATUS_MODE = 'all';
    // A candidate with no status at all — the case the fallback exists for.
    listCandidates.mockResolvedValue([{ id: 'cand-1', name: 'Asha Rao' }]);

    const response = await runKekaScheduleSyncWorker('test');

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.statusMode).toBe('all');
    expect(body.rowsWritten).toBe(1);
  });

  test('in filtered mode a candidate outside the vocabulary is never queried for interviews', async () => {
    listCandidates.mockResolvedValue([{ id: 'cand-1', name: 'Asha Rao', status: 'Rejected' }]);

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).candidatesActive).toBe(0);
    expect(listInterviews).not.toHaveBeenCalled();
  });
});

describe('One row per panelist per interview', () => {
  test('a two-person panel writes into both panelists own partitions', async () => {
    listInterviews.mockResolvedValue([kekaInterview({
      panel: [
        { interviewerId: 'p1', name: 'Alice', email: ALICE },
        { interviewerId: 'p2', name: 'Bob', email: BOB.toUpperCase() },
      ],
    })]);

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsWritten).toBe(2);
    // Bob's address arrived upper-cased from Keka; the partition must still be
    // the lowercased one his token will read.
    for (const email of [ALICE, BOB]) {
      expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
        TableName: 'test-admin',
        Key: expect.objectContaining({ PK: keys.schedPk(email) }),
      });
    }
  });

  test('a duplicated panel email writes one row, not two', async () => {
    listInterviews.mockResolvedValue([kekaInterview({
      panel: [
        { interviewerId: 'p1', name: 'Alice', email: ALICE },
        { interviewerId: 'p2', name: 'Alice again', email: ALICE },
      ],
    })]);

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsWritten).toBe(1);
  });

  test('fills a missing Keka meeting URL from the panelists Teams calendar', async () => {
    const scheduledAt = soonIso();
    listInterviews.mockResolvedValue([kekaInterview({ scheduledAt, meetingUrl: undefined })]);
    findMeetingLink.mockResolvedValue({
      meetingUrl: 'https://teams.microsoft.com/l/meetup-join/example',
      organizerEmail: 'organizer@minfytech.com',
    });

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsWritten).toBe(1);
    expect(findMeetingLink).toHaveBeenCalledWith({
      calendarEmail: ALICE,
      scheduledAt,
      candidateName: 'Asha Rao',
      candidateEmail: 'asha@example.com',
      jobTitle: 'Migration Architect',
    });
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: keys.schedPk(ALICE), SK: keys.schedSk(Date.parse(scheduledAt), 'int-1') },
      ExpressionAttributeValues: expect.objectContaining({
        ':meeting_url': 'https://teams.microsoft.com/l/meetup-join/example',
        ':organizer_email': 'organizer@minfytech.com',
      }),
    });
  });

  test('uses the Keka meeting URL without calling Teams calendar lookup', async () => {
    listInterviews.mockResolvedValue([kekaInterview({ meetingUrl: 'https://teams.microsoft.com/l/meetup-join/from-keka' })]);

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsWritten).toBe(1);
    expect(findMeetingLink).not.toHaveBeenCalled();
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      ExpressionAttributeValues: expect.objectContaining({
        ':meeting_url': 'https://teams.microsoft.com/l/meetup-join/from-keka',
      }),
    });
  });

  test('still indexes the interview when Teams calendar lookup has no safe match', async () => {
    findMeetingLink.mockRejectedValue(new Error('Multiple Teams meetings were found around this Keka interview time.'));

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsWritten).toBe(1);
    const writes = ddbMock.commandCalls(UpdateCommand)
      .map((call) => call.args[0].input as any)
      .filter((input) => String(input.Key?.PK || '').startsWith('SCHED#'));
    expect(writes[0].ExpressionAttributeValues[':meeting_url']).toBeUndefined();
  });

  test('a panel with no email cannot be indexed and is skipped', async () => {
    listInterviews.mockResolvedValue([kekaInterview({ panel: [{ interviewerId: 'p1', name: 'Unknown' }] })]);

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).interviewsIndexed).toBe(0);
  });

  test('interviews outside the default [-7d, +30d] window are not indexed', async () => {
    listInterviews.mockResolvedValue([
      kekaInterview({ id: 'old', scheduledAt: new Date(Date.now() - 60 * DAY_MS).toISOString() }),
      kekaInterview({ id: 'far', scheduledAt: new Date(Date.now() + 90 * DAY_MS).toISOString() }),
      kekaInterview({ id: 'unparseable', scheduledAt: 'not a date' }),
    ]);

    const response = await runKekaScheduleSyncWorker('test');

    const body = JSON.parse(response.body);
    expect(body.interviewsSeen).toBe(3);
    expect(body.interviewsIndexed).toBe(0);
  });
});

/**
 * The window is what decides whether a tenant's existing interviews are usable at
 * all. Defaulting to 7 days back means every round older than a week is invisible
 * to My Interviews — which is most of what a tenant has when the feature is first
 * switched on, and made the whole flow look broken rather than empty.
 */
describe('The sweep window is an operator lever', () => {
  afterEach(() => {
    delete process.env.KEKA_SYNC_LOOKBACK_DAYS;
    delete process.env.KEKA_SYNC_LOOKAHEAD_DAYS;
  });

  test('a wider lookback brings an already-completed round into the index', async () => {
    process.env.KEKA_SYNC_LOOKBACK_DAYS = '120';
    const scheduledAt = new Date(Date.now() - 60 * DAY_MS).toISOString();
    listInterviews.mockResolvedValue([kekaInterview({ id: 'last-month', scheduledAt })]);

    const response = await runKekaScheduleSyncWorker('test');

    const body = JSON.parse(response.body);
    expect(body.windowLookbackDays).toBe(120);
    expect(body.interviewsIndexed).toBe(1);
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: keys.schedPk(ALICE), SK: keys.schedSk(Date.parse(scheduledAt), 'last-month') },
    });
  });

  test('the reported window matches what was actually applied', async () => {
    // Reported back so "0 rows written" can be told apart from "nothing was in
    // range" without reading the worker source.
    process.env.KEKA_SYNC_LOOKBACK_DAYS = '45';
    process.env.KEKA_SYNC_LOOKAHEAD_DAYS = '10';

    const body = JSON.parse((await runKekaScheduleSyncWorker('test')).body);

    expect(body.windowLookbackDays).toBe(45);
    expect(body.windowLookaheadDays).toBe(10);
  });

  test('a lookahead narrower than the interview excludes it, proving the lever is real', async () => {
    process.env.KEKA_SYNC_LOOKAHEAD_DAYS = '1';
    listInterviews.mockResolvedValue([kekaInterview({ scheduledAt: soonIso() })]);

    const body = JSON.parse((await runKekaScheduleSyncWorker('test')).body);

    expect(body.interviewsSeen).toBe(1);
    expect(body.interviewsIndexed).toBe(0);
  });

  test.each([
    ['0', 7],
    ['-5', 7],
    ['not-a-number', 7],
    ['', 7],
    ['5000', 730],
  ])('a lookback of %s resolves to %s days', async (value, expected) => {
    // Zero or garbage must not hide an interview that started an hour ago, and an
    // unbounded value must not index years of history into every partition.
    process.env.KEKA_SYNC_LOOKBACK_DAYS = value;

    const body = JSON.parse((await runKekaScheduleSyncWorker('test')).body);

    expect(body.windowLookbackDays).toBe(expected);
  });
});

describe('An unindexable panel is counted, not silently dropped', () => {
  test('an in-window interview with no panel email is reported', async () => {
    // The only signal that would explain an empty My Interviews page when the
    // sweep otherwise reports success.
    listInterviews.mockResolvedValue([kekaInterview({ panel: [{ interviewerId: 'p1', name: 'No Email' }] })]);

    const body = JSON.parse((await runKekaScheduleSyncWorker('test')).body);

    expect(body.interviewsWithoutPanelEmail).toBe(1);
    expect(body.interviewsIndexed).toBe(0);
  });

  test('a fully indexed run reports none', async () => {
    const body = JSON.parse((await runKekaScheduleSyncWorker('test')).body);

    expect(body.interviewsWithoutPanelEmail).toBe(0);
    expect(body.rowsWritten).toBe(1);
  });
});

describe('Rows that vanish from Keka are cancelled, never deleted', () => {
  test('an in-window row the sweep did not see is stamped cancelled_at', async () => {
    const scheduledAt = Date.now() + 2 * DAY_MS;
    mockQueries({
      windowRows: [{
        PK: keys.schedPk(ALICE),
        SK: keys.schedSk(scheduledAt, 'int-gone'),
        keka_interview_id: 'int-gone',
        scheduled_at: scheduledAt,
        last_seen_sync_id: 'a-previous-run',
      }],
    });

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsCancelled).toBe(1);
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: keys.schedPk(ALICE), SK: keys.schedSk(scheduledAt, 'int-gone') },
      UpdateExpression: 'SET cancelled_at = :cancelled_at, synced_at = :synced_at',
    });
    // The interviewer's page must never have a row disappear underneath it.
    expect(ddbMock).not.toHaveReceivedCommand(DeleteCommand);
  });

  test('a row that merely aged out of the window is left alone', async () => {
    // Defensive path: the index entry matched but scheduled_at is older than the
    // window, so this sweep never looked the interview up and cannot judge it.
    const scheduledAt = Date.now() - 60 * DAY_MS;
    mockQueries({
      windowRows: [{
        PK: keys.schedPk(ALICE),
        SK: keys.schedSk(scheduledAt, 'int-completed'),
        keka_interview_id: 'int-completed',
        scheduled_at: scheduledAt,
        last_seen_sync_id: 'a-previous-run',
      }],
    });

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsCancelled).toBe(0);
  });

  test('an already-cancelled row is not re-stamped', async () => {
    const scheduledAt = Date.now() + 2 * DAY_MS;
    mockQueries({
      windowRows: [{
        PK: keys.schedPk(ALICE),
        SK: keys.schedSk(scheduledAt, 'int-gone'),
        scheduled_at: scheduledAt,
        cancelled_at: Date.now() - 1000,
        last_seen_sync_id: 'a-previous-run',
      }],
    });

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsCancelled).toBe(0);
  });

  test('a row this run touched carries the run id and survives', async () => {
    // The sweep stamps last_seen_sync_id on every row it writes; reflect the
    // in-flight run id back on the window row to prove the skip works.
    let runId: string | undefined;
    ddbMock.on(UpdateCommand).callsFake((input) => {
      const seen = input.ExpressionAttributeValues?.[':last_seen_sync_id'];
      if (seen) runId = String(seen);
      return {};
    });
    ddbMock.on(QueryCommand).callsFake((input) => (
      input.IndexName === 'GSI1_OrgRecency'
        ? {
          Items: [{
            PK: keys.schedPk(ALICE),
            SK: 'x',
            scheduled_at: Date.now() + 2 * DAY_MS,
            last_seen_sync_id: runId,
          }],
        }
        : { Items: [] }
    ));

    const response = await runKekaScheduleSyncWorker('test');

    expect(runId).toBeTruthy();
    expect(JSON.parse(response.body).rowsCancelled).toBe(0);
  });
});

describe('A rescheduled interview does not become a second round', () => {
  test('provisioning identity moves to the new row and the stale row is deleted', async () => {
    const newScheduledAt = Date.parse(soonIso());
    const staleSk = keys.schedSk(newScheduledAt - 2 * DAY_MS, 'int-1');
    listInterviews.mockResolvedValue([kekaInterview({ scheduledAt: new Date(newScheduledAt).toISOString() })]);
    mockQueries({
      partitionRows: [{
        PK: keys.schedPk(ALICE),
        SK: staleSk,
        keka_interview_id: 'int-1',
        scheduled_at: newScheduledAt - 2 * DAY_MS,
        intelligence_id: 'intel-already-open',
        workspace_id: 'ws-1',
        provisioned_at: 1,
        provisioned_by: 'user-alice',
      }],
    });

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsSuperseded).toBe(1);
    // The new row inherits the round, so opening it returns the existing one.
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: keys.schedPk(ALICE), SK: keys.schedSk(newScheduledAt, 'int-1') },
      ExpressionAttributeValues: expect.objectContaining({
        ':intelligence_id': 'intel-already-open',
        ':workspace_id': 'ws-1',
      }),
    });
    // The stale row is removed rather than cancelled — it is the same round at a
    // stale time, and leaving it would show a phantom cancelled twin.
    expect(ddbMock).toHaveReceivedCommandWith(DeleteCommand, {
      Key: { PK: keys.schedPk(ALICE), SK: staleSk },
    });
  });

  test('an unprovisioned stale row is cleaned up without inventing an identity', async () => {
    const newScheduledAt = Date.parse(soonIso());
    listInterviews.mockResolvedValue([kekaInterview({ scheduledAt: new Date(newScheduledAt).toISOString() })]);
    mockQueries({
      partitionRows: [{
        PK: keys.schedPk(ALICE),
        SK: keys.schedSk(newScheduledAt - DAY_MS, 'int-1'),
        keka_interview_id: 'int-1',
        scheduled_at: newScheduledAt - DAY_MS,
      }],
    });

    await runKekaScheduleSyncWorker('test');

    const writes = ddbMock.commandCalls(UpdateCommand)
      .map((call) => call.args[0].input as any)
      .filter((input) => String(input.Key?.PK || '').startsWith('SCHED#'));
    expect(writes).toHaveLength(1);
    expect(writes[0].ExpressionAttributeValues[':intelligence_id']).toBeUndefined();
  });

  test('an active open lease defers the reschedule and keeps its leased row until finalization', async () => {
    const newScheduledAt = Date.parse(soonIso());
    const staleSk = keys.schedSk(newScheduledAt - DAY_MS, 'int-1');
    listInterviews.mockResolvedValue([kekaInterview({ scheduledAt: new Date(newScheduledAt).toISOString() })]);
    mockQueries({
      partitionRows: [{
        PK: keys.schedPk(ALICE),
        SK: staleSk,
        keka_interview_id: 'int-1',
        scheduled_at: newScheduledAt - DAY_MS,
        provisioning_token: 'open-token',
        provisioning_expires_at: Date.now() + MINUTE_MS,
        provisioning_by: 'user-alice',
        provisioning_intelligence_id: 'intel-in-flight',
      }],
    });

    const response = await runKekaScheduleSyncWorker('test');

    expect(JSON.parse(response.body).rowsSuperseded).toBe(0);
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: keys.schedPk(ALICE), SK: staleSk },
      UpdateExpression: 'SET last_seen_sync_id = :run, synced_at = :now',
      ExpressionAttributeValues: expect.objectContaining({
        ':token': 'open-token',
      }),
    });
    expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
      ExpressionAttributeValues: { ':pk': keys.schedPk(ALICE) },
      ConsistentRead: true,
    });
    expect(ddbMock).not.toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: keys.schedPk(ALICE), SK: keys.schedSk(newScheduledAt, 'int-1') },
    });
    expect(ddbMock).not.toHaveReceivedCommandWith(DeleteCommand, {
      Key: { PK: keys.schedPk(ALICE), SK: staleSk },
    });
  });
});

describe('An interrupted sweep resumes from its checkpoint', () => {
  test('jobs before cursor_job_index are not walked again', async () => {
    listJobs.mockResolvedValue([
      { id: 'job-1', title: 'Done already' },
      { id: 'job-2', title: 'Migration Architect' },
    ]);
    ddbMock.on(GetCommand).resolves({
      Item: { PK: keys.syncPk('keka'), SK: 'STATE', cursor_job_index: 1, sync_run_id: 'run-abc', started_at: 1 },
    });

    const response = await runKekaScheduleSyncWorker('test');

    expect(listCandidates).toHaveBeenCalledTimes(1);
    expect(listCandidates).toHaveBeenCalledWith('job-2');
    expect(JSON.parse(response.body).jobsProcessed).toBe(1);
  });

  test('the run id is reused while resuming, so mid-run rows are not treated as vanished', async () => {
    listJobs.mockResolvedValue([{ id: 'job-1', title: 'A' }, { id: 'job-2', title: 'B' }]);
    ddbMock.on(GetCommand).resolves({
      Item: { PK: keys.syncPk('keka'), SK: 'STATE', cursor_job_index: 1, sync_run_id: 'run-abc', started_at: 1 },
    });

    await runKekaScheduleSyncWorker('test');

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      ExpressionAttributeValues: expect.objectContaining({ ':last_seen_sync_id': 'run-abc' }),
    });
  });

  test('a completed sweep clears the cursor so the next run starts clean', async () => {
    await runKekaScheduleSyncWorker('test');

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: keys.syncPk('keka'), SK: 'STATE' },
      ExpressionAttributeValues: expect.objectContaining({ ':cursor_job_index': 0, ':sync_run_id': '' }),
    });
  });

  test('a Keka failure records the error and keeps the cursor for the retry', async () => {
    listCandidates.mockRejectedValue(new Error('Keka rate limited the sweep.'));

    await expect(runKekaScheduleSyncWorker('test')).rejects.toThrow('Keka rate limited');

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      Key: { PK: keys.syncPk('keka'), SK: 'STATE' },
      UpdateExpression: expect.stringContaining('REMOVE #lease_owner, #lease_expires_at'),
      ConditionExpression: '#lease_owner = :lease_owner',
      ExpressionAttributeValues: expect.objectContaining({ ':last_error': 'Keka rate limited the sweep.' }),
    });
  });
});

describe('The sweep owns a bounded DynamoDB lease', () => {
  test('acquires the state item conditionally for longer than the Lambda maximum runtime', async () => {
    const before = Date.now();

    await runKekaScheduleSyncWorker('eventbridge');

    const acquisition = ddbMock.commandCalls(UpdateCommand)
      .map((call) => call.args[0].input as any)
      .find((input) => input.ConditionExpression?.includes('attribute_not_exists(#lease_expires_at)'));
    expect(acquisition).toEqual(expect.objectContaining({
      TableName: 'test-admin',
      Key: { PK: keys.syncPk('keka'), SK: 'STATE' },
      ConditionExpression: 'attribute_not_exists(#lease_expires_at) OR #lease_expires_at < :lease_now',
      ExpressionAttributeNames: expect.objectContaining({
        '#lease_owner': 'lease_owner',
        '#lease_expires_at': 'lease_expires_at',
      }),
    }));
    expect(acquisition.ExpressionAttributeValues[':lease_owner']).toEqual(expect.any(String));
    expect(acquisition.ExpressionAttributeValues[':lease_expires_at'] - before).toBeGreaterThan(15 * MINUTE_MS);
    expect(acquisition.ExpressionAttributeValues[':lease_expires_at'] - before).toBeLessThanOrEqual(17 * MINUTE_MS);
  });

  test('skips a concurrent invocation before Keka calls or the cancellation scan', async () => {
    ddbMock.on(UpdateCommand).rejects(Object.assign(
      new Error('The conditional request failed'),
      { name: 'ConditionalCheckFailedException' },
    ));

    const response = await runKekaScheduleSyncWorker('eventbridge');

    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ status: 'SKIPPED', reason: 'LEASE_HELD' });
    expect(listJobs).not.toHaveBeenCalled();
    expect(ddbMock).not.toHaveReceivedCommand(GetCommand);
    expect(ddbMock).not.toHaveReceivedCommand(QueryCommand);
    expect(ddbMock.commandCalls(UpdateCommand)).toHaveLength(1);
  });

  test('takes over an expired lease while preserving the prior checkpoint and run id', async () => {
    listJobs.mockResolvedValue([
      { id: 'job-1', title: 'Done already' },
      { id: 'job-2', title: 'Resume here' },
    ]);
    ddbMock.on(GetCommand).resolves({
      Item: {
        PK: keys.syncPk('keka'),
        SK: 'STATE',
        cursor_job_index: 1,
        sync_run_id: 'run-before-timeout',
        started_at: 1,
        lease_owner: 'expired-owner',
        lease_expires_at: Date.now() - 1,
      },
    });

    await runKekaScheduleSyncWorker('eventbridge');

    expect(listCandidates).toHaveBeenCalledTimes(1);
    expect(listCandidates).toHaveBeenCalledWith('job-2');
    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      ExpressionAttributeValues: expect.objectContaining({ ':last_seen_sync_id': 'run-before-timeout' }),
    });
  });

  test('all state changes require ownership and successful completion releases the lease', async () => {
    await runKekaScheduleSyncWorker('test');

    const stateUpdates = ddbMock.commandCalls(UpdateCommand)
      .map((call) => call.args[0].input as any)
      .filter((input) => input.Key?.PK === keys.syncPk('keka'));
    const acquisition = stateUpdates.shift();
    expect(acquisition.ConditionExpression).toContain('attribute_not_exists(#lease_expires_at)');
    expect(stateUpdates.length).toBeGreaterThan(0);
    for (const update of stateUpdates) {
      expect(update.ConditionExpression).toBe('#lease_owner = :lease_owner');
      expect(update.ExpressionAttributeValues[':lease_owner']).toEqual(expect.any(String));
    }
    expect(stateUpdates.at(-1)?.UpdateExpression).toContain('REMOVE #lease_owner, #lease_expires_at');
  });
});
