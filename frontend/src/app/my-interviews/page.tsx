'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { format } from 'date-fns';
import { api, type ScheduledInterview } from '@/lib/api';
import { useAuth } from '@/contexts/AuthContext';
import { SkeletonList } from '@/components/ui/Skeleton';
import { CalendarClock, ExternalLink, Mail, RefreshCw, Video, XCircle } from 'lucide-react';

function meetingLabel(item: ScheduledInterview): string {
  if (item.meeting_url) return 'Teams link ready';
  if (item.meeting_id) return 'Meeting found, link pending';
  return 'Meeting pending';
}

function statusLabel(item: ScheduledInterview): string {
  if (item.cancelled_at) return 'Cancelled';
  if (item.intelligence_id) return 'Provisioned';
  return item.keka_status || 'Scheduled';
}

export default function MyInterviewsPage() {
  const router = useRouter();
  const { profile } = useAuth();
  const [items, setItems] = useState<ScheduledInterview[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    try {
      setError(null);
      const data = refresh ? await api.refreshMyInterviews() : await api.getMyInterviews();
      setItems(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load scheduled interviews');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
    <div className="space-y-6">
      <div className="card flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Interview schedule</p>
          <h1 className="mt-2 text-xl font-semibold text-text-primary">My Interviews</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
            Scheduled Keka rounds assigned to your panel email. Open a round to continue in the existing interview workspace.
          </p>
          {/* The rows live in a partition keyed by this exact address, so showing
              it makes the filter visible: an interviewer who sees nothing can tell
              whether Keka has them on the panel under a different address. Taken
              from GET /me, never a decoded token claim. */}
          {profile?.email && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-elevated px-2.5 py-1 text-xs text-text-muted">
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

      {error && (
        <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>
      )}

      {items.length === 0 ? (
        <div className="card flex min-h-[220px] flex-col items-center justify-center p-6 text-center">
          <span className="mb-3 rounded-xl bg-accent/10 p-2.5 text-accent"><CalendarClock size={20} /></span>
          <p className="text-sm font-medium text-text-primary">No scheduled interviews found</p>
          <p className="mt-1 max-w-md text-sm text-text-muted">
            Your assigned Keka interview rounds will appear here after the schedule sync runs.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const cancelled = Boolean(item.cancelled_at);
            const opening = openingId === item.keka_interview_id;
            return (
              <div
                key={`${item.keka_interview_id}-${item.panelist_email}`}
                className="rounded-xl border border-border bg-surface-elevated p-4 transition-colors hover:bg-surface-interactive"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-sm font-semibold text-text-primary">{item.candidate_name}</h2>
                      <span className="rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-text-muted">
                        {statusLabel(item)}
                      </span>
                    </div>
                    <p className="mt-1 text-sm text-text-secondary">{item.job_title}</p>
                    <div className="mt-3 flex flex-wrap gap-3 text-xs text-text-muted">
                      <span className="inline-flex items-center gap-1.5">
                        <CalendarClock size={14} />
                        {format(new Date(item.scheduled_at), 'dd-MM-yyyy')}
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

                  {cancelled ? (
                    <span className="inline-flex items-center gap-2 rounded-lg border border-danger/25 bg-danger/10 px-3 py-2 text-xs font-semibold text-danger">
                      <XCircle size={14} />
                      Cancelled in Keka
                    </span>
                  ) : (
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      {/* meeting_url comes from Keka when it carries one, else from
                          the organiser's Outlook calendar via Graph. When neither
                          matched, the row stays honest about it rather than
                          offering a link that goes nowhere. */}
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
                        onClick={() => void openInterview(item)}
                        disabled={opening}
                        className="btn-primary inline-flex items-center justify-center gap-2 px-3 py-2 text-sm"
                      >
                        {opening ? <RefreshCw size={16} className="animate-spin" /> : <ExternalLink size={16} />}
                        {item.intelligence_id ? 'Continue' : 'Open'}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
