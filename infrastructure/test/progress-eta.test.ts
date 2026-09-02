import {
  STAGE_COUNT,
  appendProgress,
  estimateProgress,
  formatDuration,
  formatRange,
  type ProgressEstimate,
  type ProgressEvent,
  type ProgressSnapshot,
} from '../lambdas/shared/progress-eta';

/**
 * The progress estimate a user watches while an AWS cost estimate is being built.
 *
 * The module's own premise is that a confidently wrong countdown is worse than no
 * countdown, because once the number has lied the user can no longer tell a slow run from
 * a hung one. That makes the interesting properties here about honesty rather than
 * accuracy, and they are all falsifiable:
 *
 *  - the bar never moves backwards, however badly a stage overruns;
 *  - a run that is still going never renders as finished;
 *  - a stage past its estimate reports MORE time left, not less;
 *  - a run that is over reports its real elapsed time instead of a forecast;
 *  - a row nobody has written to stops quoting a time at all.
 *
 * Every case passes an explicit `now`. The module takes the clock as a parameter precisely
 * so this file can walk a run instant by instant, and a `Date.now()` anywhere in here would
 * make the timeline tests non-reproducible for the sake of saving one constant.
 */

const T0 = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60_000;

/**
 * The read-time watchdog's threshold, copied from `calculator-routes.ts:394`.
 *
 * Duplicated rather than imported because importing that module drags the whole API handler
 * (and its DynamoDB clients) into this test. It is here to pin an ORDERING the module
 * documents at `progress-eta.ts:141-148`: doubt must arrive before the watchdog destroys a
 * status, so there is a window where the prose has stopped promising a finish while the run
 * is still allowed to recover.
 */
const WATCHDOG_STALE_AFTER_MS = 11 * MINUTE;

/**
 * The record as the orchestrator would actually have written it after emitting `events`.
 *
 * Folded through `appendProgress` rather than assembled by hand, because that is exactly
 * what `recordStage` (`calculator-orchestrator/index.ts:104`) does — so no fixture here can
 * describe a row shape the writer never produces. `updated_at` is the last event's instant
 * for the same reason: `patch` stamps it on every write and nothing else touches the row,
 * so a row genuinely IS silent for the whole length of a slow stage.
 */
const recordAfter = (events: ProgressEvent[], overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot => {
  let written: ReturnType<typeof appendProgress> | undefined;
  for (const event of events) written = appendProgress(written?.progress_history, event);

  return {
    status: 'PROCESSING',
    progress_started_at: events[0].at,
    created_at: events[0].at - 2 * SECOND,
    updated_at: events[events.length - 1].at,
    // 10 rows, which the module folds to 6 priced groups.
    resource_count: 10,
    ...written,
    ...overrides,
  };
};

/**
 * A row parked in one stage: the worker entered `stage` at T0 and has written nothing since.
 *
 * No history, so the calibration factor is 1 and the arithmetic under test is the nominal
 * stage table rather than a recalibration. `updated_at` deliberately stays at T0 because
 * that is the truth about a parked row — the module is then entitled to call it stalled.
 */
const parkedIn = (stage: string, forMs: number, overrides: Partial<ProgressSnapshot> = {}): ProgressEstimate =>
  estimateProgress({
    status: 'PROCESSING',
    progress_stage: stage,
    progress_started_at: T0,
    progress_stage_started_at: T0,
    updated_at: T0,
    resource_count: 10,
    ...overrides,
  }, T0 + forMs);

/** The six real pipeline stages, in the order the pipeline emits them. */
const LIVE_STAGES = ['connecting', 'grouping', 'classifying', 'pricing', 'saving', 'narrating'];

/**
 * A realistic 10-row run, stage by stage, with the messages the pipeline sends.
 *
 * The durations are close to nominal for six groups on purpose: this fixture is used for the
 * monotonicity walk, and a run that also stresses the recalibration clamp would make a
 * failure ambiguous between the two.
 */
const NORMAL_RUN: ProgressEvent[] = [
  { stage: 'connecting', message: 'Loading AWS service catalogue', at: T0 },
  { stage: 'grouping', message: 'Folding 10 rows', at: T0 + 13 * SECOND },
  { stage: 'classifying', message: 'Matching 6 groups to services', at: T0 + 16 * SECOND },
  { stage: 'pricing', message: 'Pricing 6 groups from live AWS rates', at: T0 + 34 * SECOND },
  { stage: 'saving', message: 'Building the shareable estimate', at: T0 + 46 * SECOND },
  { stage: 'narrating', message: 'Writing up assumptions', at: T0 + 84 * SECOND },
];
const NORMAL_RUN_ENDED_AT = T0 + 99 * SECOND;

/**
 * Every poll the view page would make over a whole run, in order.
 *
 * Four samples per stage rather than one, because monotonicity is a property of successive
 * polls: a single reading per stage would miss a bar that climbs within a stage and then
 * drops at the boundary, which is the failure the module's cap exists to prevent.
 */
const pollsAcross = (run: ProgressEvent[], endedAt: number): Array<{ label: string; snapshot: ProgressSnapshot; now: number }> => {
  const polls: Array<{ label: string; snapshot: ProgressSnapshot; now: number }> = [];
  run.forEach((event, index) => {
    const nextAt = index + 1 < run.length ? run[index + 1].at : endedAt;
    const snapshot = recordAfter(run.slice(0, index + 1));
    for (const through of [0, 0.25, 0.6, 0.95]) {
      const now = Math.round(event.at + (nextAt - event.at) * through);
      polls.push({ label: `${event.stage} +${now - event.at}ms`, snapshot, now });
    }
  });
  return polls;
};

describe('The bar only ever moves forwards, whatever the run does', () => {
  test('a whole run polled four times per stage never reports a smaller fraction than the poll before', () => {
    const regressions: string[] = [];
    let previous = -1;
    let previousLabel = 'before the worker started';

    for (const poll of pollsAcross(NORMAL_RUN, NORMAL_RUN_ENDED_AT)) {
      const { fraction } = estimateProgress(poll.snapshot, poll.now);
      if (fraction < previous) regressions.push(`${poll.label} fell to ${fraction} from ${previous} at ${previousLabel}`);
      previous = fraction;
      previousLabel = poll.label;
    }

    expect(regressions).toEqual([]);
    // And it did actually climb — a bar frozen at 0 would satisfy monotonicity trivially.
    expect(previous).toBe(0.97);
  });

  test('a stage held far past its estimate stops at where the next stage begins instead of overshooting and snapping back', () => {
    // classifying is step 3 and nominally ~16s for six groups. Held for twenty minutes it has
    // outrun itself by two orders of magnitude, which is exactly when an uncapped
    // within-stage term would push the bar into pricing's territory and then jump backwards
    // the moment pricing actually started.
    const enteredClassifying = NORMAL_RUN[2].at;
    const stillClassifying = recordAfter(NORMAL_RUN.slice(0, 3));
    const holds = [1 * SECOND, 10 * SECOND, 60 * SECOND, 5 * MINUTE, 20 * MINUTE];

    // Where the bar will be the instant the next stage is entered, asked of the module rather
    // than computed here, so the assertion cannot drift from the stage table.
    const advancedAt = enteredClassifying + 20 * MINUTE;
    const pricingJustStarted = estimateProgress(
      recordAfter([...NORMAL_RUN.slice(0, 3), { stage: 'pricing', at: advancedAt }]),
      advancedAt,
    );

    let previous = 0;
    for (const held of holds) {
      const { fraction } = estimateProgress(stillClassifying, enteredClassifying + held);
      expect(fraction).toBeGreaterThanOrEqual(previous);
      expect(fraction).toBeLessThanOrEqual(pricingJustStarted.fraction);
      previous = fraction;
    }

    // The held stage converges on the next stage's start rather than stopping short of it,
    // so advancing is continuous in both directions: no jump forward, no jump back.
    expect(previous).toBeCloseTo(pricingJustStarted.fraction, 10);
    expect(pricingJustStarted.stageNumber).toBe(4);
  });

  test('the reported step advances one stage at a time and never exceeds the stage count', () => {
    const seen = pollsAcross(NORMAL_RUN, NORMAL_RUN_ENDED_AT).map((poll) => estimateProgress(poll.snapshot, poll.now));

    expect(seen.map((estimate) => estimate.stageNumber)).toEqual([
      1, 1, 1, 1,
      2, 2, 2, 2,
      3, 3, 3, 3,
      4, 4, 4, 4,
      5, 5, 5, 5,
      6, 6, 6, 6,
    ]);
    for (const estimate of seen) {
      // 1-based, so the first stage is "step 1 of 6" and not "step 0 of 6".
      expect(estimate.stageNumber).toBeGreaterThanOrEqual(1);
      expect(estimate.stageNumber).toBeLessThanOrEqual(estimate.stageCount);
      expect(estimate.stageCount).toBe(STAGE_COUNT);
    }
  });

  test('elapsed time is measured from the worker starting, not from the row being created', () => {
    // The queue wait between created_at and progress_started_at belongs to nobody's stage;
    // charging it to connecting would make the stage users most suspect of hanging look
    // slower than it is (calculator-orchestrator/index.ts:110-115).
    const queuedForTenSeconds = recordAfter(NORMAL_RUN.slice(0, 1), { created_at: T0 - 10 * SECOND });

    expect(estimateProgress(queuedForTenSeconds, T0 + 5 * SECOND).elapsedMs).toBe(5 * SECOND);
  });
});

describe('A run that has not finished is never reported as finished', () => {
  test.each(LIVE_STAGES)('a run sitting in %s for half an hour still shows itself short of complete', (stage) => {
    const estimate = parkedIn(stage, 30 * MINUTE);

    expect(estimate.fraction).toBeLessThan(1);
    // The explicit ceiling the module caps at, so a full-looking bar always means finished.
    expect(estimate.fraction).toBeLessThanOrEqual(0.97);
    expect(estimate.remainingLowMs).toBeGreaterThan(0);
    expect(estimate.remainingHighMs).toBeGreaterThan(0);
  });

  test.each(LIVE_STAGES)('%s still has time left after a full day parked in it', (stage) => {
    // Not a realistic run, but the property has to hold at the extreme too: any path that
    // lets remaining reach zero on a live run puts a permanent "any moment now" on the page.
    const estimate = parkedIn(stage, 24 * 60 * MINUTE);

    expect(estimate.remainingLowMs).toBeGreaterThan(0);
    expect(estimate.remainingHighMs).toBeGreaterThan(estimate.remainingLowMs);
    expect(estimate.fraction).toBeLessThan(1);
  });

  test('a row the worker has not touched yet reports no progress and the whole run as remaining', () => {
    const queued = estimateProgress({ status: 'PROCESSING', created_at: T0, resource_count: 10 }, T0 + 2 * SECOND);

    expect(queued.stage).toBe('queued');
    expect(queued.stageLabel).toBe('Waiting for a worker');
    expect(queued.fraction).toBe(0);
    expect(queued.confidence).toBe('low');
    expect(queued.remainingLowMs).toBeGreaterThan(0);
    expect(queued.prose).toBe('Waiting to start — the whole estimate usually takes 1 to 3 minutes.');
  });

  test('the low bound is always below the high bound, so the range never reads inverted', () => {
    for (const stage of [...LIVE_STAGES, 'queued', 'polishing']) {
      for (const held of [0, 1 * SECOND, 30 * SECOND, 4 * MINUTE, 20 * MINUTE]) {
        const estimate = parkedIn(stage, held);
        expect(estimate.remainingHighMs).toBeGreaterThan(estimate.remainingLowMs);
      }
    }
  });
});

describe('A stage past its estimate reports more time left, not less', () => {
  /**
   * `saving` is the right stage for this: its one MCP call is allowed three minutes before
   * giving up, so a save that is going badly really does sit there for minutes, and it is the
   * stage where a countdown frozen at "one minute left" would be seen most often.
   */
  const savingHeldFor = (ms: number) => parkedIn('saving', ms);

  test('a save held well past nominal grows its upper bound rather than shrinking towards zero', () => {
    const holds = [60 * SECOND, 2 * MINUTE, 3 * MINUTE, 5 * MINUTE, 10 * MINUTE, 30 * MINUTE];
    const highs = holds.map((held) => savingHeldFor(held).remainingHighMs);

    for (let i = 1; i < highs.length; i += 1) {
      expect(highs[i]).toBeGreaterThan(highs[i - 1]);
    }

    // Against floors, not merely against zero: at ten minutes in, the honest answer is
    // "minutes more", and anything under a minute here would be the frozen countdown.
    expect(savingHeldFor(5 * MINUTE).remainingHighMs).toBeGreaterThan(4 * MINUTE);
    expect(savingHeldFor(10 * MINUTE).remainingHighMs).toBeGreaterThan(10 * MINUTE);
    expect(savingHeldFor(30 * MINUTE).remainingHighMs).toBeGreaterThan(30 * MINUTE);
  });

  test('an overrunning stage does not buy back time from the stages that have not started', () => {
    // narrating is the last stage, so there is nothing after it to borrow from: whatever the
    // overrun, the answer has to come from the overrun itself.
    const holds = [30 * SECOND, 2 * MINUTE, 10 * MINUTE];
    const lows = holds.map((held) => parkedIn('narrating', held).remainingLowMs);

    expect(lows[1]).toBeGreaterThan(lows[0]);
    expect(lows[2]).toBeGreaterThan(lows[1]);
    expect(parkedIn('narrating', 10 * MINUTE).remainingLowMs).toBeGreaterThan(2 * MINUTE);
  });

  test('an early stage that overruns never quotes less than the work still ahead of it, and grows past that once the overrun outweighs it', () => {
    /**
     * The shape differs for an early stage, and it is worth pinning: `classifying` is step 3,
     * so 62.9s of pricing, saving and narrating sit behind it whatever it does. The quoted
     * time therefore falls to that floor as the stage consumes its own estimate, sits there,
     * and then climbs once half the overrun exceeds it. What it never does is approach zero —
     * the "one minute left" that never arrives is impossible in either regime.
     */
    const holds = [20 * SECOND, 60 * SECOND, 2 * MINUTE, 5 * MINUTE, 15 * MINUTE];
    const remainings = holds.map((held) => parkedIn('classifying', held).remainingHighMs);

    for (let i = 1; i < remainings.length; i += 1) {
      expect(remainings[i]).toBeGreaterThanOrEqual(remainings[i - 1]);
    }
    // The three stages after classifying cost 62,900ms at nominal, and the quoted upper bound
    // is never below that however long the stage runs.
    for (const remaining of remainings) expect(remaining).toBeGreaterThan(62_900);
    // A quarter of an hour in, the answer is measured in many minutes, not in seconds.
    expect(parkedIn('classifying', 15 * MINUTE).remainingHighMs).toBeGreaterThan(12 * MINUTE);
  });

  test('the run that has overrun is the one quoted the longer time, holding everything else equal', () => {
    // Same stage, same workload, same calibration: the only difference is how long the
    // current stage has been going. The ordering must follow.
    const briefly = parkedIn('pricing', 5 * SECOND);
    const forAges = parkedIn('pricing', 15 * MINUTE);

    expect(forAges.remainingHighMs).toBeGreaterThan(briefly.remainingHighMs);
    expect(forAges.remainingLowMs).toBeGreaterThan(briefly.remainingLowMs);
  });
});

describe('A run that is over reports what happened instead of a forecast', () => {
  const finishedIn = (ms: number, overrides: Partial<ProgressSnapshot> = {}): ProgressEstimate =>
    estimateProgress({
      status: 'COMPLETED',
      progress_stage: 'done',
      progress_started_at: T0,
      progress_stage_started_at: T0 + ms,
      updated_at: T0 + ms,
      resource_count: 10,
      ...overrides,
    }, T0 + ms);

  test('a completed run shows a full bar, no time remaining and its real elapsed time', () => {
    const estimate = finishedIn(185 * SECOND);

    expect(estimate.fraction).toBe(1);
    expect(estimate.remainingLowMs).toBe(0);
    expect(estimate.remainingHighMs).toBe(0);
    expect(estimate.confidence).toBe('high');
    expect(estimate.stageLabel).toBe('Estimate ready');
    expect(estimate.elapsedMs).toBe(185 * SECOND);
    expect(estimate.prose).toBe('Finished in about 3 minutes.');
  });

  test('a failed run is equally final, but the sentence says it stopped rather than finished', () => {
    const estimate = estimateProgress({
      status: 'FAILED',
      progress_stage: 'failed',
      progress_started_at: T0,
      updated_at: T0 + 4 * MINUTE,
      resource_count: 10,
    }, T0 + 4 * MINUTE);

    // Not a full bar. A stopped run's bar stops where the run stopped, and this row carries
    // neither a recognised stage nor a trail, so nothing is known to have completed — 0 is
    // the honest reading. A full bar beside "Stopped before finishing" said both at once.
    expect(estimate.fraction).toBe(0);
    expect(estimate.remainingLowMs).toBe(0);
    expect(estimate.remainingHighMs).toBe(0);
    expect(estimate.confidence).toBe('high');
    expect(estimate.stageLabel).toBe('Stopped before finishing');
    expect(estimate.prose).toBe('The run stopped after about 4 minutes.');
    expect(estimate.prose).not.toMatch(/left/);
  });

  test('a row still showing a live stage but marked FAILED is terminal, because that is what the watchdog leaves behind', () => {
    // `failIfStale` (calculator-routes.ts:396) flips only the status, error_message and
    // progress fields of a row it declares dead; a row killed mid-pricing therefore arrives
    // here as pricing + FAILED. Forecasting from the stage would leave a dead run counting
    // down forever, which is the exact lie this module exists to prevent.
    const killedMidPricing = estimateProgress({
      status: 'FAILED',
      progress_stage: 'pricing',
      progress_started_at: T0,
      progress_stage_started_at: T0 + 30 * SECOND,
      updated_at: T0 + 30 * SECOND,
      resource_count: 10,
    }, T0 + 12 * MINUTE);

    expect(killedMidPricing.remainingLowMs).toBe(0);
    expect(killedMidPricing.remainingHighMs).toBe(0);
    expect(killedMidPricing.stageLabel).toBe('Stopped before finishing');
    expect(killedMidPricing.prose).toBe('The run stopped after about 12 minutes.');
    // The stage name is passed through untouched AND the number now agrees with it. Pricing
    // is the fourth of six stages, so a run the watchdog killed there is "step 4 of 6" and
    // its bar stops short. Reporting STAGE_COUNT here described a dead run as having reached
    // the last stage, which is the one number a progress bar actually draws.
    expect(killedMidPricing.stage).toBe('pricing');
    expect(killedMidPricing.stageNumber).toBe(4);
    expect(killedMidPricing.stageNumber).toBeLessThan(STAGE_COUNT);
    expect(killedMidPricing.fraction).toBeGreaterThan(0);
    expect(killedMidPricing.fraction).toBeLessThan(1);
  });

  test('a row marked COMPLETED while still showing a live stage is also terminal', () => {
    // The mirror case: the orchestrator writes the result and the terminal status, and a read
    // that races the trail append sees narrating + COMPLETED. A finished estimate must not
    // report "about a minute left" underneath a downloadable PDF.
    const estimate = estimateProgress({
      status: 'COMPLETED',
      progress_stage: 'narrating',
      progress_started_at: T0,
      progress_stage_started_at: T0 + 80 * SECOND,
      updated_at: T0 + 95 * SECOND,
      resource_count: 10,
    }, T0 + 95 * SECOND);

    expect(estimate.fraction).toBe(1);
    expect(estimate.remainingHighMs).toBe(0);
    expect(estimate.stageLabel).toBe('Estimate ready');
    expect(estimate.prose).toMatch(/^Finished in /);
  });

  test('a terminal run is never also called stalled, so the user is not warned about a run that is already over', () => {
    // A finished estimate opened a week later is silent by any measure. Raising doubt about
    // it would contradict the very status being displayed beside it.
    const aWeekLater = T0 + 7 * 24 * 60 * MINUTE;

    expect(estimateProgress({ status: 'COMPLETED', progress_stage: 'done', progress_started_at: T0, updated_at: T0 + MINUTE }, aWeekLater).stalled).toBe(false);
    expect(estimateProgress({ status: 'FAILED', progress_stage: 'pricing', progress_started_at: T0, updated_at: T0 + MINUTE }, aWeekLater).stalled).toBe(false);
  });

  test('the stage names that mean "over" are terminal even with no status on the row at all', () => {
    // Both stages are terminal — nothing is left to wait for, so both report zero remaining.
    // They differ in how full the bar is, and that difference is the point: a finished run
    // earned its full bar, a stopped one did not. 'failed' with no trail at all cannot say
    // how far the run got, so it claims nothing rather than claiming everything.
    for (const stage of ['done', 'failed']) {
      const estimate = estimateProgress({ progress_stage: stage, progress_started_at: T0 }, T0 + MINUTE);
      expect(estimate.remainingHighMs).toBe(0);
      expect(estimate.fraction).toBe(stage === 'done' ? 1 : 0);
    }
  });
});

describe('The estimate recalibrates against the run in front of it', () => {
  /**
   * Two runs identical but for how long the finished stages took.
   *
   * The stage table's nominal for six groups is 12,000ms of connecting and 3,120ms of
   * grouping — 15,120ms in total — so a history whose first two gaps sum to N x that is a
   * run observed to be N times slower than nominal, and everything still to come should be
   * quoted accordingly.
   */
  const slowByFactorOf = (multiple: number): ProgressSnapshot => {
    const connecting = 12_000 * multiple;
    const grouping = 3_120 * multiple;
    return {
      status: 'PROCESSING',
      progress_stage: 'classifying',
      progress_history: [
        { stage: 'connecting', at: T0 - connecting - grouping },
        { stage: 'grouping', at: T0 - grouping },
        { stage: 'classifying', at: T0 },
      ],
      progress_started_at: T0 - connecting - grouping,
      // Pinned identically across every multiple so the only variable is the history, and
      // the comparison is of calibration rather than of in-stage elapsed time.
      progress_stage_started_at: T0,
      updated_at: T0,
      resource_count: 10,
    };
  };

  const at = (snapshot: ProgressSnapshot) => estimateProgress(snapshot, T0 + 1 * SECOND);

  test('a run whose finished stages took twice as long is quoted more time for the stages still to come', () => {
    const nominal = at(slowByFactorOf(1));
    const twiceAsSlow = at(slowByFactorOf(2));

    expect(twiceAsSlow.remainingLowMs).toBeGreaterThan(nominal.remainingLowMs);
    expect(twiceAsSlow.remainingHighMs).toBeGreaterThan(nominal.remainingHighMs);
    // Roughly the factor itself, since the remaining stages are all multiplied by it.
    expect(twiceAsSlow.remainingHighMs / nominal.remainingHighMs).toBeGreaterThan(1.5);
  });

  test('a run whose finished stages were quick is quoted less, so a fast machine is not held to the slow default', () => {
    const nominal = at(slowByFactorOf(1));
    const halfTheTime = at(slowByFactorOf(0.5));

    expect(halfTheTime.remainingHighMs).toBeLessThan(nominal.remainingHighMs);
    expect(halfTheTime.remainingHighMs).toBeGreaterThan(0);
  });

  test('an absurdly slow history is clamped rather than inflating the forecast without bound', () => {
    // One cold start must not be allowed to rewrite the whole run. The clamp is 4x, so a
    // history a hundred times nominal has to land on exactly the same forecast as one four
    // times nominal — if these two ever diverge, the clamp has been removed or raised.
    const fourTimesSlower = at(slowByFactorOf(4));
    const hundredTimesSlower = at(slowByFactorOf(100));

    expect(hundredTimesSlower.remainingLowMs).toBeCloseTo(fourTimesSlower.remainingLowMs, 6);
    expect(hundredTimesSlower.remainingHighMs).toBeCloseTo(fourTimesSlower.remainingHighMs, 6);
    // And the clamp binds upwards rather than being a no-op at 4x.
    expect(fourTimesSlower.remainingHighMs).toBeGreaterThan(at(slowByFactorOf(1)).remainingHighMs * 2);
  });

  test('an implausibly fast history is clamped at the bottom too, so the estimate cannot collapse to nothing', () => {
    // The floor is 0.5. A history reporting a run a hundred times faster than nominal is a
    // clock artefact, not a machine, and honouring it would quote seconds for a save that
    // has a three-minute ceiling.
    const halfTheTime = at(slowByFactorOf(0.5));
    const hundredthOfTheTime = at(slowByFactorOf(0.01));

    expect(hundredthOfTheTime.remainingHighMs).toBeCloseTo(halfTheTime.remainingHighMs, 6);
  });

  test('with no history at all the forecast is the nominal table and the confidence says so', () => {
    const noEvidence = estimateProgress({
      status: 'PROCESSING',
      progress_stage: 'classifying',
      progress_started_at: T0,
      progress_stage_started_at: T0,
      updated_at: T0,
      resource_count: 10,
    }, T0 + 1 * SECOND);

    expect(noEvidence.confidence).toBe('low');
    // Identical to a history that ran exactly to nominal, which is what "factor 1" means.
    expect(noEvidence.remainingHighMs).toBeCloseTo(at(slowByFactorOf(1)).remainingHighMs, 0);
  });

  test('the stage still running is not counted as a finished one, so its own slowness never rewrites the stages after it', () => {
    /**
     * The last history entry is the stage running NOW, and its elapsed time is not its
     * duration (progress-eta.ts:178-185). Reading it as one would make the ratio lurch the
     * moment a stage is entered — from the 2x these two finished stages measured down to
     * ~1x, because a barely-started stage's elapsed time is being divided by its full
     * nominal cost.
     *
     * The observable consequence: for as long as the running stage's own remainder is spent
     * and its overrun floor has not yet bound, the forecast is EXACTLY the weighted cost of
     * the stages still ahead, and identical at two different in-stage times. If the running
     * stage's elapsed time entered the calibration, these two would differ.
     */
    const twiceAsSlowSoFar: ProgressSnapshot = {
      status: 'PROCESSING',
      progress_stage: 'classifying',
      // 24s of connecting and 6s of grouping against 12s and 3.1s nominal: a 2x run.
      progress_history: [
        { stage: 'connecting', at: T0 },
        { stage: 'grouping', at: T0 + 24 * SECOND },
        { stage: 'classifying', at: T0 + 30 * SECOND },
      ],
      progress_started_at: T0,
      progress_stage_started_at: T0 + 30 * SECOND,
      updated_at: T0 + 30 * SECOND,
      resource_count: 10,
    };

    const oneMinuteIn = estimateProgress(twiceAsSlowSoFar, T0 + 30 * SECOND + 60 * SECOND);
    const twoAndAHalfMinutesIn = estimateProgress(twiceAsSlowSoFar, T0 + 30 * SECOND + 150 * SECOND);

    expect(twoAndAHalfMinutesIn.remainingHighMs).toBe(oneMinuteIn.remainingHighMs);
    // And what remains reflects the 2x those finished stages measured: even the optimistic
    // end of the range exceeds the 62,900ms that pricing, saving and narrating cost at
    // nominal, so the calibration that IS evidence is still being applied.
    expect(oneMinuteIn.remainingLowMs).toBeGreaterThan(62_900);
  });
});

describe('Confidence tracks how much of the run has actually been observed', () => {
  const withTrail = (stages: string[]): ProgressEstimate => {
    const events = stages.map((stage, index) => ({ stage, at: T0 + index * 10 * SECOND }));
    return estimateProgress(recordAfter(events), T0 + (stages.length - 1) * 10 * SECOND + SECOND);
  };

  test('a run whose first stage is still going has observed nothing, so confidence is low', () => {
    // One history entry is zero completed stages, not one: the entry is the stage running now
    // and its duration is not known until the next entry arrives.
    expect(withTrail(['connecting']).confidence).toBe('low');
  });

  test('one and two finished stages are worth medium confidence, three or more high', () => {
    expect(withTrail(['connecting', 'grouping']).confidence).toBe('medium');
    expect(withTrail(['connecting', 'grouping', 'classifying']).confidence).toBe('medium');
    expect(withTrail(['connecting', 'grouping', 'classifying', 'pricing']).confidence).toBe('high');
    expect(withTrail(['connecting', 'grouping', 'classifying', 'pricing', 'saving']).confidence).toBe('high');
  });

  test('the trail length is one ahead of the confidence ladder, because the newest entry is still running', () => {
    // The off-by-one stated directly, since it is the part a reader gets wrong: a page
    // showing "step 4 of 6" is a run with four trail entries and only three finished stages.
    const onStepFour = withTrail(['connecting', 'grouping', 'classifying', 'pricing']);

    expect(onStepFour.stageNumber).toBe(4);
    expect(onStepFour.confidence).toBe('high');

    const onStepThree = withTrail(['connecting', 'grouping', 'classifying']);
    expect(onStepThree.stageNumber).toBe(3);
    expect(onStepThree.confidence).toBe('medium');
  });

  test('two stages stamped in the same millisecond count as nothing observed, since a zero gap is no evidence', () => {
    // Only durations strictly greater than zero are recorded (progress-eta.ts:190), so a
    // pipeline that emits two stages in one tick contributes no calibration rather than a
    // ratio of zero — which would otherwise clamp to the 0.5 floor and halve the forecast.
    const sameInstant = estimateProgress({
      status: 'PROCESSING',
      progress_stage: 'grouping',
      progress_history: [{ stage: 'connecting', at: T0 }, { stage: 'grouping', at: T0 }],
      progress_started_at: T0,
      progress_stage_started_at: T0,
      updated_at: T0,
      resource_count: 10,
    }, T0 + SECOND);

    expect(sameInstant.confidence).toBe('low');
  });

  test('a row with no stage yet is low confidence whatever else it carries', () => {
    expect(estimateProgress({ status: 'PROCESSING', created_at: T0, resource_count: 400 }, T0).confidence).toBe('low');
    expect(estimateProgress({ status: 'PROCESSING', progress_stage: 'polishing', created_at: T0 }, T0).confidence).toBe('low');
  });
});

describe('A silent row stops the countdown before the watchdog kills the run', () => {
  const silentFor = (ms: number): ProgressEstimate => estimateProgress({
    status: 'PROCESSING',
    progress_stage: 'pricing',
    progress_started_at: T0 - 30 * SECOND,
    progress_stage_started_at: T0,
    updated_at: T0,
    resource_count: 10,
  }, T0 + ms);

  test('a row written to seconds ago is not doubted, and the prose still quotes a time', () => {
    const fresh = silentFor(20 * SECOND);

    expect(fresh.stalled).toBe(false);
    expect(fresh.prose).toBe('Pricing from live AWS rates — step 4 of 6, under a minute left.');
  });

  test('the threshold is crossed strictly, so the row on the boundary is still trusted', () => {
    // The module's SILENCE_BEFORE_DOUBT_MS is four minutes (progress-eta.ts:148) and the
    // comparison is `>`. Pinned by behaviour on both sides of the instant rather than by
    // importing the constant, which is deliberately private.
    expect(silentFor(4 * MINUTE).stalled).toBe(false);
    expect(silentFor(4 * MINUTE + 1).stalled).toBe(true);
  });

  test('a stalled row stops quoting a remaining time and says it may have stopped', () => {
    const doubted = silentFor(6 * MINUTE);

    expect(doubted.stalled).toBe(true);
    expect(doubted.prose).toBe(
      'Still on "Pricing from live AWS rates" with no update for about 6 minutes. '
      + 'It may have stopped; the estimate will be marked failed automatically if nothing more arrives.',
    );
    // The countdown is gone from the sentence entirely — not softened, absent.
    expect(doubted.prose).not.toMatch(/left/);
    expect(doubted.prose).not.toMatch(/\bstep \d of \d\b/);
  });

  test('doubt arrives while the run can still recover, ahead of the watchdog that would mark it failed', () => {
    // The ordering the module documents at progress-eta.ts:141-148. At six minutes of
    // silence the prose has stopped promising a finish, but failIfStale has not yet touched
    // the status: warning early is cheap, and a countdown ticking on a dead run is not.
    const doubtedButAlive = silentFor(6 * MINUTE);

    expect(doubtedButAlive.stalled).toBe(true);
    expect(6 * MINUTE).toBeLessThan(WATCHDOG_STALE_AFTER_MS);
    // And the numbers are still there for a caller that wants them; only the prose changed.
    expect(doubtedButAlive.remainingHighMs).toBeGreaterThan(0);
    expect(doubtedButAlive.fraction).toBeLessThan(1);
  });

  test('the position on the bar is unaffected by doubt, so a recovering worker does not rewind the page', () => {
    const trusted = silentFor(4 * MINUTE);
    const doubted = silentFor(4 * MINUTE + 1);

    expect(doubted.fraction).toBeGreaterThanOrEqual(trusted.fraction);
    expect(doubted.stageNumber).toBe(trusted.stageNumber);
  });

  test('a row that has never been written to is judged on when its stage began', () => {
    // No updated_at at all — the fallback is the stage start, so a run whose stage began ten
    // minutes ago is doubted rather than being given the benefit of the missing field.
    const noUpdatedAt = estimateProgress({
      status: 'PROCESSING',
      progress_stage: 'saving',
      progress_started_at: T0,
      progress_stage_started_at: T0,
      resource_count: 10,
    }, T0 + 10 * MINUTE);

    expect(noUpdatedAt.stalled).toBe(true);
  });

  test('a queued row that nothing has picked up is doubted on the same threshold', () => {
    // Before any stage is written the run has no position, but an async invoke that was lost
    // is exactly as dead as a worker that stopped mid-stage.
    const neverPickedUp = estimateProgress({ status: 'PROCESSING', created_at: T0, resource_count: 10 }, T0 + 5 * MINUTE);

    expect(neverPickedUp.stalled).toBe(true);
    expect(estimateProgress({ status: 'PROCESSING', created_at: T0, resource_count: 10 }, T0 + 2 * MINUTE).stalled).toBe(false);
  });
});

describe('A bigger inventory takes longer, but not proportionally longer', () => {
  const wholeRunHighMs = (resourceCount: number) => estimateProgress({ status: 'PROCESSING', created_at: T0, resource_count: resourceCount }, T0).remainingHighMs;

  test('four hundred rows is quoted longer than ten, because pricing and saving scale with the workload', () => {
    expect(wholeRunHighMs(400)).toBeGreaterThan(wholeRunHighMs(10));
  });

  test('forty times the rows is nowhere near forty times the time, because identical rows fold into one group', () => {
    // The damping is the whole point: a sheet of two hundred identical web servers is one
    // priced group and costs what one costs. Quoting it linearly would put an hour on the
    // page for a run that takes three minutes, and nobody would wait for it.
    const tenRows = wholeRunHighMs(10);
    const fourHundredRows = wholeRunHighMs(400);

    expect(fourHundredRows).toBeLessThan(tenRows * 3);
    expect(fourHundredRows).toBeLessThan(tenRows * 40 * 0.1);
  });

  test('the quoted time rises with the row count and never falls', () => {
    const counts = [0, 1, 5, 10, 50, 200, 400, 2_000];
    const highs = counts.map(wholeRunHighMs);

    for (let i = 1; i < highs.length; i += 1) {
      expect(highs[i]).toBeGreaterThanOrEqual(highs[i - 1]);
    }
  });

  test('a one-row sheet is not quoted as zero work, because the floor is one group', () => {
    // Without the floor of 1 the workload-dependent terms collapse and a single-row estimate
    // is quoted as if pricing and saving were free.
    expect(wholeRunHighMs(1)).toBe(wholeRunHighMs(0));
    expect(wholeRunHighMs(1)).toBeGreaterThan(60 * SECOND);
  });

  test('the workload only stretches the stages whose cost genuinely depends on it', () => {
    // narrating is one fixed model call, so four hundred rows must not make it look longer;
    // pricing makes one Price List query per group, so it must.
    const narratingSmall = parkedIn('narrating', SECOND, { resource_count: 10 });
    const narratingLarge = parkedIn('narrating', SECOND, { resource_count: 400 });
    const pricingSmall = parkedIn('pricing', SECOND, { resource_count: 10 });
    const pricingLarge = parkedIn('pricing', SECOND, { resource_count: 400 });

    expect(narratingLarge.remainingHighMs).toBeCloseTo(narratingSmall.remainingHighMs, 6);
    expect(pricingLarge.remainingHighMs).toBeGreaterThan(pricingSmall.remainingHighMs);
  });

  test('a garbage row count is read as the smallest workload rather than throwing', () => {
    for (const count of [NaN, -50, Infinity, undefined, null, 'lots'] as unknown as number[]) {
      expect(() => estimateProgress({ progress_stage: 'pricing', resource_count: count }, T0)).not.toThrow();
    }
    // A NaN, a negative and an unreadable count all coerce to the one-group floor, so a bad
    // cell in a spreadsheet cannot make the estimate quote nonsense.
    expect(wholeRunHighMs(NaN)).toBe(wholeRunHighMs(0));
    expect(wholeRunHighMs(-50)).toBe(wholeRunHighMs(0));
    expect(wholeRunHighMs('lots' as unknown as number)).toBe(wholeRunHighMs(0));
    // Infinity is the one input NOT clamped: it propagates through every term and the prose
    // renders "about Infinity minutes". Left unasserted rather than pinned as correct — see
    // the report on this file. It is unreachable from a stored record, because a DynamoDB
    // number cannot hold Infinity.
  });
});

describe('A record missing the fields this module wants degrades instead of throwing', () => {
  test('an empty record is described as queued rather than crashing the poll route', () => {
    // The poll route calls this on every read (calculator-routes.ts:509), so a throw here is
    // a 500 on a page whose only job is to show that a run is still going.
    const estimate = estimateProgress({}, T0);

    expect(estimate.stage).toBe('queued');
    expect(estimate.stageNumber).toBe(1);
    expect(estimate.stageCount).toBe(STAGE_COUNT);
    expect(estimate.elapsedMs).toBe(0);
    expect(estimate.fraction).toBe(0);
    expect(estimate.stalled).toBe(false);
    expect(estimate.remainingHighMs).toBeGreaterThan(0);
  });

  test('a stage this module has never heard of degrades to an unknown position, not an exception', () => {
    // The stage table and the pipeline's onProgress calls are two lists meant to be kept in
    // step (progress-eta.ts:105-109). When they drift, the run must still render.
    const unknown = estimateProgress({
      status: 'PROCESSING',
      progress_stage: 'polishing',
      progress_message: 'Polishing the estimate',
      progress_started_at: T0,
      updated_at: T0,
      resource_count: 10,
    }, T0 + 30 * SECOND);

    expect(unknown.stage).toBe('polishing');
    // The pipeline's own message is shown, since the module has no label for the stage.
    expect(unknown.stageLabel).toBe('Polishing the estimate');
    expect(unknown.fraction).toBe(0);
    expect(unknown.confidence).toBe('low');
    expect(unknown.remainingLowMs).toBeGreaterThan(0);
    expect(unknown.prose).toMatch(/^Waiting to start/);
  });

  test('an unknown stage with no message falls back to a neutral word rather than an empty label', () => {
    const unlabelled = estimateProgress({ progress_stage: 'polishing', progress_started_at: T0 }, T0);

    expect(unlabelled.stageLabel).toBe('Working');
  });

  test('history entries with a missing or unreadable timestamp are skipped, not arithmetic-poisoned', () => {
    // DynamoDB will return whatever was written, and one NaN reaching the calibration would
    // turn every number in the response into NaN — a blank bar and a blank sentence.
    const corrupted = estimateProgress({
      status: 'PROCESSING',
      progress_stage: 'pricing',
      progress_history: [
        { stage: 'connecting', at: T0 },
        { stage: 'grouping', at: NaN },
        { stage: 'classifying', at: undefined as unknown as number },
        { stage: 'pricing', at: T0 + 40 * SECOND },
      ],
      progress_started_at: T0,
      progress_stage_started_at: T0 + 40 * SECOND,
      updated_at: T0 + 40 * SECOND,
      resource_count: 10,
    }, T0 + 50 * SECOND);

    expect(Number.isFinite(corrupted.fraction)).toBe(true);
    expect(Number.isFinite(corrupted.remainingLowMs)).toBe(true);
    expect(Number.isFinite(corrupted.remainingHighMs)).toBe(true);
    // Two readable entries survive, which is one completed stage: medium, not high.
    expect(corrupted.confidence).toBe('medium');
  });

  test('a null entry in the trail is survived too', () => {
    const withHole = estimateProgress({
      progress_stage: 'grouping',
      progress_history: [null as unknown as ProgressEvent, { stage: 'grouping', at: T0 }],
      progress_stage_started_at: T0,
      updated_at: T0,
    }, T0 + SECOND);

    expect(Number.isFinite(withHole.fraction)).toBe(true);
    expect(withHole.stageNumber).toBe(2);
  });

  describe('the documented order of fallbacks for when the run started', () => {
    const elapsedOn = (snapshot: ProgressSnapshot, now: number) => estimateProgress({ progress_stage: 'done', ...snapshot }, now).elapsedMs;

    test('progress_started_at wins over the trail and over created_at', () => {
      expect(elapsedOn({
        progress_started_at: T0 + 5 * SECOND,
        progress_history: [{ stage: 'connecting', at: T0 + 1 * SECOND }],
        created_at: T0,
      }, T0 + 65 * SECOND)).toBe(60 * SECOND);
    });

    test('without it the first history entry is used, so the trail stands in for the missing stamp', () => {
      expect(elapsedOn({
        progress_history: [{ stage: 'connecting', at: T0 + 1 * SECOND }, { stage: 'grouping', at: T0 + 20 * SECOND }],
        created_at: T0,
      }, T0 + 61 * SECOND)).toBe(60 * SECOND);
    });

    test('the first READABLE history entry is used, since the unreadable ones were dropped', () => {
      expect(elapsedOn({
        progress_history: [{ stage: 'connecting', at: NaN }, { stage: 'grouping', at: T0 + 1 * SECOND }],
        created_at: T0,
      }, T0 + 61 * SECOND)).toBe(60 * SECOND);
    });

    test('with no trail at all it falls back to when the row was created', () => {
      expect(elapsedOn({ created_at: T0 }, T0 + 60 * SECOND)).toBe(60 * SECOND);
    });

    test('with nothing to go on it reports no elapsed time rather than a nonsense age', () => {
      // The last resort is `now`, which reads as zero elapsed. Anything else — 0, or a
      // coerced NaN — would render as "Finished in about 28000000 minutes" on a row whose
      // timestamps were never written.
      expect(elapsedOn({}, T0 + 60 * SECOND)).toBe(0);
    });
  });

  test('a stage with no stage-start stamp falls back to the newest trail entry, then to the run start', () => {
    // The two are stamped together by appendProgress, so a row missing only the stamp came
    // from an older writer or a hand-patched row; the newest trail entry is the same instant.
    const fromTrail = estimateProgress({
      progress_stage: 'pricing',
      progress_history: [{ stage: 'connecting', at: T0 }, { stage: 'pricing', at: T0 + 30 * SECOND }],
      progress_started_at: T0,
      updated_at: T0 + 30 * SECOND,
      resource_count: 10,
    }, T0 + 40 * SECOND);
    const fromStamp = estimateProgress({
      progress_stage: 'pricing',
      progress_history: [{ stage: 'connecting', at: T0 }, { stage: 'pricing', at: T0 + 30 * SECOND }],
      progress_stage_started_at: T0 + 30 * SECOND,
      progress_started_at: T0,
      updated_at: T0 + 30 * SECOND,
      resource_count: 10,
    }, T0 + 40 * SECOND);

    expect(fromTrail.remainingHighMs).toBeCloseTo(fromStamp.remainingHighMs, 6);

    const noTrailEither = estimateProgress({
      progress_stage: 'pricing',
      progress_started_at: T0,
      updated_at: T0,
      resource_count: 10,
    }, T0 + 40 * SECOND);
    expect(Number.isFinite(noTrailEither.remainingHighMs)).toBe(true);
    expect(noTrailEither.remainingHighMs).toBeGreaterThan(0);
  });

  test('a now earlier than the timestamps on the row clamps to zero instead of going negative', () => {
    // Clock skew between the worker's Date.now() and the reader's is real, and a negative
    // elapsed time would print as a bar in the wrong direction.
    const skewed = estimateProgress({
      status: 'PROCESSING',
      progress_stage: 'pricing',
      progress_started_at: T0,
      progress_stage_started_at: T0,
      updated_at: T0,
      resource_count: 10,
    }, T0 - 30 * SECOND);

    expect(skewed.elapsedMs).toBe(0);
    expect(skewed.fraction).toBeGreaterThanOrEqual(0);
    expect(skewed.stalled).toBe(false);
    expect(skewed.remainingHighMs).toBeGreaterThan(0);
  });

  test('every field of the estimate is a usable value for every shape of record', () => {
    const shapes: ProgressSnapshot[] = [
      {},
      { status: 'PROCESSING' },
      { progress_stage: '' },
      { progress_stage: 'polishing', progress_history: [] },
      { progress_stage: 'saving', progress_history: [{ stage: 'saving', at: T0 }] },
      { status: 'FAILED' },
      { status: 'COMPLETED' },
      { progress_stage: 'done', resource_count: 100_000 },
      { progress_stage: 'connecting', progress_started_at: 0, created_at: 0, updated_at: 0 },
    ];

    for (const shape of shapes) {
      const estimate = estimateProgress(shape, T0);

      expect(typeof estimate.stage).toBe('string');
      expect(estimate.stageLabel.length).toBeGreaterThan(0);
      expect(estimate.stageNumber).toBeGreaterThanOrEqual(1);
      expect(estimate.stageNumber).toBeLessThanOrEqual(estimate.stageCount);
      expect(Number.isFinite(estimate.elapsedMs)).toBe(true);
      expect(estimate.fraction).toBeGreaterThanOrEqual(0);
      expect(estimate.fraction).toBeLessThanOrEqual(1);
      expect(Number.isFinite(estimate.remainingLowMs)).toBe(true);
      expect(Number.isFinite(estimate.remainingHighMs)).toBe(true);
      expect(typeof estimate.stalled).toBe('boolean');
      expect(['low', 'medium', 'high']).toContain(estimate.confidence);
      // Prose fit to render verbatim: a sentence, ending like one.
      expect(estimate.prose.trim().length).toBeGreaterThan(15);
      expect(estimate.prose.trim()).toMatch(/[.!]$/);
      expect(estimate.prose).not.toMatch(/NaN|undefined|Infinity/);
    }
  });

  test('an empty stage name is the same as no stage, not a stage of its own', () => {
    expect(estimateProgress({ progress_stage: '' }, T0).stage).toBe('queued');
  });
});

describe('Putting a duration into words', () => {
  test('a few seconds is under a minute, because a second-by-second countdown invites staring at it', () => {
    expect(formatDuration(1)).toBe('under a minute');
    expect(formatDuration(5 * SECOND)).toBe('under a minute');
    expect(formatDuration(44 * SECOND)).toBe('under a minute');
  });

  test('about a minute is words rather than a figure, at the boundary and either side of it', () => {
    expect(formatDuration(45 * SECOND)).toBe('about a minute');
    expect(formatDuration(60 * SECOND)).toBe('about a minute');
    expect(formatDuration(89 * SECOND)).toBe('about a minute');
  });

  test('several minutes rounds to whole minutes, since the estimate has no better precision', () => {
    expect(formatDuration(90 * SECOND)).toBe('about 2 minutes');
    expect(formatDuration(3 * MINUTE)).toBe('about 3 minutes');
    expect(formatDuration(185 * SECOND)).toBe('about 3 minutes');
    expect(formatDuration(11 * MINUTE)).toBe('about 11 minutes');
  });

  test('zero, negative and unreadable durations produce prose rather than a bare number or NaN', () => {
    // 'no time' is the module's answer for all of these. It reads oddly inside the terminal
    // sentence ("Finished in no time."), but it is prose and it is not NaN, which is what
    // this function exists to guarantee.
    expect(formatDuration(0)).toBe('no time');
    expect(formatDuration(-1)).toBe('no time');
    expect(formatDuration(-10 * MINUTE)).toBe('no time');
    expect(formatDuration(NaN)).toBe('no time');
    expect(formatDuration(Infinity)).toBe('no time');
    expect(formatDuration(-Infinity)).toBe('no time');
    expect(formatDuration(undefined as unknown as number)).toBe('no time');
  });

  test('no duration is ever rendered as a bare millisecond count, which is the thing this function is for', () => {
    for (const ms of [0, 1, 999, 45_000, 90_000, 600_000]) {
      expect(formatDuration(ms)).not.toMatch(/\d{4,}/);
    }
  });

  test('hours and days get their own words, so a long wait is not spelled out in minutes', () => {
    // "about 1440 minutes" is arithmetically right and useless to read. The tiers exist
    // because this formatter is also handed the age of a finished run — a calculation that
    // completed last week would otherwise report "about 11000 minutes"
    // (chat/context/calculator-tools.ts:466-469 sidesteps that by not calling through at all,
    // but the formatter should not depend on every caller remembering to).
    expect(formatDuration(2 * 60 * MINUTE)).toBe('about 2 hours');
    expect(formatDuration(24 * 60 * MINUTE)).toBe('about 24 hours');
    expect(formatDuration(3 * 24 * 60 * MINUTE)).toBe('about 3 days');
  });

  test('the tiers overlap on purpose, so nothing is rounded into a unit that hides it', () => {
    // 89 minutes stays in minutes rather than rounding to "about 1 hour", and 30 hours stays
    // in hours rather than becoming "about 1 day". A pipeline capped at 15 minutes never
    // reaches either, but the ETA of a queued run and the age of an old one both can, and
    // rounding 30 hours to a day loses the part a reader would act on.
    expect(formatDuration(89 * MINUTE)).toBe('about 89 minutes');
    expect(formatDuration(90 * MINUTE)).toBe('about 2 hours');
    expect(formatDuration(30 * 60 * MINUTE)).toBe('about 30 hours');
    expect(formatDuration(36 * 60 * MINUTE)).toBe('about 2 days');
  });
});

describe('Putting a range into words', () => {
  test('a genuine spread is stated as a spread, because the uncertainty is the information', () => {
    expect(formatRange(2 * MINUTE, 5 * MINUTE)).toBe('2 to 5 minutes');
    expect(formatRange(90 * SECOND, 4 * MINUTE)).toBe('2 to 4 minutes');
  });

  test('bounds that round to the same minute collapse to one figure, since "2 to 2 minutes" reads as a bug', () => {
    expect(formatRange(110 * SECOND, 130 * SECOND)).toBe('about 2 minutes');
    expect(formatRange(3 * MINUTE, 3 * MINUTE)).toBe('about 3 minutes');
  });

  test('a low bound under half a minute is dropped rather than printed as zero', () => {
    // "0 to 3 minutes" claims it might already be done, which on a live run it is not.
    expect(formatRange(20 * SECOND, 3 * MINUTE)).toBe('about 3 minutes');
    expect(formatRange(0, 5 * MINUTE)).toBe('about 5 minutes');
  });

  test('a high bound inside the first minute is a single phrase, not a range of seconds', () => {
    expect(formatRange(5 * SECOND, 30 * SECOND)).toBe('under a minute');
    expect(formatRange(0, 0)).toBe('under a minute');
    expect(formatRange(30 * SECOND, 80 * SECOND)).toBe('under a minute');
  });

  test('no range ever prints the same number twice or a bare millisecond count', () => {
    const pairs: Array<[number, number]> = [
      [0, 0], [1, 2], [SECOND, 2 * SECOND], [59 * SECOND, 61 * SECOND],
      [MINUTE, MINUTE], [MINUTE, 2 * MINUTE], [2 * MINUTE, 2 * MINUTE + 1],
      [5 * MINUTE, 13 * MINUTE], [30 * MINUTE, 90 * MINUTE],
    ];

    for (const [low, high] of pairs) {
      const words = formatRange(low, high);
      expect(words).not.toMatch(/(\b\d+\b) to \1\b/);
      expect(words).not.toMatch(/\d{4,}/);
    }
  });

  test('the range a live estimate actually produces is rendered as a sentence a user can act on', () => {
    // End to end through the module, so the prose is checked against the numbers rather than
    // against hand-written bounds.
    const estimate = parkedIn('classifying', 5 * SECOND);

    expect(estimate.prose).toBe(
      `Matching each group to an AWS service — step 3 of 6, ${formatRange(estimate.remainingLowMs, estimate.remainingHighMs)} left.`,
    );
  });
});

describe('Appending a stage to the trail', () => {
  test('the stage stamp is exactly the instant on the event, which is the whole reason this helper exists', () => {
    // A stage change written without its timestamp leaves the estimate measuring the
    // PREVIOUS stage's start, so every remaining-time answer for the rest of the run is too
    // long (progress-eta.ts:358-364). Equality, not proximity.
    const written = appendProgress([{ stage: 'connecting', at: T0 }], { stage: 'grouping', message: 'Folding 10 rows', at: T0 + 13 * SECOND });

    expect(written.progress_stage_started_at).toBe(T0 + 13 * SECOND);
    expect(written.progress_stage).toBe('grouping');
    expect(written.progress_history[written.progress_history.length - 1].at).toBe(written.progress_stage_started_at);
  });

  test('the stamp and the newest trail entry agree for every stage of a whole run', () => {
    let trail: ProgressEvent[] | undefined;
    for (const event of NORMAL_RUN) {
      const written = appendProgress(trail, event);
      trail = written.progress_history;

      expect(written.progress_stage_started_at).toBe(event.at);
      expect(trail[trail.length - 1]).toEqual(event);
      expect(written.progress_stage).toBe(event.stage);
    }
    expect(trail).toHaveLength(NORMAL_RUN.length);
  });

  test('a stage with no message omits the field entirely rather than writing an undefined', () => {
    // DynamoDB rejects an explicit undefined attribute, so an omitted key and a key set to
    // undefined are not the same thing here: the second one fails the whole patch.
    const written = appendProgress(undefined, { stage: 'connecting', at: T0 });

    expect('progress_message' in written).toBe(false);
    expect(Object.keys(written)).toEqual(['progress_stage', 'progress_stage_started_at', 'progress_history']);
  });

  test('a stage with a message carries it through for the page to show', () => {
    const written = appendProgress(undefined, { stage: 'pricing', message: 'Pricing 6 groups from live AWS rates', at: T0 });

    expect(written.progress_message).toBe('Pricing 6 groups from live AWS rates');
  });

  test('an empty message is treated as no message, so a blank line is never written to the row', () => {
    expect('progress_message' in appendProgress(undefined, { stage: 'pricing', message: '', at: T0 })).toBe(false);
  });

  test('a trail over its cap drops the oldest entries so the newest one always survives', () => {
    // Dropping the newest instead would freeze the reported position, which is the one thing
    // the trail is read for. A small explicit cap states the property without eighty rows.
    const trail: ProgressEvent[] = [
      { stage: 'connecting', at: T0 },
      { stage: 'grouping', at: T0 + 13 * SECOND },
      { stage: 'classifying', at: T0 + 16 * SECOND },
    ];
    const written = appendProgress(trail, { stage: 'pricing', at: T0 + 34 * SECOND }, 3);

    expect(written.progress_history.map((event) => event.stage)).toEqual(['grouping', 'classifying', 'pricing']);
    expect(written.progress_history).toHaveLength(3);
    expect(written.progress_history[written.progress_history.length - 1].at).toBe(written.progress_stage_started_at);
  });

  test('a trail at exactly its cap is not trimmed, so nothing is dropped a moment early', () => {
    const written = appendProgress([{ stage: 'connecting', at: T0 }, { stage: 'grouping', at: T0 + SECOND }], { stage: 'classifying', at: T0 + 2 * SECOND }, 3);

    expect(written.progress_history).toHaveLength(3);
    expect(written.progress_history[0].stage).toBe('connecting');
  });

  test('the caller trail is left alone, since the orchestrator holds it across a whole run', () => {
    // `recordStage` keeps one array in memory for the life of the run
    // (calculator-orchestrator/index.ts:93-107); mutating the caller's copy here would make
    // the trail depend on whether a patch succeeded.
    const trail: ProgressEvent[] = [{ stage: 'connecting', at: T0 }];
    const written = appendProgress(trail, { stage: 'grouping', at: T0 + SECOND }, 1);

    expect(trail).toEqual([{ stage: 'connecting', at: T0 }]);
    expect(written.progress_history).toEqual([{ stage: 'grouping', at: T0 + SECOND }]);
  });

  test('a first stage on a row with no trail starts one rather than failing on the undefined', () => {
    const written = appendProgress(undefined, { stage: 'connecting', message: 'Loading AWS service catalogue', at: T0 });

    expect(written.progress_history).toEqual([{ stage: 'connecting', message: 'Loading AWS service catalogue', at: T0 }]);
  });

  test('what the writer produces is exactly what the reader expects, one stage after the other', () => {
    // The pair is kept in one module so they cannot drift; this is that claim as a test. A
    // record built only from appendProgress output must read back as being at stage zero
    // elapsed, at the instant the stage was entered.
    let trail: ProgressEvent[] | undefined;
    NORMAL_RUN.forEach((event, index) => {
      const written = appendProgress(trail, event);
      trail = written.progress_history;

      const estimate = estimateProgress({
        status: 'PROCESSING',
        progress_started_at: NORMAL_RUN[0].at,
        updated_at: event.at,
        resource_count: 10,
        ...written,
      }, event.at);

      expect(estimate.stage).toBe(event.stage);
      expect(estimate.stageNumber).toBe(index + 1);
      expect(estimate.stalled).toBe(false);
    });
  });
});

describe('The stage table the whole estimate is weighted from', () => {
  test('a run has six stages, which is what every "step N of 6" on the page counts against', () => {
    expect(STAGE_COUNT).toBe(6);
  });

  test('each real pipeline stage is recognised, in the order the pipeline emits them', () => {
    // A stage the pipeline emits but the table omits silently stops contributing to the
    // weighting (progress-eta.ts:105-109), so the two lists drifting is a real regression
    // and this is the assertion that catches it.
    const numbers = LIVE_STAGES.map((stage) => parkedIn(stage, SECOND).stageNumber);

    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test('every stage has a label written for a user rather than the pipeline token', () => {
    for (const stage of LIVE_STAGES) {
      const { stageLabel } = parkedIn(stage, SECOND);

      expect(stageLabel).not.toBe(stage);
      expect(stageLabel.split(/\s+/).length).toBeGreaterThan(2);
    }
  });

  test('no two stages share a label, so the page always changes visibly when the run moves on', () => {
    const labels = LIVE_STAGES.map((stage) => parkedIn(stage, SECOND).stageLabel);

    expect(new Set(labels).size).toBe(LIVE_STAGES.length);
  });

  test('a later stage always starts further along the bar than an earlier one', () => {
    // The fraction at zero elapsed in a stage is that stage's starting position, so this is
    // the weighting itself: strictly increasing, and never at either end for a live run.
    const startsAt = LIVE_STAGES.map((stage) => parkedIn(stage, 0).fraction);

    for (let i = 1; i < startsAt.length; i += 1) {
      expect(startsAt[i]).toBeGreaterThan(startsAt[i - 1]);
    }
    expect(startsAt[0]).toBe(0);
    expect(startsAt[startsAt.length - 1]).toBeLessThan(1);
  });
});
