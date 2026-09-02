import { PutCommand, QueryCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

import { ddbDocClient } from '../shared/aws';
import type { ChatMessage, ChatProposal, ChatRole } from '../../schema/chat';

const CHAT_TABLE_NAME = process.env.CHAT_TABLE_NAME!;

/**
 * How many stored turns are replayed to the model.
 *
 * A window rather than the whole thread: the artifact context is re-sent every turn
 * and is by far the larger input, so an unbounded history buys very little
 * conversational memory for a lot of latency. Twelve turns is roughly six exchanges,
 * which covers "no, the other one" and "do that for staging too".
 */
export const HISTORY_TURNS = 12;

/**
 * Threads expire after 30 days.
 *
 * A chat is a working conversation about an artifact, not part of the record — the
 * estimate, the minutes and the evaluation are all stored elsewhere and are what gets
 * cited. Keeping transcripts forever would accumulate model output about candidates
 * with no retention story attached to it.
 *
 * Thirty rather than the ninety this shipped with: these transcripts are now readable
 * from the conversations list by any REVIEWER-tier admin, which turns the window into a
 * deliberate choice about how long model output discussing named candidates is kept.
 * `expires_at` is stamped at write time, so turns written before this change keep their
 * original ninety days.
 */
const TTL_DAYS = 30;

/**
 * The thread's most recent turns, oldest first.
 *
 * Queried backwards and reversed rather than forwards with a limit: the newest turns
 * are the relevant ones, and a forward query would return the *first* twelve turns of a
 * long thread.
 */
export async function loadRecentTurns(threadId: string, limit = HISTORY_TURNS): Promise<ChatMessage[]> {
  const result = await ddbDocClient.send(new QueryCommand({
    TableName: CHAT_TABLE_NAME,
    KeyConditionExpression: 'thread_id = :thread',
    ExpressionAttributeValues: { ':thread': threadId },
    ScanIndexForward: false,
    Limit: limit,
  }));
  const items = (result.Items || []) as ChatMessage[];
  return items.reverse();
}

/** The next sequence number for a thread, or 1 for a thread that does not exist yet. */
export async function nextSeq(threadId: string): Promise<number> {
  const result = await ddbDocClient.send(new QueryCommand({
    TableName: CHAT_TABLE_NAME,
    KeyConditionExpression: 'thread_id = :thread',
    ExpressionAttributeValues: { ':thread': threadId },
    ScanIndexForward: false,
    Limit: 1,
    ProjectionExpression: 'seq',
  }));
  const latest = (result.Items || [])[0] as { seq?: number } | undefined;
  return (latest?.seq || 0) + 1;
}

export async function saveTurn(input: {
  threadId: string;
  seq: number;
  role: ChatRole;
  content: string;
  proposal?: ChatProposal;
}): Promise<void> {
  const now = Date.now();
  const item: ChatMessage = {
    thread_id: input.threadId,
    seq: input.seq,
    role: input.role,
    content: input.content,
    created_at: now,
    ...(input.proposal ? { proposal: input.proposal } : {}),
    // Seconds, not milliseconds — DynamoDB reads this attribute as a Unix second
    // count, and a millisecond value simply never expires.
    expires_at: Math.floor(now / 1000) + TTL_DAYS * 24 * 60 * 60,
  };
  await ddbDocClient.send(new PutCommand({ TableName: CHAT_TABLE_NAME, Item: item }));
}

/**
 * Marks the assistant turn at `seq` as the one whose proposal was applied.
 *
 * The only write the API handler makes to this table, and it touches exactly one
 * attribute on one already-stored turn: authorship stays the chat Lambda's alone.
 * `expires_at` is deliberately not touched — applying a proposal is not a reason to
 * extend a transcript's retention past what `saveTurn` stamped.
 *
 * `ConditionExpression` is not optional here. `UpdateItem` is an upsert, so a stale or
 * wrong `seq` would CREATE an item holding nothing but `thread_id`, `seq` and
 * `applied_at`. `listThreadSummaries` scans the table and counts every row as a turn, so
 * that phantom would inflate the thread's turn count on the oversight list and — if its
 * seq happened to be 1 — blank the thread's preview, since the preview comes from seq 1
 * and this row has no `content`. The condition turns that into a no-op instead.
 *
 * Never throws, by design. By the time this runs the artifact has already been
 * rewritten; failing the request would tell the user their apply failed when it
 * succeeded, and they would apply it twice. A missed marker costs one badge on a
 * transcript. A conditional failure is not even an incident — it means the seq did not
 * match a stored turn, which is a client bug or a thread whose turns have already aged
 * out — so it is swallowed silently and anything else is logged.
 */
export async function markProposalApplied(threadId: string, seq: number): Promise<void> {
  try {
    await ddbDocClient.send(new UpdateCommand({
      TableName: CHAT_TABLE_NAME,
      Key: { thread_id: threadId, seq },
      UpdateExpression: 'SET applied_at = :now',
      // Milliseconds, matching created_at rather than the seconds expires_at uses. The
      // transcript renders this as a ms timestamp, so seconds would show January 1970.
      ExpressionAttributeValues: { ':now': Date.now() },
      ConditionExpression: 'attribute_exists(seq)',
    }));
  } catch (err) {
    if ((err as Error)?.name === 'ConditionalCheckFailedException') return;
    console.error(`[markProposalApplied] could not mark ${threadId} seq ${seq}:`, err);
  }
}

/**
 * A whole thread, oldest turn first.
 *
 * Separate from loadRecentTurns rather than a limit argument on it: that function feeds
 * the model a fixed window and has to stay cheap and bounded, while this one is a person
 * reading a transcript, which has to show every turn or it is not a transcript. Paginates
 * because a long thread can exceed DynamoDB's 1MB page.
 */
export async function loadThread(threadId: string): Promise<ChatMessage[]> {
  const turns: ChatMessage[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ddbDocClient.send(new QueryCommand({
      TableName: CHAT_TABLE_NAME,
      KeyConditionExpression: 'thread_id = :thread',
      ExpressionAttributeValues: { ':thread': threadId },
      ExclusiveStartKey: startKey,
    }));
    turns.push(...((result.Items || []) as ChatMessage[]));
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return turns;
}

/** What a scan can know about a thread without reading the artifact it discusses. */
export interface ThreadSummary {
  threadId: string;
  turnCount: number;
  preview: string;
  firstTurnAt: number;
  lastTurnAt: number;
  hasProposal: boolean;
  hasApplied: boolean;
}

/** How much of the opening question the list shows before eliding it. */
const PREVIEW_CHARS = 160;

/**
 * Folds one scanned turn into its thread's summary.
 *
 * Scan order is not sort order, so every field here is order-independent: counts add,
 * timestamps take a min or a max, and the preview comes from seq 1 specifically rather
 * than from whichever user turn happens to be seen first.
 */
function accumulate(byThread: Map<string, ThreadSummary>, item: ChatMessage): void {
  const existing = byThread.get(item.thread_id);
  const createdAt = item.created_at || 0;
  const summary: ThreadSummary = existing || {
    threadId: item.thread_id,
    turnCount: 0,
    preview: '',
    firstTurnAt: createdAt,
    lastTurnAt: createdAt,
    hasProposal: false,
    hasApplied: false,
  };
  summary.turnCount += 1;
  if (createdAt > 0) {
    // A zero firstTurnAt would sort as 1970 and render as an epoch date, so a real
    // timestamp wins over a missing one instead of being min'd against it.
    summary.firstTurnAt = summary.firstTurnAt > 0 ? Math.min(summary.firstTurnAt, createdAt) : createdAt;
    summary.lastTurnAt = Math.max(summary.lastTurnAt, createdAt);
  }
  if (item.proposal) summary.hasProposal = true;
  if (item.applied_at) summary.hasApplied = true;
  // seq 1 is the opening user turn — nextSeq starts every thread at 1.
  if (item.seq === 1 && item.content) {
    const text = item.content.trim().replace(/\s+/g, ' ');
    summary.preview = text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text;
  }
  if (!existing) byThread.set(item.thread_id, summary);
}

/**
 * Every thread in the table, reduced to one summary each, most recent activity first.
 *
 * A scan, deliberately. The table has no index and `thread_id` is
 * `{app}#{entityId}#{userId}`, so no key answers "every thread" or "one user's threads".
 * A GSI would mean a new attribute on every item plus a backfill of the ones already
 * stored, to answer a question this repo already answers by scanning — see the org-wide
 * admin lists in api-handler/admin-routes.ts. The TTL is what bounds the cost: nothing
 * older than TTL_DAYS is in the table to read.
 *
 * `content` is projected only because the opening question becomes the list preview; it
 * is the sole turn content that leaves this function.
 */
export async function listThreadSummaries(): Promise<ThreadSummary[]> {
  const byThread = new Map<string, ThreadSummary>();
  let startKey: Record<string, unknown> | undefined;
  do {
    const result = await ddbDocClient.send(new ScanCommand({
      TableName: CHAT_TABLE_NAME,
      ProjectionExpression: 'thread_id, seq, #role, content, created_at, proposal, applied_at',
      // `role` is a DynamoDB reserved word and cannot appear bare in a projection.
      ExpressionAttributeNames: { '#role': 'role' },
      ExclusiveStartKey: startKey,
    }));
    for (const item of (result.Items || []) as ChatMessage[]) {
      accumulate(byThread, item);
    }
    startKey = result.LastEvaluatedKey;
  } while (startKey);
  return [...byThread.values()].sort((a, b) => b.lastTurnAt - a.lastTurnAt);
}

/** The retention window, so a listing can state why it stops where it does. */
export const RETENTION_DAYS = TTL_DAYS;
