import { APIGatewayProxyEvent } from 'aws-lambda';
import { BatchGetCommand, GetCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient, getFileContent } from '../shared/aws';
import { successResponse, errorResponse } from '../shared/responses';
import { transcriptExcerpt } from '../shared/transcript-excerpt';
import { listThreadSummaries, loadThread, RETENTION_DAYS } from '../chat/store';
import { getCallerContext, requireAdminTier } from './authz.js';
import { writeAuditLog } from './audit.js';
import {
  ChatAppSchema,
  chatThreadId,
  parseThreadId,
  type ChatApp,
  type ChatMessage,
  type ChatThread,
  type ChatThreadSummary,
  type ChatTranscriptTurn,
  type ConversationListResponse,
} from '../../schema/chat';

/**
 * Conversation oversight — reading context-chat transcripts back out.
 *
 * A separate module for the same reason calculator-routes.ts is one: the feature adds
 * three lines to the very large and concurrently-edited api-handler/index.ts and keeps
 * its own logic here.
 *
 * There are two audiences and therefore two admin routes plus one owner route, and the
 * difference between them is the whole security design. `/admin/conversations` and
 * `/admin/conversations/thread` read *other people's* conversations, so they sit behind
 * REVIEWER tier and write an audit entry. `/chat/history` reads the caller's own thread
 * and takes no `user_id` at all — the id it queries is built from the Cognito-verified
 * `sub`, so there is no parameter to tamper with and nothing to audit.
 *
 * The transcripts themselves are what makes this sensitive: a chat about an evaluation
 * is model output discussing a named candidate. That is why the list ships previews
 * rather than turns, why the thread route is audited per read, and why the retention
 * window travels with the list response so the page can say where the history stops.
 */

const BUCKET_NAME = process.env.BUCKET_NAME!;

/** DynamoDB refuses more than 100 keys in a single BatchGetItem request. */
const BATCH_GET_MAX_KEYS = 100;

/**
 * How many times a chunk's leftover keys are re-requested before the reads in it are
 * reported as unknown rather than resolved. Four attempts across roughly half a second of
 * backoff clears ordinary provisioned-throughput noise; anything past that is a real
 * problem and should not hold up a page load.
 */
const BATCH_GET_MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * What a resolved artifact contributes to a thread's row.
 *
 * There is no field for "we could not tell": a read that never completed is reported as
 * `exists: true` with UNKNOWN_TITLE, which is the closest this two-valued wire shape gets
 * to an unknown. See batchGetItems for why that distinction has to be kept at all.
 */
interface ResolvedArtifact {
  title: string;
  exists: boolean;
  ownerEmail?: string;
}

/** Shown when a read succeeded and the record was genuinely absent or soft-deleted. */
const DELETED_TITLE = '(record deleted)';

/**
 * Shown when the record's title could not be established: the read never completed, or
 * the record is not the caller's to read. Distinct wording from DELETED_TITLE on purpose —
 * "we could not look" and "it is gone" are different facts, and a reader should not be
 * told the second when only the first is known.
 */
const UNKNOWN_TITLE = '(title unavailable)';

/**
 * How each app's artifact is fetched, identified and titled.
 *
 * Everything here is copied from the code that already owns these tables rather than
 * invented: the key shapes from the read paths in index.ts, and the title expressions
 * from the matching org-wide listing in admin-routes.ts, so a conversation row names a
 * record the same way the admin list for that record type does.
 */
interface AppArtifactTable {
  tableName: string;
  /** The primary key of one record. Interviews are the only composite-key table here. */
  key(entityId: string): Record<string, string>;
  /**
   * Recovers the entity id from a returned item. BatchGetItem answers are an unordered
   * bag with no correlation to the request, so every projection below carries whatever
   * attribute this needs.
   */
  entityIdOf(item: Record<string, any>): string | undefined;
  /**
   * Projection for the list path, as an expression plus its alias map.
   *
   * Every name is aliased, including the ones that are plainly safe. DynamoDB's reserved
   * word list is long enough that deciding per-attribute from memory is a latent 400 on
   * a route nobody exercises often — `position`, `name` and `status` are all on it, which
   * is already three of the attributes needed here.
   */
  projection: { expression: string; names: Record<string, string> };
  /** The human title of a record, or a fallback when the record has never had one. */
  title(item: Record<string, any>): string;
  /** Where the artifact lives in the frontend, so a reader can open what was discussed. */
  href(entityId: string): string;
}

/**
 * Picks the first usable name out of a list of candidates.
 *
 * 'Unnamed' is rejected explicitly, not just empty strings: it is a stored value in these
 * tables (the intelligence listing writes it as its own fallback), and letting it win
 * would stop a real name further down the list from being found.
 */
function firstRealName(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.toLowerCase() === 'unnamed') continue;
    return trimmed;
  }
  return undefined;
}

const APP_TABLES: Record<ChatApp, AppArtifactTable> = {
  interview: {
    tableName: process.env.TABLE_NAME!,
    // The interviews table is the one single-table-design table in the set: an interview
    // is PK `INTERVIEW#{id}` / SK `METADATA`, alongside USER# preference rows.
    key: (entityId) => ({ PK: `INTERVIEW#${entityId}`, SK: 'METADATA' }),
    entityIdOf: (item) => (typeof item.PK === 'string' ? item.PK.replace(/^INTERVIEW#/, '') : undefined),
    projection: {
      expression: '#pk, #metadata, #candidate_name, #owner_email, #deleted_at',
      names: {
        '#pk': 'PK',
        '#metadata': 'metadata',
        '#candidate_name': 'candidate_name',
        '#owner_email': 'owner_email',
        '#deleted_at': 'deleted_at',
      },
    },
    title: (item) => firstRealName(item.metadata?.candidate_name, item.candidate_name) || 'Unnamed',
    href: (entityId) => `/interviews/view?id=${encodeURIComponent(entityId)}`,
  },
  mom: {
    tableName: process.env.MOM_TABLE_NAME!,
    key: (entityId) => ({ mom_id: entityId }),
    entityIdOf: (item) => (typeof item.mom_id === 'string' ? item.mom_id : undefined),
    projection: {
      expression: '#mom_id, #title, #owner_email, #deleted_at',
      names: {
        '#mom_id': 'mom_id',
        '#title': 'title',
        '#owner_email': 'owner_email',
        '#deleted_at': 'deleted_at',
      },
    },
    title: (item) => firstRealName(item.title) || 'Untitled meeting',
    href: (entityId) => `/mom/view?id=${encodeURIComponent(entityId)}`,
  },
  intelligence: {
    tableName: process.env.INTELLIGENCE_TABLE_NAME!,
    key: (entityId) => ({ intelligence_id: entityId }),
    entityIdOf: (item) => (typeof item.intelligence_id === 'string' ? item.intelligence_id : undefined),
    projection: {
      // Deliberately narrow. An intelligence record carries the whole interview
      // transcript inline, and a hundred of those in one BatchGetItem response would run
      // straight into the 16MB limit for a list that only wants a candidate's name.
      expression: '#intelligence_id, #candidate_name, #candidate, #position_title, #job, #title, #position, #owner_email, #deleted_at',
      names: {
        '#intelligence_id': 'intelligence_id',
        '#candidate_name': 'candidate_name',
        '#candidate': 'candidate',
        '#position_title': 'position_title',
        '#job': 'job',
        '#title': 'title',
        '#position': 'position',
        '#owner_email': 'owner_email',
        '#deleted_at': 'deleted_at',
      },
    },
    // The same fallback chain adminListIntelligenceInterviews uses: a candidate name if
    // one was ever captured, otherwise the role, because a record created from a Keka
    // schedule can reach analysis before anyone types a name.
    title: (item) => firstRealName(
      item.candidate_name,
      item.candidate?.name,
      item.candidate?.full_name,
      item.candidate?.candidate_name,
      item.position_title,
      item.job?.title,
      item.title,
      item.position,
    ) || 'Unnamed',
    href: (entityId) => `/interviews/intelligence/view?id=${encodeURIComponent(entityId)}`,
  },
  calculator: {
    tableName: process.env.CALCULATOR_TABLE_NAME!,
    key: (entityId) => ({ calculation_id: entityId }),
    entityIdOf: (item) => (typeof item.calculation_id === 'string' ? item.calculation_id : undefined),
    projection: {
      expression: '#calculation_id, #name, #owner_email, #deleted_at',
      names: {
        '#calculation_id': 'calculation_id',
        '#name': 'name',
        '#owner_email': 'owner_email',
        '#deleted_at': 'deleted_at',
      },
    },
    title: (item) => firstRealName(item.name) || 'Untitled estimate',
    href: (entityId) => `/calculator/view?id=${encodeURIComponent(entityId)}`,
  },
};

/** Composite cache key, since entity ids are only unique within their own app. */
function artifactCacheKey(app: ChatApp, entityId: string): string {
  return `${app}#${entityId}`;
}

/**
 * Turns one fetched item into the fields a thread row needs.
 *
 * A soft-deleted record counts as gone: `deleted_at` is how an admin delete works across
 * all four tables, and a reviewer reading the conversations list should see the same
 * "deleted" state the record's own app shows.
 */
function describeArtifact(app: ChatApp, item: Record<string, any> | undefined): ResolvedArtifact {
  if (!item || item.deleted_at) {
    return { title: DELETED_TITLE, exists: false };
  }
  const ownerEmail = typeof item.owner_email === 'string' && item.owner_email.trim()
    ? item.owner_email.trim()
    : undefined;
  return {
    title: APP_TABLES[app].title(item),
    exists: true,
    // Omitted rather than defaulted when the record never stamped one. owner_email is
    // backfilled lazily on the owner's own next read, so an untouched record legitimately
    // has none, and inventing one from the user id would put a non-address in an email
    // column.
    ...(ownerEmail ? { ownerEmail } : {}),
  };
}

/**
 * Reads one table's worth of keys, chunked and with leftover keys retried.
 *
 * Two failure modes are handled separately here because they mean opposite things:
 *
 *   - A key that comes back with no item was read successfully and the record is not
 *     there. That is a deletion, and the thread lists as `artifact_exists: false`.
 *   - A key that lands in `UnprocessedKeys` was never read at all — DynamoDB throttled
 *     or the 16MB response filled up. Reporting that as a deletion would tell a reviewer
 *     a record had been destroyed because a read was rate-limited, which is a lie the
 *     page has no way to correct. So leftovers are retried with backoff, and anything
 *     still outstanding is returned in `unresolved` for the caller to label as unknown.
 */
async function batchGetItems(
  tableName: string,
  keys: Record<string, string>[],
  projection: { expression: string; names: Record<string, string> },
): Promise<{ items: Record<string, any>[]; unresolved: Record<string, string>[] }> {
  const items: Record<string, any>[] = [];
  const unresolved: Record<string, string>[] = [];

  for (let start = 0; start < keys.length; start += BATCH_GET_MAX_KEYS) {
    let pending = keys.slice(start, start + BATCH_GET_MAX_KEYS);

    for (let attempt = 0; attempt < BATCH_GET_MAX_ATTEMPTS && pending.length; attempt += 1) {
      // Linear rather than exponential: the ceiling is four attempts, so the difference
      // is a few hundred milliseconds, and a page load should not wait longer than that
      // for a title.
      if (attempt > 0) await sleep(attempt * 100);

      const result = await ddbDocClient.send(new BatchGetCommand({
        RequestItems: {
          [tableName]: {
            Keys: pending,
            ProjectionExpression: projection.expression,
            ExpressionAttributeNames: projection.names,
          },
        },
      }));

      items.push(...((result.Responses?.[tableName] || []) as Record<string, any>[]));
      pending = (result.UnprocessedKeys?.[tableName]?.Keys || []) as Record<string, string>[];
    }

    unresolved.push(...pending);
  }

  return { items, unresolved };
}

/**
 * Resolves titles and owner emails for every artifact the listed threads discuss.
 *
 * Grouped by app first so each table is read in as few round trips as its key count
 * allows, and the four tables are read concurrently — the list is one page load and the
 * threads are spread across all four apps in practice.
 */
async function resolveArtifacts(
  entityIdsByApp: Map<ChatApp, Set<string>>,
): Promise<Map<string, ResolvedArtifact>> {
  const resolved = new Map<string, ResolvedArtifact>();

  await Promise.all([...entityIdsByApp.entries()].map(async ([app, entityIds]) => {
    const table = APP_TABLES[app];
    const ids = [...entityIds];
    const { items, unresolved } = await batchGetItems(
      table.tableName,
      ids.map((entityId) => table.key(entityId)),
      table.projection,
    );

    const foundByEntityId = new Map<string, Record<string, any>>();
    for (const item of items) {
      const entityId = table.entityIdOf(item);
      if (entityId) foundByEntityId.set(entityId, item);
    }

    // Which ids never got an answer, recovered from the leftover keys rather than by
    // subtraction, so a genuinely-deleted record is not swept in with the throttled ones.
    const unresolvedIds = new Set(
      unresolved.map((key) => table.entityIdOf(key)).filter((id): id is string => !!id),
    );

    for (const entityId of ids) {
      if (unresolvedIds.has(entityId) && !foundByEntityId.has(entityId)) {
        // Unknown, not deleted. `exists: true` is the less wrong of the two available
        // answers: the thread exists because somebody had a conversation about this
        // artifact, and the row still carries a working href, so a reader who needs the
        // truth is one click away from it.
        resolved.set(artifactCacheKey(app, entityId), { title: UNKNOWN_TITLE, exists: true });
        continue;
      }
      resolved.set(artifactCacheKey(app, entityId), describeArtifact(app, foundByEntityId.get(entityId)));
    }
  }));

  return resolved;
}

/**
 * One artifact, for the two single-thread routes. A batch of one buys nothing here.
 *
 * `requireOwnerUserId` is passed only by /chat/history. The chat's own context loaders
 * refuse every artifact whose `owner_user_id` is not the caller's (see
 * lambdas/chat/context), so a caller can only ever hold a thread about a record they own —
 * which means enforcing the same rule here costs a legitimate reader nothing and stops the
 * route from answering "what is this estimate called and whose is it?" for an id somebody
 * was merely sent. The admin route deliberately passes nothing: reading other people's
 * records is what it is for.
 */
async function resolveOneArtifact(
  app: ChatApp,
  entityId: string,
  requireOwnerUserId?: string,
): Promise<ResolvedArtifact & { item?: Record<string, any> }> {
  const table = APP_TABLES[app];
  // No ProjectionExpression, unlike the list path: the thread response also wants the
  // transcript the assistant was shown, which lives on the record itself (intelligence)
  // or behind an S3 key on it (interview), and both are cheaper to take from an item
  // already in hand than to fetch a second time.
  const result = await ddbDocClient.send(new GetCommand({
    TableName: table.tableName,
    Key: table.key(entityId),
  }));

  const item = result.Item as Record<string, any> | undefined;
  if (requireOwnerUserId && item && item.owner_user_id !== requireOwnerUserId) {
    // Not "deleted" — it is there, it is simply not this caller's. Nothing off the record
    // travels back, not the title and not the owner's email.
    return { title: UNKNOWN_TITLE, exists: false };
  }
  return { ...describeArtifact(app, item), ...(item ? { item } : {}) };
}

/**
 * The excerpt of the interview transcript the conversation was grounded in, if any.
 *
 * Only the two interview flows have one — an estimate and a set of minutes carry their
 * own content in the record, which the transcript pane is not for. Every failure here is
 * swallowed: a reviewer opening a transcript must not get a 500 because an S3 object was
 * lifecycled away or a record predates the field. The excerpt is context, not the answer.
 */
async function resolveTranscriptExcerpt(
  app: ChatApp,
  item: Record<string, any> | undefined,
): Promise<string | undefined> {
  if (!item) return undefined;
  try {
    if (app === 'intelligence') {
      return transcriptExcerpt(item.transcript?.rawText);
    }
    if (app === 'interview' && item.transcript_s3_key) {
      return transcriptExcerpt(await getFileContent(BUCKET_NAME, item.transcript_s3_key));
    }
    return undefined;
  } catch (err: any) {
    console.warn(`Transcript excerpt unavailable for ${app} record: ${err?.message || err}`);
    return undefined;
  }
}

/** Stored turn -> wire turn. Drops `thread_id` (on the envelope) and `expires_at` (ours). */
function toTranscriptTurn(turn: ChatMessage): ChatTranscriptTurn {
  return {
    seq: turn.seq,
    role: turn.role,
    content: turn.content,
    created_at: turn.created_at,
    ...(turn.proposal ? { proposal: turn.proposal } : {}),
    ...(turn.applied_at ? { applied_at: turn.applied_at } : {}),
  };
}

/**
 * GET /admin/conversations — every context-chat thread in the retention window.
 *
 * REVIEWER rather than VIEWER, which is where the other org-wide lists sit. VIEWER is the
 * tier for aggregate and metadata oversight; this list is a directory of conversations
 * about named candidates, and reading it is a step beyond counting records.
 *
 * Threads whose id does not parse are dropped silently. `listThreadSummaries` is a scan,
 * so it reads whatever is in the table — including anything a future writer puts there —
 * and a malformed partition key is not something a reviewer can act on.
 */
export async function adminListConversations(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'REVIEWER');
  if (denied) return denied;

  const summaries = await listThreadSummaries();

  const parsedThreads = summaries.flatMap((summary) => {
    const parts = parseThreadId(summary.threadId);
    return parts ? [{ summary, parts }] : [];
  });

  // One entry per load, not one per thread, following the /admin/audit-log precedent:
  // the audited act is "an admin opened the conversations directory", and a row per
  // listed thread would bury the reads that actually opened a transcript. Written before
  // the artifact reads below, so the log records the access even if resolving titles
  // fails afterwards.
  await writeAuditLog({
    actorUserId: caller!.userId,
    actorEmail: caller!.email,
    action: 'READ_CONVERSATION',
    detail: `listed ${parsedThreads.length} thread${parsedThreads.length === 1 ? '' : 's'}`,
  });

  const entityIdsByApp = new Map<ChatApp, Set<string>>();
  for (const { parts } of parsedThreads) {
    const existing = entityIdsByApp.get(parts.app);
    if (existing) existing.add(parts.entityId);
    else entityIdsByApp.set(parts.app, new Set([parts.entityId]));
  }

  const artifacts = await resolveArtifacts(entityIdsByApp);

  const threads: ChatThreadSummary[] = parsedThreads.map(({ summary, parts }) => {
    const artifact = artifacts.get(artifactCacheKey(parts.app, parts.entityId))
      // Only reachable if resolveArtifacts skipped an id it was handed; treated as
      // unknown rather than deleted, for the reason batchGetItems explains.
      || { title: UNKNOWN_TITLE, exists: true };
    return {
      thread_id: summary.threadId,
      app: parts.app,
      entity_id: parts.entityId,
      owner_user_id: parts.userId,
      ...(artifact.ownerEmail ? { owner_email: artifact.ownerEmail } : {}),
      title: artifact.title,
      artifact_exists: artifact.exists,
      turn_count: summary.turnCount,
      preview: summary.preview,
      first_turn_at: summary.firstTurnAt,
      last_turn_at: summary.lastTurnAt,
      has_proposal: summary.hasProposal,
      has_applied: summary.hasApplied,
    };
  });

  // window_days travels with the list so the page can state why the history stops where
  // it does, rather than leaving a reviewer to wonder whether an old thread is missing or
  // was simply never had.
  const body: ConversationListResponse = { threads, window_days: RETENTION_DAYS };
  return successResponse(body);
}

/**
 * GET /admin/conversations/thread?app=&entity_id=&user_id= — one thread in full.
 *
 * Query parameters rather than a path segment carrying the thread id, because that id is
 * `{app}#{entityId}#{userId}` and a `#` cannot survive a URL path: everything from it on
 * is a fragment the browser never sends. The three parts travel separately and the id is
 * rebuilt here with the same function that wrote it.
 */
export async function adminGetConversationThread(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  const denied = requireAdminTier(caller, 'REVIEWER');
  if (denied) return denied;

  const params = event.queryStringParameters || {};
  const app = ChatAppSchema.safeParse(params.app);
  if (!app.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Query parameter `app` must be one of calculator, mom, interview, intelligence');
  }
  const entityId = (params.entity_id || '').trim();
  const userId = (params.user_id || '').trim();
  if (!entityId || !userId) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Query parameters `entity_id` and `user_id` are required');
  }

  const threadId = chatThreadId(app.data, entityId, userId);
  const turns = await loadThread(threadId);
  // A thread id names a conversation that happened, so nothing here is a 404 through
  // normal use — unlike /chat/history below, where an empty thread is the first open of
  // a drawer. An empty result means the id is wrong or the TTL has reclaimed the turns.
  if (!turns.length) {
    return errorResponse(404, 'NOT_FOUND', 'Conversation not found or expired');
  }

  const artifact = await resolveOneArtifact(app.data, entityId);

  // Reading your own conversation is not an admin action, so it is not logged as one:
  // an admin who used the chat themselves would otherwise generate audit rows about
  // their own transcripts, which is noise that makes the real accesses harder to find.
  // The tier gate above still applies — this route lives under /admin and lists every
  // owner's threads, and exempting the audit is not the same as exempting the gate.
  if (userId !== caller!.userId) {
    await writeAuditLog({
      actorUserId: caller!.userId,
      actorEmail: caller!.email,
      action: 'READ_CONVERSATION',
      targetType: 'chat_thread',
      targetId: threadId,
      targetOwnerUserId: userId,
      detail: `${app.data} thread, ${turns.length} turn${turns.length === 1 ? '' : 's'}`,
    });
  }

  const excerpt = await resolveTranscriptExcerpt(app.data, artifact.item);

  const body: ChatThread = {
    thread_id: threadId,
    app: app.data,
    entity_id: entityId,
    owner_user_id: userId,
    ...(artifact.ownerEmail ? { owner_email: artifact.ownerEmail } : {}),
    title: artifact.title,
    artifact_exists: artifact.exists,
    // Offered even when the record is gone: a dead link is more honest than silently
    // dropping the only pointer to what was discussed, and the app's own view renders
    // its own not-found state.
    artifact_href: APP_TABLES[app.data].href(entityId),
    turns: turns.map(toTranscriptTurn),
    ...(excerpt ? { transcript_excerpt: excerpt } : {}),
  };
  return successResponse(body);
}

/**
 * GET /chat/history?app=&entity_id= — the caller's own thread for one artifact.
 *
 * No tier check, and none is needed: there is no `user_id` parameter. The thread id is
 * built from `caller.userId`, which comes from the Cognito-verified `sub` re-read by
 * getCallerContext, so the only thread this route can ever return is the caller's own.
 * That is the security property — not a check that could be forgotten, but an id the
 * request has no way to influence.
 *
 * Response shape is identical to the admin route's on purpose, so the drawer and the
 * admin transcript view render from one shape and cannot drift apart.
 */
export async function getChatHistory(event: APIGatewayProxyEvent) {
  const caller = await getCallerContext(event);
  if (!caller) return errorResponse(401, 'ACCESS_DENIED', 'Unauthorized');

  const params = event.queryStringParameters || {};
  const app = ChatAppSchema.safeParse(params.app);
  if (!app.success) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Query parameter `app` must be one of calculator, mom, interview, intelligence');
  }
  const entityId = (params.entity_id || '').trim();
  if (!entityId) {
    return errorResponse(400, 'VALIDATION_ERROR', 'Query parameter `entity_id` is required');
  }

  const threadId = chatThreadId(app.data, entityId, caller.userId);
  const [turns, artifact] = await Promise.all([
    loadThread(threadId),
    resolveOneArtifact(app.data, entityId, caller.userId),
  ]);

  // An empty thread is a 200 with no turns, not a 404. Opening the chat drawer on an
  // artifact for the first time is the normal case, and a 404 there would make the
  // browser show an error for "you have not asked anything yet".
  //
  // No audit entry either, for the same reason the admin route skips one when the reader
  // is the owner: this is a person reading their own conversation.
  const body: ChatThread = {
    thread_id: threadId,
    app: app.data,
    entity_id: entityId,
    owner_user_id: caller.userId,
    ...(artifact.ownerEmail ? { owner_email: artifact.ownerEmail } : {}),
    title: artifact.title,
    artifact_exists: artifact.exists,
    artifact_href: APP_TABLES[app.data].href(entityId),
    turns: turns.map(toTranscriptTurn),
  };
  return successResponse(body);
}
