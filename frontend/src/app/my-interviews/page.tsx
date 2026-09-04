'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import {
  AlertCircle,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Mail,
  RefreshCw,
  SearchX,
  UsersRound,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { api, type InterviewIntelligenceRecord, type ScheduledInterview } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { SkeletonList } from '@/components/ui/Skeleton';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { getIntelligenceCandidateName } from '@/lib/getIntelligenceCandidateName';

function meetingLabel(item: ScheduledInterview): string {
  if (item.meeting_url) return 'Teams link ready';
  if (item.meeting_id) return 'Meeting found, link pending';
  return 'Meeting pending';
}

function scheduledStatusLabel(item: ScheduledInterview): string {
  if (item.cancelled_at) return 'Cancelled';
  if (item.intelligence_id) return 'Workspace ready';
  return item.keka_status || 'Scheduled';
}

function nextStep(record: InterviewIntelligenceRecord): string {
  if (record.status === 'approved') return 'Approved report';
  if (record.aiEvaluation) return 'Review report';
  if (record.transcript) return 'Review evidence';
  if (record.questionPlan) return 'Bring in transcript';
  return 'Prepare panel guide';
}

function recordTime(record: InterviewIntelligenceRecord): number {
  const scheduled = Date.parse(record.teams.scheduledAt || '');
  if (Number.isFinite(scheduled)) return scheduled;
  return record.updated_at || record.created_at || 0;
}

function isPastRecord(record: InterviewIntelligenceRecord, now: number): boolean {
  const scheduled = Date.parse(record.teams.scheduledAt || '');
  if (Number.isFinite(scheduled) && scheduled < now) return true;
  return ['transcript_ready', 'scores_submitted', 'analysis_processing', 'analysis_failed', 'analysis_generated', 'approved'].includes(record.status);
}

export default function MyInterviewsPage() {
  const router = useRouter();
  const { profile } = useAuth();
  const [scheduled, setScheduled] = useState<ScheduledInterview[]>([]);
  const [records, setRecords] = useState<InterviewIntelligenceRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      setError(null);
      const [scheduledData, recordData] = await Promise.all([
        refresh ? api.refreshMyInterviews() : api.getMyInterviews(),
        api.getIntelligenceInterviews(),
      ]);
      setScheduled(scheduledData.items ?? []);
      setRecords(recordData.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'HireRite interviews could not be loaded');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const now = Date.now();
  const activeScheduled = useMemo(
    () => scheduled
      .filter((item) => !item.cancelled_at && item.scheduled_at >= now - 60 * 60 * 1000)
      .sort((left, right) => left.scheduled_at - right.scheduled_at),
    [scheduled, now],
  );
  const pastRecords = useMemo(
    () => records
      .filter((record) => isPastRecord(record, now))
      .sort((left, right) => recordTime(right) - recordTime(left)),
    [records, now],
  );
  const reportsReady = records.filter((record) => record.aiEvaluation || record.status === 'approved').length;
  const needsAttention = records.filter((record) => (
    record.status === 'analysis_failed'
    || record.teams.transcriptStatus === 'failed'
    || record.progress_stage === 'failed'
  )).length + scheduled.filter((item) => Boolean(item.cancelled_at)).length;

  const openInterview = async (item: ScheduledInterview) => {
    if (item.cancelled_at) return;

    setOpeningId(item.keka_interview_id);
    setError(null);
    try {
      const result = await api.openMyInterview(item.keka_interview_id);
      router.push(`/interviews/intelligence/view?id=${encodeURIComponent(result.intelligence_id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open scheduled interview');
    } finally {
      setOpeningId(null);
    }
  };

  if (loading) return <SkeletonList rows={5} />;

  return (
    <div className="space-y-7 pb-8">
      <section className="card p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">HireRite</p>
            <h1 className="mt-2 text-2xl font-semibold text-text-primary">My Interviews</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
              Scheduled Keka rounds, Teams entry, panel guide, transcript, review, and approved reports in one place.
            </p>
            {profile?.email && (
              <p className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-elevated px-2.5 py-1 text-xs text-text-muted">
                <Mail size={13} />
                Showing rounds for <span className="font-mono text-text-secondary">{profile.email}</span>
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => {
              setRefreshing(true);
              void load(true);
            }}
            disabled={refreshing}
            className="btn-secondary inline-flex items-center justify-center gap-2 px-3 py-2 text-sm"
          >
            <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>
      )}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard title="Scheduled interviews" value={activeScheduled.length} detail="Upcoming Keka rounds" icon={CalendarClock} tone="teal" />
        <SummaryCard title="Past interviews" value={pastRecords.length} detail="Completed or elapsed workspaces" icon={Clock3} tone="amber" />
        <SummaryCard title="Reports ready" value={reportsReady} detail="Ready for review or sharing" icon={CheckCircle2} tone="green" />
        <SummaryCard title="Needs attention" value={needsAttention} detail="Sync or review issues to resolve" icon={AlertCircle} tone="red" />
      </div>

      <section className="space-y-4">
        <SectionHeader title="Scheduled Interviews" detail="Open the workspace, prepare the panel guide, and join the Teams meeting from the same row." />
        {activeScheduled.length === 0 ? (
          <EmptyState title="No scheduled interviews found" detail="Assigned Keka rounds will appear here after the schedule sync runs." />
        ) : (
          <div className="space-y-3">
            {activeScheduled.map((item) => (
              <ScheduledCard
                key={`${item.keka_interview_id}-${item.panelist_email}`}
                item={item}
                opening={openingId === item.keka_interview_id}
                onOpen={() => void openInterview(item)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-4">
        <SectionHeader title="Past Interviews" detail="Completed and elapsed HireRite workspaces stay available for transcript review, evaluation, approval, and export." />
        {pastRecords.length === 0 ? (
          <EmptyState title="No past interviews yet" detail="Completed interviews will move into this section automatically." />
        ) : (
          <div className="grid gap-3">
            {pastRecords.map((record) => (
              <PastInterviewCard key={record.intelligence_id} record={record} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

const summaryTones: Record<string, { border: string; icon: string; line: string }> = {
  teal: { border: 'border-accent/40 shadow-[0_0_24px_rgba(91,213,196,0.10)]', icon: 'border-accent/20 bg-accent/10 text-accent', line: 'bg-accent/70' },
  amber: { border: 'border-warning/30', icon: 'border-warning/20 bg-warning/10 text-warning', line: 'bg-warning/60' },
  green: { border: 'border-success/30', icon: 'border-success/20 bg-success/10 text-success', line: 'bg-success/70' },
  red: { border: 'border-danger/30', icon: 'border-danger/20 bg-danger/10 text-danger', line: 'bg-danger/60' },
};

function SummaryCard({ title, value, detail, icon: Icon, tone }: { title: string; value: number; detail: string; icon: LucideIcon; tone: keyof typeof summaryTones }) {
  const style = summaryTones[tone];
  return (
    <div className={`metric-card p-5 ${style.border}`}>
      <div className="mb-4 flex items-start justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</p>
        <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border ${style.icon}`}>
          <Icon size={17} />
        </span>
      </div>
      <p className="text-2xl font-semibold text-text-primary">{value}</p>
      <p className="mt-1 text-xs text-text-muted">{detail}</p>
      <div className={`mt-4 h-0.5 rounded-full ${style.line}`} />
    </div>
  );
}

function SectionHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <div>
      <h2 className="text-base font-semibold text-text-primary">{title}</h2>
      <p className="mt-1 text-sm leading-6 text-text-muted">{detail}</p>
    </div>
  );
}

function EmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="card flex min-h-[170px] flex-col items-center justify-center p-6 text-center">
      <span className="mb-3 rounded-xl bg-accent/10 p-2.5 text-accent"><SearchX size={20} /></span>
      <p className="text-sm font-medium text-text-primary">{title}</p>
      <p className="mt-1 max-w-md text-sm text-text-muted">{detail}</p>
    </div>
  );
}

function ScheduledCard({ item, opening, onOpen }: { item: ScheduledInterview; opening: boolean; onOpen: () => void }) {
  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-4 transition-colors hover:bg-surface-interactive">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-text-primary">{item.candidate_name}</h3>
            <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-muted">
              {scheduledStatusLabel(item)}
            </span>
          </div>
          <p className="mt-1 text-sm text-text-secondary">{item.job_title}</p>
          <div className="mt-3 flex flex-wrap gap-3 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock size={14} />
              {format(new Date(item.scheduled_at), 'dd-MM-yyyy, h:mm a')}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <Video size={14} />
              {meetingLabel(item)}
            </span>
            <span>
              Panel: {(item.panel || []).map((member) => member.name || member.email).filter(Boolean).join(', ') || 'Not listed'}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {item.meeting_url && (
            <a
              href={item.meeting_url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn-secondary inline-flex items-center justify-center gap-2 px-3 py-2 text-sm"
            >
              <Video size={16} />
              Join Teams
            </a>
          )}
          <button
            type="button"
            onClick={onOpen}
            disabled={opening}
            className="btn-primary inline-flex items-center justify-center gap-2 px-3 py-2 text-sm"
          >
            {opening ? <RefreshCw size={16} className="animate-spin" /> : <ExternalLink size={16} />}
            {item.intelligence_id ? 'Continue' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}

function PastInterviewCard({ record }: { record: InterviewIntelligenceRecord }) {
  return (
    <Link
      href={`/interviews/intelligence/view?id=${encodeURIComponent(record.intelligence_id)}`}
      className="rounded-xl border border-border bg-surface-elevated p-4 transition-colors hover:bg-surface-interactive"
    >
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <UsersRound size={18} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-sm font-semibold text-text-primary">{getIntelligenceCandidateName(record)}</h3>
              <StatusBadge status={record.status} />
            </div>
            <p className="mt-1 text-sm text-text-secondary">{record.job.title || 'Role not provided'}</p>
            <div className="mt-3 flex flex-wrap gap-2 text-xs text-text-muted">
              <span className="rounded-full bg-surface px-3 py-1">{format(new Date(recordTime(record)), 'dd-MM-yyyy')}</span>
              <span className="rounded-full bg-surface px-3 py-1">{record.panel.length} panelist{record.panel.length === 1 ? '' : 's'}</span>
              <span className="rounded-full bg-surface px-3 py-1">Next: {nextStep(record)}</span>
            </div>
          </div>
        </div>
        <span className="inline-flex items-center gap-2 text-sm font-semibold text-accent">
          Open workspace
          <ArrowRight size={16} />
        </span>
      </div>
    </Link>
  );
}
