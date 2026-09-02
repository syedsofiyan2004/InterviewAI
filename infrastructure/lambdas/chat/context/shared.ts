// Type-only, and it has to stay that way: tools.ts imports `clampContext` from this module,
// so a value import here would close a runtime cycle. `import type` is erased at compile.
import type { ReadOnlyTool } from '../tools';

/**
 * Bounded context blocks — what the chat is allowed to know about an artifact.
 *
 * Every builder here returns plain text under a character budget rather than the raw
 * record. Three reasons, in order of how much they matter:
 *
 *  1. Latency. The user's first token has to paint immediately, and time-to-first-token
 *     scales with input length. A 400-server estimate serialised whole is tens of
 *     thousands of tokens the model must read before it can say anything.
 *  2. Cost. Every turn re-sends the whole context.
 *  3. Leakage. A record carries fields the conversation has no business seeing —
 *     S3 keys, owner ids, presigned-upload paths. Building the block by hand means
 *     those are excluded by construction rather than by remembering to strip them.
 *
 * Long lists are *summarised*, never cut mid-row: a table that stops halfway reads to
 * the model as a complete table, and it will then answer confidently about an
 * inventory it only half saw.
 */

/** Roughly 6k tokens of context. Comfortably inside the latency budget. */
export const CONTEXT_CHAR_BUDGET = 24_000;

/** How many rows of any one table are listed before the rest are summarised. */
export const MAX_TABLE_ROWS = 40;

export interface EntityContext {
  /** Shown in the chat header so the user can see which artifact the thread is about. */
  title: string;
  /** The context block handed to the model. */
  context: string;
  /** True when this app offers a change tool. Evaluations are read-only by design. */
  editable: boolean;
  /**
   * Tools that let the model look up what this block had to leave out, each one already
   * bound to the loaded record.
   *
   * Built by the loader rather than assembled from an app name, and that is the access
   * control: a tool closes over the record whose `owner_user_id` was just checked, so no
   * argument the model emits can point it at another estimate. See `ReadOnlyTool`.
   *
   * Absent where an artifact is meant to be explained rather than investigated. The
   * evaluation builders have none by design — there is nothing to look up that the block
   * does not already carry, and a score is evidence, not a dataset to query.
   */
  readTools?: ReadOnlyTool[];
}

/**
 * Why a loader could not produce a context block.
 *
 *  - `not_found` — no record with that id, or one that has been soft-deleted. Deletion
 *    belongs here rather than under `not_owner` because a deleted record is gone for its
 *    owner too, and telling them it is somebody else's would be a lie.
 *  - `not_owner` — the record exists and belongs to another user. Chat initiation is
 *    owner-only in every app, deliberately and with no admin fallback.
 *  - `no_result` — the record is the caller's own and still has nothing to talk about:
 *    the pipeline has not produced a result, or what it stored no longer parses.
 */
export type EntityContextFailure = 'not_found' | 'not_owner' | 'no_result';

/**
 * A loaded context block, or the reason there isn't one.
 *
 * These three used to be a single `null`, on the theory that distinguishing them would
 * let a probe learn which ids exist. They are separated now because the REST layer
 * already answers a non-owner with 403 and a stranger's id with 404, so nothing was
 * being hidden — while the merged answer, "not found, or has no result to talk about
 * yet", was routinely wrong about the reader's own records and cost a maintainer an hour
 * chasing a bug that did not exist. The gate is unchanged; only the message is.
 */
export type EntityContextResult =
  | { ok: true; entity: EntityContext }
  | { ok: false; reason: EntityContextFailure };

/** dd-MM-yyyy, the format used in every generated document in this repo. */
export function formatDate(value: number | string | undefined): string {
  if (value === undefined || value === null || value === '') return 'Not recorded';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()}`;
}

export function money(value: number | null | undefined, currency = 'USD'): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'not priced';
  return `${currency} ${value.toFixed(2)}`;
}

/** Drops empty, null and whitespace-only values so a block has no "undefined" lines. */
export function line(label: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text || text === 'undefined' || text === 'null') return null;
  return `${label}: ${text}`;
}

export function section(heading: string, lines: (string | null)[]): string {
  const kept = lines.filter((entry): entry is string => Boolean(entry));
  if (!kept.length) return '';
  return `## ${heading}\n${kept.join('\n')}`;
}

export function joinSections(sections: string[]): string {
  return sections.filter(Boolean).join('\n\n');
}

/**
 * Lists up to `limit` rows and states plainly how many were left out.
 *
 * The count sentence is the load-bearing part: without it the model treats 40 of 400
 * servers as the whole estimate and tells the user their landscape is 40 machines.
 */
export function boundedRows<T>(
  rows: T[],
  render: (row: T, index: number) => string,
  limit = MAX_TABLE_ROWS,
  noun = 'rows',
): string {
  if (!rows.length) return '(none)';
  const shown = rows.slice(0, limit).map(render);
  if (rows.length <= limit) return shown.join('\n');
  return [
    ...shown,
    `... and ${rows.length - limit} more ${noun}, not listed here. Say so if the user asks about ${noun} you cannot see.`,
  ].join('\n');
}

/**
 * Last-resort trim, applied to the finished block.
 *
 * Cuts at a line boundary and says it did, so a truncated block never looks complete.
 */
export function clampContext(text: string, budget = CONTEXT_CHAR_BUDGET): string {
  if (text.length <= budget) return text;
  const notice = '\n\n[Context truncated to fit the model window. Some detail above is missing — say so rather than guessing.]';
  const cut = text.slice(0, budget - notice.length);
  const lastBreak = cut.lastIndexOf('\n');
  return `${lastBreak > budget / 2 ? cut.slice(0, lastBreak) : cut}${notice}`;
}
