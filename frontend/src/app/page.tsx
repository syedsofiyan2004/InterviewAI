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
import { OnboardingTour } from '@/components/ui/OnboardingTour';

export default function Dashboard() {
   const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, completed: 0, pending: 0, failed: 0 });
  const [confirmDelete, setConfirmDelete] = useState<{ id: string; name: string } | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [filter, setFilter] = useState('ALL');

  const filteredInterviews = interviews.filter(i => filter === 'ALL' || i.status === filter);

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
    <div className="space-y-8 max-w-7xl mx-auto">
      <OnboardingTour />
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Evaluations</h1>
          <p className="text-sm text-text-secondary mt-0.5">
            {interviews.length} total · {stats.completed} completed · {stats.pending} in progress
          </p>
        </div>
        <Link 
          href="/interviews/new"
          id="tour-new-btn"
          className="bg-accent text-accent-foreground px-4 py-2 rounded-md font-semibold text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <Plus size={18} />
          New Interview
        </Link>
      </div>

      {/* Summary Cards */}
      <div id="tour-stats" className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <StatCard title="Total interviews" value={stats.total} icon={Users} type="blue" />
        <StatCard title="Evaluating" value={stats.pending} icon={Clock} type="amber" />
        <StatCard title="Completed" value={stats.completed} icon={CheckCircle2} type="green" />
        <StatCard title="Needs attention" value={stats.failed} icon={AlertCircle} type="red" />
      </div>

      {/* Table Section */}
      <div id="tour-table" className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-surface/30">
          <h3 className="text-sm font-semibold text-text-primary">Recent Evaluations</h3>
          <div className="flex items-center gap-2">
             <span className="text-xs text-text-muted">Filter by status:</span>
             <select 
               value={filter}
               onChange={(e) => setFilter(e.target.value)}
               className="bg-surface border border-border text-xs rounded px-2 py-1 focus:outline-none focus:ring-1 focus:ring-accent"
             >
               <option value="ALL">All States</option>
               <option value="CREATED">Created</option>
               <option value="COMPLETED">Completed</option>
               <option value="FAILED">Failed</option>
             </select>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface/50 text-text-muted text-xs font-semibold border-b border-border">
                <th className="px-6 py-3 font-semibold">Candidate</th>
                <th className="px-6 py-3 font-semibold">Position</th>
                <th className="px-6 py-3 font-semibold text-center">Date</th>
                <th className="px-6 py-3 font-semibold text-center">Status</th>
                <th className="px-6 py-3 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={5} className="px-6 py-6 h-16 bg-surface/20" />
                  </tr>
                ))
              ) : filteredInterviews.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-20 text-center">
                    <div className="flex flex-col items-center justify-center space-y-3">
                       <div className="w-12 h-12 rounded-full bg-surface-elevated border border-border flex items-center justify-center text-text-muted">
                          <FileSearch size={24} />
                       </div>
                       <div className="space-y-1">
                          <p className="text-sm font-semibold text-text-primary">No evaluations found</p>
                          <p className="text-xs text-text-muted">
                            {filter === 'ALL' ? "Start by creating a new interview evaluation." : `No interviews with status "${filter}" found.`}
                          </p>
                       </div>
                       {filter !== 'ALL' && (
                         <button 
                           onClick={() => setFilter('ALL')}
                           className="text-xs text-accent font-semibold hover:underline mt-2"
                         >
                           Clear Filter
                         </button>
                       )}
                    </div>
                  </td>
                </tr>
              ) : (
                filteredInterviews.map((interview) => (
                  <tr key={interview.interview_id} className="hover:bg-surface/60 dark:hover:bg-slate-700/30 transition-colors group">
                    <td className="px-6 py-5 font-semibold text-text-primary text-sm">
                      {interview.candidate_name}
                    </td>
                    <td className="px-6 py-5 text-text-secondary text-sm">
                      {interview.position}
                    </td>
                    <td className="px-6 py-5 text-center text-text-secondary text-xs">
                      {format(new Date(interview.created_at), 'MMM d, yyyy')}
                    </td>
                    <td className="px-6 py-5 text-center">
                      <StatusBadge status={interview.status} />
                    </td>
                    <td className="px-6 py-5 text-right flex items-center justify-end gap-2">
                      <button
                        onClick={() => setConfirmDelete({ id: interview.interview_id, name: interview.candidate_name })}
                        className="p-1 rounded-md text-text-muted hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/10 transition-all"
                        title="Delete Interview"
                      >
                        <Trash2 size={16} />
                      </button>
                      <Link 
                        href={`/interviews/view?id=${interview.interview_id}`}
                        className="p-1 rounded-md text-text-muted group-hover:text-accent group-hover:bg-accent/5 transition-all inline-block"
                      >
                        <ChevronRight size={18} />
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
      <ConfirmDialog 
        isOpen={!!confirmDelete}
        title="Delete Interview"
        description={`Are you sure you want to delete the interview for ${confirmDelete?.name}? This action cannot be undone.`}
        confirmLabel="Delete"
        onConfirm={() => confirmDelete && handleDelete(confirmDelete.id)}
        onCancel={() => setConfirmDelete(null)}
      />

      {toast && (
        <Toast 
          message={toast.message} 
          type={toast.type} 
          onClose={() => setToast(null)} 
        />
      )}
    </div>
  );
}

function StatCard({ title, value, icon: Icon, type }: any) {
  const iconColor: any = {
    blue: "text-blue-400",
    amber: "text-amber-400",
    green: "text-green-400",
    red: "text-red-400",
  };
  const borderColor: any = {
    blue: "border-b-blue-500/40",
    amber: "border-b-amber-500/40",
    green: "border-b-green-500/40",
    red: "border-b-red-500/40",
  };

  return (
    <div className={cn(
      "card p-5 flex items-start justify-between border-b-2 transition-colors cursor-pointer hover:shadow-sm",
      borderColor[type]
    )}>
      <div className="space-y-1">
        <p className="text-sm font-medium text-text-secondary">{title}</p>
        <h4 className="text-3xl font-bold text-text-primary tracking-tight">{value}</h4>
      </div>
      <Icon size={18} className={iconColor[type]} />
    </div>
  );
}

function cn(...inputs: any[]) {
  return inputs.filter(Boolean).join(' ');
}

