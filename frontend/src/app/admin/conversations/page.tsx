'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { Check, Info, MessagesSquare } from 'lucide-react';
import { api, type ChatThreadSummary } from '@/lib/api';
import type { ChatApp } from '@/lib/chatApi';
import { TierGuard } from '@/components/admin/TierGuard';
import { Skeleton } from '@/components/ui/Skeleton';

/**
 * Every conversation held with the context assistant, for oversight.
 *
 * Read-only, deliberately: the assistant writes model output about named candidates
 * and priced work, and somebody has to be able to read what it said. Starting a chat
 * about an artifact you do not own stays forbidden — the thread id embeds its owner, so
 * there is no way in from here, only a way to read.
 *
 * The list carries no turn content beyond the opening question. Whoever wants the
 * transcript opens the thread, which is one more click and one more audited read.
 */

const APP_LABEL: Record<ChatApp, string> = {
  calculator: 'Estimate',
  mom: 'Minutes',
  interview: 'Evaluation',
  intelligence: 'Workspace',
};

type AppFilter = 'all' | ChatApp;

const APP_TABS: Array<{ id: AppFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'calculator', label: 'Estimates' },
  { id: 'mom', label: 'Minutes' },
  { id: 'interview', label: 'Evaluations' },
  { id: 'intelligence', label: 'Workspaces' },
];

/**
 * All three parts of the thread id travel as query params.
 *
 * There are no dynamic route segments in this app (static export), and the owner is
 * part of the identity of a thread rather than a filter on it — two people asking about
 * the same estimate have two separate conversations.
 */
function threadHref(thread: ChatThreadSummary): string {
  const params = new URLSearchParams({
    app: thread.app,
    entity_id: thread.entity_id,
    user_id: thread.owner_user_id,
  });
  return `/admin/conversations/view?${params.toString()}`;
}

const HEAD_CELL = 'px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-text-muted';

function ConversationsContent() {
  const [threads, setThreads] = useState<ChatThreadSummary[]>([]);
  const [windowDays, setWindowDays] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<AppFilter>('all');
  /** Bumped by the retry button. The fetch stays in the effect so it can be cancelled. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .listConversations()
      .then((data) => {
        if (cancelled) return;
        setThreads(data.threads ?? []);
        setWindowDays(data.window_days);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load conversations');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    // A retry while the first request is still out would otherwise let the loser of the
    // race write its answer over the winner's.
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = () => {
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  };

  const counts = useMemo(() => {
    const byApp = { calculator: 0, mom: 0, interview: 0, intelligence: 0 } as Record<ChatApp, number>;
    for (const thread of threads) byApp[thread.app] = (byApp[thread.app] ?? 0) + 1;
    return byApp;
  }, [threads]);

  // The server has already sorted by most recent activity, so filtering keeps that order.
  const filtered = useMemo(
    () => (filter === 'all' ? threads : threads.filter((thread) => thread.app === filter)),
    [threads, filter],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        {/* Said out loud so a short list is not read as "nobody used the assistant". */}
        <p className="flex max-w-2xl items-start gap-2 text-xs text-text-muted">
          <Info size={14} className="mt-0.5 flex-shrink-0" />
          {windowDays === null ? (
            <Skeleton className="h-4 w-72" />
          ) : (
            <span>
              Threads are deleted {windowDays} days after their last turn, so this is the last{' '}
              {windowDays} days of conversations rather than a complete history. A conversation
              stays listed even after the record it was about is deleted.
            </span>
          )}
        </p>

        <div className="status-tabs shrink-0" role="tablist" aria-label="Filter conversations by app">
          {APP_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={filter === tab.id}
              data-active={filter === tab.id}
              onClick={() => setFilter(tab.id)}
              className="status-tab"
            >
              {tab.label}
              {tab.id === 'all' ? (threads.length ? ` (${threads.length})` : '') : counts[tab.id] ? ` (${counts[tab.id]})` : ''}
            </button>
          ))}
        </div>
      </div>

      <div className="data-table">
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <th scope="col" className={HEAD_CELL}>Artifact</th>
                <th scope="col" className={HEAD_CELL}>App</th>
                <th scope="col" className={HEAD_CELL}>Owner</th>
                <th scope="col" className={`${HEAD_CELL} text-right`}>Turns</th>
                <th scope="col" className={HEAD_CELL}>Applied</th>
                <th scope="col" className={HEAD_CELL}>Last activity</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 5 }).map((_, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td colSpan={6} className="px-5 py-4">
                      <Skeleton className="h-4 w-full" />
                    </td>
                  </tr>
                ))
              ) : error ? (
                <tr>
                  <td colSpan={6} className="px-5 py-16 text-center">
                    <p className="text-sm font-semibold text-text-primary">Conversations could not be loaded</p>
                    <p className="mt-1 text-xs text-text-muted">Nothing has changed. Try loading the list again.</p>
                    <button type="button" onClick={retry} className="btn-secondary mt-5 px-3 py-2 text-xs font-semibold">
                      Try again
                    </button>
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-16 text-center">
                    <span className="mb-3 inline-flex rounded-xl bg-surface p-2.5 text-text-muted">
                      <MessagesSquare size={20} />
                    </span>
                    <p className="text-sm font-medium text-text-primary">
                      {threads.length === 0 ? 'No conversations yet' : 'No conversations in this app'}
                    </p>
                    <p className="mt-1 text-xs text-text-muted">
                      {threads.length === 0
                        ? 'Questions people ask the assistant on an estimate, a set of minutes or an evaluation appear here.'
                        : 'Clear the filter to see conversations from the other apps.'}
                    </p>
                  </td>
                </tr>
              ) : (
                filtered.map((thread) => (
                  <tr
                    key={thread.thread_id}
                    className="transition-colors hover:bg-surface-interactive/50"
                    style={{ borderBottom: '1px solid var(--border)' }}
                  >
                    <td className="max-w-[22rem] px-5 py-3">
                      {/* The row still opens even when the artifact is gone: the
                          conversation happened, and reading it is the point of this page.
                          Only the title stops pretending to be a live record — the server
                          sends "(record deleted)" for it, so no second badge is needed. */}
                      <Link
                        href={threadHref(thread)}
                        className={
                          thread.artifact_exists
                            ? 'text-sm font-semibold text-text-primary hover:text-accent'
                            : 'text-sm font-semibold italic text-text-muted hover:text-accent'
                        }
                      >
                        {thread.title}
                      </Link>
                      {thread.preview && (
                        <p className="mt-0.5 truncate text-xs text-text-muted" title={thread.preview}>
                          {thread.preview}
                        </p>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-5 py-3">
                      <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-secondary">
                        {APP_LABEL[thread.app]}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-text-secondary">
                      {thread.owner_email || thread.owner_user_id}
                    </td>
                    <td className="px-5 py-3 text-right text-sm tabular-nums text-text-primary">{thread.turn_count}</td>
                    <td className="whitespace-nowrap px-5 py-3">
                      {thread.has_applied ? (
                        <span className="inline-flex items-center gap-1 text-xs font-semibold text-success">
                          <Check size={13} /> Applied
                        </span>
                      ) : thread.has_proposal ? (
                        <span className="text-xs text-text-muted">Proposed, not applied</span>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                    </td>
                    <td
                      className="whitespace-nowrap px-5 py-3 text-xs text-text-muted"
                      title={`Started ${format(new Date(thread.first_turn_at), 'dd-MM-yyyy, HH:mm')}`}
                    >
                      {format(new Date(thread.last_turn_at), 'dd-MM-yyyy, HH:mm')}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function AdminConversationsPage() {
  return (
    <TierGuard minTier="REVIEWER">
      <ConversationsContent />
    </TierGuard>
  );
}
