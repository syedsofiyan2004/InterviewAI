/**
 * How far along an estimate is, and roughly how much longer it has to go.
 *
 * Why this exists. The pipeline already reports which stage it is in, and the view page
 * already polls for it, but "Pricing 12 group(s) from live AWS rates" answers the wrong
 * question. A user watching a run that takes minutes wants to know whether it is still
 * moving and when it will be done; a stage name tells them neither. The record did not
 * even carry the timestamps needed to work it out, which is why `progress_started_at`,
 * `progress_stage_started_at` and `progress_history` were added alongside this module.
 *
 * The honesty problem, and how it is handled. Two of the six stages have costs that scale
 * with the workload rather than being fixed: `pricing` makes a Price List query per group,
 * and `saving` makes one MCP call that is allowed up to three minutes before it gives up.
 * A flat table of per-stage durations would therefore be roughly right on a ten-row sheet
 * and badly wrong on a four-hundred-row one, and a confidently wrong countdown is worse
 * than no countdown: it teaches the user that the number means nothing, and then they
 * cannot tell a slow run from a hung one.
 *
 * So this module does three things instead of one:
 *
 *  - Weights each stage by nominal cost, scaling the workload-dependent ones by the
 *    number of groups actually being priced.
 *  - **Recalibrates from the run in front of it.** Stages that have already completed have
 *    known real durations. Their ratio against nominal is applied to what remains, so a
 *    run that is throttled or unusually large corrects itself after the first stage or two
 *    instead of holding to a fiction.
 *  - Reports a RANGE, never a point. The spread is per-stage, because the uncertainty is
 *    not uniform: folding an inventory into groups is nearly deterministic, whereas a save
 *    that may or may not exhaust a three-minute timeout is not.
 *
 * Pure and synchronous: it reads a snapshot of the record plus the current time and
 * returns numbers and prose. No I/O, no clock of its own, so it is exhaustively testable
 * and safe to call from a poll route, a chat context block and a report alike — all three
 * must agree, which they only do if they share this one implementation.
 */

/** One entry of the record's `progress_history`. */
export interface ProgressEvent {
  stage: string;
  message?: string;
  at: number;
}

/**
 * What this module needs off a calculation record.
 *
 * Structural rather than an import of `CalculationRecord`, so the report renderers and the
 * chat context can pass their own narrower views without dragging the full record schema —
 * and so a caller physically cannot reach a cost field from here. This module estimates
 * time; it has no business reading money.
 */
export interface ProgressSnapshot {
  status?: string;
  progress_stage?: string;
  progress_message?: string;
  progress_started_at?: number;
  progress_stage_started_at?: number;
  progress_history?: ProgressEvent[];
  created_at?: number;
  updated_at?: number;
  /** Drives the weight of the two workload-dependent stages. */
  resource_count?: number;
}

export interface ProgressEstimate {
  /** The stage as the pipeline named it, or `'queued'` before the worker writes anything. */
  stage: string;
  /** That stage in words a user reads, e.g. "Pricing from live AWS rates". */
  stageLabel: string;
  /** 1-based position in the run, and how many stages a run has. Both for "step 3 of 6". */
  stageNumber: number;
  stageCount: number;
  /** Milliseconds since the worker started — not since the row was created. */
  elapsedMs: number;
  /** 0..1, and monotonic: it never moves backwards across successive polls. */
  fraction: number;
  /** Bounds on the time left. Both 0 once the run reaches a terminal status. */
  remainingLowMs: number;
  remainingHighMs: number;
  /**
   * True when nothing has written to the row for long enough that it is probably dead.
   *
   * Advisory only. The authority on declaring a run failed is the read-time watchdog in
   * `calculator-routes.ts`, which flips the status conditionally so a worker that comes
   * back cannot be overwritten. This flag exists so the prose can stop promising a
   * completion time it no longer believes in, and it deliberately trips EARLIER than that
   * watchdog: warning while a run might still recover is cheap, and a countdown still
   * ticking down on a dead run is exactly the lie this module exists to avoid.
   */
  stalled: boolean;
  /** How much to trust the range, given how much of the run has been observed. */
  confidence: 'low' | 'medium' | 'high';
  /** One sentence fit to render verbatim in the UI, a chat turn, or a report. */
  prose: string;
}

/**
 * The stages a run passes through, in order, with what each costs.
 *
 * `nominalMs` is the fixed part. `perGroupMs` is added once per group being priced, and is
 * zero for the stages whose cost genuinely does not depend on the workload. `spread` is
 * the multiplier applied either side of the estimate to produce the reported range.
 *
 * The names must match what the pipeline emits — `connecting` from the orchestrator
 * (`calculator-orchestrator/index.ts:85`) and the rest from `onProgress` calls in
 * `pipeline.ts` (:1372, :1471, :1483, :1532, :1554). A stage the pipeline emits that is
 * missing here degrades to an unknown-position estimate rather than throwing, but it also
 * silently stops contributing to the weighting, so the two lists are meant to be kept in
 * step.
 */
const STAGES: Array<{
  stage: string;
  label: string;
  nominalMs: number;
  perGroupMs: number;
  spread: number;
}> = [
  // Fetching the service catalogue over the network. Fixed cost, but a cold sidecar
  // container makes it occasionally much slower, hence the wide spread on a short stage.
  { stage: 'connecting', label: 'Loading the AWS service catalogue', nominalMs: 12_000, perGroupMs: 0, spread: 1.8 },
  // Pure in-memory folding of the inventory. The most predictable stage in the run.
  { stage: 'grouping', label: 'Folding the inventory into groups', nominalMs: 3_000, perGroupMs: 20, spread: 1.2 },
  // Model calls that pick a serviceCode and filters per group. Scales with groups, and
  // model latency varies enough that the spread stays wide even when the count is known.
  { stage: 'classifying', label: 'Matching each group to an AWS service', nominalMs: 8_000, perGroupMs: 1_400, spread: 1.7 },
  // One Price List query per group, plus retries. The single biggest term on a large sheet.
  { stage: 'pricing', label: 'Pricing from live AWS rates', nominalMs: 6_000, perGroupMs: 900, spread: 1.6 },
  // One MCP build_estimate call with a three-minute ceiling, then a read-back verify. The
  // widest spread of any stage: it either answers quickly or it approaches its timeout,
  // and there is little in between.
  { stage: 'saving', label: 'Building the shareable AWS estimate', nominalMs: 35_000, perGroupMs: 250, spread: 2.6 },
  // A single model call writing up assumptions. Fixed, and short.
  { stage: 'narrating', label: 'Writing up assumptions and warnings', nominalMs: 15_000, perGroupMs: 0, spread: 1.5 },
];

export const STAGE_COUNT = STAGES.length;

/** Stages that mean the run is over. Nothing is estimated past one of these. */
const TERMINAL_STAGES = new Set(['done', 'failed']);

/**
 * How long a silent row is allowed to be before the prose stops predicting.
 *
 * Under the 11-minute threshold that `failIfStale` uses to actually mark a run failed,
 * because these two are answering different questions: that one must be certain before
 * destroying a status, and this one only has to stop making a promise.
 */
const SILENCE_BEFORE_DOUBT_MS = 4 * 60 * 1000;

function stageIndex(stage: string | undefined): number {
  return STAGES.findIndex((entry) => entry.stage === stage);
}

/** Nominal cost of a stage at a given workload size. */
function costOf(index: number, groups: number): number {
  const entry = STAGES[index];
  return entry.nominalMs + entry.perGroupMs * groups;
}

/**
 * How many groups this run is pricing.
 *
 * Groups, not rows: the pipeline folds identical resources together before pricing, so a
 * sheet of two hundred identical web servers is one priced group and costs what one costs.
 * `resource_count` is the only size signal on the record, so it is used as an upper bound
 * and damped rather than taken literally — otherwise every large-but-repetitive inventory
 * would be quoted a wildly pessimistic time. The floor of 1 keeps a single-row estimate
 * from collapsing the workload-dependent terms to nothing.
 */
function groupsFrom(snapshot: ProgressSnapshot): number {
  const parsed = Number(snapshot.resource_count);
  // `|| 0` alone catches NaN, null, text and negatives but NOT Infinity, and an infinite
  // group count propagates all the way into the prose as "about Infinity minutes". A stored
  // DynamoDB number cannot be infinite, so this is unreachable from a real record — but the
  // function is exported arithmetic and a caller in a later change need not know that.
  const rows = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
  if (rows <= 1) return 1;
  // Sub-linear on purpose: real inventories repeat, and the repetition is the whole reason
  // grouping exists. Roughly 200 rows reads as ~30 groups.
  return Math.max(1, Math.round(Math.sqrt(rows) * 2));
}

/**
 * Index of the last stage on the trail that this module knows about, or -1.
 *
 * Walked backwards from the end rather than forwards, because the answer wanted is where
 * the run got TO. A forwards scan returns the first stage it recognises, which on a trail
 * ending in an unrecognised entry would report the run as barely started.
 */
function lastRecognisedStage(history: ProgressEvent[]): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const index = stageIndex(history[i].stage);
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * Real durations of the stages that have already finished, from the history trail.
 *
 * A stage's duration is the gap to the NEXT event, which is why the last entry is skipped:
 * it is the stage still running, and its elapsed time is not its duration. Reading it as
 * one would make the recalibration ratio fall as any slow stage progresses, so the
 * estimate would shrink precisely when it should be growing.
 */
function completedDurations(history: ProgressEvent[]): Map<string, number> {
  const durations = new Map<string, number>();
  for (let i = 0; i + 1 < history.length; i += 1) {
    const span = history[i + 1].at - history[i].at;
    if (span > 0) durations.set(history[i].stage, span);
  }
  return durations;
}

/**
 * Observed-over-nominal across the finished stages, clamped.
 *
 * Clamped hard because this factor multiplies everything still to come, so one anomalous
 * stage must not be able to rewrite the whole forecast. A 3s grouping stage that happened
 * to take 30s is a cold start, not evidence that pricing will take ten times as long.
 * Returns 1 when nothing has finished yet, which is the same as saying "no evidence".
 */
function calibration(history: ProgressEvent[], groups: number): { factor: number; observed: number } {
  const durations = completedDurations(history);
  let observed = 0;
  let nominal = 0;
  // Counted here rather than taken from `durations.size`, which counts every stage on the
  // trail including ones this table does not recognise. The factor arithmetic skips those,
  // so `size` could report three observations behind a factor derived from one — and
  // `observed` is what the caller turns into a confidence level, which would then claim
  // "high" on the strength of a single stage. Confidence has to count the same evidence the
  // number was actually built from.
  let counted = 0;
  for (const [stage, actual] of durations) {
    const index = stageIndex(stage);
    if (index < 0) continue;
    observed += actual;
    nominal += costOf(index, groups);
    counted += 1;
  }
  if (!nominal || !observed) return { factor: 1, observed: 0 };
  return { factor: Math.min(4, Math.max(0.5, observed / nominal)), observed: counted };
}

/**
 * A span in words: "no time", "under a minute", "about a minute", "about 3 minutes",
 * "about 2 hours", "about 4 days" — never a bare millisecond count.
 *
 * The hour and day tiers are not decoration. This formats a *terminal* run's elapsed time
 * as well as a live forecast, and a record read a week after it finished has an elapsed
 * time measured in days: without them, "Finished in about 11000 minutes" is what a reader
 * sees. That sentence was already being worked around in a caller, which is the wrong place
 * for it — the caller cannot fix the wording, only avoid printing it.
 *
 * Zero, negative and non-finite input all return "no time" rather than throwing or printing
 * "NaN minutes". Reachable for real: a terminal record whose timestamps are all missing has
 * no elapsed time to state, and "no time" is the honest reading of that.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'no time';
  const seconds = Math.round(ms / 1000);
  if (seconds < 45) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes <= 1) return 'about a minute';
  // The tiers overlap deliberately: 90 minutes reads better as "about 2 hours" than as
  // "about 90 minutes", and 36 hours better as "about 2 days". Switching exactly at 60 and
  // 24 would put "about 1 hour" and "about 1 day" in front of a reader for spans they
  // would rather see in the finer unit.
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `about ${hours} hours`;
  return `about ${Math.round(hours / 24)} days`;
}

/**
 * A range in words, collapsing to a single figure when the bounds round to the same thing.
 *
 * "2 to 2 minutes" reads as a bug, and printing a range whose ends are indistinguishable
 * suggests a precision the estimate does not have in either direction.
 */
export function formatRange(lowMs: number, highMs: number): string {
  // Guarded the same way formatDuration is, and for the same reason: this is exported
  // arithmetic, and "NaN to NaN minutes" in front of a client is worse than saying nothing
  // useful. A range with no usable bounds is a range nobody can act on.
  if (!Number.isFinite(lowMs) || !Number.isFinite(highMs)) return 'an unknown amount of time';
  const low = Math.round(lowMs / 60_000);
  const high = Math.round(highMs / 60_000);
  if (high <= 1) return 'under a minute';
  if (low === high || low <= 0) return `about ${high} minutes`;
  return `${low} to ${high} minutes`;
}

/**
 * Where a run is and how much longer it has.
 *
 * `now` is a parameter rather than a call to the clock so callers can be tested and so a
 * report rendered later can describe a run as it stood at a chosen instant.
 */
export function estimateProgress(snapshot: ProgressSnapshot, now: number): ProgressEstimate {
  const groups = groupsFrom(snapshot);
  const history = (snapshot.progress_history || []).filter((event) => event && Number.isFinite(event.at));
  const stage = snapshot.progress_stage || 'queued';
  const started = Number(snapshot.progress_started_at)
    || (history.length ? history[0].at : 0)
    || Number(snapshot.created_at)
    || now;
  const elapsedMs = Math.max(0, now - started);

  const total = STAGES.reduce((sum, _entry, index) => sum + costOf(index, groups), 0);

  // A finished run reports the truth it has rather than a forecast: its real elapsed time,
  // a full bar and no time remaining. Every branch below assumes a live run.
  if (TERMINAL_STAGES.has(stage) || snapshot.status === 'COMPLETED' || snapshot.status === 'FAILED') {
    const failed = stage === 'failed' || snapshot.status === 'FAILED';
    // How far a stopped run actually got.
    //
    // `stage` is 'failed' here, which is not a stage of the work and carries no position, so
    // the position has to come from the last recognised entry on the trail. Reporting
    // STAGE_COUNT instead described a run the watchdog killed during pricing as "step 6 of
    // 6" — a correct sentence ("Stopped before finishing") beside a number saying it
    // finished, and the number is the part a progress bar draws.
    //
    // The bar stops where the run stopped for the same reason: the completed weight only,
    // with the stage it died in counted as unfinished, and capped below full so a stopped
    // run can never render as a complete one.
    // The row's own stage first, the trail only as a fallback. `failIfStale` flips the
    // status of a row it declares dead and leaves the live stage in place, so a run killed
    // mid-pricing arrives here as pricing + FAILED — the position is sitting on the row, and
    // reading the trail instead would ignore the better answer of the two. The trail covers
    // the other shape, where `stage` is the bare 'failed' the orchestrator writes.
    const reached = failed
      ? (stageIndex(stage) >= 0 ? stageIndex(stage) : lastRecognisedStage(history))
      : -1;
    const stoppedFraction = reached < 0
      ? 0
      : Math.min(0.97, STAGES.slice(0, reached).reduce((sum, _e, i) => sum + costOf(i, groups), 0) / total);
    return {
      stage,
      stageLabel: failed ? 'Stopped before finishing' : 'Estimate ready',
      stageNumber: failed && reached >= 0 ? reached + 1 : STAGE_COUNT,
      stageCount: STAGE_COUNT,
      elapsedMs,
      fraction: failed ? stoppedFraction : 1,
      remainingLowMs: 0,
      remainingHighMs: 0,
      stalled: false,
      confidence: 'high',
      prose: failed
        ? `The run stopped after ${formatDuration(elapsedMs)}.`
        : `Finished in ${formatDuration(elapsedMs)}.`,
    };
  }

  const index = stageIndex(stage);
  const { factor, observed } = calibration(history, groups);

  // Before the worker writes its first stage there is nothing to calibrate against and no
  // position to report, so the whole run is quoted at nominal and the confidence says so.
  if (index < 0) {
    const low = total * 0.7;
    const high = total * 1.9;
    return {
      stage,
      stageLabel: stage === 'queued' ? 'Waiting for a worker' : (snapshot.progress_message || 'Working'),
      stageNumber: 1,
      stageCount: STAGE_COUNT,
      elapsedMs,
      fraction: 0,
      remainingLowMs: low,
      remainingHighMs: high,
      stalled: now - Number(snapshot.updated_at || started) > SILENCE_BEFORE_DOUBT_MS,
      confidence: 'low',
      prose: `Waiting to start — the whole estimate usually takes ${formatRange(low, high)}.`,
    };
  }

  const entry = STAGES[index];
  const stageStarted = Number(snapshot.progress_stage_started_at)
    || (history.length ? history[history.length - 1].at : started);
  const inStageMs = Math.max(0, now - stageStarted);
  const stageCost = costOf(index, groups) * factor;

  // Work still to do: the unfinished remainder of this stage, plus every stage after it.
  // The current stage's remainder floors at zero rather than going negative, because a
  // stage overrunning its estimate must not be able to buy back time from the stages that
  // have not started — that is how a countdown ends up frozen at "one minute left".
  let remaining = Math.max(0, stageCost - inStageMs);
  for (let i = index + 1; i < STAGES.length; i += 1) remaining += costOf(i, groups) * factor;

  // A stage that has already outrun its own estimate is evidence about itself, so the
  // floor grows with the overrun instead of promising an imminent finish.
  const overrun = Math.max(0, inStageMs - stageCost);
  remaining = Math.max(remaining, overrun * 0.5 + 5_000);

  const remainingLowMs = remaining / entry.spread;
  const remainingHighMs = remaining * entry.spread;

  // Fraction from completed weight plus the observed part of the current stage, capped
  // just under full so a live run never renders as finished. Capping the within-stage part
  // at the stage's own weight is what keeps it monotonic across polls: without it, an
  // overrunning stage would push the bar past the next stage's start and then jump back.
  const done = STAGES.slice(0, index).reduce((sum, _e, i) => sum + costOf(i, groups), 0);
  const within = Math.min(costOf(index, groups), inStageMs / Math.max(1, factor));
  const fraction = Math.min(0.97, Math.max(0, (done + within) / total));

  const silentFor = now - Number(snapshot.updated_at || stageStarted);
  const stalled = silentFor > SILENCE_BEFORE_DOUBT_MS;

  const confidence: ProgressEstimate['confidence'] = observed >= 3 ? 'high' : observed >= 1 ? 'medium' : 'low';
  const label = entry.label;

  const prose = stalled
    ? `Still on "${label}" with no update for ${formatDuration(silentFor)}. It may have stopped; `
      + 'the estimate will be marked failed automatically if nothing more arrives.'
    : `${label} — step ${index + 1} of ${STAGE_COUNT}, ${formatRange(remainingLowMs, remainingHighMs)} left.`;

  return {
    stage,
    stageLabel: label,
    stageNumber: index + 1,
    stageCount: STAGE_COUNT,
    elapsedMs,
    fraction,
    remainingLowMs,
    remainingHighMs,
    stalled,
    confidence,
    prose,
  };
}

/**
 * Appends a stage to a history trail, returning the fields a record update should write.
 *
 * Kept here beside the reader so the two cannot drift: the estimate's accuracy depends
 * entirely on `progress_stage_started_at` being stamped at the same instant as the entry
 * appended to the trail, and that invariant is easy to break from a caller that only
 * remembers one of them.
 *
 * Trims from the FRONT when the trail hits its cap. The early stages are the least useful
 * ones to keep once a run is deep into pricing, and dropping the newest instead would
 * freeze the reported position — which is the one thing the trail is read for.
 */
export function appendProgress(
  history: ProgressEvent[] | undefined,
  event: ProgressEvent,
  cap = 80,
): { progress_stage: string; progress_message?: string; progress_stage_started_at: number; progress_history: ProgressEvent[] } {
  const trail = [...(history || []), event];
  return {
    progress_stage: event.stage,
    ...(event.message ? { progress_message: event.message } : {}),
    progress_stage_started_at: event.at,
    progress_history: trail.length > cap ? trail.slice(trail.length - cap) : trail,
  };
}
