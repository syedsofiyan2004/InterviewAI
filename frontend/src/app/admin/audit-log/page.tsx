'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ScrollText, Info } from 'lucide-react';
import { format } from 'date-fns';

type AuditRow = Awaited<ReturnType<typeof api.getAuditLog>>['items'][number];

function AuditLogContent() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (nextCursor?: string) => {
    const data = await api.getAuditLog(nextCursor);
    setRows((prev) => (nextCursor ? [...prev, ...(data.items ?? [])] : data.items ?? []));
    setCursor(data.last_evaluated_key);
  }, []);

  useEffect(() => {
    loadPage()
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load the audit log'))
      .finally(() => setLoading(false));
  }, [loadPage]);

  const handleLoadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      await loadPage(cursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more entries');
    } finally {
      setLoadingMore(false);
    }
  };

  if (loading) return <SkeletonList rows={6} />;

  if (error) {
    return <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>;
  }

  return (
    <div className="space-y-4">
      <p className="flex items-start gap-2 text-xs text-text-muted">
        <Info size={14} className="mt-0.5 flex-shrink-0" />
        Opening this page is itself an audited action.
      </p>

      {rows.length === 0 ? (
        <div className="card flex min-h-[220px] flex-col items-center justify-center p-6 text-center">
          <span className="mb-3 rounded-xl bg-surface-elevated p-2.5 text-text-muted"><ScrollText size={20} /></span>
          <p className="text-sm font-medium text-text-primary">No entries yet</p>
          <p className="mt-1 text-sm text-text-muted">Admin reads, downloads, and decisions are recorded here.</p>
        </div>
      ) : (
        <div className="data-table">
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                  <th scope="col" className="px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-text-muted">When</th>
                  <th scope="col" className="px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-text-muted">Actor</th>
                  <th scope="col" className="px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-text-muted">Action</th>
                  <th scope="col" className="px-5 py-3 text-[11px] font-bold uppercase tracking-wide text-text-muted">Target</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.audit_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="whitespace-nowrap px-5 py-3 text-xs text-text-muted">
                      {format(new Date(row.ts), 'dd-MM-yyyy, HH:mm:ss')}
                    </td>
                    <td className="px-5 py-3 text-sm text-text-primary">{row.actor_email || row.actor_user_id}</td>
                    <td className="px-5 py-3">
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-accent">
                        {row.action.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-text-muted">
                      {[row.target_type, row.target_id].filter(Boolean).join(' · ') || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {cursor && (
        <div className="flex justify-center">
          <button type="button" onClick={handleLoadMore} className="btn-secondary" disabled={loadingMore}>
            {loadingMore ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function AdminAuditLogPage() {
  return (
    <TierGuard minTier="OWNER">
      <AuditLogContent />
    </TierGuard>
  );
}
