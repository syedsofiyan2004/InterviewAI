'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowRight, CheckCircle2, Clock, FileText, FolderKanban, Plus, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { api, Mom, MomProject } from '@/lib/api';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast } from '@/components/ui/Toast';

export default function MomDashboard() {
  const [projects, setProjects] = useState<MomProject[]>([]);
  const [moms, setMoms] = useState<Mom[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  const [confirmDeleteProject, setConfirmDeleteProject] = useState<{ id: string; title: string; count: number } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const loadData = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      const [projectData, momData] = await Promise.all([
        api.getMomProjects(),
        api.getMoms(),
      ]);
      setProjects([...projectData.items].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0)));
      setMoms([...momData.items].sort((a, b) => getMomSortDate(b) - getMomSortDate(a)));
    } catch (err) {
      console.error('Failed to load MOM workspace', err);
      setToast({ message: 'Failed to load MOM projects', type: 'error' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    const hasActiveJobs = moms.some((mom) => mom.status === 'CREATED' || mom.status === 'PROCESSING');
    if (!hasActiveJobs) return;

    const timer = window.setInterval(() => {
      loadData(false);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [loadData, moms]);

  const stats = useMemo(() => moms.reduce((acc, mom) => {
    acc.total++;
    if (mom.status === 'COMPLETED') acc.completed++;
    else if (mom.status === 'FAILED') acc.failed++;
    else acc.processing++;
    return acc;
  }, { total: 0, completed: 0, processing: 0, failed: 0 }), [moms]);

  const filtered = moms.filter((mom) => filter === 'ALL' || mom.status === filter);

  const handleDelete = async (id: string) => {
    try {
      await api.deleteMom(id);
      setToast({ message: 'MOM deleted successfully', type: 'success' });
      await loadData();
    } catch {
      setToast({ message: 'Failed to delete MOM', type: 'error' });
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleDeleteProject = async (id: string) => {
    try {
      const result = await api.deleteMomProject(id);
      setToast({ message: `Project deleted with ${result.deleted_moms} MOM report${result.deleted_moms === 1 ? '' : 's'}`, type: 'success' });
      await loadData();
    } catch {
      setToast({ message: 'Failed to delete project', type: 'error' });
    } finally {
      setConfirmDeleteProject(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-8">
      <div className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase mb-1">
            Minfy AI / MOM Analyzer
          </p>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Project Workspaces</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {projects.length} projects / {stats.total} meeting reports / {stats.completed} completed / {stats.processing} in progress
          </p>
        </div>
        <Link
          href="/mom/new"
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 shrink-0"
          style={{ background: '#4F46E5' }}
        >
          <Plus size={15} />
          New Project
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat title="Projects" value={projects.length} icon={FolderKanban} active={false} />
        <Stat title="Total MOMs" value={stats.total} icon={FileText} onClick={() => setFilter('ALL')} active={filter === 'ALL'} />
        <Stat title="Processing" value={stats.processing} icon={Clock} onClick={() => setFilter('PROCESSING')} active={filter === 'PROCESSING'} />
        <Stat title="Completed" value={stats.completed} icon={CheckCircle2} onClick={() => setFilter('COMPLETED')} active={filter === 'COMPLETED'} />
      </div>

      <section className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-text-primary">Projects</h2>
            <p className="text-xs text-text-muted mt-1">Open a project folder to add another transcript under the same project.</p>
          </div>
        </div>

        {loading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="h-36 rounded-xl animate-pulse" style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)' }} />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <div className="rounded-xl px-6 py-16 text-center" style={{ background: 'var(--surface-elevated)', border: '1px solid var(--border)' }}>
            <FolderKanban size={34} className="mx-auto text-accent" />
            <p className="text-sm font-semibold text-text-primary mt-4">No projects yet</p>
            <p className="text-xs text-text-muted mt-1">Create a project folder first, then add meeting transcripts inside it.</p>
            <Link href="/mom/new" className="inline-flex items-center gap-2 mt-5 px-4 py-2 rounded-lg bg-accent text-accent-foreground text-sm font-semibold">
              <Plus size={15} />
              New Project
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {projects.map((project) => {
              const href = project.project_id
                ? `/mom/project?id=${project.project_id}`
                : `/mom/project?title=${encodeURIComponent(project.project_title)}`;
              return (
                <div
                  key={project.project_id || project.project_title}
                  className="group rounded-xl p-5 transition-all hover:-translate-y-0.5"
                  style={{ border: '1px solid var(--border)', background: 'var(--surface-elevated)' }}
                >
                  <div className="flex items-start justify-between gap-4">
                    <Link href={href} className="min-w-0 flex-1">
                      <div className="flex items-center gap-3">
                        <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent shrink-0">
                          <FolderKanban size={19} />
                        </span>
                        <div className="min-w-0">
                          <h3 className="truncate text-base font-semibold text-text-primary">{project.project_title}</h3>
                          <p className="text-xs text-text-muted mt-0.5">
                            Updated {project.updated_at ? format(new Date(project.updated_at), 'MMM d, yyyy') : 'recently'}
                          </p>
                        </div>
                      </div>
                    </Link>
                    <div className="flex items-center gap-1 shrink-0">
                      {project.project_id && (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteProject({
                            id: project.project_id!,
                            title: project.project_title,
                            count: project.mom_count,
                          })}
                          className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-red-50 hover:text-red-500"
                          title="Delete project"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                      <Link href={href} aria-label={`Open ${project.project_title}`}>
                        <ArrowRight size={18} className="text-text-muted transition-transform group-hover:translate-x-1 group-hover:text-accent" />
                      </Link>
                    </div>
                  </div>

                  <Link href={href} className="mt-5 grid grid-cols-2 gap-3">
                    <div className="rounded-lg p-3" style={{ background: 'var(--surface)' }}>
                      <p className="text-[11px] font-medium text-text-muted">Reports</p>
                      <p className="text-xl font-bold text-text-primary mt-1">{project.mom_count}</p>
                    </div>
                    <div className="rounded-lg p-3" style={{ background: 'var(--surface)' }}>
                      <p className="text-[11px] font-medium text-text-muted">Completed</p>
                      <p className="text-xl font-bold text-text-primary mt-1">{project.completed_count}</p>
                    </div>
                  </Link>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>
        <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <h3 className="text-sm font-semibold text-text-primary">Recent Meeting Reports</h3>
            <p className="text-xs text-text-muted mt-1">Open the project folder when you need to add more transcripts.</p>
          </div>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            className="text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/30 transition-all"
            style={{ border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--color-text-secondary)' }}
          >
            <option value="ALL">All statuses</option>
            <option value="PROCESSING">Processing</option>
            <option value="COMPLETED">Completed</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <th className="px-6 py-3 text-xs font-medium text-text-muted">Title</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted">Project</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted">Source</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-center">Meeting Date</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-center">Status</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td colSpan={6} className="px-6 py-5">
                      <div className="h-4 rounded animate-pulse" style={{ background: 'var(--surface)' }} />
                    </td>
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-20 text-center">
                    <p className="text-sm font-semibold text-text-primary">No reports found</p>
                    <p className="text-xs text-text-muted mt-1">Open a project and add a transcript to generate the first report.</p>
                  </td>
                </tr>
              ) : (
                filtered.map((mom) => (
                  <tr key={mom.mom_id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td className="px-6 py-4">
                      <Link href={`/mom/view?id=${mom.mom_id}`} className="text-sm font-semibold text-text-primary hover:text-accent">
                        {mom.title || 'Untitled meeting'}
                      </Link>
                    </td>
                    <td className="px-6 py-4 text-sm text-text-secondary">{mom.project_title || 'General'}</td>
                    <td className="px-6 py-4 text-sm text-text-secondary capitalize">{mom.source_type || 'file'}</td>
                    <td className="px-6 py-4 text-sm text-text-secondary text-center">
                      {formatMomMeetingDate(mom)}
                    </td>
                    <td className="px-6 py-4 text-center">
                      <div className="flex justify-center">
                        <StatusBadge status={mom.status || 'CREATED'} />
                      </div>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex justify-end">
                        <button
                          onClick={() => setConfirmDelete({ id: mom.mom_id, title: mom.title || 'Untitled meeting' })}
                          className="p-1.5 rounded-md text-text-muted hover:text-red-500 transition-colors"
                          title="Delete MOM"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          isOpen={!!confirmDelete}
          title="Delete MOM?"
          description={`This will permanently delete "${confirmDelete.title}" and its uploaded transcript.`}
          confirmLabel="Delete"
          onConfirm={() => handleDelete(confirmDelete.id)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {confirmDeleteProject && (
        <ConfirmDialog
          isOpen={!!confirmDeleteProject}
          title="Delete project?"
          description={`This will permanently delete "${confirmDeleteProject.title}" and ${confirmDeleteProject.count} MOM report${confirmDeleteProject.count === 1 ? '' : 's'} inside it.`}
          confirmLabel="Delete project"
          onConfirm={() => handleDeleteProject(confirmDeleteProject.id)}
          onCancel={() => setConfirmDeleteProject(null)}
        />
      )}
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function Stat({
  title,
  value,
  icon: Icon,
  active,
  onClick,
}: {
  title: string;
  value: number;
  icon: any;
  active: boolean;
  onClick?: () => void;
}) {
  const content = (
    <>
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-text-muted">{title}</p>
        <Icon size={18} className="text-accent" />
      </div>
      <p className="text-2xl font-bold text-text-primary mt-4">{value}</p>
    </>
  );

  if (onClick) {
    return (
      <button
      onClick={onClick}
      className="text-left p-5 rounded-xl transition-all"
      style={{
        border: active ? '1px solid #4F46E5' : '1px solid var(--border)',
        background: active ? '#4F46E512' : 'var(--surface-elevated)',
      }}
      >
        {content}
      </button>
    );
  }

  return (
    <div
      className="text-left p-5 rounded-xl transition-all"
      style={{ border: '1px solid var(--border)', background: 'var(--surface-elevated)' }}
    >
      {content}
    </div>
  );
}

function getMomSortDate(mom: Mom): number {
  return mom.meeting_date_sort || mom.source_last_modified || mom.created_at || 0;
}

function formatMomMeetingDate(mom: Mom): string {
  if (mom.meeting_date_sort) return format(new Date(mom.meeting_date_sort), 'MMM d, yyyy');
  if (mom.meeting_date && mom.meeting_date !== 'Not specified') return mom.meeting_date;
  return mom.status === 'COMPLETED' ? 'Not specified' : 'Pending analysis';
}
