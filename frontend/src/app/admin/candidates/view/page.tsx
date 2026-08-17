'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CandidateDetail } from '@/components/workspace/CandidateDetail';
import { TierGuard } from '@/components/admin/TierGuard';
import { Skeleton } from '@/components/ui/Skeleton';

// useSearchParams needs a Suspense boundary; the static export prerenders this
// page shell and fills the query string on the client. Dynamic segments are not
// available under output: 'export', so the id travels as ?id=.
function AdminCandidateView() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');

  if (!id) {
    return (
      <div className="card flex min-h-[280px] flex-col items-center justify-center p-6 text-center">
        <p className="text-sm font-medium text-text-primary">No review workspace selected</p>
        <Link href="/admin/candidates" className="btn-secondary mt-4">Review workspaces</Link>
      </div>
    );
  }

  return (
    <CandidateDetail workspaceId={id} backHref="/admin/candidates" backLabel="Review workspaces" />
  );
}

export default function AdminCandidateViewPage() {
  return (
    <TierGuard minTier="VIEWER">
      <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
        <AdminCandidateView />
      </Suspense>
    </TierGuard>
  );
}
