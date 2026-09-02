'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { api, IntegrationStatus, InterviewIntelligenceRecord } from '@/lib/api';
import {
  ArrowRight,
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  Clock3,
  PlusCircle,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { format } from 'date-fns';
import { Skeleton } from '@/components/ui/Skeleton';
import { useAuth } from '@/contexts/AuthContext';

import { getIntelligenceCandidateName } from '@/lib/getIntelligenceCandidateName';

const statusLabels: Record<string, string> = {
  data_ready: 'Data ready',
  questions_generated: 'Questions generated',
  transcript_ready: 'Transcript ready',
  scores_submitted: 'Scores submitted',
  analysis_generated: 'Analysis generated',
  approved: 'Approved',
  draft: 'Draft',
};

const statusNextSteps: Record<string, string> = {
  draft: 'Add the interview data',
  data_ready: 'Prepare the panel guide',
  questions_generated: 'Run the interview',
  transcript_ready: 'Review the analysis',
  scores_submitted: 'Review the analysis',
  analysis_generated: 'Approve the report',
  approved: 'Complete',
};

const intelligenceStatuses = Object.keys(statusLabels);

export default function InterviewIntelligenceDashboard() {
  const { hasTier } = useAuth();
  const canCreateManually = hasTier('REVIEWER');
  const [items, setItems] = useState<InterviewIntelligenceRecord[]>([]);
  const [status, setStatus] = useState<IntegrationStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedFilter = searchParams.get('status') || 'all';
  const activeFilter = requestedFilter === 'all' || intelligenceStatuses.includes(requestedFilter)
    ? requestedFilter
    : 'all';

  const setActiveFilter = useCallback((nextFilter: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (nextFilter === 'all') params.delete('status');
    else params.set('status', nextFilter);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);

  useEffect(() => {
    let mounted = true;
    async function load() {
      try {
        setLoadError(false);
        const [records, integrationStatus] = await Promise.all([
          api.getIntelligenceInterviews(),
          api.getIntegrationStatus(),
        ]);
        if (!mounted) return;
        setItems(records.items || []);
        setStatus(integrationStatus);
      } catch (error) {
        console.error('Failed to load interview workspaces', error);
        if (mounted) setLoadError(true);
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
  const filteredItems = useMemo(
    () => items.filter((item) => activeFilter === 'all' || item.status === activeFilter),
    [activeFilter, items],
  );

  return (
    <div className="space-y-8 pb-10">
      <section className="intelligence-hero intelligence-dashboard-hero">
        <div className="min-w-0">
          <p className="page-kicker">Interview Evaluator / Connected mode</p>
          <h1 className="mt-3 max-w-2xl text-3xl font-semibold leading-tight tracking-tight text-text-primary md:text-4xl">
            Interview work, kept in context.
          </h1>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-text-secondary">
            Each workspace carries the role, candidate, panel guide, transcript, and decision record from preparation through approval.
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            {/* REVIEWER+ only (Part E). Members get the interviewer-centric entry
                point instead; the server rejects manual creation either way. */}
            {canCreateManually ? (
              <Link href="/interviews/intelligence/new" className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold">
                <PlusCircle size={16} />
              New connected workspace
              </Link>
            ) : (
              <Link href="/my-interviews" className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold">
                <CalendarClock size={16} />
                My scheduled interviews
              </Link>
            )}
            <span className="inline-flex items-center gap-2 rounded-xl border border-border bg-surface-elevated px-4 py-2.5 text-xs font-semibold text-text-muted">
              <Clock3 size={14} />
              One record from brief to decision
            </span>
          </div>
        </div>

        <div className="intelligence-hero-panel">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">How it works</p>
            <BrainCircuit size={18} className="text-accent" />
          </div>
          <div className="mt-5 space-y-2">
            <WorkflowLine num="01" title="Prepare" detail="Role, candidate, and panel guide" />
            <WorkflowLine num="02" title="Review" detail="Transcript, evidence, and coverage" />
            <WorkflowLine num="03" title="Decide" detail="Human approval and PDF report" />
          </div>
        </div>
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Metric title="Guides prepared" value={generated} icon={ClipboardList} detail="Ready for interviewers" />
        <Metric title="Reviews ready" value={analyzed} icon={BrainCircuit} detail="Transcript and scores analyzed" />
        <Metric title="Reports approved" value={approved} icon={CheckCircle2} detail="Ready to share" />
      </div>

      <section className="intelligence-card p-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Connected sources</h2>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              Interview details and Teams transcripts are attached as each connected source becomes available.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <IntegrationPill label={`Interview details: ${status?.keka.configured ? 'Available' : 'In setup'}`} />
            <IntegrationPill label={`Meeting transcript: ${status?.teams.configured ? 'Available' : 'In setup'}`} />
          </div>
        </div>
      </section>

      <section>
        <div className="mb-4 flex items-end justify-between gap-4">
          <div>
            <p className="page-kicker">Records</p>
            <h2 className="mt-1 text-xl font-semibold text-text-primary">Interview workspaces</h2>
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-text-muted">
            <span className="hidden sm:inline">Show</span>
            <select
              value={activeFilter}
              onChange={(event) => setActiveFilter(event.target.value)}
              className="rounded-lg border border-border bg-surface-elevated px-3 py-2 text-xs font-semibold text-text-primary outline-none focus:border-accent"
              aria-label="Filter interview workspaces by status"
            >
              <option value="all">All workspaces ({items.length})</option>
              {intelligenceStatuses.map((statusValue) => (
                <option key={statusValue} value={statusValue}>{statusLabels[statusValue]}</option>
              ))}
            </select>
          </label>
        </div>

        {loading ? (
          <IntelligenceDashboardSkeleton />
        ) : loadError ? (
          <div className="intelligence-empty">
            <h3 className="text-base font-semibold text-text-primary">Interview workspaces could not be loaded</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-text-muted">Your existing workspaces are unchanged. Reload the collection to try again.</p>
            <button type="button" onClick={() => window.location.reload()} className="btn-secondary mt-5 px-4 py-2.5 text-sm font-semibold">Reload workspaces</button>
          </div>
        ) : items.length === 0 ? (
          <div className="intelligence-empty">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-border bg-surface">
              <BrainCircuit size={24} className="text-accent" />
            </div>
            <h3 className="mt-4 text-base font-semibold text-text-primary">Start with one interview</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-text-muted">
              Create a workspace to collect the interview inputs, prepare the panel, and complete the review in one place.
            </p>
            {canCreateManually ? (
              <Link href="/interviews/intelligence/new" className="btn-primary mt-5 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold">
                <PlusCircle size={16} />
                Create first workspace
              </Link>
            ) : (
              <Link href="/my-interviews" className="btn-primary mt-5 inline-flex items-center gap-2 px-4 py-2.5 text-sm font-semibold">
                <CalendarClock size={16} />
                Open a scheduled interview
              </Link>
            )}
          </div>
        ) : filteredItems.length === 0 ? (
          <div className="intelligence-empty">
            <h3 className="text-base font-semibold text-text-primary">No matching workspaces</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-text-muted">There are no workspaces in this state right now.</p>
            <button type="button" onClick={() => setActiveFilter('all')} className="btn-secondary mt-5 px-4 py-2.5 text-sm font-semibold">Show all workspaces</button>
          </div>
        ) : (
          <div className="grid gap-4">
            {filteredItems.map((item) => (
              <InterviewCard key={item.intelligence_id} item={item} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function IntelligenceDashboardSkeleton() {
  return (
    <div className="space-y-4" aria-busy="true" aria-live="polite">
      {[1, 2, 3].map((item) => (
        <div key={item} className="intelligence-record-card h-36">
          <div className="flex items-center gap-4">
            <Skeleton className="h-12 w-12 shrink-0 rounded-2xl" />
            <div className="min-w-0 flex-1 space-y-3">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-64" />
            </div>
          </div>
          <div className="w-full space-y-3 md:w-64">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-2 w-full" />
            <Skeleton className="h-3 w-36" />
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({ title, value, icon: Icon, detail }: { title: string; value: number; icon: LucideIcon; detail: string }) {
  return (
    <div className="intelligence-metric">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</p>
        <Icon size={18} className="text-accent" />
      </div>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
      <p className="mt-1 text-xs text-text-muted">{detail}</p>
    </div>
  );
}

function WorkflowLine({ num, title, detail }: { num: string; title: string; detail: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-3">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent/10 font-mono text-xs font-semibold text-accent">
        {num}
      </span>
      <div>
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        <p className="text-xs text-text-muted">{detail}</p>
      </div>
    </div>
  );
}

function InterviewCard({ item }: { item: InterviewIntelligenceRecord }) {
  const complete = [
    !!item.questionPlan,
    !!item.transcript,
    item.status === 'scores_submitted' || !!item.aiEvaluation || item.status === 'approved',
    !!item.aiEvaluation,
    item.status === 'approved',
  ].filter(Boolean).length;

  return (
    <Link href={`/interviews/intelligence/view?id=${item.intelligence_id}`} className="intelligence-record-card group">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-accent/10 text-accent">
          <UsersRound size={20} />
        </div>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold text-text-primary">{getIntelligenceCandidateName(item)}</h3>
            <StatusPill status={item.status} />
          </div>
          <p className="mt-1 text-sm text-text-secondary">{item.job.title || 'Role not provided'}</p>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-text-muted">
            <span className="rounded-full bg-surface px-3 py-1">{item.panel.length} interviewer{item.panel.length === 1 ? '' : 's'}</span>
            <span className="rounded-full bg-surface px-3 py-1">{format(new Date(item.created_at), 'dd-MM-yyyy')}</span>
            <span className="rounded-full bg-surface px-3 py-1">{item.keka.mode === 'live' ? 'Keka connected' : 'Manual data'}</span>
          </div>
        </div>
      </div>
      <div className="w-full shrink-0 md:w-64">
        <div className="mb-3 flex items-center justify-between text-xs font-semibold">
          <span className="text-text-muted">Progress</span>
          <span className="text-accent">{complete}/5 stages</span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {['Questions', 'Transcript', 'Scores', 'Analysis', 'Approval'].map((label, index) => (
            <span
              key={label}
              title={label}
              className={`h-2 rounded-full ${index < complete ? 'bg-accent' : 'bg-surface'}`}
            />
          ))}
        </div>
        <div className="mt-4 flex items-center justify-between gap-2 text-sm font-semibold text-accent">
          <span className="text-xs font-medium text-text-muted">Next: {statusNextSteps[item.status] || 'Continue review'}</span>
          <span className="inline-flex items-center gap-2">
            Open workspace
          <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
          </span>
        </div>
      </div>
    </Link>
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
