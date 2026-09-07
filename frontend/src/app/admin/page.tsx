'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api, type AdminOverview } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { Shield, Users, LayoutDashboard, ListChecks, ArrowRight, Search, ClipboardList, Calculator } from 'lucide-react';
import { Skeleton } from '@/components/ui/Skeleton';

function OverviewContent() {
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.getAdminOverview()
      .then((data) => setOverview(data))
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
      </div>
    );
  }

  if (error || !overview) {
    return (
      <div className="card flex min-h-[220px] flex-col items-center justify-center p-6 text-center">
        <p className="text-sm font-medium text-text-primary">Unable to load the overview</p>
        <p className="mt-1 text-sm text-text-muted">Refresh the page to try again.</p>
      </div>
    );
  }

  const metrics = [
    { application: 'HireRite', label: 'Interview reports', total: overview.total_interviews, href: '/admin/interviews', icon: LayoutDashboard, breakdown: overview.interviews },
    { application: 'MOM Analyzer', label: 'MOM reports', total: overview.total_moms, href: '/admin/moms', icon: ListChecks, breakdown: overview.moms },
    {
      application: 'HireRite',
      label: 'Review workspaces',
      total: overview.total_workspaces ?? overview.total_intelligence,
      href: '/admin/candidates',
      icon: Users,
      breakdown: overview.workspaces ?? overview.intelligence,
    },
    {
      application: 'Cost Calculator',
      label: 'Cost estimates',
      total: overview.total_calculations ?? 0,
      href: '/admin/calculator',
      icon: Calculator,
      breakdown: overview.calculations,
    },
  ];

  return (
    <div className="space-y-6">
      {['HireRite', 'MOM Analyzer', 'Cost Calculator'].map(application => (
        <section key={application} aria-label={`${application} administration`}>
          <h2 className="mb-3 text-lg font-semibold text-text-primary">{application}</h2>
          <div className="grid gap-5 sm:grid-cols-2">
        {metrics.filter(metric => metric.application === application).map((metric) => {
          const Icon = metric.icon;
          const statuses = Object.entries(metric.breakdown ?? {}).filter(([, count]) => count > 0);
          return (
            <Link key={metric.label} href={metric.href} className="group metric-card flex flex-col p-5 transition-shadow hover:shadow-lg">
              <div className="mb-3 flex items-start justify-between">
                <span className="rounded-lg bg-accent/10 p-2 text-accent"><Icon size={18} /></span>
                <ArrowRight size={15} className="text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">{metric.label}</p>
              <p className="mt-1 text-3xl font-bold tracking-tight text-text-primary">{metric.total}</p>
              {statuses.length > 0 && (
                <div className="mt-auto flex flex-wrap gap-1.5 border-t border-border pt-3">
                  {statuses.map(([status, count]) => (
                    <span key={status} className="rounded-full bg-surface-elevated px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-secondary">
                      {status.replace(/_/g, ' ')} {count}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          );
        })}
          </div>
        </section>
      ))}

      <div className="grid gap-4 sm:grid-cols-2">
        <Link href="/admin/search" className="card flex items-center gap-3 p-4 transition-colors hover:bg-surface-interactive">
          <span className="rounded-lg bg-accent/10 p-2 text-accent"><Search size={17} /></span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-text-primary">Search across the organisation</span>
            <span className="block text-xs text-text-muted">Every search is written to the audit log.</span>
          </span>
        </Link>
        <Link href="/admin/candidates" className="card flex items-center gap-3 p-4 transition-colors hover:bg-surface-interactive">
          <span className="rounded-lg bg-accent/10 p-2 text-accent"><ClipboardList size={17} /></span>
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-text-primary">Review workspaces</span>
            <span className="block text-xs text-text-muted">Multiple interview rounds, comments, shares, and final decisions in one view.</span>
          </span>
        </Link>
      </div>
    </div>
  );
}

export default function AdminOverviewPage() {
  return (
    <TierGuard minTier="VIEWER">
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <span className="rounded-xl bg-accent/10 p-2.5 text-accent"><Shield size={20} /></span>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-text-primary">Admin workspace</h1>
            <p className="text-sm text-text-muted">Organisation-wide activity at a glance.</p>
          </div>
        </div>
        <OverviewContent />
      </div>
    </TierGuard>
  );
}
