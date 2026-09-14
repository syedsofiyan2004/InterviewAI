'use client';

import { useEffect, useState } from 'react';
import { FileCheck, Loader2, Save, Upload } from 'lucide-react';
import { api, type SowPeerReviewContextDocument } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';

function AdminSowPeerReview() {
  const [instructions, setInstructions] = useState('');
  const [mapInstructions, setMapInstructions] = useState('');
  const [documents, setDocuments] = useState<SowPeerReviewContextDocument[]>([]);
  const [busy, setBusy] = useState<'load' | 'save' | 'upload' | null>('load');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try { const result = await api.getAdminSowPeerReview(); setInstructions(result.instructions); setMapInstructions(result.map_instructions || ''); setDocuments(result.documents); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not load SOW Peer Review configuration.'); }
    finally { setBusy(null); }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setBusy('save'); setMessage(null); setError(null);
    try { await api.updateAdminSowPeerReview(instructions, mapInstructions); setMessage('SOW Peer Review skill and MAP instructions saved.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not save instructions.'); }
    finally { setBusy(null); }
  };

  const upload = async (file: File) => {
    setBusy('upload'); setMessage(null); setError(null);
    try { await api.uploadSowPeerReviewFile(file, true); const result = await api.getAdminSowPeerReview(); setDocuments(result.documents); setMessage('Reference document added to the review context.'); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not add the reference document.'); }
    finally { setBusy(null); }
  };

  if (busy === 'load') return <div className="card p-8 text-sm text-text-muted">Loading SOW Peer Review configuration...</div>;
  return <div className="space-y-6 pb-8">
    <div className="card p-5 md:p-6"><p className="page-kicker">Owner configuration</p><div className="mt-2 flex items-start gap-3"><span className="rounded-xl bg-accent/10 p-2.5 text-accent"><FileCheck size={21} /></span><div><h1 className="text-xl font-semibold text-text-primary md:text-2xl">SOW Peer Review Context</h1><p className="mt-2 max-w-3xl text-sm leading-6 text-text-secondary">Edit the review rubric and add approved PDF or DOCX reference material. These context documents are supplied to future SOW reviews.</p></div></div></div>
    {error && <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>}{message && <div className="rounded-xl border border-success/25 bg-success/10 p-4 text-sm text-success">{message}</div>}
    <section className="card p-5 md:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-text-primary">SOW Peer Review skill</h2><p className="mt-1 text-sm text-text-muted">The complete administrator-managed skill, initially loaded from docs/sow-peer-review.md. Changes apply to future reviews.</p></div><button type="button" onClick={() => void save()} disabled={busy !== null || !instructions.trim()} className="btn-primary inline-flex items-center gap-2 px-4 py-2.5 text-sm disabled:opacity-50">{busy === 'save' ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />} Save skill</button></div><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={28} spellCheck={false} className="premium-input mt-5 w-full resize-y p-4 font-mono text-sm leading-6" /></section>
    <section className="card p-5 md:p-6"><div><h2 className="font-semibold text-text-primary">MAP/TCO Eligibility skill</h2><p className="mt-1 text-sm text-text-muted">The complete administrator-managed skill, initially loaded from docs/map-tco-eligibility/SKILL.md. Changes apply to future Calculator MAP analyses and SOW funding checks.</p></div><textarea value={mapInstructions} onChange={(event) => setMapInstructions(event.target.value)} rows={28} spellCheck={false} className="premium-input mt-5 w-full resize-y p-4 font-mono text-sm leading-6" /><p className="mt-3 text-xs leading-5 text-text-muted">Funding percentages and included-service references remain enforced. Greenfield, VMware, modernization, and VM inputs are never inferred.</p></section>
    <section className="card p-5 md:p-6"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold text-text-primary">Approved reference context</h2><p className="mt-1 text-sm text-text-muted">Upload templates, standards, checklists, and other material the reviewer should consult.</p></div><label className="btn-secondary inline-flex cursor-pointer items-center gap-2 px-4 py-2.5 text-sm"><Upload size={16} /> {busy === 'upload' ? 'Uploading...' : 'Add PDF or DOCX'}<input type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" className="sr-only" disabled={busy !== null} onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); event.currentTarget.value = ''; }} /></label></div><div className="mt-5 space-y-2">{documents.length ? documents.map((document) => <div key={document.document_id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface-elevated px-4 py-3"><span className="truncate text-sm text-text-primary">{document.file_name}</span><span className="shrink-0 text-xs text-text-muted">{document.character_count.toLocaleString()} chars</span></div>) : <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-text-muted">No additional reference documents yet.</p>}</div></section>
  </div>;
}

export default function AdminSowPeerReviewPage() { return <TierGuard minTier="OWNER"><AdminSowPeerReview /></TierGuard>; }
