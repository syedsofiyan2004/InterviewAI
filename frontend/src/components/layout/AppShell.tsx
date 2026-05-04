'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useAuth } from '@/contexts/AuthContext';

import { TourProvider } from '@/contexts/TourContext';
import { useTour, checkTourStatus } from '@/contexts/TourContext';
import { TourOverlay } from '@/components/ui/TourOverlay';

const PUBLIC_PATHS = ['/login'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const [pointer, setPointer] = useState({ x: 55, y: 35 });

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  useEffect(() => {
    if (!isLoading && !user && !isPublic) {
      router.push('/login');
    }
  }, [isLoading, user, isPublic, router]);

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
      <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
        <Sidebar />
        <div style={{ flex: 1, minWidth: 0 }} className="flex flex-col overflow-hidden">
          <Topbar />
          <main
            className="app-workspace flex-1 overflow-y-auto p-6 lg:p-7"
            onMouseMove={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setPointer({
                x: ((event.clientX - rect.left) / rect.width) * 100,
                y: ((event.clientY - rect.top) / rect.height) * 100,
              });
            }}
            style={{ '--mx': `${pointer.x}%`, '--my': `${pointer.y}%` } as React.CSSProperties}
          >
            {children}
          </main>
        </div>
      </div>
      <AppOnboardingTour />
      <TourOverlay />
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
          body: 'Start here to choose between interview evaluation and meeting minutes analysis.',
          position: 'right',
        },
        {
          targetId: 'tour-nav-interviews',
          title: 'Interview Evaluator',
          body: 'Open evaluations to score candidates, review evidence, and download interview reports.',
          position: 'right',
        },
        {
          targetId: 'tour-nav-interviews-new',
          title: 'Create an evaluation',
          body: 'Use this when you want to upload a transcript, job description, and optional resume for a new candidate.',
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
        {
          targetId: 'tour-nav-tf-generator',
          title: 'TF Generator',
          body: 'Use this production review workspace to parse AWS prerequisite workbooks, validate resources, and review Terraform before controlled deployment.',
          position: 'right',
        },
      ], 'app-overview');
    }, 900);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pathname, startTour, isActive]);

  return null;
}
