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
  Trash2
} from 'lucide-react';
import { format } from 'date-fns';

export default function Dashboard() {
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ total: 0, completed: 0, pending: 0, failed: 0 });

  useEffect(() => {
    async function loadData() {
      try {
        const data = await api.getInterviews();
        setInterviews(data.items);
        
        const summary = data.items.reduce((acc, curr) => {
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

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete the interview for ${name}? This action cannot be undone.`)) {
      return;
    }

    try {
      await api.deleteInterview(id);
      setInterviews(prev => prev.filter(i => i.interview_id !== id));
      // Refresh stats
      const data = await api.getInterviews();
      const summary = data.items.reduce((acc, curr) => {
        acc.total++;
        if (curr.status === 'COMPLETED') acc.completed++;
        else if (curr.status === 'FAILED') acc.failed++;
        else acc.pending++;
        return acc;
      }, { total: 0, completed: 0, pending: 0, failed: 0 });
      setStats(summary);
    } catch (err) {
      alert('Failed to delete interview');
      console.error(err);
    }
  };

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight">Executive Summary</h1>
          <p className="text-text-secondary mt-1">Overview of latest interview evaluations and performance signals.</p>
        </div>
        <Link 
          href="/interviews/new"
          className="bg-accent text-accent-foreground px-4 py-2 rounded-md font-medium text-sm hover:opacity-90 transition-opacity flex items-center gap-2"
        >
          <Plus size={18} />
          New Interview
        </Link>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <StatCard title="Total Interviews" value={stats.total} icon={Users} type="blue" />
        <StatCard title="Evaluating" value={stats.pending} icon={Clock} type="amber" />
        <StatCard title="Completed" value={stats.completed} icon={CheckCircle2} type="green" />
        <StatCard title="Attention Req." value={stats.failed} icon={AlertCircle} type="red" />
      </div>

      {/* Table Section */}
      <div className="card overflow-hidden">
        <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-surface">
          <h3 className="font-semibold text-text-primary text-sm uppercase tracking-wider">Recent Evaluations</h3>
          <button className="text-xs text-accent font-semibold hover:underline">View All</button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface/50 text-text-muted text-[10px] uppercase tracking-widest border-b border-border">
                <th className="px-6 py-3 font-bold">Candidate</th>
                <th className="px-6 py-3 font-bold">Position</th>
                <th className="px-6 py-3 font-bold text-center">Date</th>
                <th className="px-6 py-3 font-bold text-center">Status</th>
                <th className="px-6 py-3 font-bold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {loading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i} className="animate-pulse">
                    <td colSpan={5} className="px-6 py-6 h-16 bg-surface/20" />
                  </tr>
                ))
              ) : interviews.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-6 py-12 text-center text-text-muted text-sm">
                    No interviews found. Start by creating a new evaluation.
                  </td>
                </tr>
              ) : (
                interviews.map((interview) => (
                  <tr key={interview.interview_id} className="hover:bg-surface/50 transition-colors group">
                    <td className="px-6 py-5 font-medium text-text-primary text-sm">
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
                        onClick={() => handleDelete(interview.interview_id, interview.candidate_name)}
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
    </div>
  );
}

function StatCard({ title, value, icon: Icon, type }: any) {
  const styles: any = {
    blue: "text-blue-600 dark:text-blue-400 border-blue-100 dark:border-blue-900/30",
    amber: "text-amber-600 dark:text-amber-400 border-amber-100 dark:border-amber-900/30",
    green: "text-green-600 dark:text-green-400 border-green-100 dark:border-green-900/30",
    red: "text-red-600 dark:text-red-400 border-red-100 dark:border-red-900/30",
  };

  return (
    <div className="card p-6 flex items-start justify-between hover:border-accent/30 transition-colors">
      <div>
        <p className="text-xs font-bold text-text-muted uppercase tracking-widest">{title}</p>
        <h4 className="text-3xl font-bold text-text-primary mt-2 tracking-tight">{value}</h4>
      </div>
      <div className={`p-2 rounded-lg border ${styles[type]}`}>
        <Icon size={20} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: any = {
    CREATED: "text-text-muted border-border bg-surface/30",
    FILES_UPLOADED: "text-blue-600 bg-blue-50/50 border-blue-100 dark:text-blue-400 dark:bg-blue-900/10 dark:border-blue-900/30",
    QUEUED: "text-amber-600 bg-amber-50/50 border-amber-100 dark:text-amber-400 dark:bg-amber-900/10 dark:border-amber-900/30",
    PROCESSING: "text-amber-600 bg-amber-50/50 border-amber-100 dark:text-amber-400 dark:bg-amber-900/10 dark:border-amber-900/30 animate-pulse",
    COMPLETED: "text-green-600 bg-green-50/50 border-green-100 dark:text-green-400 dark:bg-green-900/10 dark:border-green-900/30",
    FAILED: "text-red-600 bg-red-50/50 border-red-100 dark:text-red-400 dark:bg-red-900/10 dark:border-red-900/30",
  };

  return (
    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wide ${styles[status]}`}>
      {status.replace('_', ' ')}
    </span>
  );
}
