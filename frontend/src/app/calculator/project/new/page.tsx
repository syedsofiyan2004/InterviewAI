'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, FolderKanban, Loader2 } from 'lucide-react';
import { calculatorApi } from '@/lib/calculatorApi';

/**
 * Create an estimate project.
 *
 * Deliberately a near-copy of /mom/new: the two apps sit beside each other in the same
 * hub, and a project folder that behaves differently in one of them is a worse outcome
 * than a page that looks familiar.
 *
 * Its own route rather than /calculator/new, which is the estimate form and is linked
 * from the sidebar — "New Estimate" there must keep opening the estimate form.
 */
export default function NewCalculationProjectPage() {
  const router = useRouter();
  const [projectTitle, setProjectTitle] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    const safeTitle = projectTitle.trim();
    if (!safeTitle) {
      setError('Please enter a project name.');
      return;
    }

    setLoading(true);
    try {
      // Returns the existing project when the name is already taken, so a double submit
      // lands on the same folder instead of creating a second one.
      const project = await calculatorApi.createCalculationProject(safeTitle);
      router.push(`/calculator/project?id=${encodeURIComponent(project.project_id)}`);
    } catch (err: any) {
      setError(err.message || 'Failed to create the project');
      setLoading(false);
    }
  };

  return (
    <div className="space-y-8">
      <Link
        href="/calculator"
        className="flex items-center gap-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary"
      >
        <ArrowLeft size={16} />
        Back to projects
      </Link>

      <div className="space-y-2">
        <p className="page-kicker">AWS Cost Calculator</p>
        <h1 className="text-2xl font-semibold text-text-primary">New project</h1>
        <p className="text-sm leading-6 text-text-secondary">
          Create a project first. Every estimate you build for this engagement stays grouped
          inside it.
        </p>
      </div>

      {error && (
        <div
          className="card border-danger/30 bg-danger/5 p-4 text-sm font-semibold text-danger"
          role="alert"
          aria-live="assertive"
        >
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="card space-y-6 p-8">
        <div className="border-b border-border pb-5">
          <h2 className="text-lg font-semibold text-text-primary">Project details</h2>
          <p className="mt-1 text-sm leading-6 text-text-secondary">
            Use the client or engagement name your delivery team will recognise when comparing
            estimates later.
          </p>
        </div>

        {/* Guidance beside the control rather than under it, so the card uses its width
            instead of leaving one wide input next to nothing. Same layout as /mom/new. */}
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start">
          <div>
            <label htmlFor="project-title" className="mb-2 block text-xs font-semibold text-text-muted">
              Project Name
            </label>
            <p id="project-title-help" className="text-xs leading-5 text-text-muted">
              Estimates created inside this folder stay grouped under this project, including
              every revision the assistant re-prices for you.
            </p>
          </div>
          <input
            id="project-title"
            required
            maxLength={120}
            className="premium-input w-full px-4 text-sm"
            value={projectTitle}
            onChange={(event) => setProjectTitle(event.target.value)}
            placeholder="e.g. Rainbow Migration"
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
