'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BrainCircuit, FolderPlus, Home, LayoutDashboard, ListChecks, PlusCircle, LogOut, Sun, Moon } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useAuth } from '@/contexts/AuthContext';
import { useState, useEffect } from 'react';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const navSections = [
  {
    name: 'Interview Evaluator',
    items: [
      { name: 'Evaluations', href: '/interviews', icon: LayoutDashboard },
      { name: 'New Evaluation', href: '/interviews/new', icon: PlusCircle },
      { name: 'Intelligence Mode', href: '/interviews/intelligence', icon: BrainCircuit },
    ],
  },
  {
    name: 'MOM Analyzer',
    items: [
      { name: 'Projects', href: '/mom', icon: ListChecks },
      { name: 'New Project', href: '/mom/new', icon: FolderPlus },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    const isDarkMode = document.documentElement.classList.contains('dark');
    setIsDark(isDarkMode);
  }, []);

  const toggleTheme = () => {
    const root = document.documentElement;
    const goingDark = !root.classList.contains('dark');
    root.classList.toggle('dark');
    setIsDark(goingDark);
    localStorage.setItem('theme', goingDark ? 'dark' : 'light');
  };

  const displayEmail = user?.email ?? '';
  const initials = displayEmail ? displayEmail.charAt(0).toUpperCase() : '?';

  return (
    <div 
      className="flex flex-col h-screen border-r border-border/80 bg-surface text-text-primary overflow-hidden shadow-[10px_0_28px_rgba(15,23,42,0.06)]"
      style={{ width: '220px', flexShrink: 0 }}
    >
      <Link href="/" className="h-14 flex items-center gap-3 px-5 border-b border-border/70 flex-shrink-0 hover:bg-surface-elevated/70 transition-colors" aria-label="Go to Minfy MiMo AI Hub home">
        <img src="/minfy-ai-logo.png" alt="" className="h-9 w-9 rounded-lg object-contain shadow-sm" />
        <div className="min-w-0 leading-tight">
          <span className="block font-semibold text-text-primary tracking-tight">Minfy MiMo</span>
          <span className="block text-[11px] font-medium text-text-muted">AI Hub</span>
        </div>
      </Link>
      
      <nav className="flex-1 px-3 py-6 space-y-6 overflow-y-auto">
        <Link
          id="tour-nav-home"
          href="/"
          className={cn(
            "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group text-sm font-medium",
            pathname === '/'
              ? "bg-accent/10 text-accent ring-1 ring-accent/15"
              : "text-text-secondary hover:bg-surface-elevated/80 hover:text-text-primary"
          )}
        >
          <Home size={18} className={cn(pathname === '/' ? "text-accent" : "text-text-muted group-hover:text-text-primary")} />
          Home
        </Link>

        {navSections.map((section) => (
          <div key={section.name} className="space-y-2">
            <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">
              {section.name}
            </p>
            <div className="space-y-1">
              {section.items.map((item) => {
                const itemPath = item.href.split('?')[0];
                const isActive = pathname === itemPath;
                const Icon = item.icon;

                return (
                  <Link
                    id={`tour-nav-${item.href.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home'}`}
                    key={item.name}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 group text-sm font-medium",
                      isActive
                        ? "bg-accent/10 text-accent ring-1 ring-accent/15"
                        : "text-text-secondary hover:bg-surface-elevated/80 hover:text-text-primary"
                    )}
                  >
                    <Icon size={18} className={cn(isActive ? "text-accent" : "text-text-muted group-hover:text-text-primary")} />
                    {item.name}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>
      
      <div id="tour-sidebar-footer" className="p-4 border-t border-border/70">
        <div className="rounded-xl border border-border/70 bg-surface-elevated/60 p-3">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-accent-foreground text-sm font-semibold shrink-0 shadow-md shadow-accent/20">
            {initials}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs font-medium text-text-primary truncate">
              {displayEmail}
            </p>
            <p className="text-xs text-text-muted">Enterprise</p>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <button
            onClick={signOut}
            className="flex items-center gap-1.5 text-xs text-text-muted hover:text-danger transition-colors"
          >
            <LogOut size={13} />
            Sign out
          </button>
          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-md hover:bg-surface-elevated text-text-muted transition-colors"
            title="Toggle theme"
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
        </div>
        </div>
      </div>
    </div>
  );
}
