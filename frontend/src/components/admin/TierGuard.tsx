'use client';

import Link from 'next/link';
import { ShieldAlert } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import type { AdminTier } from '@/lib/api';
import { Skeleton } from '@/components/ui/Skeleton';
import type { ReactNode } from 'react';

interface TierGuardProps {
  minTier: AdminTier;
  children: ReactNode;
}

/**
 * Hides an admin surface from users without the required tier.
 *
 * This is presentation only. Every route behind this guard re-derives base_role
 * and tier from DynamoDB on the server, so bypassing this component (devtools,
 * a typed URL, a stale bundle) gets a 403 from the API and no data. Keeping the
 * check here as well just avoids showing a page that can only ever error.
 */
export function TierGuard({ minTier, children }: TierGuardProps) {
  const { isProfileLoading, hasTier } = useAuth();

  if (isProfileLoading) {
    return (
      <div className="space-y-5">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!hasTier(minTier)) {
    return (
      <div className="flex min-h-[420px] flex-col items-center justify-center px-6 text-center">
        <div className="mb-4 rounded-2xl bg-danger/10 p-3.5 text-danger">
          <ShieldAlert size={26} />
        </div>
        <h2 className="text-lg font-semibold text-text-primary">You do not have access to this page</h2>
        <p className="mt-1.5 max-w-md text-sm text-text-muted">
          This area requires the {minTier.toLowerCase()} access tier. If you believe this is a
          mistake, ask an owner to review your access.
        </p>
        <Link href="/" className="btn-secondary mt-5">
          Back to dashboard
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
