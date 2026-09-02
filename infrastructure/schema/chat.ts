import { z } from 'zod';

import { EstimatePlanSchema, EstimateScenarioRequestSchema, RequirementPatchSchema } from './estimate-plan';
import { MomResultSchema } from './mom';

/**
 * Context chat — the shapes shared by the streaming chat Lambda, the two apply
 * routes on API Gateway, and the browser.
 *
 * The chat is deliberately per-artifact rather than per-user: a thread is scoped to
 * one estimate, one set of minutes or one evaluation, so "make the web tier cheaper"
 * needs no restating of which estimate is meant. That scoping is also the security
 * boundary — the thread id embeds the owner, so a thread cannot be read across
 * accounts even if its id leaks.
 */

/**
 * Which app the thread belongs to.
 *
 * `interview` is the evaluation flow and `intelligence` the interviewer-centric flow;
 * they are separate tables and separate records, so they are separate apps here even
 * though both are answered by the same read-only context builder.
 */
export const ChatAppSchema = z.enum(['calculator', 'mom', 'interview', 'intelligence']);
export type ChatApp = z.infer<typeof ChatAppSchema>;

export const ChatRoleSchema = z.enum(['user', 'assistant']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

/**
 * One field the chat wants to change on an estimate's resource row.
 *
 * `row` is a 0-based index into the record's `resources` array, which is the only
 * stable handle a conversation has on a machine: server names are optional in an
 * uploaded sheet and duplicated in practice.
 */
export const EstimateResourceEditSchema = z.object({
  row: z.number().int().min(0),
  /** Only sizing fields are editable. Costs are never writable — they are priced, not set. */
  field: z.enum([
    'size',
    'quantity',
    'os',
    'purchase_model',
    'region',
    'vcpu',
    'ram_gb',
    'disk_gb',
    'hoursPerMonth',
    'notes',
  ]),
  /** Numeric fields are coerced on apply; a string here keeps the wire shape uniform. */
  value: z.string().max(200),
  /** Shown in the diff so the user can see why, not only what. */
  reason: z.string().max(400).optional(),
});
export type EstimateResourceEdit = z.infer<typeof EstimateResourceEditSchema>;

/**
 * Re-exported rather than declared here: both shapes moved to `schema/estimate-plan.ts` once
 * the create and revise routes needed them too, and a chat module asking for
 * `EstimateScenarioRequest` should not have to know that. See that file for why.
 */
export {
  PricingModelRequestSchema,
  EstimateScenarioRequestSchema,
  type PricingModelRequest,
  type EstimateScenarioRequest,
} from './estimate-plan';

/**
 * A proposed change to an estimate. Nothing here is applied by the chat itself.
 *
 * `instruction` is audit text only. The calculator executes typed requirement patches,
 * scenario patches and legacy row edits; it must not re-interpret this prose on apply.
 */
export const EstimateChangeProposalSchema = z.object({
  kind: z.literal('estimate_change'),
  summary: z.string().min(1).max(600),
  instruction: z.string().min(1).max(2000),
  requirement_patches: z.array(RequirementPatchSchema).max(200).default([]),
  resource_edits: z.array(EstimateResourceEditSchema).max(50).default([]),
  /**
   * Scenarios to price, each becoming its own line and its own link.
   *
   * Capped above the eighteen a real request needed, because the cap is a runaway guard
   * and not a product limit — but it IS a real limit: every scenario is a full pricing
   * pass plus a save call against a worker already at the fifteen-minute Lambda ceiling,
   * so a request for hundreds has to be refused somewhere rather than time out having
   * produced nothing. Empty keeps the single-estimate behaviour every existing thread
   * relies on.
   */
  scenarios: z.array(EstimateScenarioRequestSchema).max(30).default([]),
  /**
   * Which documents to produce.
   *
   * Asked for by name because the formats are not interchangeable: a matrix of links is
   * unreadable as a PDF and belongs in a Word document, while the workbook exists to be
   * pivoted rather than read. Empty means leave the existing outputs alone.
   */
  deliverables: z.array(z.enum(['pdf', 'xlsx', 'docx'])).max(3).default([]),
});
export type EstimateChangeProposal = z.infer<typeof EstimateChangeProposalSchema>;

/**
 * A proposed edit to stored minutes.
 *
 * `patch` carries only the top-level keys that change, merged over the stored result
 * on apply and re-validated against MomResultSchema. A partial rather than a whole
 * document because the common request is "drop the two internal risks" — sending the
 * entire minutes back would put every untouched sentence at risk of being reworded.
 */
export const MomEditProposalSchema = z.object({
  kind: z.literal('mom_edit'),
  summary: z.string().min(1).max(600),
  patch: MomResultSchema.partial(),
});
export type MomEditProposal = z.infer<typeof MomEditProposalSchema>;

export const ChatProposalSchema = z.discriminatedUnion('kind', [
  EstimateChangeProposalSchema,
  MomEditProposalSchema,
]);
export type ChatProposal = z.infer<typeof ChatProposalSchema>;

/** One stored turn. Partition key is the thread, sort key the turn number. */
export const ChatMessageSchema = z.object({
  thread_id: z.string(),
  /**
   * Monotonic turn number within the thread, starting at 1.
   *
   * A number rather than a timestamp: two messages written in the same millisecond
   * would collide on a timestamp key, and the user's message and the reply to it are
   * written milliseconds apart.
   */
  seq: z.number().int().min(1),
  role: ChatRoleSchema,
  content: z.string(),
  created_at: z.number(),
  /** Present only on an assistant turn that proposed a change. */
  proposal: ChatProposalSchema.optional(),
  /**
   * Set once the user applies the proposal, so the transcript shows what happened.
   *
   * Written by the apply route rather than by the chat, because only the route knows
   * whether the artifact was actually rewritten — the chat only ever proposes. The
   * route finds the turn by the `chat_seq` the browser echoes back from the `done`
   * event, so an unapplied proposal and an applied one differ by this attribute alone.
   *
   * Epoch *milliseconds*, like `created_at` — `expires_at` below is the one deliberate
   * exception. A seconds value here renders as January 1970 in the transcript.
   */
  applied_at: z.number().optional(),
  /**
   * Epoch *seconds* for the table's TTL attribute.
   *
   * Seconds, not milliseconds: DynamoDB reads this as a Unix second count and
   * silently never expires an item whose value is a thousand times too large.
   */
  expires_at: z.number().int().optional(),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/** POST body of the streaming chat endpoint. */
export const ChatTurnRequestSchema = z.object({
  app: ChatAppSchema,
  entity_id: z.string().min(1).max(200),
  /**
   * Capped well below the model's limit. A paste of an entire transcript belongs in
   * the artifact, not the chat, and an unbounded field here is a cost hole.
   */
  message: z.string().min(1).max(4000),
});
export type ChatTurnRequest = z.infer<typeof ChatTurnRequestSchema>;

/**
 * One line of the response stream, newline-delimited JSON.
 *
 * NDJSON rather than SSE framing: the browser reads this with a plain
 * `ReadableStream` reader and a line split, with no EventSource (which cannot send
 * an Authorization header) and no `data:`/`event:` prefixes to strip.
 */
export const ChatStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('proposal'), proposal: ChatProposalSchema }),
  z.object({ type: z.literal('done'), seq: z.number().int() }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

/** GET /chat/config — how the browser learns the streaming endpoint. */
export const ChatConfigSchema = z.object({
  /** Empty when the chat Lambda is not deployed, so the UI can hide the launcher. */
  chat_url: z.string(),
});
export type ChatConfig = z.infer<typeof ChatConfigSchema>;

/**
 * Which assistant turn proposed the change being applied — the `seq` from the stream's
 * `done` event, or from the turn as it came back in history.
 *
 * Optional, and it has to be: a turn restored from a stream that dropped before `done`
 * has no seq to send, and a cached older bundle calls these routes without the field at
 * all. Neither can be allowed to fail an apply, because what it addresses is only the
 * *marking* of the turn — the artifact is rewritten either way. Its absence costs an
 * `applied_at` on one transcript row, not a change.
 *
 * Which is also why a caller must OMIT it rather than send a placeholder. `min(1)` is a
 * real floor — turns start at 1 — and the chat Lambda emits `done` with `seq: 0` when it
 * answered but could not persist the turn. Passing that 0 through would fail the whole
 * apply on validation, trading a missing badge for a change that never lands.
 */
const ChatSeqSchema = z.number().int().min(1).optional();

/** POST /calculator/{id}/revise — applying an estimate proposal. */
export const ReviseCalculationSchema = z.object({
  instruction: z.string().min(1).max(2000),
  requirement_patches: z.array(RequirementPatchSchema).max(200).default([]),
  resource_edits: z.array(EstimateResourceEditSchema).max(50).default([]),
  /**
   * Carried flat rather than as an `EstimatePlanSchema`, deliberately.
   *
   * These two fields are the same shape the proposal already published, so the browser
   * forwards what it was given instead of assembling a nested object from it -- the same
   * reason `resource_edits` is flat here. The route composes them into the record's
   * `requested_plan`, which keeps the composition in one place on the server where the
   * parent estimate's own plan is available to fall back on.
   *
   * Empty means "no matrix was asked for", which a revision inherits from its parent rather
   * than treating as a request to drop the parent's bands.
   */
  scenarios: z.array(EstimateScenarioRequestSchema).max(30).default([]),
  deliverables: z.array(z.enum(['pdf', 'xlsx', 'docx'])).max(3).default([]),
  chat_seq: ChatSeqSchema,
});
export type ReviseCalculation = z.infer<typeof ReviseCalculationSchema>;

/** POST /moms/{id}/revise — applying a minutes proposal. */
export const ApplyMomEditSchema = z.object({
  patch: MomResultSchema.partial(),
  chat_seq: ChatSeqSchema,
});
export type ApplyMomEdit = z.infer<typeof ApplyMomEditSchema>;

/**
 * Thread id. Embeds the owner, so a thread is unreachable from another account even
 * with the app name and the entity id, both of which appear in a URL.
 */
export function chatThreadId(app: ChatApp, entityId: string, userId: string): string {
  return `${app}#${entityId}#${userId}`;
}

/**
 * The three parts of a thread id, recovered from the id itself.
 *
 * Nothing extra has to be stored to make a thread listable: the app, the artifact and
 * the owner are already in the partition key. Split at the FIRST and LAST separator
 * rather than with `split('#')`, so an entity id that ever contains one still survives
 * the round trip. Returns null for anything that is not a thread id — a scan reads
 * whatever is in the table, including rows written by a future version of this code.
 */
export function parseThreadId(
  threadId: string,
): { app: ChatApp; entityId: string; userId: string } | null {
  const first = threadId.indexOf('#');
  const last = threadId.lastIndexOf('#');
  // first < 1 catches both "no separator" and a leading one; last <= first means there
  // is only one separator; a trailing one leaves no user id.
  if (first < 1 || last <= first || last === threadId.length - 1) return null;
  const app = ChatAppSchema.safeParse(threadId.slice(0, first));
  if (!app.success) return null;
  return {
    app: app.data,
    entityId: threadId.slice(first + 1, last),
    userId: threadId.slice(last + 1),
  };
}

/**
 * One row of the conversations list. Deliberately carries no turn content beyond the
 * opening question: a list that shipped whole transcripts would be a bulk export of
 * model output about candidates, which is not what an oversight list is for.
 */
export const ChatThreadSummarySchema = z.object({
  thread_id: z.string(),
  app: ChatAppSchema,
  entity_id: z.string(),
  owner_user_id: z.string(),
  owner_email: z.string().optional(),
  /** Artifact title, or a placeholder when the record discussed has since been deleted. */
  title: z.string(),
  /** False when the artifact is gone. The conversation still happened, so it still lists. */
  artifact_exists: z.boolean(),
  turn_count: z.number().int(),
  /** The opening question, trimmed, so the list is scannable without opening every row. */
  preview: z.string(),
  first_turn_at: z.number(),
  last_turn_at: z.number(),
  /** True when the assistant proposed a change somewhere in this thread. */
  has_proposal: z.boolean(),
  /** True when one of those proposals was actually applied to the artifact. */
  has_applied: z.boolean(),
});
export type ChatThreadSummary = z.infer<typeof ChatThreadSummarySchema>;

/** GET /admin/conversations */
export const ConversationListResponseSchema = z.object({
  threads: z.array(ChatThreadSummarySchema),
  /** Retention window in days, so the page can say why the list stops where it does. */
  window_days: z.number().int(),
});
export type ConversationListResponse = z.infer<typeof ConversationListResponseSchema>;

/**
 * One turn as the browser reads it back.
 *
 * A projection of ChatMessage rather than the stored item: `thread_id` is already on
 * the envelope and `expires_at` is storage bookkeeping the client has no use for.
 */
export const ChatTranscriptTurnSchema = z.object({
  seq: z.number().int(),
  role: ChatRoleSchema,
  content: z.string(),
  created_at: z.number(),
  proposal: ChatProposalSchema.optional(),
  applied_at: z.number().optional(),
});
export type ChatTranscriptTurn = z.infer<typeof ChatTranscriptTurnSchema>;

/**
 * One thread in full — the response of both GET /admin/conversations/thread and
 * GET /chat/history.
 *
 * The same shape for both on purpose: an owner reading their own history and a
 * reviewer reading somebody else's are looking at the same conversation, and two
 * shapes would mean two renderers that could drift apart.
 */
export const ChatThreadSchema = z.object({
  thread_id: z.string(),
  app: ChatAppSchema,
  entity_id: z.string(),
  owner_user_id: z.string(),
  owner_email: z.string().optional(),
  title: z.string(),
  artifact_exists: z.boolean(),
  /** Where the artifact lives in the UI, so a reader can open what was discussed. */
  artifact_href: z.string().optional(),
  turns: z.array(ChatTranscriptTurnSchema),
  /**
   * What the model was told about the interview transcript, when there was one.
   *
   * Present so a reviewer reads the conversation against the same evidence the
   * assistant had, instead of guessing why it answered the way it did.
   */
  transcript_excerpt: z.string().optional(),
});
export type ChatThread = z.infer<typeof ChatThreadSchema>;
