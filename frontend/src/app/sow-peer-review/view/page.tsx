'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { AlertTriangle, CheckCircle2, Clock, Download, FileText, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { api, type SowPeerReviewFinding, type SowPeerReviewReport } from '@/lib/api';
import { BackButton } from '@/components/ui/BackButton';
import { StatusBadge } from '@/components/ui/StatusBadge';

type FindingGroup = 'blockers' | 'majors' | 'openQuestions' | 'minors';
const groups: Array<{ key: FindingGroup; title: string; tone: string }> = [
  { key: 'blockers', title: 'Blockers', tone: 'border-danger/25 bg-danger/5' },
  { key: 'majors', title: 'Major findings', tone: 'border-warning/25 bg-warning/5' },
  { key: 'openQuestions', title: 'Open questions', tone: 'border-info/25 bg-info/5' },
  { key: 'minors', title: 'Minor findings', tone: 'border-border bg-surface' },
];

export default function SowPeerReviewViewPage() {
  const id = useSearchParams().get('id') || '';
  const [status, setStatus] = useState('QUEUED');
  const [fileName, setFileName] = useState('SOW Peer Review');
  const [report, setReport] = useState<SowPeerReviewReport | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [hasCalculatorContext, setHasCalculatorContext] = useState(false);
  const [hasReferenceContext, setHasReferenceContext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadReview = useCallback(async () => {
    if (!id) { setError('The review id is missing.'); setLoading(false); return true; }
    try {
      const result = await api.getSowPeerReviewStatus(id);
      setStatus(result.status); setFileName(result.file_name || 'SOW Peer Review'); setReport(result.report || null); setDownloadUrl(result.download_url || null); setHasCalculatorContext(Boolean(result.has_calculator_context)); setHasReferenceContext(Boolean(result.has_reference_context));
      setError(result.status === 'FAILED' ? result.error_message || 'This review could not be completed.' : null);
      setLoading(false);
      return result.status === 'COMPLETED' || result.status === 'FAILED';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The review could not be loaded.'); setLoading(false); return true;
    }
  }, [id]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let active = true;
    const poll = async () => { const done = await loadReview(); if (active && !done) timer = setTimeout(poll, 3000); };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [loadReview]);

  const totalFindings = useMemo(() => report ? groups.reduce((sum, group) => sum + (report[group.key]?.length || 0), 0) : 0, [report]);

  return <div className="mx-auto max-w-6xl space-y-6 pb-10">
    <div className="pt-2"><BackButton defaultHref="/sow-peer-review" defaultLabel="SOW Peer Review" /></div>
    <header className="card p-5 md:p-7"><div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="page-kicker mb-2">SOW Peer Review Report</p><h1 className="truncate text-xl font-semibold text-text-primary">{fileName}</h1><div className="mt-3"><StatusBadge status={status} /></div></div>{downloadUrl && <a href={downloadUrl} className="btn-primary inline-flex shrink-0 items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold"><Download size={16} /> Download Word report</a>}</div></header>
    {(loading || status === 'QUEUED' || status === 'PROCESSING') && !error && <section className="card p-8 text-center"><Loader2 size={30} className="mx-auto animate-spin text-accent" /><h2 className="mt-4 font-semibold text-text-primary">Reviewing your SOW</h2><p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-text-secondary">Sonnet 5 is checking the uploaded SOW against the review skill{hasCalculatorContext ? ', selected Calculator costs, and MAP context' : ''}{hasReferenceContext ? `${hasCalculatorContext ? ', and' : ', plus'} approved reference documents` : ''}. This page updates automatically and can be revisited from the dashboard.</p><div className="mx-auto mt-5 h-2 max-w-lg overflow-hidden rounded-full bg-surface-elevated"><div className="h-full w-2/3 animate-pulse rounded-full bg-accent" /></div></section>}
    {error && <section className="rounded-xl border border-danger/25 bg-danger/10 p-6"><div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 text-danger" size={20} /><div><h2 className="font-semibold text-text-primary">Review needs to be run again</h2><p className="mt-1 text-sm leading-6 text-danger">{error}</p><a href="/sow-peer-review/new" className="btn-secondary mt-4 inline-flex items-center gap-2 px-3 py-2 text-xs font-semibold"><RefreshCw size={14} /> Start a new review</a></div></div></section>}
    {report && <><section className="grid gap-4 md:grid-cols-[1fr_280px]"><div className="card p-5 md:p-7"><div className="flex items-center gap-2 text-success"><CheckCircle2 size={18} /><p className="text-xs font-semibold uppercase tracking-wide">Executive overview</p></div><p className="mt-4 text-sm leading-7 text-text-secondary">{report.overview}</p></div><div className="metric-card p-6"><p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Total review points</p><p className="mt-4 text-3xl font-semibold text-text-primary">{totalFindings}</p><div className="mt-4 space-y-2 text-xs text-text-secondary"><p className="flex justify-between"><span>Blockers</span><strong className="text-danger">{report.blockers?.length || 0}</strong></p><p className="flex justify-between"><span>Major</span><strong className="text-warning">{report.majors?.length || 0}</strong></p><p className="flex justify-between"><span>Questions</span><strong>{report.openQuestions?.length || 0}</strong></p></div></div></section>{groups.map((group) => <section key={group.key} className={`rounded-xl border p-5 md:p-6 ${group.tone}`}><div className="flex items-center gap-2">{group.key === 'blockers' ? <ShieldAlert size={18} className="text-danger" /> : group.key === 'openQuestions' ? <Clock size={18} className="text-info" /> : <FileText size={18} className="text-accent" />}<h2 className="font-semibold text-text-primary">{group.title}</h2><span className="rounded-full bg-surface-elevated px-2 py-0.5 text-xs text-text-muted">{report[group.key]?.length || 0}</span></div><div className="mt-4 grid gap-3">{report[group.key]?.length ? report[group.key].map((item, index) => <Finding key={`${group.key}-${index}`} item={item} />) : <p className="rounded-lg border border-border/70 bg-surface/70 p-4 text-sm text-text-muted">No findings in this category.</p>}</div></section>)}</>}
  </div>;
}

function Finding({ item }: { item: SowPeerReviewFinding }) {
  return <article className="rounded-lg border border-border bg-surface p-4 md:p-5"><p className="text-xs font-semibold uppercase tracking-wide text-accent">{item.location || 'Document'}</p><p className="mt-2 text-sm font-medium leading-6 text-text-primary">{item.finding || item.question}</p>{item.whyItMatters && <p className="mt-2 text-sm leading-6 text-text-secondary"><span className="font-medium text-text-primary">Why it matters: </span>{item.whyItMatters}</p>}</article>;
}
