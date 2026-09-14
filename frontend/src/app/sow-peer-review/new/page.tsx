'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FileCheck, FileText, FolderKanban, Loader2, Upload } from 'lucide-react';
import { api } from '@/lib/api';
import { calculatorApi, type CalculationProject } from '@/lib/calculatorApi';
import { BackButton } from '@/components/ui/BackButton';

export default function NewSowPeerReviewPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const calculationId = searchParams.get('calculationId') || undefined;
  const [file, setFile] = useState<File | null>(null);
  const [projects, setProjects] = useState<CalculationProject[]>([]);
  const [projectId, setProjectId] = useState(searchParams.get('projectId') || '');
  const [includeReferenceContext, setIncludeReferenceContext] = useState(false);
  const [projectsBusy, setProjectsBusy] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'uploading' | 'queued'>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void calculatorApi.getCalculationProjects().then((response) => { if (active) setProjects(response.items || []); }).catch(() => {}).finally(() => { if (active) setProjectsBusy(false); });
    return () => { active = false; };
  }, []);

  const runReview = async () => {
    if (!file) return;
    setBusy(true); setError(null); setPhase('uploading');
    try {
      const uploaded = await api.uploadSowPeerReviewFile(file);
      setPhase('queued');
      const queued = await api.reviewSowPeerReview(uploaded.s3_key, uploaded.file_name, projectId ? undefined : calculationId, projectId || undefined, includeReferenceContext);
      if (!queued.job_id) throw new Error('The SOW review job could not be started.');
      router.push(`/sow-peer-review/view?id=${encodeURIComponent(queued.job_id)}`);
    } catch (err) {
      setPhase('idle');
      setError(err instanceof Error ? err.message : 'The SOW could not be submitted for review.');
      setBusy(false);
    }
  };

  return <div className="mx-auto max-w-4xl space-y-6 pb-10">
    <div className="pt-2"><BackButton defaultHref="/sow-peer-review" defaultLabel="SOW Peer Review" /></div>
    <header><p className="page-kicker mb-1">Pre-Sales Tools</p><h1 className="text-2xl font-semibold text-text-primary">New SOW review</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">Upload the client document and optionally connect a Calculator project. The review runs independently in the background.</p></header>
    <section className="card p-5 md:p-7"><div className="flex items-start gap-3"><span className="rounded-xl bg-accent/10 p-2.5 text-accent"><FolderKanban size={20} /></span><div className="min-w-0 flex-1"><h2 className="font-semibold text-text-primary">Optional context</h2><p className="mt-1 text-sm leading-6 text-text-secondary">The default review uses only the uploaded SOW and the editable review skill for a faster, focused analysis.</p><select value={projectId} onChange={(event) => setProjectId(event.target.value)} disabled={projectsBusy || busy} className="mt-4 w-full rounded-lg border border-border bg-surface-elevated px-3 py-2.5 text-sm text-text-primary"><option value="">No Calculator context</option>{projects.filter((project) => project.project_id).map((project) => <option key={project.project_id} value={project.project_id!}>{project.project_title} · {project.estimate_count} estimate{project.estimate_count === 1 ? '' : 's'}</option>)}</select><label className="mt-4 flex cursor-pointer items-start gap-3 text-sm text-text-secondary"><input type="checkbox" checked={includeReferenceContext} onChange={(event) => setIncludeReferenceContext(event.target.checked)} disabled={busy} className="mt-0.5 h-4 w-4 accent-accent" /><span><span className="font-medium text-text-primary">Include approved reference documents</span><span className="mt-1 block text-xs leading-5 text-text-muted">Optional templates and standards curated by an administrator. This may increase review time.</span></span></label></div></div></section>
    <section className="card p-5 md:p-7"><div className="mb-5 flex items-start gap-3"><span className="rounded-xl bg-accent/10 p-2.5 text-accent"><FileCheck size={20} /></span><div><h2 className="font-semibold text-text-primary">SOW document</h2><p className="mt-1 text-sm text-text-secondary">PDF or DOCX files are supported.</p></div></div><label htmlFor="sow-file" className="upload-zone flex cursor-pointer flex-col items-center justify-center gap-3 p-10 text-center"><Upload size={26} className="text-accent" /><span className="text-sm font-semibold text-text-primary">{file ? file.name : 'Choose a SOW or proposal'}</span><span className="text-xs text-text-muted">The original is used only as review input</span><input id="sow-file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" disabled={busy} className="sr-only" onChange={(event) => setFile(event.target.files?.[0] || null)} /></label>{error && <div className="mt-4 rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>}<div className="mt-5 flex flex-wrap items-center justify-between gap-3"><p className="flex items-center gap-2 text-xs text-text-muted"><FileText size={14} /> A formatted Word report will be created.</p><button type="button" onClick={() => void runReview()} disabled={!file || busy} className="btn-primary inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold disabled:opacity-50">{busy ? <Loader2 size={16} className="animate-spin" /> : <FileCheck size={16} />}{busy ? (phase === 'uploading' ? 'Uploading...' : 'Opening review...') : 'Start review'}</button></div></section>
  </div>;
}
