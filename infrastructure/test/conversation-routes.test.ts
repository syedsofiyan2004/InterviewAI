import { mockClient } from 'aws-sdk-client-mock';
import 'aws-sdk-client-mock-jest';
import { BatchGetCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEvent } from 'aws-lambda';

import { ddbDocClient, s3Client } from '../lambdas/shared/aws';
import { requireAdminTier, type CallerContext } from '../lambdas/api-handler/authz';
import {
  adminGetConversationThread,
  adminListConversations,
  getChatHistory,
} from '../lambdas/api-handler/conversation-routes';
import { handler } from '../lambdas/api-handler/index';
import { ChatThreadSchema, ConversationListResponseSchema, chatThreadId } from '../schema/chat';
import type { AdminTier } from '../schema/admin';

/**
 * The three conversation-oversight routes, and the two rules that separate them.
 *
 * The first rule is the tier gate. `/admin/conversations` and `/admin/conversations/thread`
 * read *other people's* transcripts — model output discussing named candidates — so both
 * sit behind REVIEWER and both write an audit row. The gate is asserted per route rather
 * than sampled, for the reason set out in handler-guards.test.ts: a route that forgets its
 * gate is a privilege hole, and a sampled suite is exactly the suite that would not notice.
 *
 * The second rule is that `/chat/history` needs no gate at all, because it takes no
 * `user_id`: the thread id is built from the Cognito-verified `sub`. The tests below assert
 * that property the only way it can be asserted — by trying to influence the id from the
 * request and finding that nothing in the request reaches it.
 *
 * Handlers are called directly where a direct call shows the behaviour, and through
 * `handler` where the behaviour *is* the top-level catch turning a throw into a 500.
 */

const ddbMock = mockClient(ddbDocClient);
const s3Mock = mockClient(s3Client);

const ADMIN_TABLE = 'test-admin';
const CHAT_TABLE = 'test-chat';
const CALCULATOR_TABLE = 'test-calculations';
const INTELLIGENCE_TABLE = 'test-intelligence';
const INTERVIEWS_TABLE = 'test-interviews';

const ADMIN_ID = 'admin-1';
const ADMIN_EMAIL = 'reviewer@minfytech.com';
const OWNER_ID = 'owner-7';
const CALC_ID = 'calc-9';

/** The tiers that clear REVIEWER. Every one of them is exercised on every admin route. */
const ALLOWED_TIERS: AdminTier[] = ['REVIEWER', 'APPROVER', 'OWNER'];

interface Stubs {
  /** The caller's live grant. `null` is an ADMIN whose grant was revoked. */
  tier?: AdminTier | null;
  baseRole?: 'MEMBER' | 'ADMIN';
  /** What each artifact table hands back from a GetItem, keyed by table name. */
  items?: Record<string, Record<string, unknown>>;
  /** What each artifact table hands back from a BatchGetItem, keyed by table name. */
  batch?: Record<string, Record<string, unknown>[]>;
  /** Stored turns for the thread being read. */
  turns?: Record<string, unknown>[];
  /** Rows the chat-table scan returns, i.e. turns across every thread. */
  scan?: Record<string, unknown>[];
}

/**
 * One registration per command, because these routes use each command against more than
 * one table and a per-table stub would be silently consumed by the wrong caller.
 *
 * GetCommand serves both the caller's membership row and the single-artifact read;
 * QueryCommand serves both `getActiveTier` on the admin table and `loadThread` on the chat
 * table. Both dispatch on TableName rather than on call order, so adding a read to a route
 * cannot make an unrelated test pass for the wrong reason.
 */
function stub({
  tier = 'REVIEWER',
  baseRole = 'ADMIN',
  items = {},
  batch = {},
  turns = [],
  scan = [],
}: Stubs = {}) {
  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.TableName === ADMIN_TABLE) {
      return String(input.Key?.SK || '').startsWith('MEMBER#') ? { Item: { base_role: baseRole } } : {};
    }
    const item = items[input.TableName as string];
    return item ? { Item: item } : {};
  });
  ddbMock.on(QueryCommand).callsFake((input) => (
    input.TableName === CHAT_TABLE ? { Items: turns } : { Items: tier ? [{ tier }] : [] }
  ));
  ddbMock.on(ScanCommand).resolves({ Items: scan });
  ddbMock.on(BatchGetCommand).callsFake((input) => {
    const [table] = Object.keys(input.RequestItems || {});
    return { Responses: { [table]: batch[table] || [] } };
  });
  ddbMock.on(PutCommand).resolves({});
}

function event(overrides: {
  userId?: string | null;
  email?: string;
  query?: Record<string, string> | null;
  resource?: string;
} = {}): APIGatewayProxyEvent {
  const {
    userId = ADMIN_ID,
    email = ADMIN_EMAIL,
    query = null,
    resource = '/admin/conversations',
  } = overrides;
  return {
    httpMethod: 'GET',
    resource,
    pathParameters: {},
    queryStringParameters: query,
    requestContext: { authorizer: { claims: userId ? { sub: userId, email } : {} } },
  } as unknown as APIGatewayProxyEvent;
}

/** A stored turn, in the shape the chat table holds. */
function turn(overrides: Record<string, unknown> = {}) {
  return {
    thread_id: chatThreadId('calculator', CALC_ID, OWNER_ID),
    seq: 1,
    role: 'user',
    content: 'why is the web tier so expensive',
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

/** The query parameters the admin thread route needs to name a conversation. */
const THREAD_QUERY = { app: 'calculator', entity_id: CALC_ID, user_id: OWNER_ID };

const body = (response: { body: string }) => JSON.parse(response.body);

/** Every audit row written during a test. */
const auditRows = () => ddbMock
  .commandCalls(PutCommand)
  .map((call) => call.args[0].input.Item as Record<string, unknown>)
  .filter((item) => item?.entity_type === 'AUDIT_LOG');

beforeEach(() => {
  ddbMock.reset();
  s3Mock.reset();
  jest.spyOn(console, 'error').mockImplementation(() => undefined);
  jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe('requireAdminTier: a non-null return means DENIED', () => {
  const caller = (tier: AdminTier | null): CallerContext => ({
    userId: ADMIN_ID, email: ADMIN_EMAIL, baseRole: 'ADMIN', tier,
  });

  test('a VIEWER asked for REVIEWER gets a response object back, not null', () => {
    // Pinned here so the gate tests below cannot be misread. `if (denied) return denied`
    // is the whole check in both routes, and a reader who assumed the truthy value meant
    // "allowed" would write a suite that passes with the gate inverted.
    const denied = requireAdminTier(caller('VIEWER'), 'REVIEWER');
    expect(denied).not.toBeNull();
    expect(denied!.statusCode).toBe(403);
  });

  test('a REVIEWER asked for REVIEWER gets null', () => {
    expect(requireAdminTier(caller('REVIEWER'), 'REVIEWER')).toBeNull();
  });
});

describe('GET /admin/conversations — the tier gate, on this route specifically', () => {
  test('a VIEWER-tier admin is refused', async () => {
    stub({ tier: 'VIEWER', scan: [turn()] });

    const response = await adminListConversations(event());

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('Requires REVIEWER tier');
    // VIEWER is the tier for counting records. Reading who talked to an assistant about
    // which candidate is a step past that, so nothing may be read on the way to the 403 —
    // not the thread list, not the titles.
    expect(ddbMock).not.toHaveReceivedCommand(ScanCommand);
    expect(ddbMock).not.toHaveReceivedCommand(BatchGetCommand);
    expect(auditRows()).toHaveLength(0);
  });

  test.each(ALLOWED_TIERS)('a %s-tier admin is allowed', async (tier) => {
    stub({
      tier,
      scan: [turn()],
      batch: { [CALCULATOR_TABLE]: [{ calculation_id: CALC_ID, name: 'Template Project' }] },
    });

    const response = await adminListConversations(event());

    expect(response.statusCode).toBe(200);
    expect(body(response).threads).toHaveLength(1);
  });

  test.each([
    ['a plain member, with no admin grant at all', { baseRole: 'MEMBER' as const, tier: null }, 'Admin access required'],
    ['an ADMIN whose grant has been revoked', { baseRole: 'ADMIN' as const, tier: null }, 'No admin grant'],
  ])('%s is refused', async (_label, caller, message) => {
    // The "no default viewer" rule: base_role ADMIN on its own grants nothing.
    stub({ ...caller, scan: [turn()] });

    const response = await adminListConversations(event());

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain(message);
  });

  test('an unauthenticated caller gets 401, not 403', async () => {
    stub();

    const response = await adminListConversations(event({ userId: null }));

    expect(response.statusCode).toBe(401);
  });
});

describe('GET /admin/conversations/thread — the same gate, asserted again', () => {
  test('a VIEWER-tier admin is refused', async () => {
    stub({ tier: 'VIEWER', turns: [turn()] });

    const response = await adminGetConversationThread(event({ query: THREAD_QUERY }));

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain('Requires REVIEWER tier');
    // The turns themselves are never loaded. This route returns whole transcripts, so a
    // gate that ran after the read would have already pulled them into memory beside a 403.
    expect(ddbMock).not.toHaveReceivedCommandWith(QueryCommand, { TableName: CHAT_TABLE });
    expect(auditRows()).toHaveLength(0);
  });

  test.each(ALLOWED_TIERS)('a %s-tier admin is allowed', async (tier) => {
    stub({
      tier,
      turns: [turn()],
      items: { [CALCULATOR_TABLE]: { calculation_id: CALC_ID, name: 'Template Project', owner_user_id: OWNER_ID } },
    });

    const response = await adminGetConversationThread(event({ query: THREAD_QUERY }));

    expect(response.statusCode).toBe(200);
    expect(ChatThreadSchema.safeParse(body(response)).success).toBe(true);
  });

  test.each([
    ['a plain member, with no admin grant at all', { baseRole: 'MEMBER' as const, tier: null }, 'Admin access required'],
    ['an ADMIN whose grant has been revoked', { baseRole: 'ADMIN' as const, tier: null }, 'No admin grant'],
  ])('%s is refused', async (_label, caller, message) => {
    stub({ ...caller, turns: [turn()] });

    const response = await adminGetConversationThread(event({ query: THREAD_QUERY }));

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain(message);
  });

  test('an unauthenticated caller gets 401, not 403', async () => {
    stub();

    const response = await adminGetConversationThread(event({ userId: null, query: THREAD_QUERY }));

    expect(response.statusCode).toBe(401);
  });

  test.each([
    ['an app the platform does not have', { app: 'chatbot', entity_id: CALC_ID, user_id: OWNER_ID }],
    ['no entity id', { app: 'calculator', user_id: OWNER_ID }],
    ['no owner id, which would otherwise build a half-formed thread key', { app: 'calculator', entity_id: CALC_ID }],
  ])('%s is a 400 before any thread is read', async (_label, query) => {
    stub({ turns: [turn()] });

    const response = await adminGetConversationThread(event({ query: query as Record<string, string> }));

    expect(response.statusCode).toBe(400);
    expect(ddbMock).not.toHaveReceivedCommandWith(QueryCommand, { TableName: CHAT_TABLE });
  });

  test('a thread with no stored turns is a 404 here, unlike /chat/history', async () => {
    // The contrast is deliberate: an admin arrives holding a thread id from the list, so an
    // empty result means the id is wrong or the TTL reclaimed the turns. An owner opening
    // the drawer for the first time is the ordinary case and gets a 200 — see below.
    stub({ turns: [] });

    const response = await adminGetConversationThread(event({ query: THREAD_QUERY }));

    expect(response.statusCode).toBe(404);
  });

  test('rebuilds the thread id from the three parts, so a composite entity id survives', async () => {
    // A `#` cannot travel in a URL path, which is why the id is split into query
    // parameters and reassembled here. A MOM project id is `PROJECT#p-1`, so the
    // reassembly has to be the same function that wrote the key.
    stub({ turns: [turn({ thread_id: 'mom#PROJECT#p-1#u-2' })] });

    const response = await adminGetConversationThread(event({
      query: { app: 'mom', entity_id: 'PROJECT#p-1', user_id: 'u-2' },
    }));

    expect(response.statusCode).toBe(200);
    expect(body(response).thread_id).toBe('mom#PROJECT#p-1#u-2');
    expect(body(response).entity_id).toBe('PROJECT#p-1');
  });
});

describe('the audit trail on the admin routes', () => {
  test('listing writes one READ_CONVERSATION row to the admin table', async () => {
    stub({ scan: [turn(), turn({ seq: 2, role: 'assistant', content: 'the instance is on-demand' })] });

    await adminListConversations(event());

    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: ADMIN_TABLE,
      Item: expect.objectContaining({
        entity_type: 'AUDIT_LOG',
        action: 'READ_CONVERSATION',
        actor_user_id: ADMIN_ID,
        actor_email: ADMIN_EMAIL,
      }),
    });
    // One row per load, not one per listed thread: a row per thread would bury the reads
    // that actually opened a transcript under the reads that only opened a directory.
    expect(auditRows()).toHaveLength(1);
  });

  test('opening one transcript names the thread and its owner in the row', async () => {
    stub({
      turns: [turn()],
      items: { [CALCULATOR_TABLE]: { calculation_id: CALC_ID, name: 'Template Project', owner_user_id: OWNER_ID } },
    });

    await adminGetConversationThread(event({ query: THREAD_QUERY }));

    expect(ddbMock).toHaveReceivedCommandWith(PutCommand, {
      TableName: ADMIN_TABLE,
      Item: expect.objectContaining({
        entity_type: 'AUDIT_LOG',
        action: 'READ_CONVERSATION',
        target_type: 'chat_thread',
        target_id: chatThreadId('calculator', CALC_ID, OWNER_ID),
        // Without this the log says an admin read a thread but not whose, which is the
        // one fact an oversight review of the oversight tool needs.
        target_owner_user_id: OWNER_ID,
      }),
    });
  });

  test('an admin reading their own thread writes no row', async () => {
    // Not an exemption from the gate — the tier check above still ran — only from the log.
    // An admin who uses the chat themselves would otherwise fill the audit log with rows
    // about their own transcripts and hide the accesses that matter.
    stub({ turns: [turn({ thread_id: chatThreadId('calculator', CALC_ID, ADMIN_ID) })] });

    const response = await adminGetConversationThread(event({
      query: { app: 'calculator', entity_id: CALC_ID, user_id: ADMIN_ID },
    }));

    expect(response.statusCode).toBe(200);
    expect(auditRows()).toHaveLength(0);
  });
});

describe('an admin read that cannot be logged fails rather than succeeding quietly', () => {
  test('a rejected audit write turns the conversations list into a 500', async () => {
    // writeAuditLog is awaited on purpose (api-handler/audit.ts). Driven through `handler`
    // because the behaviour under test is the throw reaching the top-level catch.
    stub({ scan: [turn()] });
    ddbMock.on(PutCommand).rejects(new Error('audit table down'));

    const response = await handler(event({ resource: '/admin/conversations' }));

    expect(response.statusCode).toBe(500);
    // The row is written before the titles are resolved, so a failed audit also means no
    // artifact was read: the access did not happen, rather than happening unlogged.
    expect(ddbMock).not.toHaveReceivedCommand(BatchGetCommand);
  });

  test('a rejected audit write turns a transcript read into a 500, with no turns in the body', async () => {
    stub({ turns: [turn({ content: 'is this candidate worth a second round' })] });
    ddbMock.on(PutCommand).rejects(new Error('audit table down'));

    const response = await handler(event({
      resource: '/admin/conversations/thread',
      query: THREAD_QUERY,
    }));

    expect(response.statusCode).toBe(500);
    // The turns are already in memory by the time the audit is written, so this is the
    // assertion that matters: an unloggable read must not answer with the transcript.
    expect(response.body).not.toContain('second round');
  });
});

describe('the thread response carries the evidence the assistant was shown', () => {
  test('an intelligence record contributes a transcript excerpt from its inline text', async () => {
    stub({
      turns: [turn({ thread_id: chatThreadId('intelligence', 'i-1', OWNER_ID) })],
      items: {
        [INTELLIGENCE_TABLE]: {
          intelligence_id: 'i-1',
          owner_user_id: OWNER_ID,
          candidate_name: 'Asha Rao',
          transcript: { rawText: 'Interviewer: walk me through the migration.\nCandidate: nine months, 1500 VMs.' },
        },
      },
    });

    const response = await adminGetConversationThread(event({
      query: { app: 'intelligence', entity_id: 'i-1', user_id: OWNER_ID },
    }));

    // A reviewer reads the conversation against what the model could see. Without this the
    // transcript pane is empty and the assistant's answers look unfounded.
    expect(body(response).transcript_excerpt).toContain('1500 VMs');
  });

  test('an unreadable transcript object costs the excerpt, not the whole read', async () => {
    stub({
      turns: [turn({ thread_id: chatThreadId('interview', 'ev-1', OWNER_ID) })],
      items: {
        [INTERVIEWS_TABLE]: {
          PK: 'INTERVIEW#ev-1',
          owner_user_id: OWNER_ID,
          metadata: { candidate_name: 'Asha Rao' },
          transcript_s3_key: 'users/owner-7/interviews/ev-1/transcript.txt',
        },
      },
    });
    s3Mock.on(GetObjectCommand).rejects(new Error('NoSuchKey'));

    const response = await adminGetConversationThread(event({
      query: { app: 'interview', entity_id: 'ev-1', user_id: OWNER_ID },
    }));

    // An S3 object lifecycled away, or a record written before the field existed, must not
    // 500 a reviewer out of a conversation that is stored somewhere else entirely.
    expect(response.statusCode).toBe(200);
    expect(body(response)).not.toHaveProperty('transcript_excerpt');
    expect(body(response).turns).toHaveLength(1);
  });
});

describe('GET /chat/history is owner-scoped by construction', () => {
  test('a missing caller is refused with 401 before anything is read', async () => {
    stub({ turns: [turn()] });

    const response = await getChatHistory(event({ userId: null, query: { app: 'calculator', entity_id: CALC_ID } }));

    expect(response.statusCode).toBe(401);
    expect(ddbMock).not.toHaveReceivedCommand(QueryCommand);
  });

  test('an artifact the caller has never chatted about is a 200 with no turns', async () => {
    stub({
      turns: [],
      items: { [CALCULATOR_TABLE]: { calculation_id: CALC_ID, name: 'Template Project', owner_user_id: OWNER_ID } },
    });

    const response = await getChatHistory(event({
      userId: OWNER_ID,
      query: { app: 'calculator', entity_id: CALC_ID },
    }));

    // Opening the drawer for the first time is the normal case. A 404 here would paint an
    // error state over "you have not asked anything yet".
    expect(response.statusCode).toBe(200);
    expect(body(response).turns).toEqual([]);
    expect(body(response).thread_id).toBe(chatThreadId('calculator', CALC_ID, OWNER_ID));
  });

  test('the thread id comes from the verified sub, and a user_id parameter is ignored', async () => {
    stub({
      turns: [],
      items: { [CALCULATOR_TABLE]: { calculation_id: CALC_ID, owner_user_id: OWNER_ID, name: 'Template Project' } },
    });

    const response = await getChatHistory(event({
      userId: 'reader-2',
      query: { app: 'calculator', entity_id: CALC_ID, user_id: OWNER_ID },
    }));

    // The security property of this route is that there is nothing to tamper with: the id
    // is assembled from `caller.userId`, so a smuggled user_id changes neither the key
    // queried nor the owner reported.
    const queried = ddbMock.commandCalls(QueryCommand)
      .map((call) => call.args[0].input.ExpressionAttributeValues?.[':thread'])
      .filter(Boolean);
    expect(queried).toEqual([chatThreadId('calculator', CALC_ID, 'reader-2')]);
    expect(body(response).owner_user_id).toBe('reader-2');
  });

  test('an estimate belonging to someone else yields no title and no owner email', async () => {
    stub({
      turns: [],
      items: {
        [CALCULATOR_TABLE]: {
          calculation_id: CALC_ID,
          name: 'Acme Migration',
          owner_user_id: OWNER_ID,
          owner_email: 'owner@minfytech.com',
        },
      },
    });

    const response = await getChatHistory(event({
      userId: 'reader-2',
      query: { app: 'calculator', entity_id: CALC_ID },
    }));

    // An id somebody was merely sent must not answer "what is this estimate called and
    // whose is it?". Nothing off the record travels back — and "unavailable" rather than
    // "deleted", because the record is there and calling it gone would be a lie.
    expect(response.statusCode).toBe(200);
    expect(body(response).title).toBe('(title unavailable)');
    expect(body(response).artifact_exists).toBe(false);
    expect(body(response)).not.toHaveProperty('owner_email');
  });

  test.each([
    ['an unknown app', { app: 'chatbot', entity_id: CALC_ID }],
    ['no entity id', { app: 'calculator' }],
  ])('%s is a 400', async (_label, query) => {
    stub({ turns: [] });

    const response = await getChatHistory(event({ userId: OWNER_ID, query: query as Record<string, string> }));

    expect(response.statusCode).toBe(400);
  });
});

describe('applied_at on a transcript turn', () => {
  const proposal = {
    kind: 'estimate_change',
    summary: 'shrink the web tier',
    instruction: 'use t3.medium',
    resource_edits: [],
  };

  test('a turn that was applied surfaces the timestamp', async () => {
    stub({
      turns: [
        turn({ seq: 1 }),
        turn({ seq: 2, role: 'assistant', content: 'proposed', proposal, applied_at: 1_700_000_060_000 }),
      ],
      items: { [CALCULATOR_TABLE]: { calculation_id: CALC_ID, name: 'Template Project', owner_user_id: OWNER_ID } },
    });

    const response = await getChatHistory(event({ userId: OWNER_ID, query: { app: 'calculator', entity_id: CALC_ID } }));

    // The transcript shows an applied badge from this attribute alone — an unapplied
    // proposal and an applied one differ by nothing else — so dropping it in the
    // projection would silently make every applied change read as a bare suggestion.
    expect(body(response).turns[1].applied_at).toBe(1_700_000_060_000);
  });

  test('a turn that was not applied omits the key rather than carrying an empty one', async () => {
    stub({
      turns: [turn({ seq: 1, role: 'assistant', content: 'proposed', proposal })],
      items: { [CALCULATOR_TABLE]: { calculation_id: CALC_ID, name: 'Template Project', owner_user_id: OWNER_ID } },
    });

    const response = await getChatHistory(event({ userId: OWNER_ID, query: { app: 'calculator', entity_id: CALC_ID } }));

    // The browser reads this as `'applied_at' in turn`, so the key's presence is the
    // signal. The conditional spread keeps it absent; a plain `applied_at: turn.applied_at`
    // would put the key on the wire with nothing in it.
    expect(body(response).turns[0]).not.toHaveProperty('applied_at');
    expect(response.body).not.toContain('applied_at');
    // The proposal it belongs to is still there, so this is not passing because the turn
    // came back empty.
    expect(body(response).turns[0].proposal.summary).toBe('shrink the web tier');
  });
});

describe('the conversations list response', () => {
  test('states the retention window alongside the threads', async () => {
    stub({
      scan: [turn()],
      batch: {
        [CALCULATOR_TABLE]: [{ calculation_id: CALC_ID, name: 'Template Project', owner_email: 'owner@minfytech.com' }],
      },
    });

    const response = await adminListConversations(event());

    const parsed = ConversationListResponseSchema.safeParse(body(response));
    expect(parsed.success).toBe(true);
    // The page states this number to explain why the history stops where it does; without
    // it a reviewer cannot tell a missing thread from an expired one.
    expect(parsed.success && parsed.data.window_days).toBe(30);
    expect(body(response).threads[0]).toMatchObject({
      app: 'calculator',
      entity_id: CALC_ID,
      owner_user_id: OWNER_ID,
      owner_email: 'owner@minfytech.com',
      title: 'Template Project',
      artifact_exists: true,
    });
  });

  test('a thread whose artifact is gone still lists, marked deleted', async () => {
    stub({ scan: [turn()], batch: { [CALCULATOR_TABLE]: [] } });

    const response = await adminListConversations(event());

    // The conversation happened. Dropping the row would quietly shrink the oversight list
    // every time somebody deleted the record they had been talking about.
    expect(body(response).threads[0]).toMatchObject({ title: '(record deleted)', artifact_exists: false });
  });

  test('an unparseable thread id is dropped instead of failing the page', async () => {
    stub({
      scan: [turn({ thread_id: 'chatbot#x#y' }), turn({ thread_id: 'mom' }), turn()],
      batch: { [CALCULATOR_TABLE]: [{ calculation_id: CALC_ID, name: 'Template Project' }] },
    });

    const response = await adminListConversations(event());

    // The listing is a scan, so it reads whatever is in the table, including rows a future
    // writer adds. A malformed partition key is not something a reviewer can act on.
    expect(body(response).threads.map((thread: { app: string }) => thread.app)).toEqual(['calculator']);
  });
});
