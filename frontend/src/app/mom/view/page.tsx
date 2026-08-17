'use client';

import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { AlertCircle, CheckCircle2, Clock, Download, Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import { api, DetailedMom, MomResult } from '@/lib/api';
import { BackButton } from '@/components/ui/BackButton';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { LiveProgressBanner } from '@/components/ui/LiveProgressBanner';

type MomDetailView = 'summary' | 'discussion' | 'actions' | 'report';

function MomViewContent() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id') || '';
  const [mom, setMom] = useState<DetailedMom | null>(null);
  const [result, setResult] = useState<MomResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<MomDetailView>('summary');

  const fetchMom = useCallback(async () => {
    if (!id) {
      setError('Missing MOM id');
      setLoading(false);
      return true;
    }

    try {
      const data = await api.getMom(id);
      setMom(data);

      if (data.status === 'COMPLETED') {
        const momResult = await api.getMomResult(id);
        setResult(momResult);
        setLoading(false);
        return true;
      }

      if (data.status === 'FAILED') {
        setLoading(false);
        return true;
      }

      setLoading(false);
      return false;
    } catch (err: any) {
      setError(err.message || 'Failed to load MOM');
      setLoading(false);
      return true;
    }
  }, [id]);

  useEffect(() => {
    let timer: NodeJS.Timeout;

    async function poll() {
      const done = await fetchMom();
      if (!done) timer = setTimeout(poll, 3000);
    }

    poll();
    return () => clearTimeout(timer);
  }, [fetchMom]);

  const discussionTopics = useMemo(() => {
    if (!result) return [];
    if (result.discussion_points && result.discussion_points.length > 0) {
      return result.discussion_points;
    }
    return result.key_topics || [];
  }, [result]);

  const allActionItems = useMemo(() => {
    if (!result) return [];
    const directActions = (result.action_items || []).map((a: any) => ({
      task: a.task,
      owner: a.assignee || a.owner || 'Unassigned',
      due_date: a.deadline || a.due_date || null,
      priority: a.priority || null,
      topic: null,
    }));
    const nestedActions = (result.discussion_points || []).flatMap((dp: any) =>
      (dp.action_items || []).map((a: any) => ({
        task: a.task,
        owner: a.owner || a.assignee || 'Unassigned',
        due_date: a.due_date || a.deadline || null,
        priority: a.priority || null,
        topic: dp.topic || null,
      }))
    );
    return [...directActions, ...nestedActions];
  }, [result]);

  const meetingDateDisplay = useMemo(() => {
    if (mom?.meeting_date_sort) return format(new Date(mom.meeting_date_sort), 'dd-MM-yyyy');
    const raw = result?.date || mom?.meeting_date;
    if (raw && raw !== 'Not specified') {
      const parsed = new Date(raw);
      if (!isNaN(parsed.getTime())) return format(parsed, 'dd-MM-yyyy');
      return raw;
    }
    return null;
  }, [mom?.meeting_date_sort, mom?.meeting_date, result?.date]);

  if (loading && !mom) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <Loader2 className="animate-spin text-accent" size={40} />
        <p className="text-text-secondary">Loading MOM...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-xl mx-auto mt-20 card p-8 text-center space-y-6">
        <AlertCircle size={32} className="mx-auto text-danger" />
        <h3 className="text-xl font-semibold text-text-primary">Failed to load</h3>
        <p className="text-text-secondary">{error}</p>
        <Link href="/mom" className="inline-block px-6 py-2 bg-accent text-accent-foreground font-semibold rounded-md">
          Back to MOMs
        </Link>
      </div>
    );
  }

  const inProgress = mom?.status === 'PROCESSING' || mom?.status === 'CREATED';
  const handleDownloadReport = async () => {
    if (!result || !id) return;

    setDownloading(true);
    try {
      const { download_url } = await api.getMomReportUrl(id);
      window.location.href = download_url;
    } catch (err: any) {
      setError(err.message || 'Failed to download MOM report');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-8 pb-8">
      <div className="flex items-center justify-between">
        <BackButton defaultHref="/mom" defaultLabel="Meetings" />
        <StatusBadge status={mom?.status || 'CREATED'} variant="pill" />
      </div>

      <header className="space-y-2">
        <p className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase">MOM Report</p>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <p className="text-sm font-semibold text-accent">{mom?.project_title || 'General'}</p>
            <h1 className="text-3xl font-bold text-text-primary tracking-tight">{result?.title || mom?.title || 'Untitled meeting'}</h1>
            <p className="text-xs text-text-muted mt-2">Generated by Minfy AI MOM Analyzer</p>
          </div>
          {result && (
            <button
              onClick={handleDownloadReport}
              disabled={downloading}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
            >
              {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
              {downloading ? 'Preparing PDF' : 'Download PDF'}
            </button>
          )}
        </div>
        {meetingDateDisplay && <p className="text-sm text-text-muted">{meetingDateDisplay}</p>}
      </header>

      {inProgress && (
        <LiveProgressBanner
          taskType="mom"
          title="Generating MOM Meeting Report"
          subtitle="Extracting discussion topics, decisions, and action items from meeting transcript..."
          startTime={mom?.analysis_started_at}
          progressMessage={mom?.progress_message}
          progressStage={mom?.progress_stage}
          progressEvents={mom?.progress_events}
        />
      )}

      {mom?.status === 'FAILED' && (
        <div className="card p-6 border-danger/30 bg-danger/5">
          <div className="flex gap-3">
            <AlertCircle className="text-danger shrink-0" size={22} />
            <div>
              <h2 className="text-sm font-semibold text-danger">MOM analysis failed</h2>
              <p className="text-sm text-text-secondary mt-1">{mom.error?.message || 'Please try uploading the transcript again.'}</p>
            </div>
          </div>
        </div>
      )}

      {result && (
        <>
          <MomDetailTabs activeView={activeView} onChange={setActiveView} />
          <div className="space-y-6">
            <div className={activeView === 'summary' ? 'space-y-6' : 'hidden'} role="tabpanel">
              <section className="card p-6 space-y-4">
                <div className="flex items-center gap-2">
                  <CheckCircle2 size={18} className="text-success" />
                  <h2 className="text-lg font-semibold text-text-primary">Overall Summary</h2>
                </div>
                <p className="text-sm leading-7 text-text-secondary whitespace-pre-line">{result.overall_summary}</p>
              </section>

              {result.attendees && result.attendees.length > 0 && (
                <section className="card p-6 space-y-4">
                  <h2 className="text-lg font-semibold text-text-primary">Attendees</h2>
                  <div className="flex flex-wrap gap-2">
                    {result.attendees.map((attendee) => (
                      <span key={`${attendee.name}-${attendee.role || ''}`} className="px-2.5 py-1 rounded-full bg-accent/10 text-accent text-xs font-semibold">
                        {attendee.role ? `${attendee.name} · ${attendee.role}` : attendee.name}
                      </span>
                    ))}
                  </div>
                </section>
              )}
            </div>

            <div className={activeView === 'discussion' ? 'space-y-6' : 'hidden'} role="tabpanel">
              <section className="card p-6 space-y-4">
                <h2 className="text-lg font-semibold text-text-primary">Key Discussion Topics</h2>
                {discussionTopics.length === 0 ? (
                  <p className="text-xs text-text-muted">No key discussion topics recorded for this meeting.</p>
                ) : (
                  <div className="space-y-4">
                    {discussionTopics.map((topic: any, index: number) => (
                      <div key={index} className="p-4 rounded-lg bg-surface space-y-2 border border-border/40">
                        <div className="flex items-center justify-between">
                          <h3 className="text-sm font-semibold text-text-primary">{topic.topic}</h3>
                          {topic.raised_by && (
                            <span className="text-[11px] font-medium text-accent bg-accent/10 px-2 py-0.5 rounded">
                              Raised by: {topic.raised_by}
                            </span>
                          )}
                        </div>
                        <p className="text-xs leading-6 text-text-secondary whitespace-pre-line">{topic.summary}</p>
                        {topic.key_takeaway && (
                          <p className="text-xs font-medium text-accent mt-1">Key Takeaway: {topic.key_takeaway}</p>
                        )}
                        {topic.decisions && topic.decisions.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-border/30 space-y-1">
                            <p className="text-[11px] font-semibold text-text-primary uppercase tracking-wide">Decisions Made:</p>
                            {topic.decisions.map((d: any, di: number) => (
                              <p key={di} className="text-xs text-text-secondary">• {d.decision || d}</p>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <div className={activeView === 'actions' ? 'space-y-6' : 'hidden'} role="tabpanel">
              <section className="card p-6 space-y-4">
                <h2 className="text-lg font-semibold text-text-primary">Action Items</h2>
                {allActionItems.length === 0 ? (
                  <p className="text-xs text-text-muted">No action items recorded for this meeting.</p>
                ) : (
                  <div className="space-y-3">
                    {allActionItems.map((action, index) => (
                      <div key={index} className="flex items-start justify-between p-4 rounded-lg bg-surface border border-border/40 gap-4">
                        <div className="space-y-1 min-w-0 flex-1">
                          <p className="text-sm font-medium text-text-primary">{action.task}</p>
                          <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                            {action.owner && <span>Owner: <strong className="text-text-secondary">{action.owner}</strong></span>}
                            {action.topic && <span className="truncate max-w-xs">• {action.topic}</span>}
                          </div>
                        </div>
                        <div className="flex flex-col items-end gap-1 shrink-0">
                          {action.due_date && (
                            <span className="px-2 py-1 rounded bg-surface-elevated text-[11px] font-semibold text-text-secondary border border-border">
                              Due: {action.due_date}
                            </span>
                          )}
                          {action.priority && (
                            <span className={`text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded ${
                              action.priority === 'High' ? 'bg-danger/10 text-danger' : 'bg-accent/10 text-accent'
                            }`}>
                              {action.priority} Priority
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>

            <div className={activeView === 'report' ? 'space-y-6' : 'hidden'} role="tabpanel">
              <section className="card p-6 space-y-4 text-center">
                <h2 className="text-lg font-semibold text-text-primary">Export Report</h2>
                <p className="text-sm text-text-secondary max-w-md mx-auto">Download a PDF version of this Minutes of Meeting report.</p>
                <button
                  onClick={handleDownloadReport}
                  disabled={downloading}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-accent text-white font-semibold text-sm hover:opacity-90 transition-opacity"
                >
                  {downloading ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />}
                  {downloading ? 'Preparing PDF...' : 'Download PDF Report'}
                </button>
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function MomDetailTabs({ activeView, onChange }: { activeView: MomDetailView; onChange: (view: MomDetailView) => void }) {
  const tabs: { id: MomDetailView; label: string }[] = [
    { id: 'summary', label: 'Summary' },
    { id: 'discussion', label: 'Discussion Topics' },
    { id: 'actions', label: 'Action Items' },
    { id: 'report', label: 'PDF Export' },
  ];

  return (
    <div className="flex border-b border-border space-x-1" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={activeView === tab.id}
          onClick={() => onChange(tab.id)}
          className={`px-4 py-2.5 text-xs font-semibold border-b-2 transition-colors ${
            activeView === tab.id
              ? 'border-accent text-accent'
              : 'border-transparent text-text-muted hover:text-text-primary'
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}

export default function MomViewPage() {
  return (
    <Suspense fallback={<div className="p-8 text-center text-text-muted">Loading MOM...</div>}>
      <MomViewContent />
    </Suspense>
  );
}
