'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Calculator, Loader2, Plus, Trash2 } from 'lucide-react';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { calculatorApi, formatMonthly, type CalculationSummary } from '@/lib/calculatorApi';

/** dd-MM-yyyy, matching the date format used across the hub. */
function formatDate(epochMs: number): string {
  if (!epochMs) return '—';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '—';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getFullYear()}`;
}

export default function CalculatorPage() {
  const [items, setItems] = useState<CalculationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  /**
   * Deletes after a confirm, then drops the row locally rather than refetching —
   * the list is already correct and a reload would flash a spinner over it.
   */
  const remove = async (item: CalculationSummary) => {
    if (!window.confirm(`Delete "${item.name}"? The estimate, its uploaded sheet and its PDF are removed. This cannot be undone.`)) {
      return;
    }
    setDeletingId(item.calculation_id);
    setError(null);
    try {
      await calculatorApi.deleteCalculation(item.calculation_id);
      setItems((current) => current.filter((row) => row.calculation_id !== item.calculation_id));
    } catch (err: any) {
      setError(err.message || 'Could not delete that estimate');
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    let mounted = true;

    async function load() {
      try {
        const response = await calculatorApi.getCalculations();
        if (mounted) setItems(response.items);
      } catch (err: any) {
        if (mounted) setError(err.message || 'Could not load estimates');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    load();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="page-kicker">AWS Cost Calculator</p>
          <h1 className="text-2xl font-semibold text-text-primary">Estimates</h1>
          <p className="text-sm leading-6 text-text-secondary">
            Describe a workload in plain English and get a shareable AWS Pricing Calculator estimate.
          </p>
        </div>
        <Link
          href="/calculator/new"
          className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold"
        >
          <Plus size={16} />
          New Estimate
        </Link>
      </div>

      {error && (
        <div
          className="card border-danger/30 bg-danger/5 p-4 text-sm font-semibold text-danger"
          role="alert"
        >
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-3 text-sm text-text-secondary">
          <Loader2 size={18} className="animate-spin text-accent" />
          Loading estimates...
        </div>
      ) : items.length === 0 && !error ? (
        <div className="card flex flex-col items-center justify-center gap-3 p-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface-elevated text-text-muted">
            <Calculator size={22} />
          </span>
          <h2 className="text-lg font-semibold text-text-primary">No estimates yet</h2>
          <p className="max-w-md text-sm leading-6 text-text-secondary">
            Start with a rough description of the architecture. You can refine it and re-run as the
            design firms up.
          </p>
          <Link
            href="/calculator/new"
            className="btn-primary mt-2 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold"
          >
            <Plus size={16} />
            New Estimate
          </Link>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Name
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Status
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Monthly
                  </th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Created
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.calculation_id}
                    className="border-b border-border transition-colors last:border-0 hover:bg-surface-interactive"
                  >
                    <td className="px-6 py-3">
                      <Link
                        href={`/calculator/view?id=${item.calculation_id}`}
                        className="font-semibold text-text-primary hover:text-accent"
                      >
                        {item.name}
                      </Link>
                    </td>
                    <td className="px-6 py-3">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-6 py-3 text-right tabular-nums text-text-primary">
                      {formatMonthly(item.monthly_total)}
                    </td>
                    <td className="px-6 py-3 text-text-secondary">{formatDate(item.created_at)}</td>
                    <td className="px-6 py-3 text-right">
                      <button
                        type="button"
                        onClick={() => void remove(item)}
                        disabled={deletingId === item.calculation_id}
                        aria-label={`Delete ${item.name}`}
                        title="Delete estimate"
                        className="inline-flex items-center rounded-lg p-2 text-text-muted transition-colors hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                      >
                        {deletingId === item.calculation_id
                          ? <Loader2 size={15} className="animate-spin" />
                          : <Trash2 size={15} />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
