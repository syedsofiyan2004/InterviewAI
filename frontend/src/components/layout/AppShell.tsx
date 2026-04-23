'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loader2 } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { useAuth } from '@/contexts/AuthContext';

const PUBLIC_PATHS = ['/login'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, isLoading } = useAuth();

  const isPublic = PUBLIC_PATHS.some((p) => pathname.startsWith(p));

  // Client-side auth guard — runs after Cognito session check resolves
  useEffect(() => {
    if (!isLoading && !user && !isPublic) {
      router.push('/login');
    }
  }, [isLoading, user, isPublic, router]);

  // ── Loading state ──────────────────────────────────────────────────────────
  // Block ALL page rendering until we know the auth state.
  // This is what prevents pages from mounting and calling authFetch
  // before we know whether the user is signed in.
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={32} />
      </div>
    );
  }

  // ── Public routes (login, etc.) ────────────────────────────────────────────
  if (isPublic) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        {children}
      </div>
    );
  }

  // ── Unauthenticated on a protected route ───────────────────────────────────
  // Show spinner while useEffect redirect fires
  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="animate-spin text-accent" size={32} />
      </div>
    );
  }

  // ── Authenticated app shell ────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar />
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar />
        <main className="flex-1 p-8 overflow-y-auto">
          {children}
        </main>
      </div>
    </div>
  );
}
