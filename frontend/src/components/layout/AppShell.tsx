'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useAuth } from '@/contexts/AuthContext';

import { TourProvider } from '@/contexts/TourContext';
import { useTour, checkTourStatus } from '@/contexts/TourContext';
import { TourOverlay } from '@/components/ui/TourOverlay';
import { CommandPalette } from '@/components/ui/CommandPalette';

const PUBLIC_PATHS = ['/login'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileNavigationOpen, setIsMobileNavigationOpen] = useState(false);
  const workspaceRef = useRef<HTMLElement>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pointerPositionRef = useRef({ x: 50, y: 42 });
  const lastRenderedPointerRef = useRef({ x: 50, y: 42 });

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));
  const isAdminArea = pathname.startsWith('/admin');

  useEffect(() => {
    if (!isLoading && !user && !isPublic) {
      router.push('/login');
    }
  }, [isLoading, user, isPublic, router]);

  useEffect(() => () => {
    if (pointerFrameRef.current) window.cancelAnimationFrame(pointerFrameRef.current);
  }, []);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={32} />
      </div>
    );
  }

  if (isPublic) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        {children}
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={32} />
      </div>
    );
  }

  return (
    <TourProvider>
      <div
        style={{
          display: 'flex',
          height: '100vh',
          overflow: 'hidden',
          '--sidebar-width': isSidebarCollapsed ? '76px' : '220px',
        } as React.CSSProperties}
      >
        <Sidebar
          collapsed={isSidebarCollapsed}
          onToggleCollapsed={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
          mobileOpen={isMobileNavigationOpen}
          onCloseMobile={() => setIsMobileNavigationOpen(false)}
        />
        <div style={{ flex: 1, minWidth: 0 }} className="flex flex-col overflow-hidden">
          <Topbar onOpenNavigation={() => setIsMobileNavigationOpen(true)} />
          <main
            ref={workspaceRef}
            className="app-workspace flex-1 overflow-y-auto p-7 lg:p-8"
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              const nextPosition = {
                x: ((event.clientX - rect.left) / rect.width) * 100,
                y: ((event.clientY - rect.top) / rect.height) * 100,
              };
              const previous = pointerPositionRef.current;
              if (Math.abs(nextPosition.x - previous.x) < 1 && Math.abs(nextPosition.y - previous.y) < 1) return;
              pointerPositionRef.current = nextPosition;

              if (pointerFrameRef.current) return;
              pointerFrameRef.current = window.requestAnimationFrame(() => {
                const workspace = workspaceRef.current;
                const rendered = lastRenderedPointerRef.current;
                const position = pointerPositionRef.current;
                if (workspace && (Math.abs(position.x - rendered.x) >= 1 || Math.abs(position.y - rendered.y) >= 1)) {
                  workspace.style.setProperty('--mx', `${position.x}%`);
                  workspace.style.setProperty('--my', `${position.y}%`);
                  lastRenderedPointerRef.current = position;
                }
                pointerFrameRef.current = null;
              });
            }}
          >
            {/* One container defines the workspace measure for every route, so the
                content edge never shifts between a list page and the create page
                beside it — including while a page is still loading. Admin keeps the
                full width because its tables need it. */}
            <div className={`relative z-10${isAdminArea ? '' : ' page-shell'}`}>
              {children}
            </div>
          </main>
        </div>
      </div>
      <AppOnboardingTour />
      <TourOverlay />
      <CommandPalette />
    </TourProvider>
  );
}

function AppOnboardingTour() {
  const pathname = usePathname();
  const { startTour, isActive } = useTour();

  useEffect(() => {
    if (isActive) return;

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const done = await checkTourStatus('app-overview');
      if (done || cancelled) return;

      startTour([
        {
          targetId: 'tour-nav-home',
          title: 'Your work hub',
          body: 'Start here to choose between HireRite, meeting minutes analysis, and cost calculator work.',
          position: 'right',
        },
        {
          targetId: 'tour-nav-my-interviews',
          title: 'My Interviews',
          body: 'Open scheduled interviews, continue past reviews, and download approved hiring reports.',
          position: 'right',
        },
        {
          targetId: 'tour-nav-mom',
          title: 'MOM projects',
          body: 'Open project workspaces to keep meeting reports grouped by project.',
          position: 'right',
        },
        {
          targetId: 'tour-nav-mom-new',
          title: 'Create a MOM project',
          body: 'Create a project first, then add one transcript or bulk upload meeting files inside that project.',
          position: 'right',
        },
      ], 'app-overview');
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pathname, startTour, isActive]);

  return null;
}
