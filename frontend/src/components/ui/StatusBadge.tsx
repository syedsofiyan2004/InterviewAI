'use client';

import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface StatusBadgeProps {
  status: string;
  variant?: 'pill' | 'dot';
  className?: string;
}

export function StatusBadge({ status, variant = 'dot', className }: StatusBadgeProps) {
  const normalizedStatus = typeof status === 'string' && status.trim() ? status : 'CREATED';
  const pillStyles: Record<string, string> = {
    CREATED: "text-text-muted border-border bg-surface/50",
    FILES_UPLOADED: "text-accent bg-accent/10 border-accent/25",
    QUEUED: "text-warning bg-warning/10 border-warning/25",
    PROCESSING: "text-warning bg-warning/10 border-warning/25 animate-pulse",
    COMPLETED: "text-success bg-success/10 border-success/25",
    FAILED: "text-danger bg-danger/10 border-danger/25",
  };

  const dotStyles: Record<string, string> = {
    CREATED: "text-text-muted",
    FILES_UPLOADED: "text-text-muted",
    QUEUED: "text-warning",
    PROCESSING: "text-warning",
    COMPLETED: "text-success",
    FAILED: "text-danger",
  };

  const label = normalizedStatus.replace(/_/g, ' ');

  if (variant === 'pill') {
    const currentStyle = pillStyles[normalizedStatus] || pillStyles.CREATED;
    return (
      <span className={cn(
        "px-2.5 py-1 rounded-full text-[10px] font-bold border uppercase tracking-wide",
        currentStyle,
        className
      )} aria-label={`Status: ${label.toLowerCase()}`}>
        {label}
      </span>
    );
  }

  const currentStyle = dotStyles[normalizedStatus] || dotStyles.CREATED;
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border border-current/15 bg-current/5 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide",
      currentStyle,
      className
    )} aria-label={`Status: ${label.toLowerCase()}`}>
      <span className="w-1.5 h-1.5 rounded-full bg-current inline-block" aria-hidden="true" />
      {label}
    </span>
  );
}
