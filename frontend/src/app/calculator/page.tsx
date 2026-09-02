'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
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
  type CalculationProject,
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

const UNGROUPED_LABEL = 'Ungrouped estimates';

/** Where a project card leads. The synthetic row has no id, so it goes by flag. */
function projectHref(project: CalculationProject): string {
  return project.project_id
    ? `/calculator/project?id=${encodeURIComponent(project.project_id)}`
    : '/calculator/project?ungrouped=1';
}

export default function CalculatorPage() {
  const [projects, setProjects] = useState<CalculationProject[]>([]);
  const [items, setItems] = useState<CalculationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // The row awaiting confirmation. window.confirm was replaced because it renders the
  // CloudFront hostname above the message, which reads like a browser warning rather
  // than part of the app; ConfirmDialog is what the rest of the hub already uses.
  const [confirmDelete, setConfirmDelete] = useState<CalculationSummary | null>(null);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<CalculationProject | null>(null);

  const load = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      const [projectData, estimateData] = await Promise.all([
        calculatorApi.getCalculationProjects(),
        calculatorApi.getCalculations(),
      ]);
      setProjects(projectData.items);
      setItems(estimateData.items);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Could not load estimates');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A running estimate is finished by a background Lambda, so the list has to be re-read
  // to see it land. Polling stops as soon as nothing is in flight.
  useEffect(() => {
    const running = items.some((item) => item.status === 'PROCESSING');
    if (!running) return;
    const timer = window.setInterval(() => void load(false), 5000);
    return () => window.clearInterval(timer);
  }, [items, load]);

  const stats = useMemo(() => items.reduce((acc, item) => {
    acc.total += 1;
    if (item.status === 'COMPLETED') acc.completed += 1;
    else if (item.status === 'PROCESSING') acc.processing += 1;
    return acc;
  }, { total: 0, completed: 0, processing: 0 }), [items]);

  /**
   * Deletes, then drops the row locally rather than refetching — the list is already
   * correct and a reload would flash a spinner over it. The project counts above are
   * refreshed, since one of them just changed.
   */
  const remove = async (item: CalculationSummary) => {
    setConfirmDelete(null);
    setDeletingId(item.calculation_id);
    setError(null);
    try {
      await calculatorApi.deleteCalculation(item.calculation_id);
      setItems((current) => current.filter((row) => row.calculation_id !== item.calculation_id));
      const refreshed = await calculatorApi.getCalculationProjects();
      setProjects(refreshed.items);
    } catch (err: any) {
      setError(err.message || 'Could not delete that estimate');
    } finally {
      setDeletingId(null);
    }
  };

  const removeProject = async (project: CalculationProject) => {
    setConfirmDeleteProject(null);
    if (!project.project_id) return;
    setError(null);
    try {
      await calculatorApi.deleteCalculationProject(project.project_id);
      await load(false);
    } catch (err: any) {
      setError(err.message || 'Could not delete that project');
    }
  };

  /** Estimates keyed by project title, so the table below reads like the project list. */
  const grouped = useMemo(() => {
    const map = new Map<string, CalculationSummary[]>();
    for (const item of items) {
      const key = item.project_title?.trim() || UNGROUPED_LABEL;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(item);
    }
    return [...map.entries()];
  }, [items]);

  return (
    <div className="space-y-8 pb-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-2">
          <p className="page-kicker">AWS Cost Calculator</p>
          <h1 className="text-2xl font-semibold text-text-primary">Project Workspaces</h1>
          <p className="text-sm leading-6 text-text-secondary">
            {projects.length} project{projects.length === 1 ? '' : 's'} / {stats.total} estimate
            {stats.total === 1 ? '' : 's'} / {stats.completed} priced / {stats.processing} in progress
          </p>
        </div>
        <Link
          href="/calculator/project/new"
          className="btn-primary inline-flex shrink-0 items-center gap-2 px-4 py-2.5 text-sm font-semibold"
        >
          <Plus size={16} />
          New Project
        </Link>
      </div>

      {error && (
        <div className="card border-danger/30 bg-danger/5 p-4 text-sm font-semibold text-danger" role="alert">
          {error}
        </div>
      )}

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">Projects</h2>
          <p className="mt-1 text-xs text-text-muted">
            Open a project to build another estimate for the same engagement.
          </p>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {Array.from({ length: 2 }).map((_, index) => (
              <div
                key={index}
                className="h-36 animate-pulse rounded-xl"
                style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)' }}
              />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div
            className="rounded-xl px-6 py-16 text-center"
            style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)' }}
          >
            <FolderKanban size={34} className="mx-auto text-accent" />
            <p className="mt-4 text-sm font-semibold text-text-primary">No projects yet</p>
            <p className="mt-1 text-xs text-text-muted">
              Create a project first, then build the estimates for it inside.
            </p>
            <Link
              href="/calculator/project/new"
              className="btn-primary mt-5 inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold"
            >
              <Plus size={15} />
              New Project
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {projects.map((project) => {
              const href = projectHref(project);
              return (
                <div
                  key={project.project_id || UNGROUPED_LABEL}
                  className="group rounded-xl p-5 transition-all hover:-translate-y-0.5"
                  style={{ border: '1px solid var(--border)', background: 'var(--surface-elevated)' }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <Link href={href} className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                          <FolderKanban size={19} />
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold text-text-primary">
                            {project.project_title}
                          </h3>
                          <p className="mt-0.5 text-xs text-text-muted">
                            Updated {formatDate(project.updated_at)}
                          </p>
                        </div>
                      </div>
                    </Link>
                    <div className="flex shrink-0 items-center gap-1">
                      {/* The synthetic Ungrouped row is not a record, so there is nothing
                          to delete — only real projects get the control. */}
                      {project.project_id && (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteProject(project)}
                          className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-danger/10 hover:text-danger"
                          aria-label={`Delete ${project.project_title}`}
                          title="Delete project"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                      <Link href={href} aria-label={`Open ${project.project_title}`}>
                        <ArrowRight
                          size={18}
                          className="text-text-muted transition-transform group-hover:translate-x-1 group-hover:text-accent"
                        />
                      </Link>
                    </div>
                  </div>

                  <Link href={href} className="mt-5 grid grid-cols-3 gap-3">
                    <div className="rounded-lg p-3" style={{ background: 'var(--surface)' }}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Estimates</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">
                        {project.estimate_count}
                      </p>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'var(--surface)' }}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Priced</p>
                      <p className="mt-1 text-2xl font-semibold tabular-nums text-text-primary">
                        {project.completed_count}
                      </p>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'var(--surface)' }}>
                      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Monthly</p>
                      {/* A dash, not $0.00, while nothing in the project has priced — zero
                          would read as a costed answer. */}
                      <p className="mt-1 truncate text-lg font-semibold tabular-nums text-text-primary">
                        {project.monthly_total === null || project.monthly_total === undefined
                          ? '—'
                          : formatCurrency(project.monthly_total)}
                      </p>
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text-primary">All Estimates</h2>
          <p className="mt-1 text-xs text-text-muted">
            Grouped by project. Open a project folder to add another estimate under the same one.
          </p>
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
            <h3 className="text-lg font-semibold text-text-primary">No estimates yet</h3>
            <p className="max-w-md text-sm leading-6 text-text-secondary">
              Create a project, then start with a rough description of the architecture. You can
              refine it and re-run as the design firms up.
            </p>
            <Link
              href="/calculator/project/new"
              className="btn-primary mt-2 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold"
            >
              <Plus size={16} />
              New Project
            </Link>
          </div>
        ) : (
          <div className="card overflow-hidden">
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
                  {grouped.flatMap(([group, rows]) => [
                    <tr key={`group-${group}`} className="border-b border-border bg-surface-elevated/80">
                      <td colSpan={5} className="px-6 py-2.5 text-xs font-bold uppercase tracking-wider text-accent">
                        {group} ({rows.length} estimate{rows.length === 1 ? '' : 's'})
                      </td>
                    </tr>,
                    ...rows.map((item) => (
                      <tr
                        key={item.calculation_id}
                        className="border-b border-border transition-colors last:border-0 hover:bg-surface-interactive"
                      >
                        <td className="px-6 py-3 pl-9">
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
                    )),
                  ])}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat title="Projects" value={projects.length} icon={FolderKanban} />
        <Stat title="Estimates" value={stats.total} icon={Calculator} />
        <Stat title="Processing" value={stats.processing} icon={Clock} />
        <Stat title="Priced" value={stats.completed} icon={CheckCircle2} />
      </div>

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
          isOpen={!!confirmDeleteProject}
          title="Delete project?"
          description={`This will permanently delete "${confirmDeleteProject.project_title}" and the ${confirmDeleteProject.estimate_count} estimate${confirmDeleteProject.estimate_count === 1 ? '' : 's'} inside it.`}
          confirmLabel="Delete project"
          onConfirm={() => void removeProject(confirmDeleteProject)}
          onCancel={() => setConfirmDeleteProject(null)}
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
  value: number;
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
