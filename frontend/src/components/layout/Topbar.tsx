'use client';

import { usePathname } from 'next/navigation';
import { HelpCircle } from 'lucide-react';

export function Topbar() {
  const pathname = usePathname();
  const pageTitle = pathname === '/' ? 'Dashboard' 
    : pathname === '/interviews/new' ? 'New evaluation'
    : pathname.startsWith('/interviews/view') ? 'Evaluation details'
    : pathname === '/interviews' ? 'Evaluations'
    : pathname === '/mom/new' ? 'New MOM project'
    : pathname.startsWith('/mom/project') ? 'MOM project'
    : pathname.startsWith('/mom/view') ? 'MOM details'
    : pathname === '/mom' ? 'MOM Analyzer'
    : 'Workspace';

  return (
    <header className="h-14 border-b border-border/75 bg-surface-elevated/80 backdrop-blur-xl flex items-center justify-between px-6 flex-shrink-0 sticky top-0 z-10 shadow-[0_10px_32px_rgba(0,0,0,0.16)]">
      <div className="flex items-center gap-4">
        <span className="text-sm font-semibold text-text-primary">
          {pageTitle}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={() => {
            Object.keys(localStorage)
              .filter((key) => key.startsWith('minfy_tour_done'))
              .forEach((key) => localStorage.removeItem(key));
            localStorage.setItem('minfy_tour_replay', 'all');
            window.location.reload();
          }}
          className="p-2 rounded-lg text-text-muted hover:bg-accent/10 hover:text-accent transition-colors"
          title="Replay guide"
        >
          <HelpCircle size={16} />
        </button>
      </div>
    </header>
  );
}
