'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  ArrowLeft,
  Calculator,
  CheckCircle2,
  Clock,
  FolderKanban,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  calculatorApi,
  formatCurrency,
  formatMonthly,
  type CalculationSummary,
} from '@/lib/calculatorApi';

/** dd-MM-yyyy, matching the date format used across the hub. */
function formatDate(epochMs: number): string {
  if (!epochMs) return '—';
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return '—';
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${day}-${month}-${date.getFullYear()}`;
}

/**
 * One project's estimates.
 *
 * Two ways in, both used by the project list: `?id=<uuid>` for a real project, and
 * `?ungrouped=1` for the synthetic folder holding every estimate created before projects
 * existed. The second has no project record to read, so the title is fixed here and the
 * delete-project control is hidden — there is nothing to delete.
 */
function CalculatorProjectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get('id');
  const ungrouped = searchParams.get('ungrouped') === '1';

  const [projectTitle, setProjectTitle] = useState(ungrouped ? 'Ungrouped estimates' : 'Project');
  const [items, setItems] = useState<CalculationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<CalculationSummary | null>(null);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
  const [deletingProject, setDeletingProject] = useState(false);

  const load = useCallback(async (showLoading = true) => {
    if (!projectId && !ungrouped) {
      setError('No project was specified.');
      setLoading(false);
      return;
    }
    try {
      if (showLoading) setLoading(true);
      const [project, estimates] = await Promise.all([
        projectId ? calculatorApi.getCalculationProject(projectId) : Promise.resolve(null),
        calculatorApi.getCalculations(projectId ?? null),
      ]);
      if (project) setProjectTitle(project.project_title);
      setItems(estimates.items);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Could not load this project');
    } finally {
      setLoading(false);
    }
  }, [projectId, ungrouped]);

  useEffect(() => {
    void load();
  }, [load]);

  // A running estimate writes its result from a background Lambda, so the list has to be
  // re-read to see it finish. Polling stops as soon as nothing is in flight.
  useEffect(() => {
    const running = items.some((item) => item.status === 'PROCESSING');
    if (!running) return;
    const timer = window.setInterval(() => void load(false), 5000);
    return () => window.clearInterval(timer);
  }, [items, load]);

  const stats = useMemo(() => items.reduce((acc, item) => {
    acc.total += 1;
    if (item.status === 'COMPLETED') {
      acc.completed += 1;
      acc.monthly += Number(item.monthly_total || 0);
    } else if (item.status === 'PROCESSING') {
      acc.processing += 1;
    }
    return acc;
  }, { total: 0, completed: 0, processing: 0, monthly: 0 }), [items]);

  const remove = async (item: CalculationSummary) => {
    setConfirmDelete(null);
    setDeletingId(item.calculation_id);
    try {
      await calculatorApi.deleteCalculation(item.calculation_id);
      setItems((current) => current.filter((row) => row.calculation_id !== item.calculation_id));
    } catch (err: any) {
      setError(err.message || 'Could not delete that estimate');
    } finally {
      setDeletingId(null);
    }
  };

  /**
   * Deletes the project and everything filed under it.
   *
   * Navigates away rather than refetching, because the page's own record no longer
   * exists — reloading it would only produce a 404. `replace` rather than `push` so the
   * back button cannot return to a project that has been deleted.
   */
  const removeProject = async () => {
    setConfirmDeleteProject(false);
    if (!projectId) return;
    setDeletingProject(true);
    setError(null);
    try {
      await calculatorApi.deleteCalculationProject(projectId);
      router.replace('/calculator');
    } catch (err: any) {
      setError(err.message || 'Could not delete this project');
      setDeletingProject(false);
    }
  };

  const newEstimateHref = projectId
    ? `/calculator/new?project=${encodeURIComponent(projectId)}`
    : '/calculator/new';

  return (
    <div className="space-y-6">
      <Link
        href="/calculator"
        className="flex items-center gap-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={16} />
        Back to projects
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="page-kicker">AWS Cost Calculator</p>
          <h1 className="flex items-center gap-2.5 text-2xl font-semibold text-text-primary">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <FolderKanban size={19} />
            </span>
            {projectTitle}
          </h1>
          <p className="text-sm leading-6 text-text-secondary">
            {ungrouped
              ? 'Estimates that were built before projects existed, or created outside one.'
              : 'Every estimate built for this project, including revisions.'}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={newEstimateHref}
            className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold"
          >
            <Plus size={16} />
            New Estimate
          </Link>
          {/* Hidden on the ungrouped view: that folder is a view over estimates that
              belong to no project, not a record, so there is nothing to delete. */}
          {projectId && !ungrouped && (
            <button
              type="button"
              onClick={() => setConfirmDeleteProject(true)}
              disabled={deletingProject}
              className="inline-flex items-center gap-2 rounded-lg border border-danger/30 px-4 py-2.5 text-sm font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
              title="Delete this project and every estimate in it"
            >
              {deletingProject ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
              Delete Project
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="card border-danger/30 bg-danger/5 p-4 text-sm font-semibold text-danger" role="alert">
          {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat title="Estimates" value={String(stats.total)} icon={Calculator} />
        <Stat title="Processing" value={String(stats.processing)} icon={Clock} />
        <Stat title="Completed" value={String(stats.completed)} icon={CheckCircle2} />
        {/* Priced estimates only. Adding an unpriced one in as zero would understate the
            project total and read as a finished number. */}
        <Stat
          title="Priced monthly"
          value={stats.completed ? formatCurrency(stats.monthly) : '—'}
          icon={Calculator}
        />
      </div>

      {loading ? (
        <div className="flex items-center gap-3 text-sm text-text-secondary">
          <Loader2 size={18} className="animate-spin text-accent" />
          Loading estimates...
        </div>
      ) : items.length === 0 ? (
        <div className="card flex flex-col items-center justify-center gap-3 p-12 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface-elevated text-text-muted">
            <Calculator size={22} />
          </span>
          <h2 className="text-lg font-semibold text-text-primary">No estimates in this project yet</h2>
          <p className="max-w-md text-sm leading-6 text-text-secondary">
            Start with a rough description of the architecture, or upload the resource list. You
            can refine it and re-run as the design firms up.
          </p>
          <Link
            href={newEstimateHref}
            className="btn-primary mt-2 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold"
          >
            <Plus size={16} />
            New Estimate
          </Link>
        </div>
      ) : (
        <div className="card overflow-hidden">
          <div className="px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
            <h3 className="text-sm font-semibold text-text-primary">Project Estimates</h3>
            <p className="mt-1 text-xs text-text-muted">
              All estimates built under {projectTitle}. A revision is listed as its own row so a
              PDF already sent to a client never changes under it.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Name</th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Status</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Monthly</th>
                  <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Created</th>
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
                      {!!item.revision_number && (
                        <span className="ml-2 rounded-full bg-accent/10 px-2 py-0.5 text-xs font-semibold text-accent">
                          Rev {item.revision_number}
                        </span>
                      )}
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
                        onClick={() => setConfirmDelete(item)}
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

      {confirmDelete && (
        <ConfirmDialog
          isOpen={!!confirmDelete}
          title="Delete estimate?"
          description={`This will permanently delete "${confirmDelete.name}" and local files. Remote AWS Pricing Calculator estimates will also be removed only when the installed MCP supports deletion.`}
          confirmLabel="Delete"
          onConfirm={() => void remove(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {confirmDeleteProject && (
        <ConfirmDialog
          isOpen={confirmDeleteProject}
          title="Delete project?"
          description={`This will permanently delete "${projectTitle}" and the ${items.length} estimate${items.length === 1 ? '' : 's'} filed under it, with their uploaded sheets and documents.`}
          confirmLabel="Delete project"
          onConfirm={() => void removeProject()}
          onCancel={() => setConfirmDeleteProject(false)}
        />
      )}
    </div>
  );
}

function Stat({
  title,
  value,
  icon: Icon,
}: {
  title: string;
  value: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}) {
  return (
    <div className="metric-card p-5 text-left">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</p>
        <Icon size={18} className="text-accent" />
      </div>
      <p className="mt-4 text-2xl font-semibold tabular-nums text-text-primary">{value}</p>
    </div>
  );
}

export default function CalculatorProjectPage() {
  // useSearchParams requires a Suspense boundary above it.
  return (
    <Suspense
      fallback={(
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="animate-spin text-accent" />
        </div>
      )}
    >
      <CalculatorProjectContent />
    </Suspense>
  );
}
