'use client';

import { useEffect, useState } from 'react';
import { api, type Interview } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { AdminRecordList, type AdminRow } from '@/components/admin/AdminRecordList';

export default function AdminInterviewsPage() {
  const [rows, setRows] = useState<AdminRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminListInterviews()
      .then((data) => {
        const mapped: AdminRow[] = (data.items ?? []).map((item: any) => {
          const sourceLabel = item.source_label || (item.record_type === 'intelligence' ? 'HireRite' : 'Legacy evaluation');
          const route = item.href || (item.record_type === 'intelligence'
            ? `/interviews/intelligence/view?id=${encodeURIComponent(item.interview_id)}`
            : `/interviews/view?id=${encodeURIComponent(item.interview_id)}`);
          return {
            id: item.interview_id,
            title: item.candidate_name || 'Unnamed candidate',
            subtitle: [sourceLabel, item.position].filter(Boolean).join(' • '),
            ownerLabel: item.owner_email || item.owner_user_id,
            status: item.status,
            createdAt: item.created_at,
            href: route,
          };
        });
        setRows(mapped);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load interview reports'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <TierGuard minTier="VIEWER">
      <AdminRecordList
        rows={rows}
        loading={loading}
        error={error}
        emptyTitle="No interview reports found"
        emptyHint="Completed and in-progress interview evaluations created by any member will appear here."
        recordLabel="interview report"
      />
    </TierGuard>
  );
}
