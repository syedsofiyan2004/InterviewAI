'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';

interface BackButtonProps {
  defaultHref: string;
  defaultLabel: string;
  className?: string;
}

export function BackButton({ defaultHref, defaultLabel, className }: BackButtonProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const fromParam = searchParams.get('from');

  let href = defaultHref;
  let label = defaultLabel;

  if (fromParam) {
    href = fromParam;
    if (fromParam.includes('/admin/interviews')) {
      label = 'Admin Interviews';
    } else if (fromParam.includes('/admin/moms')) {
      label = 'Admin Meetings';
    } else if (fromParam.includes('/admin/candidates/view')) {
      label = 'Review Workspace';
    } else if (fromParam.includes('/admin/candidates')) {
      label = 'Review Workspaces';
    } else if (fromParam.includes('/admin/search')) {
      label = 'Admin Search';
    } else if (fromParam.includes('/admin/approvals')) {
      label = 'Decision Queue';
    } else if (fromParam.includes('/admin')) {
      label = 'Admin Overview';
    } else if (fromParam.includes('/interviews/intelligence')) {
      label = 'HireRite';
    } else if (fromParam.includes('/interviews')) {
      label = 'HireRite';
    } else if (fromParam.includes('/mom')) {
      label = 'Meetings';
    } else if (fromParam.includes('/candidates')) {
      label = 'Review Workspaces';
    }
  }

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (fromParam && typeof window !== 'undefined' && window.history.length > 1) {
      e.preventDefault();
      router.back();
    }
  };

  return (
    <Link
      href={href}
      onClick={handleClick}
      className={
        className ||
        'inline-flex items-center gap-2 rounded-lg border border-border bg-surface-elevated px-3.5 py-2 text-xs font-semibold text-text-primary transition-colors hover:bg-surface-interactive hover:border-accent/40'
      }
    >
      <ArrowLeft size={15} className="text-accent" />
      <span>Back to {label}</span>
    </Link>
  );
}
