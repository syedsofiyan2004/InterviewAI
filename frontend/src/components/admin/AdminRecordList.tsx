'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { ArrowRight, Inbox } from 'lucide-react';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { SkeletonList } from '@/components/ui/Skeleton';
import { format } from 'date-fns';

export interface AdminRow {
  id: string;
  title: string;
  subtitle?: string;
  ownerLabel?: string;
  status?: string;
  createdAt?: number;
  href: string;
}

interface AdminRecordListProps {
  rows: AdminRow[];
  loading: boolean;
  error: string | null;
  emptyTitle: string;
  emptyHint: string;
  recordLabel?: string;
}

/**
 * One presentation for every admin list (evaluations, meetings, candidates) so a
 * row reads the same wherever it appears. Owner is always shown: in an admin
 * view the whose-record-is-this question is the important one.
 */
export function AdminRecordList({
  rows,
  loading,
  error,
  emptyTitle,
  emptyHint,
  recordLabel = 'record',
}: AdminRecordListProps) {
  if (loading) return <SkeletonList rows={5} />;

  if (error) {
    return (
      <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="card flex min-h-[220px] flex-col items-center justify-center p-6 text-center">
        <span className="mb-3 rounded-xl bg-surface-elevated p-2.5 text-text-muted"><Inbox size={20} /></span>
        <p className="text-sm font-medium text-text-primary">{emptyTitle}</p>
        <p className="mt-1 text-sm text-text-muted">{emptyHint}</p>
      </div>
    );
  }

  const pathname = usePathname();

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
        {rows.length} {rows.length === 1 ? recordLabel : `${recordLabel}s`}
      </p>
      {rows.map((row) => {
        const linkHref = row.href.includes('from=')
          ? row.href
          : `${row.href}${row.href.includes('?') ? '&' : '?'}from=${encodeURIComponent(pathname)}`;
        return (
          <Link
            key={row.id}
            href={linkHref}
            className="group flex items-center gap-4 rounded-xl border border-border bg-surface-elevated p-4 transition-colors hover:bg-surface-interactive"
          >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-text-primary">{row.title}</span>
            <span className="block truncate text-xs text-text-muted">
              {[row.subtitle, row.ownerLabel, row.createdAt ? format(new Date(row.createdAt), 'dd-MM-yyyy') : null]
                .filter(Boolean)
                .join(' - ')}
            </span>
          </span>
          {row.status && <StatusBadge status={row.status} variant="pill" />}
          <span className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-muted transition-colors group-hover:border-accent/40 group-hover:bg-accent/10 group-hover:text-accent">
            <span>{recordLabel.includes('workspace') ? 'Review' : recordLabel.includes('report') ? 'Open report' : 'Open'}</span>
            <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>
        );
      })}
    </div>
  );
}
