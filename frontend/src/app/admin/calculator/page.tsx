'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TierGuard } from '@/components/admin/TierGuard';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Calculator, ExternalLink, FileSpreadsheet, Search, User } from 'lucide-react';
import { calculatorApi, formatCurrency, type AdminCalculationItem } from '@/lib/calculatorApi';
import { format } from 'date-fns';

/**
 * Org-wide cost estimates.
 *
 * Read-only by design: an estimate belongs to whoever built it, and an admin
 * deleting someone else's working document has no upside. The server enforces
 * VIEWER regardless of what this page renders — TierGuard only avoids showing a
 * surface that would 403.
 */
export default function AdminCalculatorPage() {
  const [items, setItems] = useState<AdminCalculationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  useEffect(() => {
    calculatorApi.adminListCalculations()
      .then((data) => setItems(data.items ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load cost estimates'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => (
      item.name.toLowerCase().includes(query)
      || (item.owner_email || '').toLowerCase().includes(query)
      || (item.region || '').toLowerCase().includes(query)
    ));
  }, [items, search]);

  // Only the priced ones can contribute; an unfinished estimate is not zero.
  const totalMonthly = useMemo(() => {
    const priced = filtered.filter((item) => typeof item.monthly_total === 'number');
    return priced.length ? priced.reduce((total, item) => total + (item.monthly_total as number), 0) : null;
  }, [filtered]);

  return (
    <TierGuard minTier="VIEWER">
      <div className="space-y-6">
        <section className="card p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Administration</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-text-primary">Cost Estimates</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Every AWS cost estimate in the organization ({items.length} total
                {totalMonthly !== null && <> · {formatCurrency(totalMonthly)} combined monthly</>}).
              </p>
            </div>
            <div className="relative min-w-[220px]">
              <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
              <input
                type="text"
                placeholder="Filter estimates..."
                value={search}
                aria-label="Filter estimates"
                onChange={(event) => setSearch(event.target.value)}
                className="w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2 text-xs text-text-primary outline-none focus:border-accent"
              />
            </div>
          </div>
        </section>

        {loading ? (
          <div className="card space-y-3 p-5">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-full" />
          </div>
        ) : error ? (
          <div className="card p-8 text-center text-sm text-danger">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="card p-12 text-center">
            <Calculator size={36} className="mx-auto text-accent" />
            <p className="mt-3 text-sm font-semibold text-text-primary">
              {items.length === 0 ? 'No cost estimates yet' : 'No estimates match that filter'}
            </p>
            <p className="mt-1 text-xs text-text-muted">
              Estimates built by team members appear here as soon as they are created.
            </p>
          </div>
        ) : (
          <div className="card overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                  <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-text-muted">
                    <th className="px-4 py-2.5">Estimate</th>
                    <th className="px-4 py-2.5">Owner</th>
                    <th className="px-4 py-2.5">Environments</th>
                    <th className="px-4 py-2.5 text-right">Monthly</th>
                    <th className="px-4 py-2.5 text-center">Created</th>
                    <th className="px-4 py-2.5 text-center">Status</th>
                    <th className="px-4 py-2.5 text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filtered.map((item) => (
                    <tr key={item.calculation_id} className="transition-colors hover:bg-surface-interactive/50">
                      <td className="px-4 py-3">
                        <Link href={item.href} className="text-sm font-semibold text-text-primary hover:text-accent">
                          {item.name}
                        </Link>
                        <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-text-muted">
                          <span>{item.region || 'region per resource'}</span>
                          <span>·</span>
                          <span>{item.line_item_count} {item.line_item_count === 1 ? 'resource' : 'resources'}</span>
                          {item.input_file_name && (
                            <span className="inline-flex items-center gap-1">
                              <FileSpreadsheet size={11} />
                              from a sheet
                            </span>
                          )}
                        </p>
                      </td>
                      <td className="px-4 py-3 text-xs text-text-secondary">
                        <span className="inline-flex items-center gap-1.5">
                          <User size={13} className="text-text-muted" />
                          {item.owner_email || 'Unknown'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-text-secondary">
                        {item.environment_hours.length
                          ? item.environment_hours.map((entry) => `${entry.name} ${entry.hoursPerDay}h`).join(', ')
                          : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-sm tabular-nums text-text-primary">
                        {formatCurrency(item.monthly_total, item.currency)}
                      </td>
                      <td className="px-4 py-3 text-center text-xs text-text-secondary">
                        {item.created_at ? format(new Date(item.created_at), 'dd-MM-yyyy') : '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex justify-center">
                          <StatusBadge status={item.status} />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={item.href}
                          className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
                        >
                          Open <ExternalLink size={12} />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </TierGuard>
  );
}
