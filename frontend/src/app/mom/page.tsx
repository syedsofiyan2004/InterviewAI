'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, CheckCircle2, Clock, FileText, Plus, Trash2 } from 'lucide-react';
import { format } from 'date-fns';
import { api, Mom } from '@/lib/api';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Toast } from '@/components/ui/Toast';

export default function MomDashboard() {
  const [moms, setMoms] = useState<Mom[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('ALL');
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; title: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const loadMoms = async () => {
    try {
      const data = await api.getMoms();
      const sorted = [...data.items].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
      setMoms(sorted);
    } catch (err) {
      console.error('Failed to load MOMs', err);
      setToast({ message: 'Failed to load MOMs', type: 'error' });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMoms();
  }, []);

  const stats = useMemo(() => moms.reduce((acc, mom) => {
    acc.total++;
    if (mom.status === 'COMPLETED') acc.completed++;
    else if (mom.status === 'FAILED') acc.failed++;
    else acc.processing++;
    return acc;
  }, { total: 0, completed: 0, processing: 0, failed: 0 }), [moms]);

  const filtered = moms.filter(mom => filter === 'ALL' || mom.status === filter);

  const handleDelete = async (id: string) => {
    try {
      await api.deleteMom(id);
      setToast({ message: 'MOM deleted successfully', type: 'success' });
      await loadMoms();
    } catch {
      setToast({ message: 'Failed to delete MOM', type: 'error' });
    } finally {
      setConfirmDelete(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-8">
      <div className="flex items-end justify-between pt-2">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase mb-1">
            Minfy AI / MOM Analyzer
          </p>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Minutes of Meeting</h1>
          <p className="text-sm text-text-muted mt-0.5">
            {stats.total} total / {stats.completed} completed / {stats.processing} in progress
          </p>
        </div>
        <Link
          href="/mom/new"
          className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold text-white transition-opacity hover:opacity-90 shrink-0"
          style={{ background: '#4F46E5' }}
        >
          <Plus size={15} />
          New MOM
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Stat title="Total MOMs" value={stats.total} icon={FileText} onClick={() => setFilter('ALL')} active={filter === 'ALL'} />
        <Stat title="Processing" value={stats.processing} icon={Clock} onClick={() => setFilter('PROCESSING')} active={filter === 'PROCESSING'} />
        <Stat title="Completed" value={stats.completed} icon={CheckCircle2} onClick={() => setFilter('COMPLETED')} active={filter === 'COMPLETED'} />
        <Stat title="Failed" value={stats.failed} icon={AlertCircle} onClick={() => setFilter('FAILED')} active={filter === 'FAILED'} />
      </div>

      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>
        <div className="px-6 py-4 flex items-center justify-between" style={{ borderBottom: '1px solid var(--border)' }}>
          <h3 className="text-sm font-semibold text-text-primary">Recent MOMs</h3>
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
                <th className="px-6 py-3 text-xs font-medium text-text-muted">Source</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-center">Date</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-center">Status</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 3 }).map((_, index) => (
                  <tr key={index} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td colSpan={5} className="px-6 py-5">
                      <div className="h-4 rounded animate-pulse" style={{ background: 'var(--surface)' }} />
                    </td>
                  </tr>
                ))
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-20 text-center">
                    <p className="text-sm font-semibold text-text-primary">No MOMs found</p>
                    <p className="text-xs text-text-muted mt-1">Create a MOM from a transcript to see it here.</p>
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
                    <td className="px-6 py-4 text-sm text-text-secondary capitalize">{mom.source_type || 'file'}</td>
                    <td className="px-6 py-4 text-sm text-text-secondary text-center">
                      {mom.created_at ? format(new Date(mom.created_at), 'MMM d, yyyy') : 'Unknown'}
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
      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}
    </div>
  );
}

function Stat({ title, value, icon: Icon, active, onClick }: { title: string; value: number; icon: any; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="text-left p-5 rounded-xl transition-all"
      style={{
        border: active ? '1px solid #4F46E5' : '1px solid var(--border)',
        background: active ? '#4F46E512' : 'var(--surface-elevated)',
      }}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-text-muted">{title}</p>
        <Icon size={18} className="text-accent" />
      </div>
      <p className="text-2xl font-bold text-text-primary mt-4">{value}</p>
    </button>
  );
}
