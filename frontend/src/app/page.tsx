'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CalendarDays, Calculator, ListChecks, Users, Share2, Shield, RefreshCw } from 'lucide-react';
import { api } from '@/lib/api';
import { calculatorApi } from '@/lib/calculatorApi';
import { useAuth } from '@/contexts/AuthContext';

const applications = [
  { title: 'HireRite', category: 'TALENT & HIRING', icon: CalendarDays, href: '/my-interviews', action: 'Open interviews', description: 'Prepare for interviews and turn candidate evidence into informed hiring decisions.', steps: ['Interview preparation', 'Transcripts & evidence', 'Candidate reviews'], label: 'Interview records', color: 'text-indigo-600 dark:text-indigo-300', background: 'bg-indigo-500/10', border: 'border-t-indigo-500' },
  { title: 'MOM Analyzer', category: 'MEETINGS & DELIVERY', icon: ListChecks, href: '/mom', action: 'Open meeting projects', description: 'Keep meeting decisions, action owners, and risks organized across your projects.', steps: ['Meeting reports', 'Decisions & actions', 'Project history'], label: 'Meeting reports', color: 'text-teal-700 dark:text-teal-300', background: 'bg-teal-500/10', border: 'border-t-teal-500' },
  { title: 'AWS Cost Calculator', category: 'CLOUD & PLANNING', icon: Calculator, href: '/calculator', action: 'Open cost projects', description: 'Plan AWS workloads and review cost estimates with the context your team needs.', steps: ['Workload planning', 'Cost breakdowns', 'Project estimates'], label: 'Cost estimates', color: 'text-amber-700 dark:text-amber-300', background: 'bg-amber-500/10', border: 'border-t-amber-500' },
];

export default function HubPage() {
  const { isAdmin, tier } = useAuth();
  const [counts, setCounts] = useState<(number | null)[]>([null, null, null]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.allSettled([api.getIntelligenceInterviews(), api.getMoms(), calculatorApi.getCalculations()])
      .then(results => {
        if (!active) return;
        setCounts(results.map(result => result.status === 'fulfilled' ? result.value.count : null));
        setLoading(false);
      });
    return () => { active = false; };
  }, [reload]);
  return (
    <div className="mx-auto max-w-7xl space-y-8 pb-6">
      <header className="relative overflow-hidden rounded-2xl border border-border bg-surface-elevated p-7 sm:p-10">
        <div aria-hidden="true" className="pointer-events-none absolute -right-16 -top-28 h-80 w-80 rounded-full border-[45px] border-accent/5" />
        <div className="relative grid gap-8 xl:grid-cols-[1fr_280px] xl:items-center">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-accent">MINFY MiMo / AI WORKSPACE</p>
            <h1 className="mt-4 max-w-2xl text-3xl font-semibold leading-tight tracking-tight text-text-primary sm:text-5xl">Move work forward.<br /><span className="text-text-secondary">Keep every decision connected.</span></h1>
            <p className="mt-5 max-w-xl text-sm leading-7 text-text-secondary sm:text-base">Your workspace for hiring, meeting intelligence, and cloud cost planning. Find the right context, collaborate with colleagues, and turn reviews into next steps.</p>
            <Link href="/my-interviews" className="btn-primary mt-6 inline-flex items-center gap-2">Go to My Interviews<ArrowRight size={16} /></Link>
          </div>
          <div className="rounded-xl border border-border bg-surface/80 p-5">
            <p className="text-xs font-semibold uppercase tracking-wider text-text-muted">Your activity at a glance</p>
            <div className="mt-4 divide-y divide-border">{applications.map((app, i) => <Link key={app.href} href={app.href} className="flex items-center justify-between gap-3 py-3 text-sm text-text-secondary hover:text-accent"><span>{app.label}</span><span className="text-xl font-semibold text-text-primary">{loading ? '?' : counts[i] ?? '?'}</span></Link>)}</div>
            <p className="mt-3 text-xs leading-5 text-text-muted">Records available in your workspaces.</p>
            {!loading && counts.some(count => count === null) && <button onClick={() => { setLoading(true); setReload(v => v + 1); }} className="mt-3 flex items-center gap-2 text-xs font-medium text-accent"><RefreshCw size={13} />Some counts unavailable. Retry</button>}
          </div>
        </div>
      </header>
      <section aria-labelledby="applications-heading">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-2"><div><h2 id="applications-heading" className="text-xl font-semibold text-text-primary">Your applications</h2><p className="mt-1 text-sm text-text-muted">Three focused workspaces. One place to get started.</p></div><span className="text-xs text-text-muted">Choose an application to continue</span></div>
        <div className="grid gap-5 xl:grid-cols-3">{applications.map(app => <Link key={app.href} href={app.href} className={`group flex flex-col rounded-xl border border-border border-t-[3px] ${app.border} bg-surface p-6 transition-shadow hover:shadow-lg focus-visible:outline-2 focus-visible:outline-accent`}>
          <div className={`mb-6 flex h-12 w-12 items-center justify-center rounded-xl ${app.background} ${app.color}`}><app.icon size={24} /></div>
          <p className={`text-[10px] font-semibold tracking-[0.16em] ${app.color}`}>{app.category}</p><h3 className="mt-2 text-xl font-semibold text-text-primary">{app.title}</h3><p className="mt-3 text-sm leading-6 text-text-secondary">{app.description}</p>
          <ul className="my-6 space-y-2 text-xs text-text-muted">{app.steps.map(step => <li key={step} className="flex items-center gap-2"><span className={`h-1.5 w-1.5 rounded-full ${app.background}`} />{step}</li>)}</ul>
          <span className="mt-auto flex items-center justify-between border-t border-border pt-4 text-sm font-semibold text-text-primary">{app.action}<ArrowRight size={17} className="text-accent transition-transform group-hover:translate-x-1" /></span>
        </Link>)}</div>
      </section>
      <section aria-labelledby="quick-actions-heading" className="rounded-xl border border-border bg-surface-elevated p-6">
        <h2 id="quick-actions-heading" className="text-lg font-semibold text-text-primary">Quick access</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
          { title: 'My Candidates', detail: 'Continue a candidate review', href: '/candidates', icon: Users },
          { title: 'Shared with Me', detail: 'Review work shared by colleagues', href: '/shared', icon: Share2 },
          { title: 'New MOM project', detail: 'Organize meeting reports', href: '/mom/new', icon: ListChecks },
          { title: 'New cost project', detail: 'Start planning an AWS workload', href: '/calculator/project/new', icon: Calculator },
        ].map(action => <Link key={action.href} href={action.href} className="rounded-lg border border-border bg-surface p-4 transition-colors hover:border-accent/40"><action.icon size={18} className="mb-3 text-accent" /><span className="block text-sm font-semibold text-text-primary">{action.title}</span><span className="mt-1 block text-xs leading-5 text-text-muted">{action.detail}</span></Link>)}</div>
      </section>
      {isAdmin && tier && <Link href="/admin" className="flex items-center gap-4 rounded-xl border border-border bg-surface p-5 hover:bg-surface-interactive"><Shield size={22} className="shrink-0 text-accent" /><span className="flex-1"><span className="block text-sm font-semibold text-text-primary">Organization administration</span><span className="mt-1 block text-xs leading-5 text-text-muted">View organization activity. Application admin tools are grouped under their application in the navigation.</span></span><ArrowRight size={18} className="shrink-0 text-text-muted" /></Link>}
    </div>
  );
}
