'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CandidateDetail } from '@/components/workspace/CandidateDetail';
import { Skeleton } from '@/components/ui/Skeleton';

// The static export has no dynamic segments, so the id arrives as ?id= and
// useSearchParams needs a Suspense boundary above it.
function CandidateView() {
  const searchParams = useSearchParams();
  const id = searchParams.get('id');

  if (!id) {
    return (
      <div className="card flex min-h-[280px] flex-col items-center justify-center p-6 text-center">
        <p className="text-sm font-medium text-text-primary">No review workspace selected</p>
        <Link href="/candidates" className="btn-secondary mt-4">Back to review workspaces</Link>
      </div>
    );
  }

  return <CandidateDetail workspaceId={id} backHref="/candidates" backLabel="Review workspaces" />;
}

export default function CandidateViewPage() {
  return (
    <Suspense fallback={<Skeleton className="h-64 rounded-xl" />}>
      <CandidateView />
    </Suspense>
  );
}
