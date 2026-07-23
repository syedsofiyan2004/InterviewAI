'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { HelpCircle, Menu, ChevronRight } from 'lucide-react';
import { getPageMetadata } from './pageMetadata';

interface TopbarProps {
  onOpenNavigation?: () => void;
}

export function Topbar({ onOpenNavigation }: TopbarProps) {
  const pathname = usePathname();
  const metadata = getPageMetadata(pathname);

  return (
    <header className="flex h-16 flex-shrink-0 items-center justify-between border-b border-border bg-surface-elevated px-4 lg:px-6">
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
          {metadata.breadcrumbs.length > 1 && (
            <nav aria-label="Breadcrumb" className="hidden items-center gap-1 text-xs text-text-muted sm:flex">
              <Link href="/" className="transition-colors hover:text-text-primary">Home</Link>
              {metadata.breadcrumbs.map((item, index) => (
                <span key={`${item.label}-${index}`} className="flex items-center gap-1">
                  <ChevronRight size={13} aria-hidden="true" />
                  {item.href ? (
                    <Link href={item.href} className="transition-colors hover:text-text-primary">{item.label}</Link>
                  ) : (
                    <span aria-current="page">{item.label}</span>
                  )}
                </span>
              ))}
            </nav>
          )}
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
          onClick={() => {
            Object.keys(localStorage)
              .filter((key) => key.startsWith('minfy_tour_done'))
              .forEach((key) => localStorage.removeItem(key));
            localStorage.setItem('minfy_tour_replay', 'all');
            window.location.reload();
          }}
          className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-interactive hover:text-accent"
          title="Replay guide"
          aria-label="Replay guide"
        >
          <HelpCircle size={16} />
        </button>
      </div>
    </header>
  );
}
