import type { ChatProposal } from '../../schema/chat';
import { clampContext } from './context/shared';

/**
 * What a tool is, and which tools mean what — the registry the loop dispatches through.
 *
 * Why a registry and not a branch. The dispatch this replaces was a ternary on the tool
 * name that produced a proposal kind, with `null` for anything else and a `console.warn`
 * saying "unknown tool". That shape had two defects that only appear once the chat has more
 * than one kind of tool. Adding a tool meant editing the ternary, so a tool the model was
 * *told* about could be dispatched to nothing. And, worse, every unrecognised name landed
 * in the same `null` branch as a malformed proposal, so a perfectly good read-only look-up
 * would have been reported to the user as "I could not put that change together properly".
 *
 * So the two categories are separated here by construction:
 *
 *  - A **proposal tool** produces a `ChatProposal` for the user to Apply or Discard. There
 *    are exactly two, they are declared in one map, and calling one ENDS the turn — there
 *    is nothing to feed back to the model, because the chat never applies anything itself.
 *  - A **read-only tool** answers a question and its answer goes back to the model as a
 *    `toolResult`, so the conversation continues. It cannot change anything, and it cannot
 *    reach a record other than the one already authorised — see `ReadOnlyTool.run`.
 *
 * A name in neither category is a model hallucinating a tool. That is now its own outcome,
 * reported to the model as a tool result saying the tool does not exist, which it can
 * recover from, instead of being mistaken for a broken proposal.
 */

/**
 * A tool the model may call to look something up, bound to one already-authorised record.
 *
 * `run` takes only the model's arguments and NOTHING that identifies a record, because the
 * record is captured in the closure when the tool is built — after `loadEntityContext` has
 * checked `owner_user_id`. This is the whole security design of the read-only tool set: an
 * argument cannot widen access to another estimate or another user's data, because there is
 * no argument that names a record and no code path here that reads one. Any id-shaped
 * argument the model invents is simply ignored.
 *
 * Synchronous, deliberately. Every read-only tool answers from the record already in
 * memory. A tool that went back to DynamoDB or S3 would reintroduce exactly the id-shaped
 * argument this design removes, and would put a network round trip inside a turn the user
 * is watching stream.
 */
export interface ReadOnlyTool {
  name: string;
  /** Bedrock Converse `toolSpec`, ready to drop into `toolConfig.tools`. */
  spec: unknown;
  /** Bounded plain text. See `TOOL_RESULT_CHAR_BUDGET`. */
  run(args: Record<string, unknown>): string;
}

/**
 * How much text one tool result may return.
 *
 * A quarter of the 24k context block budget, and that ratio is the point: several tool
 * results accumulate in a single turn's message list ON TOP of the context block, which is
 * re-sent in full every iteration. Sizing a tool result like a context block would mean
 * four look-ups doubling the input of every subsequent turn — the latency and cost problem
 * `context/shared.ts` was written to avoid, reintroduced through the back door.
 */
export const TOOL_RESULT_CHAR_BUDGET = 6_000;

/**
 * The most rows any one tool call may return.
 *
 * Matches `MAX_TABLE_ROWS` so a slice reads exactly like the context block's own listing.
 * The model reaches rows 41+ by asking for a further slice, not by asking for a bigger one:
 * an unbounded `count` would let a single call pull a 4,000-row inventory into the window.
 */
export const TOOL_ROW_LIMIT = 40;

/**
 * Which proposal each proposal tool produces.
 *
 * The map is the registry: `toProposal` reads it rather than re-deriving the kind, so a new
 * proposal tool is one entry here and one spec in prompt.ts, and there is no branch that can
 * be left un-updated.
 */
export const PROPOSAL_TOOL_KINDS: Record<string, ChatProposal['kind']> = {
  propose_estimate_change: 'estimate_change',
  propose_mom_edit: 'mom_edit',
};

export function proposalKindFor(toolName: string): ChatProposal['kind'] | null {
  return PROPOSAL_TOOL_KINDS[toolName] ?? null;
}

/**
 * Head a tool result with what it is and clamp it to the budget.
 *
 * The heading is not decoration. A bare list of rows arriving as a tool result is
 * indistinguishable from the context block's own listing, and the model has been known to
 * merge the two and then answer about a total it assembled out of overlapping slices.
 * Saying "rows 40-79 of 412" makes the slice self-describing.
 *
 * `clampContext` rather than a raw slice, so a result that overruns still ends at a line
 * boundary and still says it was cut — the same rule the context block follows, for the
 * same reason: a truncated list that looks complete gets answered from as though it were.
 */
export function toolResultText(heading: string, body: string): string {
  return clampContext(`${heading}\n${body}`, TOOL_RESULT_CHAR_BUDGET);
}

/** A whole number argument, clamped into range. Absent, junk and out-of-range all fall back. */
export function intArg(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const raw = Number(args[key]);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(raw)));
}

/** A trimmed string argument, or undefined. Never returns an empty string. */
export function textArg(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key];
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  return text || undefined;
}

/**
 * One of a closed set, or the fallback.
 *
 * A model that invents a section name gets the default rather than an error, because a
 * refusal here costs a whole iteration of the loop to recover from and the default is
 * always a legitimate answer to the question that was asked.
 */
export function choiceArg<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = textArg(args, key);
  return (raw && (allowed as readonly string[]).includes(raw)) ? raw as T : fallback;
}

/**
 * Case-insensitive substring match used by every filter argument.
 *
 * Loose on purpose: the model is filtering on values it read out of a context block that
 * abbreviates them, so "prod" has to find "Production" or the filter is useless.
 */
export function matches(value: unknown, needle: string): boolean {
  return String(value ?? '').toLowerCase().includes(needle.toLowerCase());
}

/**
 * Run a read-only tool against the model's accumulated arguments, always returning text.
 *
 * Never throws, and that is not defensive habit — a throw here happens INSIDE the tool
 * loop, after text has already streamed to the browser under a committed 200, so it would
 * turn a bad argument into a failed turn and lose the answer the user was already reading.
 * A sentence the model can read and correct is strictly better: it retries with a different
 * argument, usually within the same turn.
 *
 * Arguments arrive as partial JSON concatenated across deltas, so an unparseable string
 * normally means the model's output was cut off mid-call — which is worth saying plainly,
 * because the recovery ("ask for fewer rows") is different from the recovery for a bad
 * value.
 */
export function runReadTool(tool: ReadOnlyTool, rawInput: string): string {
  let args: Record<string, unknown> = {};
  if (rawInput.trim()) {
    try {
      const parsed = JSON.parse(rawInput);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      return `The arguments for ${tool.name} were not valid JSON, so nothing was looked up. `
        + 'They may have been cut off — try again asking for a smaller slice.';
    }
  }

  try {
    return tool.run(args);
  } catch (error) {
    console.error(`[chat] read-only tool ${tool.name} failed:`, error);
    return `${tool.name} could not be read just now. Answer from the context block, and say what you could not check.`;
  }
}
