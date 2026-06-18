'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, IntegrationStatus, InterviewIntelligenceRecord } from '@/lib/api';
import { BrainCircuit, CalendarClock, CheckCircle2, ClipboardList, PlusCircle } from 'lucide-react';
import { format } from 'date-fns';

const statusLabels: Record<string, string> = {
  data_ready: 'Data Ready',
  questions_generated: 'Questions Generated',
  transcript_ready: 'Transcript Ready',
  scores_submitted: 'Scores Submitted',
  analysis_generated: 'Analysis Generated',
  approved: 'Approved',
  draft: 'Draft',
};

export default function InterviewIntelligenceDashboard() {
  const [items, setItems] = useState<InterviewIntelligenceRecord[]>([]);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        const [records, integrationStatus] = await Promise.all([
          api.getIntelligenceInterviews(),
          api.getIntegrationStatus(),
        ]);
        if (!mounted) return;
        setItems(records.items || []);
        setStatus(integrationStatus);
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => { mounted = false; };
  }, []);

  const generated = items.filter((item) => item.questionPlan).length;
  const analyzed = items.filter((item) => item.aiEvaluation).length;
  const approved = items.filter((item) => item.status === 'approved').length;

  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-8">
      <div className="flex flex-col gap-4 pt-2 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-accent">
            Interview Agent · Intelligence Mode
          </p>
          <h1 className="text-xl font-semibold tracking-tight text-text-primary">
            Interview Intelligence
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-text-secondary">
            Prepare interviewer-wise questions before the interview, then analyze transcript coverage,
            interviewer quality, panel scoring, and final AI-assisted recommendations after the interview.
          </p>
        </div>
        <Link href="/interviews/intelligence/new" className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold">
          <PlusCircle size={16} />
          New intelligence interview
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Metric title="Question plans" value={generated} icon={ClipboardList} />
        <Metric title="AI analyses" value={analyzed} icon={BrainCircuit} />
        <Metric title="Approved reports" value={approved} icon={CheckCircle2} />
      </div>

      <div className="rounded-2xl border border-border bg-surface-elevated p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Integration status</h2>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              Live credentials are not required yet. Mock and manual modes keep the workflow testable.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <IntegrationPill label={`Keka: ${status?.keka.mode || 'mock'} mode`} />
            <IntegrationPill label={`Teams: ${status?.teams.mode || 'mock'} mode`} />
            <IntegrationPill label="Real credentials not configured yet" muted />
          </div>
        </div>
      </div>

      <div className="data-table">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-sm font-semibold text-text-primary">Intelligence interviews</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-surface">
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Candidate</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Role</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Panel</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Status</th>
                <th className="px-6 py-3 text-xs font-semibold uppercase tracking-wide text-text-muted">Created</th>
                <th className="px-6 py-3 text-right text-xs font-semibold uppercase tracking-wide text-text-muted">Open</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-6 py-10 text-center text-sm text-text-muted">Loading intelligence interviews...</td></tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-16 text-center">
                    <div className="mx-auto flex max-w-md flex-col items-center gap-3">
                      <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-surface">
                        <BrainCircuit size={22} className="text-accent" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-text-primary">No intelligence interviews yet</p>
                        <p className="mt-1 text-xs text-text-muted">Create one manually or use mock Keka data to test the full workflow.</p>
                      </div>
                    </div>
                  </td>
                </tr>
              ) : items.map((item) => (
                <tr key={item.intelligence_id} className="border-b border-border">
                  <td className="px-6 py-4 text-sm font-semibold text-text-primary">{item.candidate.name}</td>
                  <td className="px-6 py-4 text-sm text-text-secondary">{item.job.title}</td>
                  <td className="px-6 py-4 text-sm text-text-secondary">{item.panel.length} interviewer{item.panel.length === 1 ? '' : 's'}</td>
                  <td className="px-6 py-4"><StatusPill status={item.status} /></td>
                  <td className="px-6 py-4 text-xs text-text-muted">{format(new Date(item.created_at), 'MMM d, yyyy')}</td>
                  <td className="px-6 py-4 text-right">
                    <Link className="text-sm font-semibold text-accent hover:underline" href={`/interviews/intelligence/view?id=${item.intelligence_id}`}>
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Metric({ title, value, icon: Icon }: { title: string; value: number; icon: typeof CalendarClock }) {
  return (
    <div className="rounded-2xl border border-border bg-surface-elevated p-5">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</p>
        <Icon size={18} className="text-accent" />
      </div>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
    </div>
  );
}

function IntegrationPill({ label, muted = false }: { label: string; muted?: boolean }) {
  return (
    <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${muted ? 'border-border bg-surface text-text-muted' : 'border-accent/20 bg-accent/10 text-accent'}`}>
      {label}
    </span>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className="rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">
      {statusLabels[status] || status}
    </span>
  );
}
