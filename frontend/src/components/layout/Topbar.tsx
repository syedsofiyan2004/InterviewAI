'use client';

import { usePathname } from 'next/navigation';
import { BookOpen, Menu, Search } from 'lucide-react';
import { getPageMetadata } from './pageMetadata';

interface TopbarProps {
  onOpenNavigation?: () => void;
}

export function Topbar({ onOpenNavigation }: TopbarProps) {
  const pathname = usePathname();
  const metadata = getPageMetadata(pathname);

  return (
    <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-border bg-surface-elevated/95 px-4 lg:px-7">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenNavigation}
            className="rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-interactive hover:text-text-primary lg:hidden"
            aria-label="Open navigation"
          >
            <Menu size={18} />
          </button>
          <span className="hidden text-[11px] font-semibold uppercase tracking-wide text-text-muted sm:inline">MiMo workspace</span>
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold text-text-primary">{metadata.title}</h1>
          {metadata.description && (
            <p className="hidden truncate text-xs text-text-muted md:block">{metadata.description}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event('minfy-command-open'))}
          className="hidden items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs font-semibold text-text-muted transition-colors hover:border-accent/40 hover:text-text-primary md:inline-flex"
          aria-label="Open command palette"
        >
          <Search size={15} />
          <span>Search</span>
          <kbd className="rounded border border-border bg-surface-elevated px-1.5 py-0.5 font-mono text-[10px] text-text-muted">Ctrl K</kbd>
        </button>
        <button
          type="button"
          onClick={() => {
            Object.keys(localStorage)
              .filter((key) => key.startsWith('minfy_tour_done'))
              .forEach((key) => localStorage.removeItem(key));
            localStorage.setItem('minfy_tour_replay', 'all');
            window.location.reload();
          }}
          className="inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs font-semibold text-text-muted transition-colors hover:bg-surface-interactive hover:text-text-primary"
          title="Replay product guide"
          aria-label="Replay guide"
        >
          <BookOpen size={16} />
          <span className="hidden sm:inline">Guide</span>
        </button>
      </div>
    </header>
  );
}
