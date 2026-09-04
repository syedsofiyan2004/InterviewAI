'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { ArrowRight, CalendarClock, FolderOpen } from 'lucide-react';
import { api, type CandidateWorkspace } from '@/lib/api';
import { WorkspaceStatusBadge } from '@/components/workspace/WorkspaceStatusBadge';
import { SkeletonList } from '@/components/ui/Skeleton';

export default function CandidatesPage() {
  const [items, setItems] = useState<CandidateWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listWorkspaces()
      .then((data) => setItems(data.items ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load review workspaces'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonList rows={4} />;

  if (error) {
    return <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>;
  }

  return (
    <div className="space-y-5">
      <div className="card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Reviews</p>
        <h1 className="mt-2 text-xl font-semibold text-text-primary">Review workspaces</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
          These workspaces are created from HireRite interview records. Use them to discuss evidence,
          share access with named colleagues, and record final review decisions.
        </p>
      </div>

      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
        {items.length} {items.length === 1 ? 'review workspace' : 'review workspaces'}
      </p>

      {items.length === 0 ? (
        <div className="card p-6">
          <div className="flex flex-col items-center text-center">
            <span className="mb-3 rounded-xl bg-accent/10 p-2.5 text-accent"><FolderOpen size={20} /></span>
            <p className="text-sm font-semibold text-text-primary">No review workspaces yet</p>
            <p className="mt-1 max-w-xl text-sm leading-6 text-text-muted">
              Start from HireRite. MiMo will keep the candidate context and generated reports connected there.
            </p>
          </div>
          <Link href="/my-interviews" className="mx-auto mt-5 flex max-w-md rounded-xl border border-border bg-surface px-4 py-3 text-left transition-colors hover:border-accent/40 hover:bg-surface-interactive">
            <span>
              <CalendarClock size={18} className="text-accent" />
              <span className="mt-2 block text-sm font-semibold text-text-primary">HireRite</span>
              <span className="mt-1 block text-xs leading-5 text-text-muted">Open scheduled interviews and continue past hiring reviews.</span>
            </span>
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {items.map((item) => (
            <Link
              key={item.workspace_id}
              href={`/candidates/view?id=${encodeURIComponent(item.workspace_id)}`}
              className="group flex items-center gap-4 rounded-xl border border-border bg-surface-elevated p-4 transition-colors hover:bg-surface-interactive"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-text-primary">
                  {item.candidate_name || item.title}
                </span>
                <span className="block truncate text-xs text-text-muted">
                  {[item.position, format(new Date(item.updated_at), 'dd-MM-yyyy')].filter(Boolean).join(' - ')}
                </span>
              </span>
              <WorkspaceStatusBadge status={item.status} />
              <span className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-muted transition-colors group-hover:border-accent/40 group-hover:bg-accent/10 group-hover:text-accent">
                <span>Open workspace</span>
                <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
