'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { api, Interview } from '@/lib/api';
import { 
  Users, 
  CheckCircle2, 
  Clock, 
  AlertCircle,
  ChevronRight,
  Plus,
  Trash2,
  FileSearch,
  ClipboardList
} from 'lucide-react';
import { format } from 'date-fns';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast } from '@/components/ui/Toast';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useTour, checkTourStatus } from '@/contexts/TourContext';

export default function Dashboard() {
   const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, completed: 0, pending: 0, failed: 0 });
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [filter, setFilter] = useState('ALL');

  const filteredInterviews = interviews.filter(i => filter === 'ALL' || i.status === filter);

  const { startTour } = useTour();

  useEffect(() => {
    checkTourStatus().then(done => {
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
          ]);
        }, 1500);
      }
    });
  }, [startTour]);

  useEffect(() => {
    async function loadData() {
      try {
        const data = await api.getInterviews();
        const sorted = [...data.items].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
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
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await api.deleteInterview(id);
      setInterviews(prev => prev.filter(i => i.interview_id !== id));
      // Refresh stats
      const data = await api.getInterviews();
      const sorted = [...data.items].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
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
      <div className="flex items-end justify-between pt-2">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase mb-1">
            Minfy AI · Evaluation Platform
          </p>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">
            Evaluations
          </h1>
          <p className="text-sm text-text-muted mt-0.5">
            {interviews.length} total &middot; {stats.completed} completed &middot; {stats.pending} in progress
          </p>
        </div>
        <Link
          href="/interviews/new"
          id="tour-new-btn"
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 shrink-0"
          style={{ background: '#4F46E5' }}
        >
          <Plus size={15} />
          New evaluation
        </Link>
      </div>

      {/* ── Stat cards ── */}
      <div id="tour-stats" className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard title="Total interviews" value={stats.total}
          icon={Users} type="blue"
          onClick={() => setFilter('ALL')} active={filter === 'ALL'} />
        <StatCard title="Evaluating" value={stats.pending}
          icon={Clock} type="amber"
          onClick={() => setFilter('PROCESSING')} active={filter === 'PROCESSING'} />
        <StatCard title="Completed" value={stats.completed}
          icon={CheckCircle2} type="green"
          onClick={() => setFilter('COMPLETED')} active={filter === 'COMPLETED'} />
        <StatCard title="Needs attention" value={stats.failed}
          icon={AlertCircle} type="red"
          onClick={() => setFilter('FAILED')} active={filter === 'FAILED'} />
      </div>

      {/* ── Evaluations table ── */}
      <div id="tour-table" className="rounded-xl overflow-hidden"
           style={{ border: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>

        {/* Table header bar */}
        <div className="px-6 py-4 flex items-center justify-between"
             style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-semibold text-text-primary">Recent evaluations</h3>
            {filter !== 'ALL' && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
                    style={{ background: '#4F46E512', color: '#4F46E5', border: '1px solid #4F46E530' }}>
                {filter.charAt(0) + filter.slice(1).toLowerCase()}
                <button onClick={() => setFilter('ALL')}
                        className="ml-0.5 opacity-60 hover:opacity-100 leading-none">×</button>
              </span>
            )}
          </div>
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="text-xs rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent/30 transition-all"
            style={{
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--color-text-secondary)',
            }}
          >
            <option value="ALL">All statuses</option>
            <option value="COMPLETED">Completed</option>
            <option value="PROCESSING">Processing</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <th className="px-6 py-3 text-xs font-medium text-text-muted">Candidate</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted">Position</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-center">Date</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-center">Status</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-right">Action</th>
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
                        <button onClick={() => setFilter('ALL')}
                                className="text-xs font-semibold text-accent hover:underline">
                          Clear filter
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredInterviews.map((interview, idx) => {
                  const candidateName = interview.candidate_name || 'Unknown candidate';
                  const position = interview.position || 'Unknown position';
                  const createdAt = Number.isFinite(interview.created_at) ? interview.created_at : Date.now();
                  const initials = candidateName
                    .split(' ').map((n: string) => n[0]).join('').slice(0, 2).toUpperCase();
                  const avatarColors = ['#4F46E5','#0891B2','#059669','#D97706','#DC2626'];
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
                        {format(new Date(createdAt), 'MMM d, yyyy')}
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
  title: string; value: number; icon: any; type: string;
  onClick?: () => void; active?: boolean;
}) {
  const config: Record<string, { color: string; bg: string; border: string }> = {
    blue:  { color: '#3B82F6', bg: '#EFF6FF', border: '#BFDBFE' },
    amber: { color: '#F59E0B', bg: '#FFFBEB', border: '#FDE68A' },
    green: { color: '#10B981', bg: '#ECFDF5', border: '#A7F3D0' },
    red:   { color: '#EF4444', bg: '#FEF2F2', border: '#FECACA' },
  };
  const { color, bg, border } = config[type] || config.blue;

  return (
    <div
      onClick={onClick}
      className="rounded-xl p-5 transition-all duration-150 cursor-pointer select-none"
      style={{
        background: 'var(--surface-elevated)',
        border: active ? `1.5px solid ${color}` : '1px solid var(--border)',
        boxShadow: active ? `0 0 0 3px ${color}22` : '0 1px 3px rgba(0,0,0,0.04)',
      }}
    >
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-medium text-text-muted tracking-wide">{title}</p>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
             style={{ background: bg, border: `1px solid ${border}` }}>
          <Icon size={15} style={{ color }} />
        </div>
      </div>
      <div className="text-3xl font-bold text-text-primary tracking-tight">{value}</div>
      <div className="mt-3 h-[2px] rounded-full" 
           style={{ background: active ? color : `${color}35` }} />
    </div>
  );
}

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(' ');
}
