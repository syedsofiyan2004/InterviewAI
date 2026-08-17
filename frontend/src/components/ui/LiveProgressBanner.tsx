'use client';

import React, { useEffect, useRef, useState } from 'react';
import { getServerNow, type ProgressEvent } from '@/lib/api';

export type TaskType = 'analysis' | 'transcribe' | 'questions' | 'mom';

interface Step {
  seconds: number;
  message: string;
  icon: string;
}

const TASK_STEPS: Record<TaskType, Step[]> = {
  analysis: [
    { seconds: 0, message: 'Ingesting interview transcript, candidate resume, and job description...', icon: '📄' },
    { seconds: 12, message: 'Evaluating candidate responses against required job competencies...', icon: '🧠' },
    { seconds: 35, message: 'Scoring technical depth, problem-solving, and evidence markers...', icon: '🔍' },
    { seconds: 70, message: 'Analyzing interviewer panel coverage and probing quality...', icon: '👥' },
    { seconds: 110, message: 'Synthesizing candidate recommendation and executive summary...', icon: '📊' },
    { seconds: 160, message: 'Finalizing downloadable report and workspace record...', icon: '📑' },
  ],
  transcribe: [
    { seconds: 0, message: 'Connecting to Microsoft Teams recording service...', icon: '🔗' },
    { seconds: 10, message: 'AWS Transcribe is converting meeting audio to text...', icon: '🎙️' },
    { seconds: 40, message: 'Aligning transcript timestamps and speaker channels...', icon: '📝' },
    { seconds: 80, message: 'Saving completed transcript to interview workspace...', icon: '✨' },
  ],
  questions: [
    { seconds: 0, message: 'Analyzing role seniority and required technical skills...', icon: '📋' },
    { seconds: 10, message: 'Generating role-tailored question bank and panel guide...', icon: '🎯' },
    { seconds: 30, message: 'Structuring competency rubric and case study scenarios...', icon: '💡' },
  ],
  mom: [
    { seconds: 0, message: 'Extracting discussion points, key decisions, and raised risks...', icon: '📌' },
    { seconds: 15, message: 'Identifying action items, assignees, and target due dates...', icon: '📋' },
    { seconds: 45, message: 'Generating executive meeting report and summary...', icon: '📑' },
  ],
};

/**
 * Icon per server stage, so the artwork matches the sentence the server sent.
 * Stages the backend does not report fall through to the elapsed-time step's own
 * icon.
 */
const STAGE_ICONS: Record<string, string> = {
  queued: '🕓',
  ingesting: '📄',
  extracting: '🧠',
  evaluating: '🔍',
  scoring: '🔍',
  generating_questions: '🎯',
  transcribing: '🎙️',
  synthesizing: '📊',
  saving: '💾',
  done: '✅',
  failed: '⚠️',
};

// Past this, a start timestamp is not a running task — it is a leftover from an
// earlier run. Showing no timer is honest; counting from zero is not.
const MAX_PLAUSIBLE_ELAPSED_SECONDS = 6 * 60 * 60;

interface LiveProgressBannerProps {
  taskType: TaskType;
  title: string;
  subtitle?: string;
  onRetry?: () => void;
  error?: string | null;
  /**
   * Server timestamp (epoch ms) of when the task was queued. Compared against
   * `getServerNow()`, never the raw browser clock.
   */
  startTime?: number | null;
  /**
   * Server-reported phase description. When present this is shown verbatim,
   * because it reflects what the backend is actually doing. The time-based
   * TASK_STEPS copy is only a fallback for records that predate progress
   * reporting — it guesses from the clock and can claim work that is not
   * happening, so real data always wins.
   */
  progressMessage?: string | null;
  progressStage?: string | null;
  /** Stage history, newest last. Rendered as the activity log. */
  progressEvents?: ProgressEvent[] | null;
  className?: string;
}

export function LiveProgressBanner({
  taskType,
  title,
  subtitle,
  onRetry,
  error,
  startTime,
  progressMessage,
  progressStage,
  progressEvents,
  className = '',
}: LiveProgressBannerProps) {
  // Elapsed is derived, never accumulated: `serverNow - startTime` every tick.
  // Holding a mount-time anchor is what made the timer restart from 0:00 on
  // every tab switch and navigation, because unmounting threw the anchor away.
  // A pure derivation has nothing to lose, so the count stays true no matter how
  // many times this component is torn down and rebuilt.
  const [serverNow, setServerNow] = useState(() => getServerNow());

  useEffect(() => {
    if (error) return;
    const tick = () => setServerNow(getServerNow());
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [error]);

  const started = Number(startTime);
  const elapsed = Number.isFinite(started) && started > 0
    ? Math.max(0, Math.floor((serverNow - started) / 1000))
    : null;
  // No usable start stamp, or one left over from an earlier run: show the work,
  // omit the clock.
  const showElapsed = elapsed !== null && elapsed <= MAX_PLAUSIBLE_ELAPSED_SECONDS;

  const steps = TASK_STEPS[taskType] || TASK_STEPS.analysis;

  // Which time-based step the clock has reached. Only used when the server has
  // not reported a stage of its own.
  let activeStepIndex = 0;
  for (let i = 0; i < steps.length; i++) {
    if ((elapsed ?? 0) >= steps[i].seconds) {
      activeStepIndex = i;
    }
  }

  // Prefer what the server says it is doing over what the clock guesses.
  const hasLiveStage = Boolean(progressMessage);
  // A queued task has not begun work yet; calling it a "stage" overstates it.
  const isQueued = progressStage === 'queued';
  const displayMessage = progressMessage || steps[activeStepIndex].message;
  // Copy and icon must come from the same source, or the banner reads "Saving
  // the completed review..." next to the ingest icon.
  const displayIcon = (progressStage && STAGE_ICONS[progressStage])
    || (hasLiveStage ? '⚙️' : steps[activeStepIndex].icon);

  const events = (progressEvents || []).filter((entry) => entry && entry.message);

  const formatTime = (secs: number) => {
    const mins = Math.floor(secs / 60);
    const remainder = secs % 60;
    return `${mins}:${remainder < 10 ? '0' : ''}${remainder}`;
  };

  return (
    <div className={`rounded-xl border border-border bg-surface p-6 shadow-sm ${className}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-text-secondary">{subtitle}</p>}
        </div>
        {!error && showElapsed && (
          <div className="flex shrink-0 items-center gap-2 rounded-full border border-border bg-background px-3 py-1 text-xs font-mono text-text-muted">
            <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>Elapsed: {formatTime(elapsed!)}</span>
          </div>
        )}
      </div>

      {error ? (
        <div className="mt-4 rounded-lg border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
          <p className="font-medium">Task could not be completed</p>
          <p className="mt-1 text-xs opacity-90">{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="mt-3 inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-xs font-semibold text-background transition-colors hover:bg-accent/90"
            >
              Retry task now
            </button>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-4">
          {/* Active Live Progress Card */}
          <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 p-4 transition-all">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-accent/20 bg-accent/10 text-xl">
              {displayIcon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-accent">
                  {isQueued ? 'Queued' : hasLiveStage ? 'Current stage' : `Stage ${activeStepIndex + 1} of ${steps.length}`}
                </span>
              </div>
              <p className="mt-0.5 break-words text-sm font-medium text-text-primary transition-all">
                {displayMessage}
              </p>
            </div>
            <div className="h-5 w-5 shrink-0 rounded-full border-2 border-accent border-t-transparent animate-spin" />
          </div>

          {/* Stepper Progress Bar. Columns follow the step count — a fixed six
              left half the row empty for the 3-step and 4-step tasks. */}
          <div className="grid gap-1.5 pt-1" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}>
            {steps.map((st, idx) => {
              const isDone = idx < activeStepIndex;
              const isCurrent = idx === activeStepIndex;
              return (
                <div
                  key={st.seconds}
                  className={`h-1.5 rounded-full transition-all duration-500 ${
                    isDone
                      ? 'bg-accent'
                      : isCurrent
                      ? 'bg-accent/60 animate-pulse'
                      : 'bg-border/40'
                  }`}
                  title={st.message}
                />
              );
            })}
          </div>

          {events.length > 0 && <ProgressLog events={events} />}
        </div>
      )}
    </div>
  );
}

/**
 * The stage history as a terminal-style log.
 *
 * Deliberately the worker's own stage events rather than raw CloudWatch output:
 * Lambda log lines carry prompt fragments, candidate PII and stack traces, and
 * one function's stream interleaves every concurrent request. This shows the same
 * shape — timestamped, monospace, newest at the bottom — with nothing in it that
 * an interviewer should not see.
 */
function ProgressLog({ events }: { events: ProgressEvent[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the tail as stages arrive, the way a log viewer does.
  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length]);

  const clock = (at: number) => {
    const stamp = new Date(at);
    if (Number.isNaN(stamp.getTime())) return '--:--:--';
    return stamp.toLocaleTimeString('en-GB', { hour12: false });
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-text-muted">Activity log</span>
        <span className="text-[10px] font-mono text-text-muted">{events.length} {events.length === 1 ? 'stage' : 'stages'}</span>
      </div>
      <div ref={scrollRef} className="max-h-40 overflow-y-auto px-3 py-2">
        {events.map((entry, idx) => (
          <div
            key={`${entry.at}-${entry.stage}-${idx}`}
            className="flex gap-2 py-0.5 font-mono text-[11px] leading-5"
          >
            <span className="shrink-0 text-text-muted">{clock(entry.at)}</span>
            <span className="shrink-0 text-accent">{entry.stage}</span>
            <span className="min-w-0 break-words text-text-secondary">{entry.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
