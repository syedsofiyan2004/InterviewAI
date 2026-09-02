import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient } from '../lambdas/shared/aws';
import { ApplyMomEditSchema, chatThreadId, parseThreadId, ReviseCalculationSchema } from '../schema/chat';
import { loadThread, listThreadSummaries, markProposalApplied, RETENTION_DAYS } from '../lambdas/chat/store';

/**
 * The reading half of the chat store, plus the one attribute the API handler writes.
 *
 * A thread is listable only because its identity is entirely inside the partition key —
 * there is no GSI and no stored `app`/`owner` attribute. That makes `parseThreadId` the
 * load-bearing piece: if it ever disagrees with `chatThreadId`, the conversations list
 * silently attributes threads to the wrong owner or drops them, and neither failure
 * looks like an error. So the round trip is asserted directly, including the ids that
 * would break a naive `split('#')`.
 *
 * `markProposalApplied` is covered here rather than beside the routes that call it
 * because every way it can go wrong is a property of the DynamoDB call itself: an
 * unconditioned update forges a turn, a thrown error tells a user their applied change
 * failed, and a seconds timestamp dates the marker to 1970. None of those show up as a
 * failure at the route.
 */

const ddbMock = mockClient(ddbDocClient);

beforeEach(() => ddbMock.reset());
afterEach(() => jest.restoreAllMocks());

function turn(overrides: Record<string, unknown>) {
  return { thread_id: 'mom#m-1#u-1', seq: 1, role: 'user', content: 'hello', created_at: 1_000, ...overrides };
}

describe('parseThreadId round-trips chatThreadId', () => {
  test.each([
    ['calculator', 'c-1', 'u-1'],
    ['mom', 'm-1', 'u-1'],
    ['interview', 'i-1', 'user@example.com'],
    ['intelligence', '2f1b8c4e-0000-4aaa-bbbb-ccccddddeeee', 'a1b2c3d4-e5f6'],
  ] as const)('%s / %s / %s', (app, entityId, userId) => {
    expect(parseThreadId(chatThreadId(app, entityId, userId))).toEqual({ app, entityId, userId });
  });

  test('an entity id containing a separator still round-trips', () => {
    // Split at the first and last '#' rather than on every one: entity ids are
    // repo-generated today, but a composite id would silently reassign ownership.
    const id = chatThreadId('mom', 'PROJECT#p-9', 'u-7');
    expect(parseThreadId(id)).toEqual({ app: 'mom', entityId: 'PROJECT#p-9', userId: 'u-7' });
  });

  test.each([
    ['an unknown app', 'chatbot#e-1#u-1'],
    ['no separator at all', 'mom'],
    ['only one separator', 'mom#m-1'],
    ['a leading separator', '#m-1#u-1'],
    ['a trailing separator, leaving no owner', 'mom#m-1#'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, id) => {
    // A scan reads whatever is in the table, including rows a future version of the
    // writer might add, so an unparseable id is dropped rather than guessed at.
    expect(parseThreadId(id)).toBeNull();
  });
});

describe('loadThread', () => {
  test('returns every turn, following LastEvaluatedKey past the 1MB page', async () => {
    ddbMock.on(QueryCommand)
      .resolvesOnce({ Items: [turn({ seq: 1 }), turn({ seq: 2 })], LastEvaluatedKey: { thread_id: 'mom#m-1#u-1', seq: 2 } })
      .resolvesOnce({ Items: [turn({ seq: 3 })] });

    const turns = await loadThread('mom#m-1#u-1');

    expect(turns.map((t) => t.seq)).toEqual([1, 2, 3]);
    expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 2);
  });

  test('queries forwards, so a long thread reads oldest-first rather than newest-first', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    await loadThread('mom#m-1#u-1');

    // loadRecentTurns deliberately queries backwards to get the model's window. A
    // transcript must not inherit that: reversed output would read bottom-up, and a
    // Limit would show the *first* turns of a long thread while claiming to be whole.
    const [call] = ddbMock.commandCalls(QueryCommand);
    expect(call.args[0].input.ScanIndexForward).toBeUndefined();
    expect(call.args[0].input.Limit).toBeUndefined();
  });
});

describe('listThreadSummaries', () => {
  test('projects role through an expression name, since role is reserved', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [] });

    await listThreadSummaries();

    expect(ddbMock).toHaveReceivedCommandWith(ScanCommand, {
      TableName: 'test-chat',
      ProjectionExpression: expect.stringContaining('#role'),
      ExpressionAttributeNames: { '#role': 'role' },
    });
  });

  test('reduces scanned turns to one summary per thread, newest activity first', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        // Deliberately out of order and interleaved: a scan returns neither.
        turn({ thread_id: 'mom#m-1#u-1', seq: 2, role: 'assistant', content: 'sure', created_at: 2_000 }),
        turn({ thread_id: 'calculator#c-9#u-2', seq: 1, content: 'make the web tier cheaper', created_at: 50_000 }),
        turn({ thread_id: 'mom#m-1#u-1', seq: 1, content: 'drop the internal risks', created_at: 1_000 }),
        turn({
          thread_id: 'calculator#c-9#u-2', seq: 2, role: 'assistant', content: 'proposed',
          created_at: 60_000, proposal: { kind: 'estimate_change', summary: 's', instruction: 'i', resource_edits: [] },
          applied_at: 61_000,
        }),
      ],
    });

    const summaries = await listThreadSummaries();

    expect(summaries.map((s) => s.threadId)).toEqual(['calculator#c-9#u-2', 'mom#m-1#u-1']);
    expect(summaries[0]).toMatchObject({
      turnCount: 2,
      preview: 'make the web tier cheaper',
      firstTurnAt: 50_000,
      lastTurnAt: 60_000,
      hasProposal: true,
      hasApplied: true,
    });
    expect(summaries[1]).toMatchObject({
      turnCount: 2,
      preview: 'drop the internal risks',
      firstTurnAt: 1_000,
      lastTurnAt: 2_000,
      hasProposal: false,
      hasApplied: false,
    });
  });

  test('takes the preview from seq 1, not from whichever user turn is scanned first', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        turn({ seq: 3, content: 'and for staging too', created_at: 3_000 }),
        turn({ seq: 1, content: 'the opening question', created_at: 1_000 }),
      ],
    });

    const [summary] = await listThreadSummaries();

    expect(summary.preview).toBe('the opening question');
  });

  test('elides a long opening question rather than shipping the whole turn', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [turn({ seq: 1, content: 'x'.repeat(400) })] });

    const [summary] = await listThreadSummaries();

    // The list is a scannable index, not a bulk export of what was said.
    expect(summary.preview.length).toBeLessThan(400);
    expect(summary.preview.endsWith('…')).toBe(true);
  });

  test('collapses whitespace so a pasted multi-line question stays one row', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [turn({ seq: 1, content: '  first line\n\n  second line  ' })] });

    const [summary] = await listThreadSummaries();

    expect(summary.preview).toBe('first line second line');
  });

  test('a turn with no created_at does not date the thread to 1970', async () => {
    ddbMock.on(ScanCommand).resolves({
      Items: [
        turn({ seq: 1, created_at: undefined }),
        turn({ seq: 2, role: 'assistant', created_at: 5_000 }),
      ],
    });

    const [summary] = await listThreadSummaries();

    expect(summary.firstTurnAt).toBe(5_000);
    expect(summary.lastTurnAt).toBe(5_000);
  });

  test('follows LastEvaluatedKey, so the list is not silently truncated at one page', async () => {
    ddbMock.on(ScanCommand)
      .resolvesOnce({ Items: [turn({ thread_id: 'mom#m-1#u-1' })], LastEvaluatedKey: { thread_id: 'mom#m-1#u-1', seq: 1 } })
      .resolvesOnce({ Items: [turn({ thread_id: 'mom#m-2#u-1' })] });

    const summaries = await listThreadSummaries();

    expect(summaries).toHaveLength(2);
    expect(ddbMock).toHaveReceivedCommandTimes(ScanCommand, 2);
  });
});

describe('markProposalApplied', () => {
  const thread = chatThreadId('calculator', 'c-9', 'u-2');

  function lastUpdate() {
    const [call] = ddbMock.commandCalls(UpdateCommand);
    return call.args[0].input;
  }

  test('guards the update with attribute_exists(seq), so a wrong seq cannot forge a turn', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await markProposalApplied(thread, 4);

    // The one assertion in this file that must not be deletable without a red test.
    // UpdateItem is an upsert: unconditioned, a stale seq from a reloaded tab would
    // CREATE a row holding only thread_id, seq and applied_at. listThreadSummaries scans
    // the table and counts every row as a turn, so that phantom inflates the thread's
    // turn count on the oversight list — and at seq 1 it also blanks the preview, because
    // the preview comes from seq 1 and a forged row has no content.
    expect(lastUpdate().ConditionExpression).toBe('attribute_exists(seq)');
  });

  test('addresses one stored turn by its full key and sets only applied_at', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    await markProposalApplied(thread, 4);

    expect(ddbMock).toHaveReceivedCommandWith(UpdateCommand, {
      TableName: 'test-chat',
      // Both halves of the key, and the thread half carries the owner. That is the whole
      // authorisation story for this write: a caller can only name a thread id built from
      // their own sub, so there is no reachable key belonging to someone else.
      Key: { thread_id: thread, seq: 4 },
      UpdateExpression: 'SET applied_at = :now',
    });
    // Applying a proposal is not a reason to extend retention. If the TTL were touched
    // here, a thread would outlive the window the conversations page advertises.
    expect(lastUpdate().UpdateExpression).not.toContain('expires_at');
  });

  test('stamps applied_at in milliseconds, like created_at', async () => {
    ddbMock.on(UpdateCommand).resolves({});

    const before = Date.now();
    await markProposalApplied(thread, 4);
    const after = Date.now();

    // expires_at is the one attribute on a turn measured in seconds. A seconds value here
    // is roughly 1e9 against a Date.now() of roughly 1e12, so it falls far below `before`
    // and fails this range — which is the point: the transcript formats applied_at as a
    // ms timestamp and would otherwise render every applied badge as January 1970.
    const now = lastUpdate().ExpressionAttributeValues?.[':now'];
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  test('a seq that matches no stored turn resolves quietly rather than rejecting', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('The conditional request failed'), {
      name: 'ConditionalCheckFailedException',
    }));

    await expect(markProposalApplied(thread, 99)).resolves.toBeUndefined();

    // The condition failing means the seq did not match a turn — a stale client or a
    // thread whose turns have aged out of the TTL window. Not an incident, so it does not
    // get logged as one; a log line per stale tab would bury the real failures. Asserting
    // the send happened keeps this from passing for the wrong reason, i.e. a mock that
    // never rejected at all.
    expect(ddbMock).toHaveReceivedCommandTimes(UpdateCommand, 1);
    expect(errors).not.toHaveBeenCalled();
  });

  test('an unexpected DynamoDB failure is logged but still resolves', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(UpdateCommand).rejects(Object.assign(new Error('rate exceeded'), {
      name: 'ProvisionedThroughputExceededException',
    }));

    await expect(markProposalApplied(thread, 4)).resolves.toBeUndefined();
    expect(errors).toHaveBeenCalled();
  });

  test('never throws, whatever comes back — the artifact is already rewritten', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    ddbMock.on(UpdateCommand).rejects(new Error('boom'));

    // Both callers run this after the estimate row is written or the minutes are saved.
    // Propagating would return an error for a request that succeeded, and the user would
    // apply the same change a second time.
    await expect(markProposalApplied(thread, 4)).resolves.toBeUndefined();
  });
});

describe('chat_seq on the two apply bodies', () => {
  test.each([
    ['an estimate revision', () => ReviseCalculationSchema.parse({ instruction: 'make the web tier cheaper' })],
    ['a minutes edit', () => ApplyMomEditSchema.parse({ patch: {} })],
  ])('%s without chat_seq still parses', (_label, parse) => {
    // A bundle cached before this field existed keeps calling these routes without it,
    // and a turn restored from a stream that dropped before `done` has no seq to send.
    // Either failing validation would break applying a change to mark a transcript row.
    expect(parse().chat_seq).toBeUndefined();
  });

  test.each([
    ['zero, which is below the first turn', 0],
    ['a negative', -1],
    ['a fraction', 1.5],
  ])('rejects %s', (_label, seq) => {
    // seq is a turn number starting at 1, and it goes straight into a DynamoDB sort key,
    // so a value that cannot be a turn is rejected at the boundary rather than becoming a
    // silent no-op update later.
    //
    // Zero is the one a caller can actually hit: the chat Lambda emits `done` with
    // `seq: 0` when it streamed an answer but could not persist the turn (chat/index.ts).
    // A client must send no chat_seq at all in that case — forwarding the 0 fails the
    // whole apply on validation, which is a far worse outcome than a missing badge.
    expect(ReviseCalculationSchema.safeParse({ instruction: 'x', chat_seq: seq }).success).toBe(false);
    expect(ApplyMomEditSchema.safeParse({ patch: {}, chat_seq: seq }).success).toBe(false);
  });
});

describe('retention', () => {
  test('the advertised window matches the TTL the writer stamps', () => {
    // The conversations page states this number to explain why the list stops where it
    // does. If it drifts from TTL_DAYS the page confidently misreports the window.
    expect(RETENTION_DAYS).toBe(30);
  });
});
