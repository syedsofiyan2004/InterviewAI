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
    CREATED: "text-text-muted border-border bg-surface/30",
    FILES_UPLOADED: "text-blue-600 bg-blue-50/50 border-blue-100 dark:text-blue-400 dark:bg-blue-900/10 dark:border-blue-900/30",
    QUEUED: "text-amber-600 bg-amber-50/50 border-amber-100 dark:text-amber-400 dark:bg-amber-900/10 dark:border-amber-900/30",
    PROCESSING: "text-amber-600 bg-amber-50/50 border-amber-100 dark:text-amber-400 dark:bg-amber-900/10 dark:border-amber-900/30 animate-pulse",
    COMPLETED: "text-green-600 bg-green-50/50 border-green-100 dark:text-green-400 dark:bg-green-900/10 dark:border-green-900/30",
    FAILED: "text-red-600 bg-red-50/50 border-red-100 dark:text-red-400 dark:bg-red-900/10 dark:border-red-900/30",
  };

  const dotStyles: Record<string, string> = {
    CREATED: "text-text-muted",
    FILES_UPLOADED: "text-text-muted",
    QUEUED: "text-amber-500",
    PROCESSING: "text-amber-500",
    COMPLETED: "text-green-500 dark:text-green-400",
    FAILED: "text-red-500",
  };

  const label = normalizedStatus.replace(/_/g, ' ');

  if (variant === 'pill') {
    const currentStyle = pillStyles[normalizedStatus] || pillStyles.CREATED;
    return (
      <span className={cn(
        "px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wide",
        currentStyle,
        className
      )}>
        {label}
      </span>
    );
  }

  const currentStyle = dotStyles[normalizedStatus] || dotStyles.CREATED;
  return (
    <span className={cn(
      "flex items-center gap-1.5 text-xs font-semibold",
      currentStyle,
      className
    )}>
      <span className="w-1.5 h-1.5 rounded-full bg-current inline-block" />
      {label}
    </span>
  );
}
