'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FileText, Loader2, Upload } from 'lucide-react';
import { api } from '@/lib/api';

type InputMode = 'file' | 'text';

export default function NewMomPage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [mode, setMode] = useState<InputMode>('file');
  const [file, setFile] = useState<File | null>(null);
  const [transcriptText, setTranscriptText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const safeTitle = title.trim();
    if (!safeTitle) {
      setError('Please enter a meeting title.');
      return;
    }

    const uploadFile = mode === 'file'
      ? file
      : new File([new Blob([transcriptText.trim()], { type: 'text/plain' })], 'transcript.txt', { type: 'text/plain' });

    if (!uploadFile || uploadFile.size === 0) {
      setError('Please provide a transcript before starting analysis.');
      return;
    }

    setLoading(true);
    try {
      const { mom_id } = await api.createMom({ title: safeTitle, source_type: mode });
      const contentType = uploadFile.type || 'text/plain';
      const { upload_url, s3_key } = await api.getMomUploadUrl(mom_id, uploadFile.name, contentType);

      const uploadRes = await fetch(upload_url, {
        method: 'PUT',
        body: uploadFile,
        headers: { 'Content-Type': contentType },
      });
      if (!uploadRes.ok) throw new Error('Transcript upload failed');

      await api.confirmMomUpload(mom_id, s3_key);
      await api.analyzeMom(mom_id);
      router.push(`/mom/view?id=${mom_id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create MOM');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-8">
      <Link href="/mom" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium">
        <ArrowLeft size={16} />
        Back to MOMs
      </Link>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase">MOM Analyzer</p>
        <h1 className="text-3xl font-bold text-text-primary tracking-tight">New MOM</h1>
        <p className="text-text-secondary">Upload or paste a meeting transcript and generate structured minutes.</p>
      </div>

      <div className="rounded-xl border border-accent/20 bg-accent/5 p-4">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">Analysis model</p>
        <p className="mt-1 text-sm font-semibold text-text-primary">Claude Sonnet 4.6</p>
        <p className="mt-1 text-xs leading-5 text-text-secondary">
          Optimized for long meeting transcripts, decisions, risks, and action-item extraction.
        </p>
      </div>

      {error && (
        <div className="card p-4 border-danger/30 bg-danger/5 text-danger font-bold text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="card p-8 space-y-6">
        <div>
          <label className="block text-xs font-semibold text-text-muted mb-2">Meeting Title</label>
          <input
            required
            className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Q2 Delivery Planning"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-text-muted mb-2">Transcript Source</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`p-4 rounded-lg border text-left transition-all ${mode === 'file' ? 'border-accent bg-accent/5' : 'border-border bg-surface'}`}
            >
              <Upload size={18} className="text-accent mb-3" />
              <p className="text-sm font-semibold text-text-primary">Upload File</p>
              <p className="text-xs text-text-muted mt-1">PDF, DOCX, or TXT</p>
            </button>
            <button
              type="button"
              onClick={() => setMode('text')}
              className={`p-4 rounded-lg border text-left transition-all ${mode === 'text' ? 'border-accent bg-accent/5' : 'border-border bg-surface'}`}
            >
              <FileText size={18} className="text-accent mb-3" />
              <p className="text-sm font-semibold text-text-primary">Paste Text</p>
              <p className="text-xs text-text-muted mt-1">Plain transcript text</p>
            </button>
          </div>
        </div>

        {mode === 'file' ? (
          <div>
            <label className="block text-xs font-semibold text-text-muted mb-2">Transcript File</label>
            <input
              required
              type="file"
              accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="w-full text-sm text-text-secondary file:mr-4 file:rounded-md file:border-0 file:bg-accent file:px-4 file:py-2 file:text-sm file:font-semibold file:text-white"
            />
          </div>
        ) : (
          <div>
            <label className="block text-xs font-semibold text-text-muted mb-2">Transcript Text</label>
            <textarea
              required
              value={transcriptText}
              onChange={(event) => setTranscriptText(event.target.value)}
              rows={12}
              className="w-full bg-surface border border-border rounded-md px-4 py-3 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
              placeholder="Paste meeting transcript here..."
            />
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 bg-accent text-accent-foreground font-semibold rounded-md hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <FileText size={18} />}
          {loading ? 'Preparing MOM...' : 'Generate MOM'}
        </button>
      </form>
    </div>
  );
}
