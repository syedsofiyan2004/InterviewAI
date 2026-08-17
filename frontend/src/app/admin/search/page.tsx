'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { api, type SearchResult } from '@/lib/api';
import { TierGuard } from '@/components/admin/TierGuard';
import { Search, ArrowRight, Info } from 'lucide-react';
import { SkeletonList } from '@/components/ui/Skeleton';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { format } from 'date-fns';

const TYPE_LABEL: Record<SearchResult['type'], string> = {
  interview: 'Interview report',
  mom: 'MOM report',
  intelligence: 'Intelligence report',
};

function hrefFor(result: SearchResult): string {
  if (result.type === 'interview') return `/interviews/view?id=${encodeURIComponent(result.id)}&from=/admin/search`;
  if (result.type === 'mom') return `/mom/view?id=${encodeURIComponent(result.id)}&from=/admin/search`;
  return `/interviews/intelligence/view?id=${encodeURIComponent(result.id)}&from=/admin/search`;
}

function SearchContent() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setSearching(true);
    setError(null);
    try {
      const data = await api.adminSearch(trimmed);
      setResults(data.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-5">
      <form onSubmit={handleSubmit} className="relative flex items-center">
        <Search size={16} className="pointer-events-none absolute left-3 text-text-muted z-10" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search evaluations, meetings, candidates, or owner email…"
          aria-label="Search across the organisation"
          className="premium-input h-11 w-full pl-9 pr-28 text-sm"
        />
        <button
          type="submit"
          className="btn-primary absolute right-1 h-9 items-center justify-center gap-1.5 px-4 text-xs font-semibold"
          disabled={searching || !query.trim()}
        >
          <Search size={14} />
          <span>{searching ? 'Searching...' : 'Search'}</span>
        </button>
      </form>

      <p className="flex items-start gap-2 text-xs text-text-muted">
        <Info size={14} className="mt-0.5 flex-shrink-0" />
        Searching reads records owned by other people, so every search you run is recorded in the audit log.
      </p>

      {error && (
        <div className="rounded-xl border border-danger/25 bg-danger/10 p-4 text-sm text-danger">{error}</div>
      )}

      {searching && <SkeletonList rows={4} />}

      {!searching && results !== null && results.length === 0 && (
        <div className="card flex min-h-[180px] flex-col items-center justify-center p-6 text-center">
          <p className="text-sm font-medium text-text-primary">No matches found</p>
          <p className="mt-1 text-sm text-text-muted">Try a shorter or differently spelled search term.</p>
        </div>
      )}

      {!searching && results !== null && results.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-muted">
            {results.length} {results.length === 1 ? 'result' : 'results'}
          </p>
          {results.map((result) => (
            <Link
              key={`${result.type}-${result.id}`}
              href={hrefFor(result)}
              className="group flex items-center gap-4 rounded-xl border border-border bg-surface-elevated p-4 transition-colors hover:bg-surface-interactive"
            >
              <span className="rounded-md bg-accent/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-accent">
                {TYPE_LABEL[result.type]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-text-primary">{result.title || 'Untitled'}</span>
                <span className="block truncate text-xs text-text-muted">
                  {[result.owner_email || result.owner_user_id, result.created_at ? format(new Date(result.created_at), 'dd-MM-yyyy') : null]
                    .filter(Boolean)
                    .join(' - ')}
                </span>
              </span>
              {result.status && <StatusBadge status={result.status} variant="pill" />}
              <span className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-text-muted transition-colors group-hover:border-accent/40 group-hover:bg-accent/10 group-hover:text-accent">
                <span>Open report</span>
                <ArrowRight size={14} className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminSearchPage() {
  return (
    <TierGuard minTier="VIEWER">
      <SearchContent />
    </TierGuard>
  );
}
