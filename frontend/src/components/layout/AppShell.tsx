'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useAuth } from '@/contexts/AuthContext';

import { TourProvider } from '@/contexts/TourContext';
import { TourOverlay } from '@/components/ui/TourOverlay';

const PUBLIC_PATHS = ['/login'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading } = useAuth();

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
          <main className="flex-1 p-8 overflow-y-auto bg-background">
            {children}
          </main>
        </div>
      </div>
      <TourOverlay />
    </TourProvider>
  );
}
