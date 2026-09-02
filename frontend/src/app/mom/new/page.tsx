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
    <div className="space-y-8">
      <Link href="/mom" className="flex items-center gap-2 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium">
        <ArrowLeft size={16} />
        Back to projects
      </Link>

      <div className="space-y-2">
        <p className="page-kicker">MOM Analyzer</p>
        <h1 className="text-2xl font-semibold text-text-primary">New project</h1>
        <p className="text-sm leading-6 text-text-secondary">
          Create a project folder first. You can add multiple meeting transcripts inside it.
        </p>
      </div>

      {error && (
        <div className="card border-danger/30 bg-danger/5 p-4 text-sm font-semibold text-danger" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="card p-8 space-y-6">
        <div className="border-b border-border pb-5">
          <h2 className="text-lg font-semibold text-text-primary">Project details</h2>
          <p className="mt-1 text-sm leading-6 text-text-secondary">Use a project name your delivery team will recognise when searching meeting reports later.</p>
        </div>
        {/* One field on the full page measure: the guidance sits beside the control
            rather than under it, so the card uses its width instead of leaving a
            1100px-wide input next to nothing. */}
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <div>
            <label htmlFor="project-title" className="block text-xs font-semibold text-text-muted mb-2">
              Project Title
            </label>
            <p id="project-title-help" className="text-xs leading-5 text-text-muted">
              Meeting reports added inside this folder will stay grouped under this project.
              Use a name your delivery team will recognise when searching later.
            </p>
          </div>
          <input
            id="project-title"
            required
            className="premium-input w-full px-4 text-sm"
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
            placeholder="e.g. Verbal"
            aria-describedby="project-title-help"
          />
        </div>

        <div className="flex justify-center border-t border-border pt-6">
          <button
            type="submit"
            disabled={loading}
            className="btn-primary flex w-full items-center justify-center gap-2 px-10 py-3 font-semibold disabled:opacity-50 sm:w-auto"
          >
            {loading ? <Loader2 size={18} className="animate-spin" /> : <FolderKanban size={18} />}
            {loading ? 'Creating project...' : 'Create Project'}
          </button>
        </div>
      </form>
    </div>
  );
}
