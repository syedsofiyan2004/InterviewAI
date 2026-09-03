'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, Calculator, Loader2, Sparkles } from 'lucide-react';
import { api } from '@/lib/api';
import { calculatorApi } from '@/lib/calculatorApi';

type HubStats = {
  interviews: number;
  moms: number;
  calculations: number;
  loading: boolean;
};

export default function HubPage() {
  const [stats, setStats] = useState<HubStats>({ interviews: 0, moms: 0, calculations: 0, loading: true });

  useEffect(() => {
    let mounted = true;

    async function loadStats() {
      try {
        // allSettled so one app's endpoint failing never blanks the other cards.
        const [interviewsResult, momsResult, calculationsResult] = await Promise.allSettled([
          api.getIntelligenceInterviews(),
          api.getMoms(),
          calculatorApi.getCalculations(),
        ]);

        if (!mounted) return;
        setStats({
          interviews: interviewsResult.status === 'fulfilled' ? interviewsResult.value.count : 0,
          moms: momsResult.status === 'fulfilled' ? momsResult.value.count : 0,
          calculations: calculationsResult.status === 'fulfilled' ? calculationsResult.value.count : 0,
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
      title: 'HireRite',
      description: 'Open scheduled interviews, prepare panel guides, sync Teams transcripts, and complete evidence-backed hiring reviews.',
      proof: 'Output: Panel guide / Transcript / Review / PDF',
      href: '/my-interviews',
      logoSrc: '/interview-evaluator-logo.png',
      logoAlt: 'HireRite',
      icon: undefined as typeof Calculator | undefined,
      statLabel: 'Interviews',
      stat: stats.interviews,
    },
    {
      title: 'MOM Analyzer',
      description: 'Upload your meeting recording transcript. Get decisions, risks, and action items with owners - ready to share.',
      proof: 'Output: Decisions / Actions / Risks / PDF',
      href: '/mom',
      logoSrc: '/mom-analyzer-logo.png',
      logoAlt: 'MOM Analyzer',
      icon: undefined as typeof Calculator | undefined,
      statLabel: 'MOMs',
      stat: stats.moms,
    },
    {
      title: 'AWS Cost Calculator',
      description: 'Describe a workload in plain English. Get a real AWS Pricing Calculator estimate with a cost breakdown you can share.',
      proof: 'Output: Estimate / Breakdown / calculator.aws link',
      href: '/calculator',
      logoSrc: '/aws-cost-estimator-logo.png',
      logoAlt: 'AWS Cost Estimator',
      icon: Calculator as typeof Calculator | undefined,
      statLabel: 'Estimates',
      stat: stats.calculations,
    },
  ], [stats.interviews, stats.moms, stats.calculations]);

  return (
    <div className="hub-stage min-h-[calc(100vh-7rem)] rounded-[1.5rem] p-[clamp(22px,3.2vw,42px)]">
      <div className="relative z-10 flex w-full flex-col gap-10">
        <header className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_19rem] xl:items-end">
          <div className="max-w-3xl">
            <div className="mb-7 flex items-center gap-4">
              <span className="brand-logo-tile h-24 w-24 sm:h-28 sm:w-28">
                <img src="/minfy-mimo-hub-logo.png" alt="" className="h-full w-full object-contain" />
              </span>
              <div>
                <p className="text-lg font-semibold tracking-tight text-text-primary">Minfy MiMo AI Hub</p>
                <p className="text-[10px] font-semibold uppercase tracking-[0.24em] text-accent">Internal tools</p>
              </div>
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
              AI workspaces
            </p>
            <h1 className="mt-3 max-w-3xl text-[clamp(38px,6vw,76px)] font-semibold leading-[0.96] tracking-tight text-text-primary">
              Your meetings and interviews,
              <span className="block text-accent">actually documented.</span>
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-text-secondary">
              Upload a transcript. Get a proper report. Keep every source, score, and next action in one place.
            </p>
          </div>
          <div className="hub-overview-card">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Your workspace</p>
              {stats.loading ? <Loader2 size={15} className="animate-spin text-accent" /> : <Sparkles size={15} className="text-accent" />}
            </div>
            <div className="mt-6 grid grid-cols-2 divide-x divide-border">
              <div className="pr-4">
                <p className="text-3xl font-semibold tracking-tight text-text-primary">{stats.interviews}</p>
                <p className="mt-1 text-xs text-text-muted">HireRite</p>
              </div>
              <div className="pl-4">
                <p className="text-3xl font-semibold tracking-tight text-text-primary">{stats.moms}</p>
                <p className="mt-1 text-xs text-text-muted">Meeting reports</p>
              </div>
            </div>
            <p className="mt-5 border-t border-border pt-4 text-xs leading-5 text-text-secondary">Choose a workspace to continue from where the last review stopped.</p>
          </div>
        </header>

        <section className="space-y-4" aria-label="Applications">
          {apps.map((app, index) => {
            return (
              <Link
                key={app.title}
                href={app.href}
                className="hub-workspace-card group"
              >
                <div className="grid h-full gap-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="flex min-w-0 items-start gap-4">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
                      0{index + 1}
                    </span>
                    <span className="app-wordmark-tile">
                      {app.logoSrc ? (
                        <img src={app.logoSrc} alt={app.logoAlt} className="h-full w-full object-contain" />
                      ) : app.icon ? (
                        // No wordmark asset for this app yet. An icon reads as
                        // deliberate; a missing <img> renders as a broken tile.
                        <app.icon size={26} className="text-accent" aria-hidden />
                      ) : null}
                    </span>
                    <div className="min-w-0 space-y-3">
                      <h2 className="text-xl font-semibold text-text-primary">{app.title}</h2>
                      <p className="max-w-xl text-sm leading-6 text-text-secondary">{app.description}</p>
                      <code className="inline-flex max-w-full rounded-full border border-border bg-surface px-3 py-1 text-[11px] font-semibold leading-5 text-text-secondary max-sm:whitespace-normal">
                        {app.proof}
                      </code>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-4 border-t border-border pt-5 md:min-w-[11rem] md:border-l md:border-t-0 md:pl-6 md:pt-0">
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
