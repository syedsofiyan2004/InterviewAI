'use client';

import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
  BrainCircuit,
  FolderPlus,
  Home,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PlusCircle,
  Sun,
  X,
} from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useAuth } from '@/contexts/AuthContext';
import { useEffect, useState } from 'react';

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

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  mobileOpen: boolean;
  onCloseMobile: () => void;
}

interface SidebarContentProps {
  collapsed: boolean;
  mobile?: boolean;
  onCloseMobile?: () => void;
  onToggleCollapsed?: () => void;
}

export function Sidebar({ collapsed, onToggleCollapsed, mobileOpen, onCloseMobile }: SidebarProps) {
  useEffect(() => {
    if (!mobileOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseMobile();
    };
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [mobileOpen, onCloseMobile]);

  return (
    <>
      <aside
        className="hidden h-screen flex-col border-r border-border bg-surface text-text-primary shadow-[8px_0_24px_rgba(15,23,42,0.04)] transition-[width] duration-200 lg:flex"
        style={{ width: collapsed ? '76px' : '220px', flexShrink: 0 }}
      >
        <SidebarContent collapsed={collapsed} onToggleCollapsed={onToggleCollapsed} />
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/45"
            aria-label="Close navigation"
            onClick={onCloseMobile}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Application navigation"
            className="relative flex h-full w-[min(18rem,calc(100vw-2.5rem))] flex-col border-r border-border bg-surface text-text-primary shadow-2xl"
          >
            <SidebarContent collapsed={false} mobile onCloseMobile={onCloseMobile} />
          </aside>
        </div>
      )}
    </>
  );
}

function SidebarContent({ collapsed, mobile = false, onCloseMobile, onToggleCollapsed }: SidebarContentProps) {
  const pathname = usePathname();
  const { user, signOut } = useAuth();
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setIsDark(document.documentElement.classList.contains('dark'));
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const toggleTheme = () => {
    const root = document.documentElement;
    const goingDark = !root.classList.contains('dark');
    root.classList.toggle('dark', goingDark);
    setIsDark(goingDark);
    localStorage.setItem('theme', goingDark ? 'dark' : 'light');
  };

  const displayEmail = user?.email ?? '';
  const initials = displayEmail ? displayEmail.charAt(0).toUpperCase() : '?';
  const closeAfterNavigation = () => onCloseMobile?.();
  const showLabels = !collapsed || mobile;

  return (
    <>
      <div className={cn('flex h-16 flex-shrink-0 items-center border-b border-border', showLabels ? 'justify-between px-4' : 'justify-center px-2')}>
        <Link
          href="/"
          onClick={closeAfterNavigation}
          className={cn('flex min-w-0 items-center gap-3 rounded-lg transition-colors hover:bg-surface-interactive', showLabels ? 'p-1' : 'p-1.5')}
          aria-label="Go to Minfy MiMo AI Hub home"
          title={collapsed ? 'Minfy MiMo AI Hub' : undefined}
        >
          <Image
            src="/minfy-ai-logo.png"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9 flex-shrink-0 rounded-lg object-contain"
          />
          {showLabels && (
            <span className="min-w-0 leading-tight">
              <span className="block font-semibold tracking-tight text-text-primary">Minfy MiMo</span>
              <span className="block text-[11px] font-medium text-text-muted">AI Hub</span>
            </span>
          )}
        </Link>
        {mobile ? (
          <button
            type="button"
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-interactive hover:text-text-primary"
            onClick={onCloseMobile}
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        ) : (
          <button
            type="button"
            className="rounded-lg p-2 text-text-muted transition-colors hover:bg-surface-interactive hover:text-text-primary"
            onClick={onToggleCollapsed}
            aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
            title={collapsed ? 'Expand navigation' : 'Collapse navigation'}
          >
            {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          </button>
        )}
      </div>

      <nav className={cn('flex-1 space-y-6 overflow-y-auto py-5', showLabels ? 'px-3' : 'px-2')} aria-label="Primary navigation">
        <Link
          id={mobile ? undefined : 'tour-nav-home'}
          href="/"
          onClick={closeAfterNavigation}
          className={cn(
            'group flex items-center rounded-lg py-2.5 text-sm font-medium transition-colors',
            showLabels ? 'gap-3 px-3' : 'justify-center px-2',
            pathname === '/'
              ? 'bg-accent/10 text-accent'
              : 'text-text-secondary hover:bg-surface-interactive hover:text-text-primary'
          )}
          title={collapsed ? 'Home' : undefined}
        >
          <Home size={18} className={cn('flex-shrink-0', pathname === '/' ? 'text-accent' : 'text-text-muted group-hover:text-text-primary')} />
          {showLabels && 'Home'}
        </Link>

        {navSections.map((section) => (
          <div key={section.name} className="space-y-2">
            {showLabels ? (
              <p className="px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-text-muted">{section.name}</p>
            ) : (
              <div className="mx-auto h-px w-7 bg-border" aria-hidden="true" />
            )}
            <div className="space-y-1">
              {section.items.map((item) => {
                const isActive = pathname === item.href;
                const Icon = item.icon;
                return (
                  <Link
                    id={mobile ? undefined : `tour-nav-${item.href.replace(/\W+/g, '-').replace(/^-|-$/g, '') || 'home'}`}
                    key={item.name}
                    href={item.href}
                    onClick={closeAfterNavigation}
                    className={cn(
                      'group flex items-center rounded-lg py-2.5 text-sm font-medium transition-colors',
                      showLabels ? 'gap-3 px-3' : 'justify-center px-2',
                      isActive
                        ? 'bg-accent/10 text-accent'
                        : 'text-text-secondary hover:bg-surface-interactive hover:text-text-primary'
                    )}
                    title={collapsed ? item.name : undefined}
                  >
                    <Icon size={18} className={cn('flex-shrink-0', isActive ? 'text-accent' : 'text-text-muted group-hover:text-text-primary')} />
                    {showLabels && item.name}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div id={mobile ? undefined : 'tour-sidebar-footer'} className={cn('border-t border-border', showLabels ? 'p-3' : 'p-2')}>
        <div className={cn('rounded-xl border border-border bg-surface-elevated', showLabels ? 'p-3' : 'p-2')}>
          <div className={cn('flex items-center', showLabels ? 'mb-3 gap-2' : 'justify-center')}>
            <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground">
              {initials}
            </div>
            {showLabels && (
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-text-primary">{displayEmail}</p>
                <p className="text-xs text-text-muted">Enterprise</p>
              </div>
            )}
          </div>
          <div className={cn('flex items-center', showLabels ? 'justify-between' : 'mt-2 flex-col gap-1')}>
            <button
              type="button"
              onClick={signOut}
              className={cn('flex items-center gap-1.5 rounded-md text-xs text-text-muted transition-colors hover:text-danger', showLabels ? '' : 'p-1.5')}
              aria-label="Sign out"
              title={collapsed ? 'Sign out' : undefined}
            >
              <LogOut size={14} />
              {showLabels && 'Sign out'}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-interactive hover:text-text-primary"
              title="Toggle theme"
              aria-label="Toggle theme"
            >
              {isDark ? <Sun size={14} /> : <Moon size={14} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
