'use client';

import { usePathname } from 'next/navigation';
import { HelpCircle } from 'lucide-react';

export function Topbar() {
  const pathname = usePathname();
  const pageTitle = pathname === '/' ? 'Dashboard' 
    : pathname === '/interviews/new' ? 'New evaluation'
    : pathname.startsWith('/interviews/view') ? 'Evaluation details'
    : '';

  return (
    <header className="h-14 border-b border-border bg-surface-elevated/90 backdrop-blur-xl flex items-center justify-between px-6 flex-shrink-0 sticky top-0 z-10">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium text-text-secondary">
          {pageTitle}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            localStorage.removeItem('minfy_tour_done');
            window.location.reload();
          }}
          className="p-1.5 rounded-md text-text-muted hover:text-accent transition-colors"
          title="Replay guide"
        >
          <HelpCircle size={16} />
        </button>
      </div>
    </header>
  );
}
