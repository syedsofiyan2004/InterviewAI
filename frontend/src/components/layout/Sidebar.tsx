'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { FolderPlus, Home, LayoutDashboard, ListChecks, PlusCircle, ShieldCheck, LogOut, Sun, Moon } from 'lucide-react';
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
      className="flex flex-col h-screen border-r border-border bg-surface/95 text-text-primary overflow-hidden backdrop-blur-xl"
      style={{ width: '220px', flexShrink: 0 }}
    >
      <div className="h-14 flex items-center gap-3 px-5 border-b border-border flex-shrink-0">
        <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-accent text-white shadow-lg shadow-accent/20">
          <ShieldCheck size={20} />
        </div>
        <div className="flex items-baseline">
          <span className="font-semibold text-text-primary tracking-tight">Minfy</span>
          <span className="font-normal text-text-muted ml-1">AI</span>
        </div>
      </div>
      
      <nav className="flex-1 px-3 py-6 space-y-6">
        <Link
          id="tour-nav-home"
          href="/"
          className={cn(
            "flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group text-sm font-medium",
            pathname === '/'
              ? "bg-accent/10 text-accent"
              : "text-text-secondary hover:bg-surface-elevated hover:text-text-primary"
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
                const isActive = pathname === item.href;
                const Icon = item.icon;

                return (
                  <Link
                    id={`tour-nav-${item.href.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home'}`}
                    key={item.name}
                    href={item.href}
                    className={cn(
                      "flex items-center gap-3 px-3 py-2 rounded-lg transition-all duration-200 group text-sm font-medium",
                      isActive
                        ? "bg-accent/10 text-accent"
                        : "text-text-secondary hover:bg-surface-elevated hover:text-text-primary"
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
      
      <div id="tour-sidebar-footer" className="p-4 border-t border-border">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-8 h-8 rounded-full bg-accent flex items-center justify-center text-accent-foreground text-sm font-semibold shrink-0">
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
  );
}
