'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowRight, CalendarDays, Home, ListChecks, Search, X, Users, Share2, Calculator } from 'lucide-react';

type CommandItem = {
  title: string;
  detail: string;
  href: string;
  icon: ReactNode;
};

const commands: CommandItem[] = [
  { title: 'My Candidates', detail: 'HireRite candidate review workspaces you own', href: '/candidates', icon: <Users size={17} /> },
  { title: 'Shared with Me', detail: 'HireRite reviews shared by colleagues', href: '/shared', icon: <Share2 size={17} /> },
  { title: 'Cost Calculator', detail: 'AWS cost projects and estimates', href: '/calculator', icon: <Calculator size={17} /> },
  {
    title: 'Home',
    detail: 'Open the MiMo workspace hub',
    href: '/',
    icon: <Home size={17} />,
  },
  {
    title: 'HireRite',
    detail: 'Open scheduled interviews and past hiring reviews',
    href: '/my-interviews',
    icon: <CalendarDays size={17} />,
  },
  {
    title: 'MOM projects',
    detail: 'Review meeting reports by project',
    href: '/mom',
    icon: <ListChecks size={17} />,
  },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const handleOpen = () => { setQuery(''); setOpen(true); };
    const handleKeyDown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuery('');
        setOpen((value) => !value);
      }
      if (event.key === 'Escape') setOpen(false);
    };

    window.addEventListener('minfy-command-open', handleOpen);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('minfy-command-open', handleOpen);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const filtered = useMemo(() => {
    const normalisedQuery = query.trim().toLowerCase();
    if (!normalisedQuery) return commands;
    return commands.filter((command) =>
      `${command.title} ${command.detail}`.toLowerCase().includes(normalisedQuery)
    );
  }, [query]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        className="command-palette-backdrop absolute inset-0"
        aria-label="Close command palette"
        onClick={() => setOpen(false)}
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="command-palette relative w-full max-w-xl overflow-hidden"
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search size={18} className="text-text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search workspaces and actions"
            className="min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-lg p-1.5 text-text-muted hover:bg-surface-interactive hover:text-text-primary"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[24rem] overflow-y-auto p-2">
          {filtered.length ? (
            filtered.map((command) => (
              <Link
                key={command.href}
                href={command.href}
                onClick={() => setOpen(false)}
                className="command-palette-item flex items-center gap-3 p-3"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
                  {command.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-text-primary">{command.title}</span>
                  <span className="block truncate text-xs text-text-muted">{command.detail}</span>
                </span>
                <ArrowRight size={15} className="text-text-muted" />
              </Link>
            ))
          ) : (
            <p className="px-4 py-8 text-center text-sm text-text-muted">No matching action found.</p>
          )}
        </div>
      </section>
    </div>
  );
}
