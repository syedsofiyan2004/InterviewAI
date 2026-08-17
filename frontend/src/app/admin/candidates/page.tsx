'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { AdminRecordList, type AdminRow } from '@/components/admin/AdminRecordList';

export default function AdminCandidatesPage() {
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminListCandidates()
      .then((data) => {
        const mapped: AdminRow[] = (data.items ?? []).map((item) => ({
          id: item.workspace_id,
          title: item.candidate_name || item.title || 'Untitled workspace',
          subtitle: item.position || undefined,
          ownerLabel: item.owner_email || item.owner_user_id,
          status: item.status,
          createdAt: item.created_at,
          href: `/admin/candidates/view?id=${encodeURIComponent(item.workspace_id)}`,
        }));
        setRows(mapped);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load review workspaces'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <TierGuard minTier="VIEWER">
      <div className="space-y-5">
        <section className="card p-5">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Administration</p>
          <h1 className="mt-2 text-xl font-semibold text-text-primary">All Candidates</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
            Every candidate review workspace across the organization, created from real interview records.
            Each workspace keeps linked reports, comments, shares, and final decisions together.
          </p>
        </section>

        <AdminRecordList
          rows={rows}
          loading={loading}
          error={error}
          emptyTitle="No review workspaces yet"
          emptyHint="Review workspaces created from existing interview rounds will appear here."
          recordLabel="review workspace"
        />
      </div>
    </TierGuard>
  );
}
