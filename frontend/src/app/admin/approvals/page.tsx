'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type CandidateWorkspace } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { WorkspaceStatusBadge } from '@/components/workspace/WorkspaceStatusBadge';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ArrowRight, CheckCheck } from 'lucide-react';
import { format } from 'date-fns';

function ApprovalsContent() {
  const [items, setItems] = useState<CandidateWorkspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminListApprovals()
      .then((data) => {
        const pending = (data.items ?? []).filter((item) => {
          const name = (item.candidate_name || item.title || '').trim().toUpperCase();
          if (name === 'LOI' || name === 'RECORD LOI') return false;
          return item.status === 'OPEN' || item.status === 'IN_REVIEW';
        });
        setItems(pending);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load decision queue'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Administration</p>
        <h1 className="mt-2 text-xl font-semibold text-text-primary">Decision Queue</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
          Review workspaces awaiting a final approve or reject decision. Each workspace connects multi-round interview
          evidence and discussion notes for executive review.
        </p>
      </div>

      {loading && <SkeletonList rows={4} />}

      {error && (
        <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="card flex min-h-[220px] flex-col items-center justify-center p-6 text-center">
          <span className="mb-3 rounded-xl bg-success/10 p-2.5 text-success"><CheckCheck size={20} /></span>
          <p className="text-sm font-medium text-text-primary">No review workspaces waiting for a decision</p>
          <p className="mt-1 text-sm text-text-muted">Workspaces needing an executive decision will appear here automatically.</p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            {items.length} awaiting decision
          </p>
          {items.map((item) => (
            <Link
              key={item.workspace_id}
              href={`/admin/candidates/view?id=${encodeURIComponent(item.workspace_id)}`}
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
                <span>Review decision</span>
                <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminApprovalsPage() {
  return (
    <TierGuard minTier="APPROVER">
      <ApprovalsContent />
    </TierGuard>
  );
}
