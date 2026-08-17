'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import Link from 'next/link';
import {
  api,
  getServerNow,
  type WorkspaceFull,
  type Comment,
  type SharePermission,
  type LinkedRecord,
} from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { WorkspaceStatusBadge } from './WorkspaceStatusBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Toast } from '@/components/ui/Toast';
import { LiveProgressBanner } from '@/components/ui/LiveProgressBanner';
import {
  MessageSquare,
  Check,
  Users,
  Link2,
  ThumbsUp,
  ThumbsDown,
  Trash2,
  ArrowRight,
  ArrowLeft,
  BrainCircuit,
  ShieldCheck,
} from 'lucide-react';
import { format } from 'date-fns';

const RECORD_HREF: Record<LinkedRecord['record_type'], (id: string) => string> = {
  interview: (id) => `/interviews/view?id=${encodeURIComponent(id)}&from=/admin/candidates`,
  mom: (id) => `/mom/view?id=${encodeURIComponent(id)}&from=/admin/candidates`,
  intelligence: (id) => `/interviews/intelligence/view?id=${encodeURIComponent(id)}&from=/admin/candidates`,
};

const RECORD_LABEL: Record<LinkedRecord['record_type'], string> = {
  interview: 'Manual evaluation',
  mom: 'Meeting report',
  intelligence: 'Intelligence interview',
};

interface CandidateDetailProps {
  workspaceId: string;
  /** Where the back link points — differs between the member and admin surfaces. */
  backHref: string;
  backLabel: string;
}

export function CandidateDetail({ workspaceId, backHref, backLabel }: CandidateDetailProps) {
  const { profile, hasTier } = useAuth();
  const [data, setData] = useState<WorkspaceFull | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);

  const [shareEmail, setShareEmail] = useState('');
  const [shareUserId, setShareUserId] = useState('');
  const [sharePermission, setSharePermission] = useState<'VIEWER' | 'COMMENTER'>('VIEWER');
  const [sharing, setSharing] = useState(false);

  const [decisionNote, setDecisionNote] = useState('');
  const [deciding, setDeciding] = useState(false);

  const [compositeStarting, setCompositeStarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setError(null);
      const full = await api.getWorkspaceFull(workspaceId);
      setData(full);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load this review workspace');
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const compositeStatus = data?.workspace.composite_status;

  // Composite synthesis runs on a background worker (Part D), so the workspace
  // row is the only place the outcome appears — the POST returns as soon as the
  // task is queued. Poll on the same 4s cadence the intelligence pages use, and
  // tear the interval down the moment the status leaves 'processing'.
  useEffect(() => {
    if (compositeStatus !== 'processing') return;
    const timer = setInterval(() => {
      void load();
    }, 4000);
    return () => clearInterval(timer);
  }, [compositeStatus, load]);

  const handleCompositeAnalysis = async () => {
    setCompositeStarting(true);
    try {
      await api.generateCompositeAnalysis(workspaceId);
      // Flip the local row to 'processing' rather than waiting for a refetch:
      // it shows the banner on this click and is what arms the poll above.
      setData((prev) =>
        prev
          ? {
              ...prev,
              workspace: {
                ...prev.workspace,
                composite_status: 'processing',
                composite_progress_stage: 'queued',
                composite_progress_message: 'Queued for composite synthesis...',
                // Server time, not Date.now(): the worker's real stamp arrives on
                // the next poll and the two must be on the same clock or the
                // elapsed timer jumps when the optimistic value is replaced.
                composite_started_at: getServerNow(),
                composite_error: null,
              },
            }
          : prev,
      );
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : 'Failed to start composite analysis',
        type: 'error',
      });
    } finally {
      setCompositeStarting(false);
    }
  };

  const canComment = data?.my_access.can_comment ?? false;
  const isOwner = data?.my_access.is_owner ?? false;
  const canApprove = data?.my_access.can_decide ?? hasTier('APPROVER');
  const canManageShares = isOwner;

  const sortedComments = useMemo(
    () => [...(data?.comments ?? [])].sort((a, b) => a.created_at - b.created_at),
    [data?.comments],
  );

  const handlePostComment = async (event: FormEvent) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !data) return;

    // Optimistic insert — the thread should feel immediate. Reconciled from the
    // server response, and rolled back if the post fails.
    const tempId = `pending-${body.length}-${sortedComments.length}`;
    const optimistic: Comment = {
      workspace_id: workspaceId,
      comment_id: tempId,
      author_user_id: profile?.userId ?? '',
      author_email: profile?.email ?? 'You',
      body,
      resolved: false,
      created_at: Date.now(),
    };
    setData({ ...data, comments: [...(data.comments || []), optimistic] });
    setDraft('');
    setPosting(true);

    try {
      const saved = await api.createComment(workspaceId, body);
      setData((prev) =>
        prev
          ? { ...prev, comments: (prev.comments || []).map((c) => (c.comment_id === tempId ? saved : c)) }
          : prev,
      );
    } catch (err) {
      setData((prev) =>
        prev ? { ...prev, comments: (prev.comments || []).filter((c) => c.comment_id !== tempId) } : prev,
      );
      setDraft(body);
      setToast({ message: err instanceof Error ? err.message : 'Could not post comment', type: 'error' });
    } finally {
      setPosting(false);
    }
  };

  const handleResolve = async (commentId: string) => {
    if (!data) return;
    const previous = data.comments || [];
    setData({
      ...data,
      comments: previous.map((c) => (c.comment_id === commentId ? { ...c, resolved: true } : c)),
    });
    try {
      await api.resolveComment(workspaceId, commentId);
    } catch (err) {
      setData((prev) => (prev ? { ...prev, comments: previous } : prev));
      setToast({ message: err instanceof Error ? err.message : 'Could not resolve comment', type: 'error' });
    }
  };

  const handleAddShare = async (event: FormEvent) => {
    event.preventDefault();
    const userId = shareUserId.trim();
    if (!userId) return;

    setSharing(true);
    try {
      await api.addWorkspaceShare(workspaceId, {
        shared_user_id: userId,
        shared_email: shareEmail.trim() || undefined,
        permission: sharePermission,
      });
      setShareUserId('');
      setShareEmail('');
      setToast({ message: 'Access granted', type: 'success' });
      await load();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Could not share', type: 'error' });
    } finally {
      setSharing(false);
    }
  };

  const handleRemoveShare = async (userId: string) => {
    try {
      await api.removeWorkspaceShare(workspaceId, userId);
      setToast({ message: 'Access removed', type: 'success' });
      await load();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Could not remove access', type: 'error' });
    }
  };

  const handleDecision = async (decision: 'APPROVED' | 'REJECTED') => {
    setDeciding(true);
    try {
      await api.postDecision(workspaceId, decision, decisionNote.trim() || undefined);
      setDecisionNote('');
      setToast({ message: `Decision recorded: ${decision === 'APPROVED' ? 'approved' : 'rejected'}`, type: 'success' });
      await load();
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : 'Could not record decision', type: 'error' });
    } finally {
      setDeciding(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="card flex min-h-[280px] flex-col items-center justify-center p-6 text-center">
        <p className="text-sm font-medium text-text-primary">{error ?? 'Review workspace not found'}</p>
        <Link href={backHref} className="btn-secondary mt-4">{backLabel}</Link>
      </div>
    );
  }

  const { workspace, shares, decisions, linked_records, my_access } = data;

  return (
    <div className="space-y-6">
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <Link
        href={backHref}
        className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-elevated px-3.5 py-2 text-xs font-semibold text-text-primary transition-colors hover:bg-surface-interactive hover:border-accent/40"
      >
        <ArrowLeft size={15} className="text-accent" />
        <span>Back to {backLabel}</span>
      </Link>

      <div className="card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-bold tracking-tight text-text-primary">
              {workspace.candidate_name || workspace.title}
            </h1>
            <p className="mt-0.5 text-sm text-text-muted">
              {[workspace.position, `Owner: ${workspace.owner_email || workspace.owner_user_id}`].filter(Boolean).join(' - ')}
            </p>
          </div>
          <WorkspaceStatusBadge status={workspace.status} />
        </div>

        {my_access.via_admin_tier && !my_access.is_owner && (
          <p className="mt-4 flex items-center gap-2 rounded-lg border border-accent/25 bg-accent/10 px-3 py-2 text-xs text-accent">
            <ShieldCheck size={14} className="flex-shrink-0" />
            You are viewing this as an administrator ({my_access.via_admin_tier.toLowerCase()}). This access is recorded in the audit log.
          </p>
        )}
      </div>

      <section className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Link2 size={15} className="text-text-muted" /> Interview rounds and reports
        </h2>
        <div className="mb-4 flex items-center justify-between">
          <p className="max-w-2xl text-xs leading-5 text-text-muted">
            This workspace is the shared review layer for a candidate. Manual evaluations, Interview Intelligence rounds,
            and related meeting reports should be linked here so reviewers can compare evidence before a final decision.
          </p>
          <div className="flex items-center gap-2">
            {/* Manual round creation is an admin tool (Part E): interviewers reach
                their rounds through My Interviews, which provisions on open. The
                server enforces REVIEWER regardless — this only hides a CTA that
                would 403. */}
            {hasTier('REVIEWER') && (
              <Link
                href={`/interviews/intelligence/new?workspace_id=${encodeURIComponent(workspace.workspace_id)}`}
                className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 text-xs"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                Add Interview Round
              </Link>
            )}
            {hasTier('APPROVER') && (linked_records || []).filter(r => r.record_type === 'intelligence' && r.summary?.status === 'COMPLETED').length > 0 && (
              <button
                onClick={() => void handleCompositeAnalysis()}
                disabled={compositeStarting || compositeStatus === 'processing'}
                className="btn-primary flex items-center gap-1.5 bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 text-xs text-white border-transparent disabled:opacity-50"
              >
                <BrainCircuit size={14} />
                {compositeStatus === 'processing'
                  ? 'Analyzing...'
                  : workspace.composite_analysis
                  ? 'Re-analyze All Rounds'
                  : 'Analyze All Rounds'}
              </button>
            )}
          </div>
        </div>
        {(linked_records || []).filter((r) => r.record_id && r.label?.toUpperCase() !== 'LOI' && r.record_id.toUpperCase() !== 'LOI').length === 0 ? (
          <div className="rounded-lg border border-border bg-surface-elevated px-4 py-4 text-sm text-text-muted">
            No interview rounds are linked yet. Start from an evaluation or Interview Intelligence workspace so reports are
            connected here automatically before reviewers discuss the candidate.
          </div>
        ) : (
          <div className="space-y-3">
            {(linked_records || [])
              .filter((r) => r.record_id && r.label?.toUpperCase() !== 'LOI' && r.record_id.toUpperCase() !== 'LOI')
              .map((record, idx) => (
                <div
                  key={`${record.record_type}-${record.record_id}`}
                  className="group relative flex flex-col gap-3 rounded-xl border border-border bg-surface-elevated p-4 transition-all hover:border-accent/30 hover:bg-surface-interactive sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-accent border border-accent/20">
                        {record.summary?.keka_title || record.label || `Round ${idx + 1}`}
                      </span>
                      {record.summary?.interviewer_name && (
                        <span className="text-xs font-medium text-text-secondary">
                          by {record.summary.interviewer_name}
                        </span>
                      )}
                      {record.summary?.scheduled_at && (
                        <span className="text-[11px] text-text-muted border-l border-border pl-2">
                          {format(new Date(record.summary.scheduled_at), 'dd-MM-yyyy')}
                        </span>
                      )}
                    </div>
                    <span className="text-sm font-medium text-text-primary truncate">
                      {record.summary?.position_title || workspace.position || 'Interview'}
                    </span>
                    {Array.isArray(record.summary?.selected_topics) && record.summary.selected_topics.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {record.summary.selected_topics.map((topic: string) => (
                          <span key={topic} className="rounded border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium text-text-secondary">
                            {topic}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  
                  <div className="flex shrink-0 items-center gap-3">
                    {record.summary?.status === 'COMPLETED' ? (
                      <div className="flex items-center gap-2">
                        {record.summary?.overall_score !== undefined && (
                          <div className="flex items-center gap-1 rounded-full bg-surface px-2.5 py-1 shadow-sm border border-border">
                            <span className="text-[10px] font-semibold text-text-muted uppercase">Score</span>
                            <span className={`text-xs font-bold ${
                              record.summary.overall_score >= 80 ? 'text-emerald-500' :
                              record.summary.overall_score >= 60 ? 'text-amber-500' : 'text-danger'
                            }`}>{Math.round(record.summary.overall_score)}</span>
                          </div>
                        )}
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2.5 py-1 pr-3 text-[11px] font-semibold text-emerald-600 border border-emerald-500/20">
                          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                          COMPLETED
                        </span>
                      </div>
                    ) : (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-500/10 px-2.5 py-1 pr-3 text-[11px] font-semibold text-blue-600 border border-blue-500/20">
                        <span className="h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                        IN PROGRESS
                      </span>
                    )}
                    <Link
                      href={RECORD_HREF[record.record_type](record.record_id)}
                      className="btn-secondary inline-flex h-8 shrink-0 items-center justify-center gap-1.5 px-3 text-xs font-semibold bg-surface"
                    >
                      Open report <ArrowRight size={13} />
                    </Link>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>

      {compositeStatus === 'processing' && (
        <LiveProgressBanner
          taskType="analysis"
          title="Synthesizing all interview rounds"
          subtitle="This runs in the background — you can leave this page and come back."
          startTime={workspace.composite_started_at}
          progressStage={workspace.composite_progress_stage}
          progressMessage={workspace.composite_progress_message}
          progressEvents={workspace.composite_progress_events}
        />
      )}

      {compositeStatus === 'failed' && (
        <LiveProgressBanner
          taskType="analysis"
          title="Composite analysis"
          error={workspace.composite_error || 'Composite analysis failed.'}
          onRetry={hasTier('APPROVER') ? () => void handleCompositeAnalysis() : undefined}
        />
      )}

      {workspace.composite_analysis && compositeStatus !== 'processing' && (
        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <BrainCircuit size={15} className="text-text-muted" />
            {typeof workspace.composite_rounds_used === 'number' && typeof workspace.composite_rounds_total === 'number'
              && workspace.composite_rounds_used < workspace.composite_rounds_total
              ? `Composite view across ${workspace.composite_rounds_used} of ${workspace.composite_rounds_total} rounds`
              : 'Composite view across all rounds'}
          </h2>

          {/* A round only enters the synthesis once its AI review has run. Saying
              which ones were left out keeps this from reading as a verdict on the
              full panel when it is not. */}
          {!!workspace.composite_rounds_skipped?.length && (
            <p className="mb-3 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs leading-5 text-warning">
              Not included (no completed AI review yet): {workspace.composite_rounds_skipped.join(', ')}. Run the review on
              those rounds and re-analyze to fold them in.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {typeof workspace.composite_analysis.compositeScore === 'number' && (
              <div className="flex items-baseline gap-1.5 rounded-lg border border-border bg-surface-elevated px-3 py-2">
                <span className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Composite</span>
                <span
                  className={`text-lg font-bold ${
                    workspace.composite_analysis.compositeScore >= 80
                      ? 'text-emerald-500'
                      : workspace.composite_analysis.compositeScore >= 60
                      ? 'text-amber-500'
                      : 'text-danger'
                  }`}
                >
                  {Math.round(workspace.composite_analysis.compositeScore)}
                </span>
              </div>
            )}
            {workspace.composite_analysis.finalRecommendation && (
              <span className="rounded-full border border-accent/25 bg-accent/10 px-3 py-1 text-[11px] font-bold uppercase tracking-wide text-accent">
                {workspace.composite_analysis.finalRecommendation.replace(/_/g, ' ')}
              </span>
            )}
          </div>

          {workspace.composite_analysis.overallSummary && (
            <p className="mt-4 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
              {workspace.composite_analysis.overallSummary}
            </p>
          )}

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {(workspace.composite_analysis.keyStrengths || []).length > 0 && (
              <div className="rounded-lg border border-border bg-surface-elevated p-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-success">Key strengths</h3>
                <ul className="mt-2 space-y-1.5">
                  {(workspace.composite_analysis.keyStrengths || []).map((item) => (
                    <li key={item} className="text-sm leading-5 text-text-secondary">- {item}</li>
                  ))}
                </ul>
              </div>
            )}
            {(workspace.composite_analysis.majorConcerns || []).length > 0 && (
              <div className="rounded-lg border border-border bg-surface-elevated p-3">
                <h3 className="text-[11px] font-bold uppercase tracking-wider text-danger">Major concerns</h3>
                <ul className="mt-2 space-y-1.5">
                  {(workspace.composite_analysis.majorConcerns || []).map((item) => (
                    <li key={item} className="text-sm leading-5 text-text-secondary">- {item}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>
      )}

      <section className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <MessageSquare size={15} className="text-text-muted" />
          Discussion
          <span className="text-xs font-normal text-text-muted">({sortedComments.length})</span>
        </h2>

        {sortedComments.length === 0 ? (
          <p className="py-6 text-center text-sm text-text-muted">No comments yet.</p>
        ) : (
          <ul className="space-y-3">
            {sortedComments.map((comment) => (
              <li
                key={comment.comment_id}
                className={`rounded-lg border border-border bg-surface-elevated p-3 ${comment.resolved ? 'opacity-60' : ''}`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="truncate text-xs font-semibold text-text-primary">{comment.author_email}</span>
                  <span className="flex-shrink-0 text-[11px] text-text-muted">
                    {format(new Date(comment.created_at), 'dd-MM-yyyy HH:mm')}
                  </span>
                </div>
                <p className="mt-1.5 whitespace-pre-wrap text-sm text-text-secondary">{comment.body}</p>
                {comment.resolved ? (
                  <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-success">
                    <Check size={12} /> Resolved
                  </span>
                ) : (
                  canComment && (
                    <button
                      type="button"
                      onClick={() => handleResolve(comment.comment_id)}
                      className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted transition-colors hover:text-success"
                    >
                      <Check size={12} /> Mark resolved
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}

        {data.comments_has_more && (
          <p className="mt-3 text-xs text-text-muted">Showing the most recent comments only.</p>
        )}

        {canComment ? (
          <form onSubmit={handlePostComment} className="mt-4 space-y-3">
            <label htmlFor="comment-body" className="sr-only">Add a comment</label>
            <textarea
              id="comment-body"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              placeholder="Add a comment..."
              className="premium-input min-h-[104px] w-full resize-y px-4 py-3 text-sm leading-6"
            />
            <div className="flex justify-end">
              <button
                type="submit"
                className="btn-primary inline-flex h-10 min-w-[132px] items-center justify-center px-4 text-sm font-semibold"
                disabled={posting || !draft.trim()}
              >
                {posting ? 'Posting...' : 'Post comment'}
              </button>
            </div>
          </form>
        ) : (
          <p className="mt-4 rounded-lg border border-border bg-surface-elevated px-3 py-2 text-xs text-text-muted">
            You have read-only access to this review workspace.
          </p>
        )}
      </section>

      {canManageShares && (
        <section className="card p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
            <Users size={15} className="text-text-muted" /> Internal reviewers with access
          </h2>

          {(shares || []).length === 0 ? (
            <p className="text-sm text-text-muted">Only the owner can see this review workspace.</p>
          ) : (
            <ul className="space-y-2">
              {(shares || []).map((share) => (
                <li
                  key={share.shared_user_id}
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface-elevated px-3 py-2.5"
                >
                  <div className="flex-1 min-w-0">
                    {share.shared_email || share.shared_user_id}
                  </div>
                  <span className="rounded-full bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-secondary">
                    {share.permission}
                  </span>
                  <button
                    type="button"
                    onClick={() => share.shared_user_id && handleRemoveShare(share.shared_user_id)}
                    className="p-1 text-text-muted hover:text-red-400 hover:bg-red-400/10 rounded"
                    aria-label={`Remove access for ${share.shared_email || share.shared_user_id}`}
                  >
                    <Trash2 size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="mt-1 text-xs leading-5 text-text-muted">
            Give a colleague access to this candidate. <strong className="font-semibold text-text-secondary">Viewer</strong> can
            read the linked rounds and reports; <strong className="font-semibold text-text-secondary">Commenter</strong> can also
            post in the discussion. Neither can approve, reject, or delete.
          </p>

          <form onSubmit={handleAddShare} className="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_150px_auto]">
            <input
              value={shareUserId}
              onChange={(e) => setShareUserId(e.target.value)}
              placeholder="Reviewer user ID (required)"
              aria-label="User ID to share with"
              className="premium-input"
            />
            <input
              value={shareEmail}
              onChange={(e) => setShareEmail(e.target.value)}
              placeholder="Reviewer email (optional)"
              aria-label="Email of the person"
              className="premium-input"
            />
            <select
              value={sharePermission}
              onChange={(e) => setSharePermission(e.target.value as 'VIEWER' | 'COMMENTER')}
              aria-label="Permission level"
              className="premium-input"
            >
              <option value="VIEWER">Viewer</option>
              <option value="COMMENTER">Commenter</option>
            </select>
            <button
              type="submit"
              className="btn-primary inline-flex h-11 min-w-[104px] items-center justify-center px-4 text-sm font-semibold"
              disabled={sharing || !shareUserId.trim()}
            >
              {sharing ? 'Sharing...' : 'Share'}
            </button>
          </form>
          <p className="mt-2 text-xs text-text-muted">
            The user ID is the reviewer&apos;s account ID from Admin &rarr; Access. Email is optional and only used as a label.
            Candidates are external and are never granted access here.
          </p>
        </section>
      )}

      <section className="card p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-text-primary">
          <ThumbsUp size={15} className="text-text-muted" /> Decision history
        </h2>

        {(decisions || []).length === 0 ? (
          <p className="text-sm text-text-muted">No decision has been recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {[...(decisions || [])]
              .sort((a, b) => b.decided_at - a.decided_at)
              .map((decision) => (
                <li
                  key={`${decision.decided_at}-${decision.decided_by}`}
                  className="rounded-lg border border-border bg-surface-elevated p-3"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <span
                      className={`text-xs font-bold uppercase tracking-wide ${decision.decision === 'APPROVED' ? 'text-success' : 'text-danger'}`}
                    >
                      {decision.decision === 'APPROVED' ? 'Approved' : 'Rejected'}
                    </span>
                    <span className="flex-shrink-0 text-[11px] text-text-muted">
                      {format(new Date(decision.decided_at), 'dd-MM-yyyy HH:mm')}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-text-muted">
                    {decision.decided_by_email || decision.decided_by}
                  </p>
                  {decision.note && <p className="mt-1.5 text-sm text-text-secondary">{decision.note}</p>}
                </li>
              ))}
          </ul>
        )}

        {canApprove && (
          <div className="mt-4 space-y-2 border-t border-border pt-4">
            <label htmlFor="decision-note" className="sr-only">Decision note</label>
            <input
              id="decision-note"
              value={decisionNote}
              onChange={(e) => setDecisionNote(e.target.value)}
              placeholder="Optional note explaining the decision"
              className="premium-input h-11 w-full px-4 text-sm"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => handleDecision('APPROVED')}
                disabled={deciding}
              className="inline-flex h-10 min-w-[132px] items-center justify-center gap-2 rounded-lg bg-success px-4 text-sm font-semibold text-white transition-colors hover:bg-success/90 disabled:opacity-50"
            >
                <ThumbsUp size={15} /> Approve review
              </button>
              <button
                type="button"
                onClick={() => handleDecision('REJECTED')}
                disabled={deciding}
                className="inline-flex h-10 min-w-[132px] items-center justify-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 text-sm font-semibold text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
              >
                <ThumbsDown size={15} /> Reject review
              </button>
            </div>
            <p className="text-xs text-text-muted">
              Decisions are appended, never replaced. The full history stays intact.
            </p>
          </div>
        )}
      </section>

    </div>
  );
}
