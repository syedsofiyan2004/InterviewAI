'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Check, ExternalLink, MessagesSquare, User } from 'lucide-react';
import { api, type ChatThread } from '@/lib/api';
import type { ChatApp } from '@/lib/chatApi';
import { TierGuard } from '@/components/admin/TierGuard';
import { Skeleton } from '@/components/ui/Skeleton';
import { BackButton } from '@/components/ui/BackButton';
import { renderChatContent, formatTurnTime } from '@/components/chat/ContextChat';

/**
 * One conversation, verbatim.
 *
 * Verbatim is the requirement, not a style choice: this page exists so somebody
 * accountable can read exactly what the assistant told an owner about a candidate or a
 * price. Nothing here summarises, truncates or reorders the turns, and there is no way
 * to reply — the drawer is the only place a turn can be added, and only by the owner.
 *
 * Styled like the drawer on purpose, so what a reviewer reads is recognisably the thing
 * the owner saw rather than a report about it. The renderer is literally the drawer's.
 */

const APP_LABEL: Record<ChatApp, string> = {
  calculator: 'Cost estimate',
  mom: 'Meeting minutes',
  interview: 'Evaluation',
  intelligence: 'Interview workspace',
};

function isChatApp(value: string): value is ChatApp {
  return value === 'calculator' || value === 'mom' || value === 'interview' || value === 'intelligence';
}

function MissingThread({ message }: { message: string }) {
  return (
    <div className="card p-10 text-center">
      <span className="mb-3 inline-flex rounded-xl bg-surface p-2.5 text-text-muted">
        <MessagesSquare size={20} />
      </span>
      <p className="text-sm font-semibold text-text-primary">Conversation not shown</p>
      <p className="mx-auto mt-1 max-w-md text-xs text-text-muted">{message}</p>
      <Link href="/admin/conversations" className="btn-secondary mt-5 inline-flex px-3 py-2 text-xs font-semibold">
        All conversations
      </Link>
    </div>
  );
}

function ThreadContent() {
  // Ids travel as query params: the export is static, so there are no dynamic route
  // segments to put them in. All three are needed — the owner is part of a thread's
  // identity, not a filter on it.
  const searchParams = useSearchParams();
  const appParam = searchParams.get('app') || '';
  const entityId = searchParams.get('entity_id') || '';
  const userId = searchParams.get('user_id') || '';
  const app = isChatApp(appParam) ? appParam : null;

  const [thread, setThread] = useState<ChatThread | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by the retry button. The fetch stays in the effect so it can be cancelled. */
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    // Nothing to fetch without all three; that case is rendered as its own state below,
    // and `loading` is never reached because the missing-link branch returns first.
    if (!app || !entityId || !userId) return;

    let cancelled = false;
    api
      .getConversationThread(app, entityId, userId)
      .then((data) => {
        if (!cancelled) setThread(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load conversation');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [app, entityId, userId, attempt]);

  const retry = () => {
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  };

  if (!app || !entityId || !userId) {
    return (
      <MissingThread message="This link is missing the app, the record or the owner, so there is no single conversation to show. Pick one from the list." />
    );
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-96 rounded-xl" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="card p-10 text-center">
        <p className="text-sm font-semibold text-text-primary">Conversation could not be loaded</p>
        <p className="mx-auto mt-1 max-w-md text-xs text-text-muted">{error}</p>
        <button type="button" onClick={retry} className="btn-secondary mt-5 px-3 py-2 text-xs font-semibold">
          Try again
        </button>
      </div>
    );
  }

  if (!thread) {
    return <MissingThread message="No conversation was stored for this record and owner, or it has passed the retention window and been deleted." />;
  }

  return (
    <div className="space-y-4">
      <div className="card p-6">
        <p className="page-kicker">Conversation</p>
        {/* Linked while the record is still there, plain text once it is gone: a title
            that navigates to a 404 is worse than a title that admits the record is
            deleted. The conversation itself is kept either way. */}
        {thread.artifact_exists && thread.artifact_href ? (
          <Link
            href={thread.artifact_href}
            className="mt-1 inline-flex items-center gap-2 text-2xl font-bold text-text-primary transition-colors hover:text-accent"
          >
            {thread.title}
            <ExternalLink size={16} className="text-text-muted" />
          </Link>
        ) : (
          <h1 className="mt-1 text-2xl font-bold text-text-primary">{thread.title}</h1>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-text-muted">
          <span className="inline-flex items-center gap-1.5">
            <User size={13} />
            {thread.owner_email || thread.owner_user_id}
          </span>
          <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-secondary">
            {APP_LABEL[thread.app]}
          </span>
          <span>
            {thread.turns.length} {thread.turns.length === 1 ? 'turn' : 'turns'}
          </span>
          {!thread.artifact_exists && <span>The record this was about has been deleted.</span>}
        </div>
      </div>

      <div className="card p-6">
        <div className="space-y-4">
          {thread.turns.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-muted">This thread has no stored turns.</p>
          ) : (
            thread.turns.map((turn) => (
              <div key={turn.seq} className={`flex flex-col ${turn.role === 'user' ? 'items-end' : 'items-start'}`}>
                <div
                  className={
                    turn.role === 'user'
                      ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-sm text-white'
                      : 'max-w-[90%] rounded-2xl rounded-bl-sm bg-surface-interactive px-3 py-2 text-sm text-text-primary'
                  }
                >
                  <div className="space-y-2 leading-relaxed">{renderChatContent(turn.content)}</div>

                  {turn.proposal ? (
                    <div className="mt-3 rounded-lg border border-border bg-surface p-3">
                      <p className="text-xs font-medium text-text-secondary">Proposed change</p>
                      <p className="mt-1 text-sm text-text-primary">{turn.proposal.summary}</p>
                      {/* Whether it was taken up is the part a reviewer is here for. */}
                      {turn.applied_at !== undefined ? (
                        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-success">
                          <Check size={14} /> Applied {formatTurnTime(turn.applied_at)}
                          {turn.proposal.kind === 'estimate_change' ? ' as a new revision.' : ' to the stored minutes.'}
                        </p>
                      ) : (
                        <p className="mt-2 text-[11px] text-text-muted">Never applied. The record was left as it was.</p>
                      )}
                    </div>
                  ) : null}
                </div>

                <span className="mt-1 px-1 text-[10px] text-text-muted">{formatTurnTime(turn.created_at)}</span>
              </div>
            ))
          )}
        </div>

        {/* Collapsed: it is evidence for the transcript above, not the thing being read.
            Labelled for what it actually is, because a reviewer who mistook it for the
            whole record would draw the wrong conclusion from a gap in it. */}
        {thread.transcript_excerpt ? (
          <details className="mt-6 rounded-xl border border-border bg-surface">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 text-sm font-semibold text-text-primary [&::-webkit-details-marker]:hidden">
              <span>Evidence the assistant was given</span>
              <span className="text-xs font-medium text-text-muted">View excerpt</span>
            </summary>
            <div className="border-t border-border px-4 pb-4 pt-3">
              <p className="text-xs leading-5 text-text-muted">
                The excerpt of the record that was sent with these questions. It may be partial: long
                records are cut to fit the context window, so the assistant answered from this rather
                than from everything the record contains.
              </p>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-text-secondary">{thread.transcript_excerpt}</p>
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}

export default function AdminConversationViewPage() {
  return (
    <TierGuard minTier="REVIEWER">
      <div className="space-y-4">
        <BackButton defaultHref="/admin/conversations" defaultLabel="Conversations" />
        <Suspense fallback={<Skeleton className="h-96 rounded-xl" />}>
          <ThreadContent />
        </Suspense>
      </div>
    </TierGuard>
  );
}
