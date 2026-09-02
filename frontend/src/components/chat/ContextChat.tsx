'use client';

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, MessageSquare, Send, X, Loader2, Check } from 'lucide-react';
import { format, isToday } from 'date-fns';
import { api, type ChatTranscriptTurn } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  calculatorApi,
  type CalculationProgress,
  type CalculationStatus,
} from '@/lib/calculatorApi';
import {
  streamChatTurn,
  getChatUrl,
  applyEstimateChange,
  applyMomEdit,
  type ChatApp,
  type ChatProposal,
} from '@/lib/chatApi';

/**
 * The context chat, as a right-hand drawer.
 *
 * One component for all four apps. What changes per app is the greeting and whether a
 * proposal can be applied; the transport, the transcript and the streaming are the same.
 *
 * Latency is the whole point of the feature, so three things are deliberate: the user's
 * own message is on screen before the request is sent, the assistant bubble grows token
 * by token from the stream rather than appearing whole at the end, and the transcript is
 * plain text with a tiny formatter rather than a markdown library whose weight would
 * cost more than the feature.
 *
 * Turns are persisted server-side and replayed to the model, so the stored thread is
 * also loaded back into the panel the first time it opens — otherwise the owner sees an
 * empty drawer and gets answers referring to a conversation they cannot read.
 */

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  proposal?: ChatProposal;
  /** Set once a proposal has been applied, so its buttons collapse to a note. */
  applied?: boolean;
  error?: boolean;
  /**
   * When the turn was stored, for turns restored from the server.
   *
   * Absent on a turn typed in this session: it has no server timestamp until the
   * thread is loaded again, and the only visible difference between a restored turn
   * and a live one is this stamp.
   */
  createdAt?: number;
  /**
   * The turn's number in the stored thread, which is what lets an applied proposal be
   * marked in the transcript rather than only in this panel's local state.
   *
   * Absent until the stream's `done` event delivers it, and absent forever on a turn
   * whose stream errored — so applying must still work without it.
   */
  seq?: number;
}

interface ContextChatProps {
  app: ChatApp;
  entityId: string;
  /** Shown as the artifact's name in the greeting. */
  title?: string;
  /**
   * Called after a proposal is applied.
   *
   * Carries what the apply produced, because the two apps need different things from it:
   * a revision is a NEW estimate with a new id and the page has to navigate to it, while
   * a MOM edit rewrites the record in place and the page only has to refetch.
   */
  onApplied?: (change: AppliedChange) => void;
}

export type AppliedChange =
  | { kind: 'estimate_change'; calculationId: string; revisionNumber: number }
  | { kind: 'mom_edit'; momId: string; updatedFields: string[] };

const GREETING: Record<ChatApp, string> = {
  calculator: 'Ask about this estimate — how a figure was reached, what a change would cost, or ask me to propose a revision.',
  mom: 'Ask about these minutes, or ask me to trim them — cut a section, drop an internal risk, shorten the summary.',
  interview: 'Ask about this evaluation — how a score was reached, what the evidence was, or what a follow-up round should probe.',
  intelligence: 'Ask about this assessment — how a rating was reached, which evidence supports it, or where the gaps are.',
};

const STORAGE_PREFIX = 'contextchat:open:';

/**
 * How often the drawer re-reads where a running estimate has got to.
 *
 * The same interval the estimate's own page polls on, so the two cannot be more than one tick
 * apart on a page showing both.
 */
const PROGRESS_POLL_MS = 3000;

/**
 * A minimal formatter: paragraphs and simple bullet lines. No markdown library.
 *
 * Exported because the admin transcript view renders the same stored turns, and a
 * second formatter there would slowly stop looking like the drawer it is quoting.
 */
export function renderChatContent(content: string) {
  const blocks = content.split(/\n{2,}/);
  return blocks.map((block, blockIndex) => {
    const lines = block.split('\n');
    const isList = lines.every((line) => /^\s*[-*•]\s+/.test(line)) && lines.length > 0;
    if (isList) {
      return (
        <ul key={blockIndex} className="list-disc pl-5 space-y-0.5">
          {lines.map((line, lineIndex) => (
            <li key={lineIndex}>{line.replace(/^\s*[-*•]\s+/, '')}</li>
          ))}
        </ul>
      );
    }
    return (
      <p key={blockIndex} className="whitespace-pre-wrap">
        {block}
      </p>
    );
  });
}

/** The stamp shown under a restored turn, and in the admin transcript. dd-MM-yyyy is India. */
export function formatTurnTime(at: number): string {
  return format(new Date(at), 'dd-MM-yyyy, HH:mm');
}

/**
 * Which day-separator, if any, goes above each message.
 *
 * Only drawn when the thread actually crosses a day boundary: a conversation that
 * happened entirely today has nothing to separate, and a lone "today" rule above the
 * first message of a brand-new chat would be decoration. A message with no stamp was
 * typed in this session, so it is today by definition.
 */
function daySeparators(messages: ChatMessage[]): (string | null)[] {
  const isEarlier = (message: ChatMessage) => message.createdAt !== undefined && !isToday(message.createdAt);
  if (!messages.some(isEarlier)) return messages.map(() => null);

  let earlierDrawn = false;
  let todayDrawn = false;
  return messages.map((message) => {
    if (isEarlier(message)) {
      if (earlierDrawn) return null;
      earlierDrawn = true;
      return 'earlier';
    }
    if (todayDrawn) return null;
    todayDrawn = true;
    return 'today';
  });
}

function DaySeparator({ kind }: { kind: string }) {
  return (
    <div className="flex items-center gap-2 text-[11px] font-medium text-text-muted" role="separator">
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
      <span>{kind}</span>
      <span className="h-px flex-1 bg-border" aria-hidden="true" />
    </div>
  );
}

/** A stored turn as the panel holds it. Applied proposals arrive already marked. */
function restoredMessage(turn: ChatTranscriptTurn): ChatMessage {
  return {
    role: turn.role,
    content: turn.content,
    proposal: turn.proposal,
    applied: turn.applied_at !== undefined,
    createdAt: turn.created_at,
    seq: turn.seq,
  };
}

/**
 * What the estimate behind this thread is doing, or how it ended.
 *
 * Kept together because the position alone cannot say whether a run is over: the read-time
 * watchdog marks a silent run failed and leaves its live stage in place, so a dead estimate
 * still reports `pricing`. The status is the authority on that, and it decides the icon, the
 * colour and whether the outcome is worth printing.
 */
interface PipelineState {
  status: CalculationStatus;
  progress: CalculationProgress;
}

/**
 * The four ways a run can look, as literal class names.
 *
 * The same accent / success / danger treatment the estimate's own page uses for the very same
 * three outcomes, so the drawer does not introduce a fourth vocabulary for them. Amber is the
 * one addition: a run that has gone quiet has a sentence saying it may have stopped, and the
 * working colour under that sentence reads as a contradiction.
 */
const PIPELINE_TONE = {
  running: { mark: 'text-accent', bar: 'bg-accent', panel: 'bg-accent/5' },
  stalled: { mark: 'text-warning', bar: 'bg-warning', panel: 'bg-warning/5' },
  done: { mark: 'text-success', bar: 'bg-success', panel: 'bg-success/5' },
  failed: { mark: 'text-danger', bar: 'bg-danger', panel: 'bg-danger/5' },
} as const;

/**
 * Where the estimate has got to, as one line above the transcript.
 *
 * Above the conversation and outside the scrolling region on purpose. A figure that moves every
 * three seconds must not shift the transcript under a reply that is still streaming, and a
 * status that scrolls out of view is not a live status.
 *
 * Nothing here composes a sentence of its own: `prose` arrives from shared/progress-eta.ts
 * already carrying the stage, the position in the run and a range for the time left, and a
 * second wording written in the browser would eventually contradict the answer the assistant
 * gives to the same question one bubble below.
 */
function PipelineLine({ status, progress }: PipelineState) {
  const running = status === 'PROCESSING';
  const failed = status === 'FAILED';
  const tone = PIPELINE_TONE[
    failed ? 'failed' : !running ? 'done' : progress.stalled ? 'stalled' : 'running'
  ];
  // Clamped, and zero for anything non-finite: the fraction is server-supplied, and a NaN here
  // reaches the DOM as an invalid width that silently draws nothing.
  const filled = Number.isFinite(progress.fraction)
    ? Math.max(0, Math.min(1, progress.fraction))
    : 0;

  return (
    <div className={`border-b border-border px-4 py-2.5 ${tone.panel}`}>
      <div className="flex items-start gap-2">
        {running
          ? <Loader2 size={13} className={`mt-0.5 shrink-0 animate-spin ${tone.mark}`} />
          : failed
            ? <AlertTriangle size={13} className={`mt-0.5 shrink-0 ${tone.mark}`} />
            : <Check size={13} className={`mt-0.5 shrink-0 ${tone.mark}`} />}
        <div className="min-w-0">
          {/* The label is printed only once the run is over, which is the only case where it says
              something the sentence beneath it does not. A live run's prose opens with the stage
              name, so printing both put the same words on screen twice. */}
          {!running ? (
            <p className={`text-[11px] font-semibold ${tone.mark}`}>{progress.stageLabel}</p>
          ) : null}
          <p className="break-words text-[11px] leading-4 text-text-secondary">{progress.prose}</p>
        </div>
      </div>
      {/* Straight from `fraction`, which is held below full while a run is live and stops where a
          stopped run stopped — so a failed estimate cannot draw itself as a complete one. Hidden
          from assistive technology because the sentence above already carries the position. */}
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-border/60" aria-hidden="true">
        <div
          className={`h-full rounded-full transition-all duration-500 ${tone.bar}`}
          style={{ width: `${Math.round(filled * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function ContextChat({ app, entityId, title, onApplied }: ContextChatProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  /** True while the workspace is being scrolled — see the effect below. */
  const [compact, setCompact] = useState(false);
  /** True while the stored thread is being fetched, for the one time that happens. */
  const [historyLoading, setHistoryLoading] = useState(false);
  /** Where the estimate this thread is attached to has got to, or null when there is nothing
   *  worth saying about it. Only ever set for the calculator — see the poll below. */
  const [pipeline, setPipeline] = useState<PipelineState | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  /**
   * Which thread's history has been requested, so it is fetched once.
   *
   * Keyed by app and artifact rather than a boolean: the drawer keeps its open state
   * across navigations, so the same component can be shown a different artifact.
   */
  const historyKeyRef = useRef<string | null>(null);
  /**
   * Index of the assistant bubble the stream is currently filling.
   *
   * A ref rather than a value captured when `send` ran: restored history is prepended
   * to `messages`, which shifts every index, and a captured one would then have the
   * reply growing inside somebody's earlier turn.
   */
  const streamIndexRef = useRef<number | null>(null);

  // Restore the drawer's open state per app, so opening it on one estimate opens it on
  // the next. Wrapped because storage throws in a private window.
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(STORAGE_PREFIX + app) === '1');
    } catch {
      /* no stored preference */
    }
  }, [app]);

  const persistOpen = useCallback((next: boolean) => {
    setOpen(next);
    try {
      localStorage.setItem(STORAGE_PREFIX + app, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [app]);

  // Keep the newest turn in view as it streams.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  /**
   * Load the stored thread the first time the drawer is opened for this artifact.
   *
   * On first open rather than on mount: the drawer is mounted on every artifact page
   * whether or not it is open, and loading on mount would spend a request per page view
   * on a panel nobody looked at. The ref is the guard, not the message list — an empty
   * thread is a perfectly good answer and must not be retried on every open.
   *
   * Failure is silent and leaves the panel usable. Losing the history is a worse panel,
   * but refusing the next turn because the history could not be read would be a broken
   * one — the same reasoning as the server's `.catch(() => [])` when it replays turns to
   * the model.
   */
  useEffect(() => {
    const key = `${app}#${entityId}`;
    if (!open || !entityId || historyKeyRef.current === key) return;
    historyKeyRef.current = key;

    let cancelled = false;
    setHistoryLoading(true);
    api
      .getChatHistory(app, entityId)
      .then((thread) => {
        if (cancelled) return;
        const restored = (thread.turns ?? []).map(restoredMessage);
        if (!restored.length) return;
        // A turn can be in flight already if the user typed before this landed; the
        // bubble the stream is writing into moves down by however much was restored.
        if (streamIndexRef.current !== null) streamIndexRef.current += restored.length;
        setMessages((prev) => [...restored, ...prev]);
      })
      .catch(() => {
        /* No history on screen. The user can still ask. */
      })
      .finally(() => {
        if (!cancelled) setHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, app, entityId]);

  /**
   * Follow the estimate's pipeline while it is being priced, so the drawer can say where it is
   * and roughly how much longer it has.
   *
   * Calculator only. One drawer serves four apps and only this one has a pipeline behind the
   * artifact; for the other three `entityId` is not a calculation id at all, so every tick would
   * be a 404 against somebody else's record.
   *
   * Its own read rather than a value handed down by the page: this component is mounted by four
   * pages and cannot depend on any of them polling on its behalf. Polling rather than a stream
   * is what makes the drawer cheap to close — a reopened panel asks where the run is *now*,
   * instead of needing to have listened through the whole run to know.
   *
   * Gated on `open` as well as on the app, because nothing renders this while the drawer is
   * shut. A three-second timer left ticking behind a closed panel is a leak that compounds every
   * time the drawer is reopened, so the chain is torn down with the panel and started again from
   * scratch when it returns.
   *
   * Every failure here is silent and leaves the panel exactly as usable as before. Losing the
   * position is a worse drawer; refusing the next question because a status call failed would be
   * a broken one — the same reasoning as the history load above.
   */
  useEffect(() => {
    if (app !== 'calculator' || !open || !entityId) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Whether this poll has actually watched the run in flight. An outcome is only worth showing
    // to someone who was waiting for it: opening the drawer on an estimate priced last month
    // would otherwise greet them with "Finished in about 30 days".
    let watched = false;

    // Reschedules itself rather than running on an interval, matching the estimate page's poll:
    // a slow response can then never have a second request stacked behind it.
    const read = async () => {
      try {
        const next = await calculatorApi.getCalculationResult(entityId);
        if (cancelled) return;
        const progress = next.progress;
        if (!progress) {
          // An API deployed before the pipeline reported its position. There is nothing to show
          // and nothing a retry would change, so the line stays away.
          setPipeline(null);
          return;
        }
        if (next.status === 'PROCESSING') {
          watched = true;
          setPipeline({ status: next.status, progress });
          timer = setTimeout(read, PROGRESS_POLL_MS);
          return;
        }
        setPipeline(watched ? { status: next.status, progress } : null);
      } catch {
        // Quietly nothing. The estimate page surfaces a failing status route; a second copy of
        // that error inside the chat panel would only take the drawer over.
        if (!cancelled) setPipeline(null);
      }
    };
    void read();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      // Cleared rather than left standing. The next open may be a different estimate, or the same
      // one long since finished, and either way what a reopened drawer should show is whatever
      // its first poll finds — not the last thing this one saw.
      setPipeline(null);
    };
  }, [app, open, entityId]);

  // Focus the input when the drawer opens, and stop any in-flight stream when it closes
  // or the component unmounts.
  useEffect(() => {
    if (open) inputRef.current?.focus();
    return () => abortRef.current?.abort();
  }, [open]);

  // Escape closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') persistOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, persistOpen]);

  /**
   * Shrink the launcher to an icon while the page is being scrolled.
   *
   * The button is fixed to the viewport, and AppShell's `<main class="app-workspace">` is
   * what owns `overflow-y-auto` — the window itself never scrolls, which is why the
   * launcher sat over the content as an immovable slab. Listening on the workspace lets
   * it get out of the way: it collapses to a circle while the content moves and expands
   * back once the scrolling stops. It is never hidden outright, because it is the only
   * way into the assistant.
   */
  useEffect(() => {
    if (open) return;
    const scroller: Element | Window = document.querySelector('.app-workspace') ?? window;
    let idleTimer = 0;
    let frame = 0;
    const onScroll = () => {
      // rAF-throttled: a scroll event can fire per frame, and this only needs to set a
      // boolean that is already true for the rest of the gesture.
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        setCompact(true);
        window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => setCompact(false), 450);
      });
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      window.clearTimeout(idleTimer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const send = useCallback(async () => {
    const message = input.trim();
    if (!message || sending) return;

    const chatUrl = await getChatUrl();
    if (!chatUrl) {
      setMessages((prev) => [...prev, { role: 'assistant', content: 'The assistant is not available in this environment.', error: true }]);
      return;
    }

    setInput('');
    setSending(true);
    // The user's message and an empty assistant bubble are on screen before the request
    // goes out; the bubble fills as the stream arrives. The index is taken inside the
    // updater so it counts what is actually in the list, not what the last render saw.
    setMessages((prev) => {
      streamIndexRef.current = prev.length + 1;
      return [...prev, { role: 'user', content: message }, { role: 'assistant', content: '' }];
    });

    /** Rewrite the bubble the stream owns, wherever it has ended up. */
    const updateAssistant = (change: (current: ChatMessage) => ChatMessage) => {
      setMessages((prev) => {
        const index = streamIndexRef.current;
        if (index === null || !prev[index]) return prev;
        const next = [...prev];
        next[index] = change(next[index]);
        return next;
      });
    };

    abortRef.current = new AbortController();
    await streamChatTurn(
      chatUrl,
      { app, entity_id: entityId, message },
      {
        onDelta: (text) => updateAssistant((current) => ({ ...current, content: current.content + text })),
        onProposal: (proposal) => updateAssistant((current) => ({ ...current, proposal })),
        onDone: (seq) => {
          // The seq is snapshotted from the ref and cleared before the updater runs,
          // for two reasons. `updateAssistant` reads the ref *inside* setMessages, which
          // React defers until after this handler returns — it would find the null we
          // just wrote and silently drop the number. And clearing the ref inside an
          // updater is no fix either: StrictMode double-invokes updaters in development,
          // so the second pass would see null and return `prev` unchanged.
          const index = streamIndexRef.current;
          streamIndexRef.current = null;
          setSending(false);
          if (index === null) return;
          // seq 0 means the turn streamed but was never stored, so there is no row this
          // number could refer to. Keeping it off the message means `message.seq` always
          // names a real stored turn.
          if (seq < 1) return;
          setMessages((prev) => {
            if (!prev[index]) return prev;
            const next = [...prev];
            next[index] = { ...next[index], seq };
            return next;
          });
        },
        onError: (msg) => {
          updateAssistant((current) => ({ ...current, content: current.content || msg, error: true }));
          streamIndexRef.current = null;
          setSending(false);
        },
      },
      abortRef.current.signal,
    );
    streamIndexRef.current = null;
    setSending(false);
  }, [app, entityId, input, sending]);

  const apply = useCallback(async (index: number, proposal: ChatProposal, chatSeq?: number) => {
    setApplyingIndex(index);
    try {
      let change: AppliedChange;
      if (proposal.kind === 'estimate_change') {
        const res = await applyEstimateChange(entityId, proposal, chatSeq);
        change = { kind: 'estimate_change', calculationId: res.calculation_id, revisionNumber: res.revision_number };
      } else {
        const res = await applyMomEdit(entityId, proposal, chatSeq);
        change = { kind: 'mom_edit', momId: res.mom_id, updatedFields: res.updated_fields };
      }
      setMessages((prev) => {
        const next = [...prev];
        if (next[index]) next[index] = { ...next[index], applied: true };
        return next;
      });
      onApplied?.(change);
    } catch (error) {
      setMessages((prev) => [...prev, { role: 'assistant', content: (error as Error).message, error: true }]);
    } finally {
      setApplyingIndex(null);
    }
  }, [entityId, onApplied]);

  /** Recomputed with the transcript, because every stamp in it can move the boundary. */
  const separators = useMemo(() => daySeparators(messages), [messages]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => persistOpen(true)}
        aria-label="Open assistant"
        title="Ask about this"
        className={`fixed bottom-6 right-6 z-40 flex items-center rounded-full bg-accent text-sm font-medium text-white shadow-lg transition-all duration-200 hover:opacity-90 motion-reduce:transition-none ${
          compact ? 'h-11 w-11 justify-center' : 'gap-2 px-4 py-3'
        }`}
      >
        <MessageSquare size={18} className="shrink-0" />
        {/* aria-label carries the accessible name, so dropping the text while scrolling
            costs nothing to a screen reader. */}
        {!compact && <span className="whitespace-nowrap">Ask about this</span>}
      </button>
    );
  }

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="false"
      aria-label="Context assistant"
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-border bg-surface shadow-xl"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-text-primary">
          <MessageSquare size={18} className="text-accent" />
          <span className="text-sm font-semibold">Assistant</span>
        </div>
        <button type="button" onClick={() => persistOpen(false)} aria-label="Close assistant" className="rounded p-1 text-text-secondary hover:bg-surface-interactive">
          <X size={18} />
        </button>
      </header>

      {pipeline ? <PipelineLine status={pipeline.status} progress={pipeline.progress} /> : null}

      <div ref={scrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        <p className="text-sm text-text-secondary">
          {title ? <span className="font-medium text-text-primary">{title}. </span> : null}
          {GREETING[app]}
        </p>

        {historyLoading ? (
          <div className="space-y-3" aria-label="Loading earlier messages">
            <Skeleton className="ml-auto h-8 w-1/2 rounded-2xl" />
            <Skeleton className="h-14 w-4/5 rounded-2xl" />
          </div>
        ) : null}

        {messages.map((message, index) => (
          <Fragment key={index}>
            {separators[index] ? <DaySeparator kind={separators[index]!} /> : null}
            <div className={`flex flex-col ${message.role === 'user' ? 'items-end' : 'items-start'}`}>
              <div
                className={
                  message.role === 'user'
                    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-sm text-white'
                    : `max-w-[90%] rounded-2xl rounded-bl-sm px-3 py-2 text-sm ${message.error ? 'bg-danger/10 text-danger' : 'bg-surface-interactive text-text-primary'}`
                }
              >
                <div className="space-y-2 leading-relaxed">
                  {message.content ? renderChatContent(message.content) : (
                    <span className="inline-flex items-center gap-2 text-text-secondary">
                      <Loader2 size={14} className="animate-spin" /> Thinking…
                    </span>
                  )}
                </div>

                {message.proposal && !message.applied ? (
                  <div className="mt-3 rounded-lg border border-border bg-surface p-3">
                    <p className="text-xs font-medium text-text-secondary">Proposed change</p>
                    <p className="mt-1 text-sm text-text-primary">{message.proposal.summary}</p>
                    <div className="mt-3 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void apply(index, message.proposal!, message.seq)}
                        disabled={applyingIndex === index}
                        className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-60"
                      >
                        {applyingIndex === index ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                        Apply
                      </button>
                      <button
                        type="button"
                        onClick={() => setMessages((prev) => { const n = [...prev]; if (n[index]) n[index] = { ...n[index], proposal: undefined }; return n; })}
                        disabled={applyingIndex === index}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-secondary transition hover:bg-surface-interactive disabled:opacity-60"
                      >
                        Discard
                      </button>
                    </div>
                    {message.proposal.kind === 'estimate_change' ? (
                      <p className="mt-2 text-[11px] text-text-muted">Applying creates a new revision and re-prices it from live AWS rates. This estimate is left unchanged.</p>
                    ) : (
                      <p className="mt-2 text-[11px] text-text-muted">Applying rewrites the stored minutes and regenerates the PDF and Word files.</p>
                    )}
                  </div>
                ) : null}

                {message.proposal && message.applied ? (
                  <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-success">
                    <Check size={14} /> Applied.
                    {message.proposal.kind === 'estimate_change' ? ' A new revision is being priced.' : ' Documents regenerated.'}
                  </p>
                ) : null}
              </div>

              {/* The only thing that marks a restored turn. A turn typed in this session
                  has no server stamp yet, so it simply has no line here. */}
              {message.createdAt !== undefined ? (
                <span className="mt-1 px-1 text-[10px] text-text-muted">{formatTurnTime(message.createdAt)}</span>
              ) : null}
            </div>
          </Fragment>
        ))}
      </div>

      <div className="border-t border-border px-3 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask a question…"
            aria-label="Message"
            className="max-h-32 flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
          />
          <button
            type="button"
            onClick={() => void send()}
            disabled={sending || !input.trim()}
            aria-label="Send"
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
          </button>
        </div>
      </div>
    </div>
  );
}
