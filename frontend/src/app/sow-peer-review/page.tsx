'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Clock, FileCheck, FileText, Loader2, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import { api, type SowPeerReviewJobSummary } from '@/lib/api';
import { StatusBadge } from '@/components/ui/StatusBadge';

export default function SowPeerReviewDashboard() {
  const router = useRouter();
  const [reviews, setReviews] = useState<SowPeerReviewJobSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<SowPeerReviewJobSummary | null>(null);

  const loadReviews = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      setReviews((await api.listSowPeerReviews()).items || []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Review history could not be loaded.');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => { void loadReviews(); }, [loadReviews]);
  useEffect(() => {
    if (!reviews.some((review) => review.status === 'QUEUED' || review.status === 'PROCESSING')) return;
    const timer = window.setInterval(() => void loadReviews(false), 5000);
    return () => window.clearInterval(timer);
  }, [loadReviews, reviews]);

  const stats = useMemo(() => reviews.reduce((value, review) => {
    value.total += 1;
    if (review.status === 'COMPLETED') value.completed += 1;
    else if (review.status === 'FAILED') value.failed += 1;
    else value.processing += 1;
    value.blockers += review.counts?.blockers || 0;
    return value;
  }, { total: 0, completed: 0, processing: 0, failed: 0, blockers: 0 }), [reviews]);

  const openReview = (reviewId: string) => router.push(`/sow-peer-review/view?id=${encodeURIComponent(reviewId)}`);
  const deleteReview = async (review: SowPeerReviewJobSummary, confirmed = false) => {
    if (!confirmed) { setPendingDelete(review); return; }
    if (!window.confirm(`Delete the review for “${review.file_name}”? This removes its AWS record and stored files permanently.`)) return;
    setDeletingId(review.review_id); setError(null);
    try {
      await api.deleteSowPeerReview(review.review_id);
      setReviews((current) => current.filter((item) => item.review_id !== review.review_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The review could not be deleted.');
    } finally { setDeletingId(null); }
  };

  const performDelete = async (review: SowPeerReviewJobSummary) => {
    setDeletingId(review.review_id); setError(null);
    try {
      await api.deleteSowPeerReview(review.review_id);
      setReviews((current) => current.filter((item) => item.review_id !== review.review_id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The review could not be deleted.');
    } finally { setDeletingId(null); }
  };

  return <div className="space-y-7 pb-8">
    <header className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="page-kicker mb-1">Minfy AI / Pre-Sales Tools</p><h1 className="text-xl font-semibold tracking-tight text-text-primary">SOW Peer Review</h1><p className="mt-1 max-w-2xl text-sm text-text-muted">A focused workspace for client-ready SOW reviews, risks, questions, and Word reports.</p></div>
      <Link href="/sow-peer-review/new" className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold"><Plus size={15} /> New SOW Review</Link>
    </header>

    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      <DashboardStat label="Total reviews" value={stats.total} icon={FileText} />
      <DashboardStat label="In progress" value={stats.processing} icon={Clock} />
      <DashboardStat label="Completed" value={stats.completed} icon={CheckCircle2} />
      <DashboardStat label="Blockers found" value={stats.blockers} icon={ShieldAlert} />
    </div>

    {error && <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>}
    <section className="data-table overflow-hidden">
      <div className="border-b border-border px-5 py-4 md:px-6"><h2 className="text-sm font-semibold text-text-primary">Recent reviews</h2><p className="mt-1 text-xs text-text-muted">Select any row to open its analysis and document output.</p></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left"><thead className="bg-surface"><tr className="border-b border-border"><th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Document</th><th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Context</th><th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Findings</th><th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Created</th><th className="px-5 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Status</th><th className="px-5 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Delete</th></tr></thead><tbody>
        {loading ? <tr><td colSpan={6} className="px-5 py-16 text-center text-sm text-text-muted"><Clock size={22} className="mx-auto mb-3 animate-pulse text-accent" />Loading review workspace...</td></tr> : reviews.length === 0 ? <tr><td colSpan={6} className="px-5 py-16 text-center"><FileCheck size={30} className="mx-auto text-accent" /><p className="mt-3 text-sm font-semibold text-text-primary">No SOW reviews yet</p><p className="mt-1 text-xs text-text-muted">Create the first review from the button above.</p></td></tr> : reviews.slice(0, 25).map((review) => <tr key={review.review_id} tabIndex={0} role="link" onClick={() => openReview(review.review_id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') openReview(review.review_id); }} className="cursor-pointer border-b border-border transition-colors last:border-0 hover:bg-surface-interactive focus:bg-surface-interactive focus:outline-none"><td className="px-5 py-4"><p className="max-w-[300px] truncate text-sm font-semibold text-text-primary">{review.file_name}</p><p className="mt-1 max-w-[340px] truncate text-xs text-text-muted">{review.overview || review.error_message || 'Analysis in progress'}</p></td><td className="px-5 py-4 text-xs text-text-secondary">{review.project_id ? 'Calculator project' : review.calculation_id ? 'AWS estimate' : 'SOW only'}</td><td className="px-5 py-4 text-xs text-text-secondary"><span className="font-semibold text-danger">{review.counts.blockers}</span> blockers · <span className="font-semibold text-warning">{review.counts.majors}</span> major · {review.counts.openQuestions} questions</td><td className="px-5 py-4 text-xs text-text-secondary">{new Date(review.created_at).toLocaleDateString()}</td><td className="px-5 py-4"><StatusBadge status={review.status} /></td><td className="px-5 py-4 text-right"><button type="button" aria-label={`Delete ${review.file_name}`} title={review.status === 'QUEUED' || review.status === 'PROCESSING' ? 'An active review cannot be deleted' : 'Delete review'} disabled={review.status === 'QUEUED' || review.status === 'PROCESSING' || deletingId === review.review_id} onClick={(event) => { event.stopPropagation(); void deleteReview(review); }} onKeyDown={(event) => event.stopPropagation()} className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-muted transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40">{deletingId === review.review_id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}</button></td></tr>)}
      </tbody></table></div>
    </section>
    {pendingDelete && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="presentation" onMouseDown={() => { if (!deletingId) setPendingDelete(null); }}><section role="dialog" aria-modal="true" aria-labelledby="delete-review-title" onMouseDown={(event) => event.stopPropagation()} className="w-full max-w-md rounded-2xl border border-border bg-surface-elevated p-6 shadow-2xl"><div className="flex items-start justify-between gap-4"><div><div className="mb-3 inline-flex rounded-xl bg-danger/10 p-2.5 text-danger"><Trash2 size={19} /></div><h2 id="delete-review-title" className="text-lg font-semibold text-text-primary">Delete SOW review?</h2><p className="mt-2 text-sm leading-6 text-text-secondary">This will permanently remove <span className="font-semibold text-text-primary">{pendingDelete.file_name}</span>, its review record, and stored AWS artifacts.</p></div><button type="button" aria-label="Close" onClick={() => setPendingDelete(null)} disabled={Boolean(deletingId)} className="rounded-lg p-2 text-text-muted hover:bg-surface-interactive hover:text-text-primary disabled:opacity-50"><X size={18} /></button></div><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setPendingDelete(null)} disabled={Boolean(deletingId)} className="btn-secondary px-4 py-2.5 text-sm font-semibold">Cancel</button><button type="button" onClick={() => { const review = pendingDelete; void performDelete(review).finally(() => setPendingDelete(null)); }} disabled={Boolean(deletingId)} className="inline-flex items-center gap-2 rounded-lg bg-danger px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-danger/90 disabled:opacity-50">{deletingId ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />} Delete permanently</button></div></section></div>}
  </div>;
}

function DashboardStat({ label, value, icon: Icon }: { label: string; value: number; icon: typeof FileText }) {
  return <div className="metric-card p-5"><div className="flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{label}</p><Icon size={18} className="text-accent" /></div><p className="mt-4 text-2xl font-semibold text-text-primary">{value}</p></div>;
}
