'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { AlertTriangle, ArrowLeft, ExternalLink, FileDown, Info, Loader2, PiggyBank, RefreshCw, Trash2 } from 'lucide-react';
import { StatusBadge } from '@/components/ui/StatusBadge';
import {
  calculatorApi,
  formatCurrency,
  formatMonthly,
  schedulingSaving,
  type CalculationResultResponse,
} from '@/lib/calculatorApi';

const POLL_INTERVAL_MS = 3000;
const MONTHS_PER_YEAR = 12;

const annual = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value * MONTHS_PER_YEAR : null;

function CalculationDetailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const id = searchParams.get('id');

  const [data, setData] = useState<CalculationResultResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!id) return;
    if (!window.confirm('Delete this estimate? The estimate, its uploaded sheet and its PDF are removed. This cannot be undone.')) {
      return;
    }
    setDeleting(true);
    try {
      await calculatorApi.deleteCalculation(id);
      // Back to the list: this page's record no longer exists, and staying would
      // show a 404 on the next poll.
      router.push('/calculator');
    } catch (err: any) {
      setError(err.message || 'Could not delete this estimate.');
      setDeleting(false);
    }
  };

  const downloadPdf = async () => {
    if (!id) return;
    setDownloading(true);
    try {
      const { download_url } = await calculatorApi.getCalculationReportUrl(id);
      // Presigned URL with a download disposition — navigating to it saves the file
      // without leaving the page.
      window.location.href = download_url;
    } catch (err: any) {
      setError(err.message || 'The PDF could not be generated.');
    } finally {
      setDownloading(false);
    }
  };

  /** Returns true once the job reaches a terminal state, which stops the poll. */
  const fetchResult = useCallback(async (): Promise<boolean> => {
    if (!id) return true;
    try {
      const next = await calculatorApi.getCalculationResult(id);
      setData(next);
      setError(null);
      return next.status === 'COMPLETED' || next.status === 'FAILED';
    } catch (err: any) {
      setError(err.message || 'Could not load this estimate');
      // Stop polling on a hard error rather than hammering a failing endpoint.
      return true;
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (!id) {
      setLoading(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;

    async function poll() {
      const done = await fetchResult();
      if (!done && !cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }
    poll();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [id, fetchResult]);

  if (!id) {
    return (
      <div className="card border-danger/30 bg-danger/5 p-6 text-sm font-semibold text-danger">
        No estimate id was provided.
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="flex items-center gap-3 text-sm text-text-secondary">
        <Loader2 size={18} className="animate-spin text-accent" />
        Loading estimate...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="card border-danger/30 bg-danger/5 p-6 text-sm font-semibold text-danger">
        {error}
      </div>
    );
  }

  const result = data?.result ?? null;
  const isProcessing = data?.status === 'PROCESSING';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href="/calculator"
          className="flex items-center gap-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
        >
          <ArrowLeft size={16} />
          Back to estimates
        </Link>
        <div className="flex items-center gap-2">
          {data && <StatusBadge status={data.status} />}
          <button
            type="button"
            onClick={() => void remove()}
            disabled={deleting}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-semibold text-text-muted transition-colors hover:border-danger/40 hover:bg-danger/5 hover:text-danger disabled:opacity-50"
          >
            {deleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
            Delete
          </button>
        </div>
      </div>

      {isProcessing && (
        <div className="card flex items-start gap-3 border-accent/30 bg-accent/5 p-5">
          <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-accent" />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-text-primary">Building your estimate</p>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              {data?.progress_message ||
                'Looking up AWS services and pricing fields. This usually takes a minute or two.'}
            </p>
          </div>
        </div>
      )}

      {data?.status === 'FAILED' && (
        <div className="card border-danger/30 bg-danger/5 p-5">
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0">
              <p className="text-sm font-semibold text-danger">This estimate could not be built</p>
              <p className="mt-1 break-words text-sm leading-6 text-text-secondary">
                {data.error_message || 'The estimator did not return a usable result.'}
              </p>
              <Link
                href="/calculator/new"
                className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-accent hover:underline"
              >
                <RefreshCw size={14} />
                Try again with more detail
              </Link>
            </div>
          </div>
        </div>
      )}

      {result && (
        <>
          <div className="card p-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                  Estimated monthly cost
                </p>
                <p className="mt-2 text-4xl font-semibold tracking-tight text-text-primary">
                  {formatMonthly(result.monthlyTotal, result.currency)}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {formatCurrency(annual(result.monthlyTotal), result.currency)} per year (monthly &times; 12)
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void downloadPdf()}
                  disabled={downloading}
                  className="btn-secondary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
                >
                  {downloading ? <Loader2 size={15} className="animate-spin" /> : <FileDown size={15} />}
                  {downloading ? 'Preparing...' : 'Download PDF'}
                </button>
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold"
                >
                  Open in AWS Calculator
                  <ExternalLink size={15} />
                </a>
              </div>
            </div>
            <p className="mt-4 border-t border-border pt-4 text-xs leading-5 text-text-muted">
              AWS recalculates the live price when the link is opened. Press{' '}
              <strong className="font-semibold text-text-secondary">Update estimate</strong> there to
              refresh against current pricing.
            </p>
          </div>

          {/* Where the money goes, by environment. Sourced from the calculator's own
              grouping so this and the shareable link cannot disagree. */}
          {result.environments.length > 0 && (
            <div className="card overflow-hidden">
              <div className="border-b border-border px-6 py-4">
                <h2 className="text-lg font-semibold text-text-primary">Cost by environment</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Environment</th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Hours/day</th>
                      <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Monthly</th>
                      <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Annual</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.environments.map((entry) => (
                      <tr key={entry.name} className="border-b border-border last:border-0">
                        <td className="px-6 py-3 font-semibold text-text-primary">{entry.name}</td>
                        <td className="px-6 py-3 text-text-secondary">{entry.hoursPerDay}h</td>
                        <td className="px-6 py-3 text-right tabular-nums text-text-primary">
                          {formatCurrency(entry.monthly, result.currency)}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-text-secondary">
                          {formatCurrency(annual(entry.monthly), result.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Only shown when something is actually scheduled below 24h. */}
          {(() => {
            const saved = schedulingSaving(result);
            if (saved === null || saved <= 0) return null;
            return (
              <div className="card border-success/30 bg-success/5 p-6">
                <div className="flex items-start gap-3">
                  <PiggyBank size={18} className="mt-0.5 shrink-0 text-success" />
                  <div className="min-w-0">
                    <h2 className="text-lg font-semibold text-text-primary">Saving from scheduled shutdown</h2>
                    <p className="mt-1 text-sm leading-6 text-text-secondary">
                      Running non-production on a schedule instead of 24/7 avoids about{' '}
                      <strong className="font-semibold text-success">{formatCurrency(saved, result.currency)}</strong> per
                      month, or {formatCurrency(annual(saved), result.currency)} per year.
                    </p>
                    <p className="mt-2 text-xs leading-5 text-text-muted">
                      Derived from the priced monthly cost and the configured hours, for time-billed
                      resources only — not a separate AWS quote. Usage-based services such as S3
                      storage cost the same whether the environment is running or not.
                    </p>
                  </div>
                </div>
              </div>
            );
          })()}

          {result.lineItems.length > 0 && (
            <div className="card overflow-hidden">
              <div className="border-b border-border px-6 py-4">
                <h2 className="text-lg font-semibold text-text-primary">Breakdown</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left">
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Service
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Configuration
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Env
                      </th>
                      <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Hours
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Monthly
                      </th>
                      <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">
                        Annual
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.lineItems.map((item, index) => (
                      <tr key={`${item.service}-${index}`} className="border-b border-border last:border-0">
                        <td className="px-6 py-3 font-semibold text-text-primary">{item.service}</td>
                        <td className="px-6 py-3 text-text-secondary">{item.detail || '—'}</td>
                        <td className="px-6 py-3 text-text-secondary">{item.environment || '—'}</td>
                        <td className="px-6 py-3 text-text-muted">
                          {item.timeBilled && item.hoursPerDay ? `${item.hoursPerDay}h` : 'usage'}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-text-primary">
                          {formatCurrency(item.monthly, result.currency)}
                        </td>
                        <td className="px-6 py-3 text-right tabular-nums text-text-secondary">
                          {formatCurrency(annual(item.monthly), result.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.assumptions.length > 0 && (
            <div className="card p-6">
              <div className="flex items-center gap-2">
                <Info size={16} className="text-accent" />
                <h2 className="text-lg font-semibold text-text-primary">Assumptions</h2>
              </div>
              <p className="mt-1 text-sm leading-6 text-text-secondary">
                Defaults chosen on your behalf. Check these before sharing the estimate.
              </p>
              <ul className="mt-4 space-y-2">
                {result.assumptions.map((assumption, index) => (
                  <li key={index} className="flex gap-2 text-sm leading-6 text-text-secondary">
                    <span className="text-accent">•</span>
                    <span>{assumption}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="card border-warning/30 bg-warning/5 p-6">
              <div className="flex items-center gap-2">
                <AlertTriangle size={16} className="text-warning" />
                <h2 className="text-lg font-semibold text-text-primary">Warnings</h2>
              </div>
              <ul className="mt-4 space-y-2">
                {result.warnings.map((warning, index) => (
                  <li key={index} className="flex gap-2 text-sm leading-6 text-text-secondary">
                    <span className="text-warning">•</span>
                    <span>{warning}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function CalculationDetailPage() {
  // useSearchParams requires a Suspense boundary above it.
  return (
    <Suspense
      fallback={
        <div className="flex items-center gap-3 text-sm text-text-secondary">
          <Loader2 size={18} className="animate-spin text-accent" />
          Loading estimate...
        </div>
      }
    >
      <CalculationDetailContent />
    </Suspense>
  );
}
