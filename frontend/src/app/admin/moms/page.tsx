'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { FolderKanban, FileText, ExternalLink, Calendar, User, Search } from 'lucide-react';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Skeleton } from '@/components/ui/Skeleton';
import { format } from 'date-fns';

interface AdminMomItem {
  mom_id: string;
  title: string;
  project_title: string;
  meeting_date?: string | null;
  meeting_date_sort?: number | null;
  status: string;
  created_at: number;
  owner_email?: string;
  href: string;
}

function formatAdminMeetingDate(mom: AdminMomItem): string {
  if (mom.meeting_date_sort) return format(new Date(mom.meeting_date_sort), 'dd-MM-yyyy');
  if (mom.meeting_date && mom.meeting_date !== 'Not specified') {
    const parsed = new Date(mom.meeting_date);
    if (!isNaN(parsed.getTime())) return format(parsed, 'dd-MM-yyyy');
    return mom.meeting_date;
  }
  return mom.created_at ? format(new Date(mom.created_at), 'dd-MM-yyyy') : '-';
}

export default function AdminMomsPage() {
  const [items, setItems] = useState<AdminMomItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedProject, setSelectedProject] = useState<string>('ALL');

  useEffect(() => {
    api.adminListMoms()
      .then((data) => {
        const raw = (data.items ?? []).map((item: any) => ({
          mom_id: item.mom_id,
          title: item.title || 'Untitled meeting',
          project_title: item.project_title || 'General Workspace',
          meeting_date: item.meeting_date || null,
          meeting_date_sort: item.meeting_date_sort ?? null,
          status: item.status || 'COMPLETED',
          created_at: item.created_at || 0,
          owner_email: item.owner_email || item.owner_user_id || 'Unknown',
          href: `/mom/view?id=${encodeURIComponent(item.mom_id)}&from=/admin/moms`,
        }));
        setItems(raw);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load meeting reports'))
      .finally(() => setLoading(false));
  }, []);

  // Group items by project_title
  const groupedProjects = useMemo(() => {
    const map = new Map<string, AdminMomItem[]>();

    for (const item of items) {
      if (search) {
        const query = search.toLowerCase();
        const matchTitle = item.title.toLowerCase().includes(query);
        const matchProject = item.project_title.toLowerCase().includes(query);
        const matchOwner = (item.owner_email || '').toLowerCase().includes(query);
        if (!matchTitle && !matchProject && !matchOwner) continue;
      }

      const pTitle = item.project_title.trim() || 'General Workspace';
      if (selectedProject !== 'ALL' && pTitle !== selectedProject) continue;

      if (!map.has(pTitle)) {
        map.set(pTitle, []);
      }
      map.get(pTitle)!.push(item);
    }

    return Array.from(map.entries()).map(([projectTitle, reports]) => ({
      projectTitle,
      reports: reports.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)),
    }));
  }, [items, search, selectedProject]);

  const allProjectTitles = useMemo(() => {
    const set = new Set<string>();
    items.forEach((item) => set.add(item.project_title.trim() || 'General Workspace'));
    return Array.from(set).sort();
  }, [items]);

  return (
    <TierGuard minTier="VIEWER">
      <div className="space-y-6">
        <section className="card p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Administration</p>
              <h1 className="mt-1 text-2xl font-bold tracking-tight text-text-primary">Meeting Reports</h1>
              <p className="mt-1 text-sm text-text-secondary">
                Organization-wide MOM meeting reports grouped by project workspace ({items.length} total reports across {allProjectTitles.length} projects).
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative min-w-[220px]">
                <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
                <input
                  type="text"
                  placeholder="Filter meetings..."
                  value={search}
                  aria-label="Filter meetings..."
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full rounded-lg border border-border bg-surface pl-9 pr-3 py-2 text-xs text-text-primary outline-none focus:border-accent"
                />
              </div>
              {allProjectTitles.length > 1 && (
                <select
                  value={selectedProject}
                  aria-label="Filter meetings by project workspace"
                  onChange={(e) => setSelectedProject(e.target.value)}
                  className="rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-primary outline-none focus:border-accent"
                >
                  <option value="ALL">All Projects ({allProjectTitles.length})</option>
                  {allProjectTitles.map((p) => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </section>

        {loading ? (
          <div className="space-y-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div key={i} className="card p-5 space-y-3">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="card p-8 text-center text-sm text-danger">{error}</div>
        ) : groupedProjects.length === 0 ? (
          <div className="card p-12 text-center">
            <FolderKanban size={36} className="mx-auto text-accent" />
            <p className="mt-3 text-sm font-semibold text-text-primary">No meeting reports found</p>
            <p className="mt-1 text-xs text-text-muted">Meeting reports created by team members will appear grouped by project here.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {groupedProjects.map(({ projectTitle, reports }) => (
              <div key={projectTitle} className="card p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-border pb-3">
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-accent/10 text-accent">
                      <FolderKanban size={18} />
                    </span>
                    <div>
                      <h2 className="text-base font-semibold text-text-primary">{projectTitle}</h2>
                      <p className="text-xs text-text-muted">{reports.length} meeting report{reports.length === 1 ? '' : 's'}</p>
                    </div>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-border bg-surface text-xs font-semibold uppercase tracking-wide text-text-muted">
                        <th className="px-4 py-2.5">Meeting Title</th>
                        <th className="px-4 py-2.5">Owner</th>
                        <th className="px-4 py-2.5 text-center">Date</th>
                        <th className="px-4 py-2.5 text-center">Status</th>
                        <th className="px-4 py-2.5 text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {reports.map((mom) => (
                        <tr key={mom.mom_id} className="hover:bg-surface-interactive/50 transition-colors">
                          <td className="px-4 py-3">
                            <Link href={mom.href} className="text-sm font-semibold text-text-primary hover:text-accent">
                              {mom.title}
                            </Link>
                          </td>
                          <td className="px-4 py-3 text-xs text-text-secondary">
                            <span className="inline-flex items-center gap-1.5">
                              <User size={13} className="text-text-muted" />
                              {mom.owner_email}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-xs text-text-secondary text-center">
                            {formatAdminMeetingDate(mom)}
                          </td>
                          <td className="px-4 py-3 text-center">
                            <div className="flex justify-center">
                              <StatusBadge status={mom.status} />
                            </div>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Link
                              href={mom.href}
                              className="inline-flex items-center gap-1 text-xs font-semibold text-accent hover:underline"
                            >
                              Open report <ExternalLink size={12} />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </TierGuard>
  );
}
