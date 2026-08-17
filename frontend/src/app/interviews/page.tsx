'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComponentType, CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api, Interview } from '@/lib/api';
import { 
  BrainCircuit,
  Users, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  ChevronRight,
  PlusCircle,
  Trash2,
  FileSearch
} from 'lucide-react';
import { format } from 'date-fns';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast } from '@/components/ui/Toast';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useTour, checkTourStatus } from '@/contexts/TourContext';

const STATUS_FILTERS = ['ALL', 'COMPLETED', 'PROCESSING', 'FAILED'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

function isProcessingStatus(status: string) {
  return status === 'CREATED' || status === 'PROCESSING';
}

export default function Dashboard() {
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [stats, setStats] = useState({ total: 0, completed: 0, pending: 0, failed: 0 });
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedFilter = searchParams.get('status')?.toUpperCase();
  const filter: StatusFilter = STATUS_FILTERS.includes(requestedFilter as StatusFilter)
    ? requestedFilter as StatusFilter
    : 'ALL';

  const setActiveFilter = useCallback((nextFilter: StatusFilter) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextFilter === 'ALL') params.delete('status');
    else params.set('status', nextFilter.toLowerCase());
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  const filteredInterviews = useMemo(() => interviews.filter((interview) => {
    if (filter === 'ALL') return true;
    if (filter === 'PROCESSING') return isProcessingStatus(interview.status);
    return interview.status === filter;
  }), [filter, interviews]);

  const { startTour } = useTour();

  useEffect(() => {
    checkTourStatus('interviews-list').then(done => {
      if (!done) {
        setTimeout(() => {
          startTour([
            {
              targetId: 'tour-stats',
              title: 'Your evaluation overview',
              body: 'These cards show live counts of all your evaluations. Click any card to filter the table below by that status.',
              position: 'bottom',
            },
            {
              targetId: 'tour-new-btn',
              title: 'Start a new evaluation',
              body: 'Click here to begin. You will enter candidate details, then upload documents for AI analysis.',
              position: 'bottom',
            },
            {
              targetId: 'tour-table',
              title: 'Track every candidate',
              body: 'All evaluations appear here sorted by date. Click any row arrow to open the full AI report.',
              position: 'top',
            },
          ], 'interviews-list');
        }, 350);
      }
    });
  }, [startTour]);

  const loadData = useCallback(async () => {
    try {
      setLoadError(false);
      const data = await api.getInterviews();
        const normalized = (data.items || [])
          .filter((item) => item && item.interview_id)
          .map((item) => ({
            ...item,
            candidate_name: item.candidate_name || 'Unknown candidate',
            position: item.position || 'Unknown position',
            status: item.status || 'CREATED',
            created_at: Number.isFinite(item.created_at) ? item.created_at : Date.now(),
            updated_at: Number.isFinite(item.updated_at) ? item.updated_at : Date.now(),
          }));
        const sorted = normalized.sort((a, b) => b.created_at - a.created_at);
        setInterviews(sorted);
        
        const summary = sorted.reduce((acc, curr) => {
          acc.total++;
          if (curr.status === 'COMPLETED') acc.completed++;
          else if (curr.status === 'FAILED') acc.failed++;
          else acc.pending++;
          return acc;
        }, { total: 0, completed: 0, pending: 0, failed: 0 });
        
      setStats(summary);
    } catch (err) {
      console.error('Failed to load interviews', err);
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadData();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  const handleDelete = async (id: string) => {
    try {
      await api.deleteInterview(id);
      setInterviews(prev => prev.filter(i => i.interview_id !== id));
      // Refresh stats
      const data = await api.getInterviews();
      const sorted = (data.items || [])
        .filter((item) => item && item.interview_id)
        .map((item) => ({
          ...item,
          candidate_name: item.candidate_name || 'Unknown candidate',
          position: item.position || 'Unknown position',
          status: item.status || 'CREATED',
          created_at: Number.isFinite(item.created_at) ? item.created_at : Date.now(),
          updated_at: Number.isFinite(item.updated_at) ? item.updated_at : Date.now(),
        }))
        .sort((a, b) => b.created_at - a.created_at);
      const summary = sorted.reduce((acc, curr) => {
        acc.total++;
        if (curr.status === 'COMPLETED') acc.completed++;
        else if (curr.status === 'FAILED') acc.failed++;
        else acc.pending++;
        return acc;
      }, { total: 0, completed: 0, pending: 0, failed: 0 });
      setStats(summary);
      setInterviews(sorted);
      setToast({ message: 'Interview deleted successfully', type: 'success' });
    } catch (err) {
      setToast({ message: 'Failed to delete interview', type: 'error' });
      console.error(err);
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-8">

      {/* ── Page header ── */}
      <div className="flex flex-col gap-4 pt-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase mb-1">
            Minfy AI · Evaluation Platform
          </p>
          <h1 className="text-xl font-semibold text-text-primary tracking-tight">
            Evaluations
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            {interviews.length} total &middot; {stats.completed} completed &middot; {stats.pending} in progress
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/interviews/intelligence"
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-elevated px-4 py-2.5 text-sm font-semibold text-text-primary transition-colors hover:border-accent/40 hover:text-accent"
          >
            <BrainCircuit size={16} />
            Intelligence mode
          </Link>
          <Link
            href="/interviews/new"
            id="tour-new-btn"
            className="btn-primary flex items-center gap-2 px-4 py-2.5 text-sm font-semibold shrink-0"
          >
            <PlusCircle size={16} />
            New evaluation
          </Link>
        </div>
      </div>

      {/* ── Stat cards ── */}
      <div id="tour-stats" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total interviews" value={stats.total}
          icon={Users} type="teal"
          onClick={() => setActiveFilter('ALL')} active={filter === 'ALL'} />
        <StatCard title="Evaluating" value={stats.pending}
          icon={Clock} type="amber"
          onClick={() => setActiveFilter('PROCESSING')} active={filter === 'PROCESSING'} />
        <StatCard title="Completed" value={stats.completed}
          icon={CheckCircle2} type="green"
          onClick={() => setActiveFilter('COMPLETED')} active={filter === 'COMPLETED'} />
        <StatCard title="Needs attention" value={stats.failed}
          icon={AlertCircle} type="red"
          onClick={() => setActiveFilter('FAILED')} active={filter === 'FAILED'} />
      </div>

      {/* ── Evaluations table ── */}
      <div id="tour-table" className="data-table mt-8">

        {/* Table header bar */}
        <div className="px-6 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
             style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-text-primary">Recent evaluations</h3>
            {filter !== 'ALL' && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{ background: 'color-mix(in srgb, var(--accent) 10%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in srgb, var(--accent) 28%, transparent)' }}>
                {filter.charAt(0) + filter.slice(1).toLowerCase()}
                <button onClick={() => setActiveFilter('ALL')}
                        className="ml-0.5 opacity-60 hover:opacity-100 leading-none">×</button>
              </span>
            )}
          </div>
          <div className="status-tabs">
            {['ALL', 'COMPLETED', 'PROCESSING', 'FAILED'].map((status) => (
              <button
                key={status}
                type="button"
                className="status-tab"
                data-active={filter === status}
                onClick={() => setActiveFilter(status as StatusFilter)}
              >
                {status}
              </button>
            ))}
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Candidate</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Position</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted text-center">Date</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted text-center">Status</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td colSpan={5} className="px-6 py-5">
                      <div className="h-4 rounded animate-pulse" style={{ background: 'var(--surface)' }} />
                    </td>
                  </tr>
                ))
              ) : loadError ? (
                <tr>
                  <td colSpan={5} className="px-6 py-16 text-center">
                    <p className="text-sm font-semibold text-text-primary">Evaluations could not be loaded</p>
                    <p className="mt-1 text-xs text-text-muted">Your records are unchanged. Try loading the list again.</p>
                    <button type="button" onClick={loadData} className="btn-secondary mt-5 px-3 py-2 text-xs font-semibold">Try again</button>
                  </td>
                </tr>
              ) : filteredInterviews.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-20 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="w-12 h-12 rounded-full flex items-center justify-center text-text-muted"
                           style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
                        <FileSearch size={22} />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-text-primary">No evaluations found</p>
                        <p className="text-xs text-text-muted mt-1">
                          {filter === 'ALL'
                            ? 'Start by creating a new evaluation.'
                            : `No "${filter.toLowerCase()}" evaluations yet.`}
                        </p>
                      </div>
                      {filter !== 'ALL' && (
                        <button onClick={() => setActiveFilter('ALL')}
                                className="text-xs font-semibold text-accent hover:underline">
                          Clear filter
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredInterviews.map((interview) => {
                  const candidateName = interview.candidate_name || 'Unknown candidate';
                  const position = interview.position || 'Unknown position';
                  const createdAt = Number.isFinite(interview.created_at) ? interview.created_at : 0;
                  const initials = candidateName
                    .split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();
                  const avatarColors = ['#267A6B','#64748B','#059669','#D97706','#DC2626'];
                  const avatarColor = avatarColors[candidateName.charCodeAt(0) % 5];

                  return (
                    <tr
                      key={interview.interview_id}
                      className="group transition-colors"
                      style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      {/* Candidate with avatar */}
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                            style={{ background: avatarColor }}
                          >
                            {initials}
                          </div>
                          <span className="text-sm font-semibold text-text-primary">
                            {candidateName}
                          </span>
                        </div>
                      </td>

                      {/* Position */}
                      <td className="px-6 py-4 text-sm text-text-secondary">
                        {position}
                      </td>

                      {/* Date */}
                      <td className="px-6 py-4 text-xs text-text-muted text-center">
                        {format(new Date(createdAt), 'dd-MM-yyyy')}
                      </td>

                      {/* Status */}
                      <td className="px-6 py-4 text-center">
                        <StatusBadge status={interview.status} />
                      </td>

                      {/* Actions */}
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            onClick={() => setConfirmDelete({
                              id: interview.interview_id,
                              name: candidateName,
                            })}
                            className="p-1.5 rounded-md transition-colors text-text-muted hover:text-red-500"
                            style={{}}
                            title="Delete"
                          >
                            <Trash2 size={14} />
                          </button>
                          <Link
                            href={`/interviews/view?id=${interview.interview_id}`}
                            className="p-1.5 rounded-md transition-colors text-text-muted hover:text-accent"
                          >
                            <ChevronRight size={16} />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Dialogs */}
      <ConfirmDialog
        isOpen={!!confirmDelete}
        title="Delete evaluation"
        description={`Are you sure you want to delete the evaluation for ${confirmDelete?.name}? This cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => confirmDelete && handleDelete(confirmDelete.id)}
        onCancel={() => setConfirmDelete(null)}
      />
      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </div>
  );
}

function StatCard({ title, value, icon: Icon, type, onClick, active }: {
  title: string; value: number; icon: ComponentType<{ size?: number; style?: CSSProperties }>; type: string;
  onClick?: () => void; active?: boolean;
}) {
  const config: Record<string, { color: string; bg: string; border: string }> = {
    teal:  { color: '#267A6B', bg: '#ECFDF5', border: '#99F6E4' },
    amber: { color: '#F59E0B', bg: '#FFFBEB', border: '#FDE68A' },
    green: { color: '#10B981', bg: '#ECFDF5', border: '#A7F3D0' },
    red:   { color: '#EF4444', bg: '#FEF2F2', border: '#FECACA' },
  };
  const { color } = config[type] || config.teal;

  return (
    <button
      type="button"
      onClick={onClick}
      className="metric-card cursor-pointer select-none p-5 text-left transition-all duration-150 hover:-translate-y-0.5"
      style={{
        background: active ? `color-mix(in srgb, ${color} 9%, var(--surface-elevated))` : undefined,
        border: active ? `1.5px solid ${color}` : '1px solid var(--border)',
        boxShadow: active ? `0 0 0 3px ${color}18, 0 6px 18px rgb(15 23 42 / 0.08)` : undefined,
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
             style={{ background: `${color}16`, border: `1px solid ${color}30` }}>
          <Icon size={15} style={{ color }} />
        </div>
      </div>
      <div className="text-2xl font-semibold text-text-primary tracking-tight">{value}</div>
      <div className="mt-3 h-[2px] rounded-full" 
           style={{ background: active ? color : `${color}35` }} />
    </button>
  );
}

