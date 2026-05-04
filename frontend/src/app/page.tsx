'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, ClipboardList, CloudCog, FileText, Loader2, ShieldCheck } from 'lucide-react';
import { api } from '@/lib/api';

type HubStats = {
  interviews: number;
  moms: number;
  loading: boolean;
};

export default function HubPage() {
  const [stats, setStats] = useState<HubStats>({ interviews: 0, moms: 0, loading: true });
  const [pointer, setPointer] = useState({ x: 50, y: 45 });

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
      description: 'Assess interview transcripts against job descriptions with AI scoring, evidence, and PDF reports.',
      href: '/interviews',
      icon: ClipboardList,
      statLabel: 'Evaluations',
      stat: stats.interviews,
    },
    {
      title: 'MOM Analyzer',
      description: 'Convert meeting transcripts into summaries, decisions, risks, next steps, and owner-based action items.',
      href: '/mom',
      icon: FileText,
      statLabel: 'MOMs',
      stat: stats.moms,
    },
    {
      title: 'TF Generator',
      description: 'Parse AWS prerequisite workbooks, validate manifests, and generate reviewable Terraform before deployment.',
      href: '/tf-generator',
      icon: CloudCog,
      statLabel: 'Preview',
      stat: 'Local',
    },
  ], [stats.interviews, stats.moms]);

  return (
    <div
      className="hub-stage min-h-[calc(100vh-7rem)] rounded-2xl p-[clamp(22px,3.2vw,42px)]"
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPointer({
          x: ((event.clientX - rect.left) / rect.width) * 100,
          y: ((event.clientY - rect.top) / rect.height) * 100,
        });
      }}
      style={{ '--mx': `${pointer.x}%`, '--my': `${pointer.y}%` } as React.CSSProperties}
    >
      <div className="hub-grid" />
      <div className="hub-pointer-field" />

      <div className="relative z-10 flex w-full max-w-7xl flex-col gap-8">
        <header className="flex flex-col gap-8 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-3xl">
            <div className="mb-8 flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent text-accent-foreground shadow-lg shadow-accent/20">
                <ShieldCheck size={22} />
              </div>
              <div>
                <p className="text-lg font-semibold tracking-tight text-text-primary">Minfy AI</p>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent">Work clarity suite</p>
              </div>
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-accent">
              Interview intelligence / Meeting clarity
            </p>
            <h1 className="mt-4 max-w-2xl text-[clamp(38px,6vw,76px)] font-semibold leading-[0.96] tracking-tight text-text-primary">
              Conversations,
              <span className="block text-accent">understood.</span>
            </h1>
            <p className="mt-6 max-w-xl text-base leading-7 text-text-secondary">
              Choose a workspace to evaluate interviews, summarize meetings, and turn long discussions into useful reports.
            </p>
          </div>
          {stats.loading && (
            <div className="hub-status-pill flex items-center gap-2 text-xs text-text-secondary">
              <Loader2 size={14} className="animate-spin" />
              Loading workspace stats
            </div>
          )}
        </header>

        <section className="grid grid-cols-1 gap-5 lg:grid-cols-3">
          {apps.map((app, index) => {
            const Icon = app.icon;
            return (
              <Link
                key={app.title}
                href={app.href}
                className="hub-workspace-card group"
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-4">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
                      0{index + 1}
                    </span>
                    <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <Icon size={22} />
                    </div>
                  </div>
                  <ArrowRight size={18} className="text-text-muted transition-transform group-hover:translate-x-1 group-hover:text-accent" />
                </div>

                <div className="mt-8 space-y-3">
                  <div className="flex items-end justify-between gap-4">
                    <h2 className="text-xl font-semibold text-text-primary">{app.title}</h2>
                    <div className="text-right">
                      <p className="text-3xl font-bold leading-none text-text-primary">{app.stat}</p>
                      <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-text-muted">{app.statLabel}</p>
                    </div>
                  </div>
                  <p className="max-w-xl text-sm leading-6 text-text-secondary">{app.description}</p>
                </div>
              </Link>
            );
          })}
        </section>
      </div>
    </div>
  );
}
