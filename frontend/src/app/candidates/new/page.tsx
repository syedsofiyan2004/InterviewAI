'use client';

import Link from 'next/link';
import { ArrowLeft, BrainCircuit, CalendarClock, ClipboardList } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';

export default function NewCandidatePage() {
  const { hasTier } = useAuth();
  return (
    <div className="space-y-5">
      <Link href="/candidates" className="inline-flex items-center gap-2 text-sm font-semibold text-text-muted hover:text-text-primary">
        <ArrowLeft size={16} />
        Back to review workspaces
      </Link>

      <section className="card p-6">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Create review workspace</p>
        <h1 className="mt-2 text-xl font-semibold text-text-primary">Start from an interview record</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
          Review workspaces are created from manual evaluations or Interview Intelligence records so the evidence,
          reports, comments, shares, and decisions stay connected to the actual interview.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          <Link
            href="/interviews/new"
            className="rounded-xl border border-border bg-surface px-4 py-4 transition-colors hover:border-accent/40 hover:bg-surface-interactive"
          >
            <ClipboardList size={20} className="text-accent" />
            <p className="mt-3 text-sm font-semibold text-text-primary">Manual evaluation</p>
            <p className="mt-1 text-xs leading-5 text-text-muted">
              Upload the JD, resume, and transcript yourself, then review the generated report.
            </p>
          </Link>

          {/* Manual Intelligence creation is REVIEWER+ (Part E); a member's own
              rounds arrive from the Keka sync and provision themselves on open. */}
          {hasTier('REVIEWER') ? (
            <Link
              href="/interviews/intelligence/new"
              className="rounded-xl border border-border bg-surface px-4 py-4 transition-colors hover:border-accent/40 hover:bg-surface-interactive"
            >
              <BrainCircuit size={20} className="text-accent" />
              <p className="mt-3 text-sm font-semibold text-text-primary">Interview Intelligence</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                Create a connected interview workspace from Keka and Teams context.
              </p>
            </Link>
          ) : (
            <Link
              href="/my-interviews"
              className="rounded-xl border border-border bg-surface px-4 py-4 transition-colors hover:border-accent/40 hover:bg-surface-interactive"
            >
              <CalendarClock size={20} className="text-accent" />
              <p className="mt-3 text-sm font-semibold text-text-primary">My Interviews</p>
              <p className="mt-1 text-xs leading-5 text-text-muted">
                Open a scheduled round you are on the panel for. The workspace is created for you.
              </p>
            </Link>
          )}
        </div>
      </section>
    </div>
  );
}
