'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type CandidateWorkspace } from '@/lib/api';
import { WorkspaceStatusBadge } from '@/components/workspace/WorkspaceStatusBadge';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ArrowRight, Inbox } from 'lucide-react';
import { format } from 'date-fns';

export default function SharedWithMePage() {
  const [items, setItems] = useState<CandidateWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listSharedWithMe()
      .then((data) => setItems(data.items ?? []))
      .catch((err) => {
        // An empty list is not an error: treat "nothing found" as the empty
        // state rather than surfacing a raw server message on a list page.
        const message = err instanceof Error ? err.message : 'Failed to load shared workspaces';
        if (/not found/i.test(message)) {
          setItems([]);
          return;
        }
        setError(message);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonList rows={4} />;

  if (error) {
    return <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>;
  }

  if (items.length === 0) {
    return (
      <div className="card flex min-h-[240px] flex-col items-center justify-center p-6 text-center">
        <span className="mb-3 rounded-xl bg-surface-elevated p-2.5 text-text-muted"><Inbox size={20} /></span>
        <p className="text-sm font-medium text-text-primary">Nothing shared with you yet</p>
        <p className="mt-1 max-w-sm text-sm text-text-muted">
          When a colleague shares an interview review workspace with you, it appears here.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
        {items.length} shared with you
      </p>
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
              {[item.position, item.owner_email || item.owner_user_id, format(new Date(item.updated_at), 'dd-MM-yyyy')]
                .filter(Boolean)
                .join(' - ')}
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
  );
}
