'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AlertCircle, ArrowLeft, FileText, FolderUp, Loader2, Plus, Upload } from 'lucide-react';
import { format } from 'date-fns';
import { api, Mom } from '@/lib/api';
import { StatusBadge } from '@/components/ui/StatusBadge';

type InputMode = 'file' | 'text';

function MomProjectContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const projectId = searchParams.get('id');
  const projectTitleParam = searchParams.get('title');

  const [projectTitle, setProjectTitle] = useState(projectTitleParam || 'Project');
  const [moms, setMoms] = useState<Mom[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [meetingTitle, setMeetingTitle] = useState('');
  const [mode, setMode] = useState<InputMode>('file');
  const [file, setFile] = useState<File | null>(null);
  const [transcriptText, setTranscriptText] = useState('');
  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  const [bulkUploading, setBulkUploading] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ total: number; completed: number; failed: number } | null>(null);
  const bulkFileInputRef = useRef<HTMLInputElement>(null);
  const bulkFolderInputRef = useRef<HTMLInputElement>(null);

  const loadProject = useCallback(async (showLoading = true) => {
    try {
      if (showLoading) setLoading(true);
      const [momData, projectData] = await Promise.all([
        api.getMoms(),
        projectId ? api.getMomProject(projectId) : Promise.resolve(null),
      ]);

      const title = projectData?.project_title || projectTitleParam || 'General';
      setProjectTitle(title);
      setMoms(
        momData.items
          .filter((mom) => projectId ? mom.project_id === projectId : (mom.project_title || 'General') === title)
          .sort((a, b) => getMomSortDate(b) - getMomSortDate(a))
      );
    } catch (err: any) {
      setError(err.message || 'Failed to load project');
    } finally {
      setLoading(false);
    }
  }, [projectId, projectTitleParam]);

  useEffect(() => {
    loadProject();
  }, [loadProject]);

  useEffect(() => {
    const hasActiveJobs = moms.some((mom) => mom.status === 'CREATED' || mom.status === 'PROCESSING');
    if (!hasActiveJobs) return;

    const timer = window.setInterval(() => {
      loadProject(false);
    }, 5000);

    return () => window.clearInterval(timer);
  }, [loadProject, moms]);

  const stats = useMemo(() => ({
    total: moms.length,
    completed: moms.filter((mom) => mom.status === 'COMPLETED').length,
    processing: moms.filter((mom) => mom.status !== 'COMPLETED' && mom.status !== 'FAILED').length,
  }), [moms]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const safeTitle = meetingTitle.trim();
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

    setCreating(true);
    try {
      const { mom_id } = await api.createMom({
        title: safeTitle,
        project_id: projectId || undefined,
        project_title: projectId ? undefined : projectTitle,
        source_type: mode,
        source_file_name: uploadFile.name,
        source_last_modified: uploadFile.lastModified || Date.now(),
      });
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
      setCreating(false);
    }
  };

  const handleBulkFileSelect = (selected: FileList | null) => {
    setError(null);
    setBulkProgress(null);

    const files = Array.from(selected || []).filter((candidate) => {
      const extension = candidate.name.split('.').pop()?.toLowerCase();
      return !!extension && ['pdf', 'docx', 'txt'].includes(extension);
    });

    if (files.length > 20) {
      setBulkFiles(files.slice(0, 20));
      setError('Only the first 20 supported transcript files were selected. The limit is 20 files per bulk upload.');
      return;
    }

    setBulkFiles(files);
  };

  const uploadOneBulkFile = async (uploadFile: File) => {
    const { mom_id } = await api.createMom({
      title: inferMeetingTitle(uploadFile.name),
      project_id: projectId || undefined,
      project_title: projectId ? undefined : projectTitle,
      source_type: 'file',
      source_file_name: uploadFile.name,
      source_last_modified: uploadFile.lastModified || Date.now(),
    });
    const contentType = uploadFile.type || contentTypeFromFile(uploadFile.name);
    const { upload_url, s3_key } = await api.getMomUploadUrl(mom_id, uploadFile.name, contentType);

    const uploadRes = await fetch(upload_url, {
      method: 'PUT',
      body: uploadFile,
      headers: { 'Content-Type': contentType },
    });
    if (!uploadRes.ok) throw new Error(`Upload failed for ${uploadFile.name}`);

    await api.confirmMomUpload(mom_id, s3_key);
    await api.analyzeMom(mom_id);
  };

  const handleBulkSubmit = async () => {
    setError(null);
    if (bulkFiles.length === 0) {
      setError('Please select transcript files first.');
      return;
    }
    if (bulkFiles.length > 20) {
      setError('Please keep bulk uploads to 20 files or fewer.');
      return;
    }

    setBulkUploading(true);
    setBulkProgress({ total: bulkFiles.length, completed: 0, failed: 0 });

    await Promise.all(bulkFiles.map(async (bulkFile) => {
      try {
        await uploadOneBulkFile(bulkFile);
        setBulkProgress((current) => current ? { ...current, completed: current.completed + 1 } : current);
      } catch (err) {
        console.error('Bulk MOM upload failed', bulkFile.name, err);
        setBulkProgress((current) => current ? { ...current, failed: current.failed + 1 } : current);
      }
    }));

    setBulkUploading(false);
    await loadProject(false);
  };

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={32} />
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-8">
      <Link href="/mom" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium">
        <ArrowLeft size={16} />
        Back to projects
      </Link>

      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase">Project MOMs</p>
          <h1 className="text-3xl font-bold text-text-primary tracking-tight">{projectTitle}</h1>
          <p className="text-sm text-text-muted mt-1">
            {stats.total} meetings / {stats.completed} completed / {stats.processing} in progress
          </p>
        </div>
      </div>

      {error && (
        <div className="card p-4 border-danger/30 bg-danger/5 text-danger font-bold text-sm flex items-center gap-2">
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="card p-6 space-y-5">
        <div className="flex items-center gap-2">
          <Plus size={18} className="text-accent" />
          <h2 className="text-lg font-semibold text-text-primary">Add Meeting Transcript</h2>
        </div>

        <div>
          <label className="block text-xs font-semibold text-text-muted mb-2">Meeting Title</label>
          <input
            required
            className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
            value={meetingTitle}
            onChange={(event) => setMeetingTitle(event.target.value)}
            placeholder="e.g. Weekly Migration Review"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-text-muted mb-2">Transcript Source</label>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setMode('file')}
              className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-all ${mode === 'file' ? 'border-accent bg-accent/5' : 'border-border bg-surface hover:border-accent/40'}`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                <Upload size={17} />
              </span>
              <span>
                <span className="block text-sm font-semibold text-text-primary">Upload File</span>
                <span className="block text-xs text-text-muted mt-0.5">PDF, DOCX, or TXT</span>
              </span>
            </button>
            <button
              type="button"
              onClick={() => setMode('text')}
              className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left transition-all ${mode === 'text' ? 'border-accent bg-accent/5' : 'border-border bg-surface hover:border-accent/40'}`}
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
                <FileText size={17} />
              </span>
              <span>
                <span className="block text-sm font-semibold text-text-primary">Paste Text</span>
                <span className="block text-xs text-text-muted mt-0.5">Plain transcript text</span>
              </span>
            </button>
          </div>
        </div>

        {mode === 'file' ? (
          <div>
            <label className="block text-xs font-semibold text-text-muted mb-2">Transcript File</label>
            <label
              htmlFor="single-mom-file"
              className="flex min-h-12 cursor-pointer items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 transition-colors hover:border-accent/50"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-text-primary">
                  {file?.name || 'Choose transcript file'}
                </span>
                <span className="block text-xs text-text-muted mt-0.5">PDF, DOCX, or TXT</span>
              </span>
              <span className="shrink-0 rounded-md bg-accent/10 px-3 py-1.5 text-xs font-semibold text-accent">
                Browse
              </span>
            </label>
            <input
              id="single-mom-file"
              required
              type="file"
              accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
              onChange={(event) => setFile(event.target.files?.[0] || null)}
              className="hidden"
            />
          </div>
        ) : (
          <div>
            <label className="block text-xs font-semibold text-text-muted mb-2">Transcript Text</label>
            <textarea
              required
              value={transcriptText}
              onChange={(event) => setTranscriptText(event.target.value)}
              rows={8}
              className="w-full bg-surface border border-border rounded-md px-4 py-3 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
              placeholder="Paste meeting transcript here..."
            />
          </div>
        )}

        <button
          type="submit"
          disabled={creating}
          className="w-full py-3 bg-accent text-accent-foreground font-semibold rounded-md hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {creating ? <Loader2 size={18} className="animate-spin" /> : <FileText size={18} />}
          {creating ? 'Preparing MOM...' : 'Generate MOM In This Project'}
        </button>
      </form>

      <section className="card p-6 space-y-5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <FolderUp size={18} className="text-accent" />
            <h2 className="text-lg font-semibold text-text-primary">Bulk Upload</h2>
          </div>
          <span className="rounded-full bg-accent/10 px-3 py-1 text-xs font-semibold text-accent">Max 20 files</span>
        </div>
        <p className="text-sm text-text-secondary">
          Add many meetings to this project at once. Choose individual transcript files or select a project folder.
        </p>

        <div className="rounded-lg border border-border bg-surface p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => bulkFileInputRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface-elevated px-4 py-3 text-sm font-semibold text-text-primary transition-colors hover:border-accent/50 hover:text-accent"
              disabled={bulkUploading}
            >
              <FileText size={16} />
              Select Files
            </button>
            <button
              type="button"
              onClick={() => bulkFolderInputRef.current?.click()}
              className="flex items-center justify-center gap-2 rounded-lg border border-border bg-surface-elevated px-4 py-3 text-sm font-semibold text-text-primary transition-colors hover:border-accent/50 hover:text-accent"
              disabled={bulkUploading}
            >
              <FolderUp size={16} />
              Select Folder
            </button>
          </div>
          <input
            ref={bulkFileInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            onChange={(event) => handleBulkFileSelect(event.target.files)}
            className="hidden"
          />
          <input
            ref={bulkFolderInputRef}
            type="file"
            multiple
            accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
            onChange={(event) => handleBulkFileSelect(event.target.files)}
            className="hidden"
            {...({ webkitdirectory: '', directory: '' } as any)}
          />
          <p className="mt-2 text-xs text-text-muted">
            The app imports supported transcripts only, creates meeting titles from filenames, and keeps the first 20 PDF, DOCX, or TXT files.
          </p>
        </div>

        {bulkFiles.length > 0 && (
          <div className="rounded-lg bg-surface p-4">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-text-primary">{bulkFiles.length} files ready</p>
              <button
                type="button"
                onClick={() => {
                  setBulkFiles([]);
                  setBulkProgress(null);
                }}
                className="text-xs font-semibold text-text-muted hover:text-danger"
                disabled={bulkUploading}
              >
                Clear
              </button>
            </div>
            <div className="mt-3 max-h-36 space-y-2 overflow-y-auto pr-1">
              {bulkFiles.map((selectedFile) => (
                <div key={`${selectedFile.name}-${selectedFile.lastModified}`} className="flex items-center justify-between gap-3 text-xs">
                  <span className="truncate text-text-secondary">{inferMeetingTitle(selectedFile.name)}</span>
                <span className="shrink-0 text-text-muted">{format(new Date(selectedFile.lastModified || Date.now()), 'MMM d, yyyy')}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {bulkProgress && (
          <div className="rounded-lg bg-accent/5 px-4 py-3 text-sm text-text-secondary">
            {bulkUploading ? 'Uploading and queueing reports...' : 'Bulk upload finished.'}
            {' '}
            {bulkProgress.completed} queued / {bulkProgress.failed} failed / {bulkProgress.total} total
          </div>
        )}

        <button
          type="button"
          onClick={handleBulkSubmit}
          disabled={bulkUploading || bulkFiles.length === 0}
          className="w-full py-3 bg-accent text-accent-foreground font-semibold rounded-md hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-45"
        >
          {bulkUploading ? <Loader2 size={18} className="animate-spin" /> : <FolderUp size={18} />}
          {bulkUploading ? 'Queueing files...' : 'Upload Files To This Project'}
        </button>
      </section>

      <div className="rounded-xl overflow-hidden" style={{ border: '1px solid var(--border)', background: 'var(--surface-elevated)' }}>
        <div className="px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
          <h3 className="text-sm font-semibold text-text-primary">Project Reports</h3>
          <p className="text-xs text-text-muted mt-1">All MOM reports created under {projectTitle}.</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
                <th className="px-6 py-3 text-xs font-medium text-text-muted">Title</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted">Source</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-center">Meeting Date</th>
                <th className="px-6 py-3 text-xs font-medium text-text-muted text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              {moms.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-6 py-16 text-center">
                    <p className="text-sm font-semibold text-text-primary">No meeting reports yet</p>
                    <p className="text-xs text-text-muted mt-1">Add the first transcript above.</p>
                  </td>
                </tr>
              ) : moms.map((mom) => (
                <tr key={mom.mom_id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td className="px-6 py-4">
                    <Link href={`/mom/view?id=${mom.mom_id}`} className="text-sm font-semibold text-text-primary hover:text-accent">
                      {mom.title || 'Untitled meeting'}
                    </Link>
                  </td>
                  <td className="px-6 py-4 text-sm text-text-secondary capitalize">{mom.source_type || 'file'}</td>
                  <td className="px-6 py-4 text-sm text-text-secondary text-center">
                    {formatMomMeetingDate(mom)}
                  </td>
                  <td className="px-6 py-4 text-center">
                    <div className="flex justify-center">
                      <StatusBadge status={mom.status || 'CREATED'} />
                    </div>
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

function inferMeetingTitle(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  const withoutDatePrefix = withoutExtension
    .replace(/^\d{4}[-_. ]?\d{1,2}[-_. ]?\d{1,2}[-_. ]*/, '')
    .replace(/^\d{1,2}[-_. ]?\d{1,2}[-_. ]?\d{2,4}[-_. ]*/, '');
  const cleaned = withoutDatePrefix
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned || withoutExtension || 'Untitled meeting';
}

function contentTypeFromFile(fileName: string): string {
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  return 'text/plain';
}

function getMomSortDate(mom: Mom): number {
  return mom.meeting_date_sort || mom.source_last_modified || mom.created_at || 0;
}

function formatMomMeetingDate(mom: Mom): string {
  if (mom.meeting_date_sort) return format(new Date(mom.meeting_date_sort), 'MMM d, yyyy');
  if (mom.meeting_date && mom.meeting_date !== 'Not specified') return mom.meeting_date;
  return mom.status === 'COMPLETED' ? 'Not specified' : 'Pending analysis';
}

export default function MomProjectPage() {
  return (
    <Suspense fallback={<div className="min-h-[60vh] flex items-center justify-center"><Loader2 className="animate-spin text-accent" /></div>}>
      <MomProjectContent />
    </Suspense>
  );
}
