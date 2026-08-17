'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { format } from 'date-fns';
import { api, type QuestionBankRoleSummary } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { SkeletonList } from '@/components/ui/Skeleton';
import { ArrowRight, LibraryBig } from 'lucide-react';

function QuestionBankList() {
  const [items, setItems] = useState<QuestionBankRoleSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.adminListQuestionBank()
      .then((data) => setItems(data.items ?? []))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load question bank'))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <SkeletonList rows={5} />;

  return (
    <div className="space-y-6">
      <div className="card p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent">Owner configuration</p>
        <h1 className="mt-2 text-xl font-semibold text-text-primary">Question Bank</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-text-secondary">
          Curate role competencies and reusable interview questions. These edits steer future generated guides for each role.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>
      )}

      {!error && items.length === 0 ? (
        <div className="card flex min-h-[220px] flex-col items-center justify-center p-6 text-center">
          <span className="mb-3 rounded-xl bg-accent/10 p-2.5 text-accent"><LibraryBig size={20} /></span>
          <p className="text-sm font-medium text-text-primary">No curated roles found</p>
          <p className="mt-1 max-w-md text-sm text-text-muted">
            Run the seed script to populate editable role rows from the shipped question bank.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            {items.length} roles
          </p>
          {items.map((role) => (
            <Link
              key={role.role_key}
              href={`/admin/question-bank/view?id=${encodeURIComponent(role.role_key)}`}
              className="group flex items-center gap-4 rounded-xl border border-border bg-surface-elevated p-4 transition-colors hover:bg-surface-interactive"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-text-primary">{role.role_title}</span>
                <span className="block truncate text-xs text-text-muted">
                  {[role.department, role.experience, `${role.competencies.length} competencies`, format(new Date(role.updated_at), 'dd-MM-yyyy')]
                    .filter(Boolean)
                    .join(' - ')}
                </span>
              </span>
              <span className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-muted transition-colors group-hover:border-accent/40 group-hover:bg-accent/10 group-hover:text-accent">
                <span>Edit</span>
                <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminQuestionBankPage() {
  return (
    <TierGuard minTier="OWNER">
      <QuestionBankList />
    </TierGuard>
  );
}
