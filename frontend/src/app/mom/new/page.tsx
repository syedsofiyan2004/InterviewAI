'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FolderKanban, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

export default function NewMomProjectPage() {
  const router = useRouter();
  const [projectTitle, setProjectTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const safeProjectTitle = projectTitle.trim();
    if (!safeProjectTitle) {
      setError('Please enter a project title.');
      return;
    }

    setLoading(true);
    try {
      const project = await api.createMomProject({ project_title: safeProjectTitle });
      router.push(`/mom/project?id=${project.project_id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create project');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <Link href="/mom" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium">
        <ArrowLeft size={16} />
        Back to projects
      </Link>

      <div className="space-y-2">
        <p className="text-[11px] font-semibold tracking-[0.12em] text-accent uppercase">MOM Analyzer</p>
        <h1 className="text-3xl font-bold text-text-primary tracking-tight">New Project</h1>
        <p className="text-text-secondary">
          Create a project folder first. You can add multiple meeting transcripts inside it.
        </p>
      </div>

      {error && (
        <div className="card p-4 border-danger/30 bg-danger/5 text-danger font-bold text-sm">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="card p-8 space-y-6">
        <div>
          <label className="block text-xs font-semibold text-text-muted mb-2">Project Title</label>
          <input
            required
            className="w-full h-11 bg-surface border border-border rounded-md px-4 text-sm focus:ring-2 focus:ring-ring focus:outline-none transition-all"
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
            placeholder="e.g. Verbal"
          />
          <p className="mt-1.5 text-xs text-text-muted">
            Meeting reports added inside this folder will stay grouped under this project.
          </p>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-3 bg-accent text-accent-foreground font-semibold rounded-md hover:opacity-90 transition-opacity flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {loading ? <Loader2 size={18} className="animate-spin" /> : <FolderKanban size={18} />}
          {loading ? 'Creating project...' : 'Create Project'}
        </button>
      </form>
    </div>
  );
}
