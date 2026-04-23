'use client';

import { usePathname } from 'next/navigation';

export function Topbar() {
  const pathname = usePathname();
  const pageTitle = pathname === '/' ? 'Dashboard' 
    : pathname === '/interviews/new' ? 'New evaluation'
    : pathname.startsWith('/interviews/view') ? 'Evaluation details'
    : '';

  return (
    <header className="h-14 border-b border-border bg-surface-elevated flex items-center px-6 flex-shrink-0 sticky top-0 z-10">
      <div className="flex items-center gap-4">
        <span className="text-sm font-medium text-text-secondary">
          {pageTitle}
        </span>
      </div>
    </header>
  );
}
