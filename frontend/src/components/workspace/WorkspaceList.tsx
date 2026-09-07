'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ArrowRight, Search, Users, Share2, RefreshCw } from 'lucide-react';
import { api, type CandidateWorkspace } from '@/lib/api';
import { WorkspaceStatusBadge } from './WorkspaceStatusBadge';
import { SkeletonList } from '@/components/ui/Skeleton';

const statuses = ['OPEN', 'IN_REVIEW', 'APPROVED', 'REJECTED'];
export function WorkspaceList({ shared = false }: { shared?: boolean }) {
  const [items, setItems] = useState<CandidateWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('ALL');
  const [sort, setSort] = useState('recent');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    (shared ? api.listSharedWithMe() : api.listWorkspaces())
      .then(data => { if (active) setItems(data.items ?? []); })
      .catch(err => { if (active) setError(err instanceof Error ? err.message : 'Unable to load workspaces'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [shared, reload]);
  const filtered = items.filter(item =>
    (status === 'ALL' || item.status === status) &&
    [item.candidate_name, item.title, item.position, shared ? item.owner_email : ''].join(' ').toLowerCase().includes(query.trim().toLowerCase())
  ).sort((a, b) => sort === 'name'
    ? (a.candidate_name || a.title).localeCompare(b.candidate_name || b.title)
    : b.updated_at - a.updated_at);
  const Icon = shared ? Share2 : Users;
  return (
    <div className="space-y-6">
      <header className="card p-6 sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent"><Icon size={16} /> HireRite / Candidate reviews</p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text-primary">{shared ? 'Shared with Me' : 'My Candidates'}</h1>
            <p className="mt-3 text-sm leading-6 text-text-secondary">{shared
              ? 'Candidate review workspaces colleagues have shared with your account. Compare linked evidence and follow hiring decisions; commenter access also lets you join the discussion.'
              : 'Your candidate review workspaces bring linked interview rounds, reports, reviewer comments, and final decisions together. Open a candidate to review the evidence or manage access for colleagues.'}</p>
          </div>
          <Link href={shared ? '/candidates' : '/my-interviews'} className="btn-secondary">{shared ? 'My Candidates' : 'My Interviews'}<ArrowRight size={16} /></Link>
        </div>
        <p className="mt-5 border-t border-border pt-4 text-xs leading-5 text-text-muted">{shared
          ? 'Access is granted from a candidate workspace under Internal reviewers with access. Viewer access is read-only; commenter access includes discussion. Sharing does not grant approval rights.'
          : 'Start with an interview in HireRite to create a connected review workspace. Candidates shared by colleagues appear in Shared with Me.'}</p>
      </header>
      {loading ? <SkeletonList rows={4} /> : error ? (
        <div role="alert" className="card p-5"><p className="text-sm text-danger">{error}</p><button className="btn-secondary mt-3" onClick={() => { setLoading(true); setError(null); setReload(v => v + 1); }}><RefreshCw size={15} />Try again</button></div>
      ) : <>
        <div className="flex flex-col gap-3 sm:flex-row">
          <label className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5"><Search size={17} className="text-text-muted" /><span className="sr-only">Search candidates</span><input className="w-full min-w-0 bg-transparent text-sm text-text-primary outline-none" value={query} onChange={e => setQuery(e.target.value)} placeholder={shared ? 'Search candidate, role, or owner' : 'Search candidate or role'} /></label>
          <select aria-label="Filter by review status" value={status} onChange={e => setStatus(e.target.value)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"><option value="ALL">All statuses</option>{statuses.map(s => <option key={s} value={s}>{s.replaceAll('_', ' ').toLowerCase()}</option>)}</select>
          <select aria-label="Sort candidates" value={sort} onChange={e => setSort(e.target.value)} className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"><option value="recent">Recently updated</option><option value="name">Candidate name</option></select>
        </div>
        <p aria-live="polite" className="text-xs text-text-muted">Showing {filtered.length} of {items.length} {shared ? 'shared' : 'owned'} review workspaces</p>
        {filtered.length === 0 ? <div className="card p-10 text-center"><Icon className="mx-auto text-accent" size={26} /><h2 className="mt-4 font-semibold text-text-primary">{items.length ? 'No matching candidates' : shared ? 'Nothing shared with you yet' : 'No candidate reviews yet'}</h2><p className="mt-2 text-sm text-text-muted">{items.length ? 'Try a different name or review status.' : shared ? 'Ask the workspace owner to add your account as an internal reviewer.' : 'Open My Interviews to prepare or continue a hiring review.'}</p>{items.length > 0 && <button className="btn-secondary mx-auto mt-4" onClick={() => { setQuery(''); setStatus('ALL'); }}>Clear filters</button>}</div>
        : <div className="space-y-3">{filtered.map(item => <Link key={item.workspace_id} href={`/candidates/view?id=${encodeURIComponent(item.workspace_id)}`} className="group flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface-elevated p-5 transition-colors hover:border-accent/40 hover:bg-surface-interactive">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 font-semibold text-accent">{(item.candidate_name || item.title || '?').charAt(0).toUpperCase()}</span>
          <span className="min-w-[140px] flex-1"><span className="block font-semibold text-text-primary">{item.candidate_name || item.title}</span><span className="mt-1 block text-xs text-text-muted">{item.position || 'Role not specified'} ? Updated {Number.isFinite(new Date(item.updated_at).getTime()) ? format(new Date(item.updated_at), 'dd MMM yyyy') : 'date unavailable'}</span>{shared && <span className="mt-1 block break-all text-xs text-text-muted">Owner: {item.owner_email || item.owner_user_id}</span>}</span>
          <span className="flex flex-wrap items-center gap-3">{shared && item.my_permission && <span className="rounded-full border border-border px-2 py-1 text-xs text-text-secondary">{item.my_permission === 'COMMENTER' ? 'Can comment' : 'View only'}</span>}<WorkspaceStatusBadge status={item.status} /><ArrowRight size={17} className="text-accent" /></span>
        </Link>)}</div>}
      </>}
    </div>
  );
}
