'use client';

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { WorkspaceStatus } from '@/lib/api';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Deliberately separate from StatusBadge: workspace status is a decision state
// (open → in review → approved/rejected), not a processing state, and reusing
// the processing palette would make "APPROVED" look like "COMPLETED".
const STYLES: Record<WorkspaceStatus, string> = {
  OPEN: 'text-text-muted border-border bg-surface/50',
  IN_REVIEW: 'text-warning bg-warning/10 border-warning/25',
  APPROVED: 'text-success bg-success/10 border-success/25',
  REJECTED: 'text-danger bg-danger/10 border-danger/25',
};

export function WorkspaceStatusBadge({ status, className }: { status: WorkspaceStatus; className?: string }) {
  const label = status.replace(/_/g, ' ');
  return (
    <span
      className={cn(
        'rounded-full border px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide',
        STYLES[status] ?? STYLES.OPEN,
        className,
      )}
      aria-label={`Status: ${label.toLowerCase()}`}
    >
      {label}
    </span>
  );
}
