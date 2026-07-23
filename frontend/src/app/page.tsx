'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ClipboardList, FileText, Loader2 } from 'lucide-react';
import { api } from '@/lib/api';

type HubStats = {
  interviews: number;
  moms: number;
  loading: boolean;
};

export default function HubPage() {
  const [stats, setStats] = useState<HubStats>({ interviews: 0, moms: 0, loading: true });

  useEffect(() => {
    let mounted = true;

    async function loadStats() {
      try {
        const [interviewsResult, momsResult] = await Promise.allSettled([
          api.getInterviews(),
          api.getMoms(),
        ]);

        if (!mounted) return;
        setStats({
          interviews: interviewsResult.status === 'fulfilled' ? interviewsResult.value.count : 0,
          moms: momsResult.status === 'fulfilled' ? momsResult.value.count : 0,
          loading: false,
        });
      } catch {
        if (mounted) setStats(prev => ({ ...prev, loading: false }));
      }
    }

    loadStats();
    return () => {
      mounted = false;
    };
  }, []);

  const apps = useMemo(() => [
    {
      title: 'Interview Evaluator',
      description: 'Paste an interview transcript and a job description. Get a scored report with evidence for each competency.',
      proof: 'Output: Score / Strengths / Red flags / PDF',
      href: '/interviews',
      icon: ClipboardList,
      statLabel: 'Evaluations',
      stat: stats.interviews,
    },
    {
      title: 'MOM Analyzer',
      description: 'Upload your meeting recording transcript. Get decisions, risks, and action items with owners - ready to share.',
      proof: 'Output: Decisions / Actions / Risks / PDF',
      href: '/mom',
      icon: FileText,
      statLabel: 'MOMs',
      stat: stats.moms,
    },
  ], [stats.interviews, stats.moms]);

  return (
    <div className="hub-stage min-h-[calc(100vh-7rem)] rounded-2xl p-[clamp(22px,3.2vw,42px)]">
      <div className="relative z-10 flex w-full max-w-7xl flex-col gap-10">
        <header className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-8 flex items-center gap-3">
              <img src="/minfy-ai-logo.png" alt="" className="h-12 w-12 rounded-xl object-contain shadow-sm" />
              <div>
                <p className="text-lg font-semibold tracking-tight text-text-primary">Minfy MiMo AI Hub</p>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent">Internal tools</p>
              </div>
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
              Two tools. One place.
            </p>
            <h1 className="mt-3 max-w-3xl text-[clamp(38px,6vw,76px)] font-semibold leading-[0.96] tracking-tight text-text-primary">
              Your meetings and interviews,
              <span className="block text-accent">actually documented.</span>
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Upload a transcript. Get a proper report. No copying, no formatting, no chasing people for notes.
            </p>
          </div>
          {stats.loading && (
            <div className="hub-status-pill flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={14} className="animate-spin" />
              Loading workspace stats
            </div>
          )}
        </header>

        <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {apps.map((app, index) => {
            const Icon = app.icon;
            return (
              <Link
                key={app.title}
                href={app.href}
                className="hub-workspace-card group"
              >
                <div className="flex h-full flex-col justify-between gap-6">
                  <div>
                    <div className="flex items-center gap-4">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
                      0{index + 1}
                    </span>
                    <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <Icon size={22} />
                    </div>
                  </div>

                    <div className="mt-6 space-y-3">
                      <h2 className="text-xl font-semibold text-text-primary">{app.title}</h2>
                      <p className="max-w-xl text-sm leading-6 text-text-secondary">{app.description}</p>
                      <code className="inline-flex max-w-full rounded-full border border-border bg-surface px-3 py-1 text-[11px] font-semibold leading-5 text-text-secondary">
                        {app.proof}
                      </code>
                    </div>
                  </div>

                  <div className="flex items-end justify-between gap-4 border-t border-border pt-5">
                    <div>
                      <p className="text-2xl font-semibold leading-none text-text-primary">{app.stat}</p>
                      <p className="mt-1 text-xs uppercase tracking-wide text-text-muted">{app.statLabel}</p>
                    </div>
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg border border-border text-text-muted transition-colors group-hover:border-accent/40 group-hover:text-accent">
                      <ArrowRight size={17} className="transition-transform group-hover:translate-x-0.5" />
                    </span>
                  </div>
                </div>
              </Link>
            );
          })}
        </section>
      </div>
    </div>
  );
}
