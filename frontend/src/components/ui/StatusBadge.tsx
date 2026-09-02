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
  const rawStatus = typeof status === 'string' && status.trim() ? status.trim() : 'CREATED';
  // Manual evaluations use UPPER_CASE statuses; Interview Intelligence records
  // use lower_case ones. Normalising here keeps one source of truth for colour
  // so intelligence rows stop falling through to the muted "CREATED" style.
  const normalizedStatus = rawStatus.toUpperCase();

  const pillStyles: Record<string, string> = {
    CREATED: "text-text-muted border-border bg-surface/50",
    FILES_UPLOADED: "text-accent bg-accent/10 border-accent/25",
    QUEUED: "text-warning bg-warning/10 border-warning/25",
    ANALYZING: "text-info bg-info/10 border-info/25 animate-pulse",
    REVIEW_REQUIRED: "text-warning bg-warning/10 border-warning/25",
    PROCESSING: "text-warning bg-warning/10 border-warning/25 animate-pulse",
    COMPLETED: "text-success bg-success/10 border-success/25",
    PARTIAL: "text-warning bg-warning/10 border-warning/25",
    FAILED: "text-danger bg-danger/10 border-danger/25",

    // --- Interview Intelligence lifecycle ---
    DRAFT: "text-text-muted border-border bg-surface/50",
    DATA_READY: "text-info bg-info/10 border-info/25",
    QUESTIONS_GENERATED: "text-info bg-info/10 border-info/25",
    TRANSCRIPT_READY: "text-accent bg-accent/10 border-accent/25",
    SCORES_SUBMITTED: "text-accent bg-accent/10 border-accent/25",
    ANALYSIS_PROCESSING: "text-warning bg-warning/10 border-warning/25 animate-pulse",
    ANALYSIS_FAILED: "text-danger bg-danger/10 border-danger/25",
    // Report is ready but still needs a human sign-off.
    ANALYSIS_GENERATED: "text-accent bg-accent/10 border-accent/25",
    // Terminal success: signed off by a reviewer.
    APPROVED: "text-success bg-success/10 border-success/25",
  };

  const dotStyles: Record<string, string> = {
    CREATED: "text-text-muted",
    FILES_UPLOADED: "text-text-muted",
    QUEUED: "text-warning",
    ANALYZING: "text-info",
    REVIEW_REQUIRED: "text-warning",
    PROCESSING: "text-warning",
    COMPLETED: "text-success",
    PARTIAL: "text-warning",
    FAILED: "text-danger",

    DRAFT: "text-text-muted",
    DATA_READY: "text-info",
    QUESTIONS_GENERATED: "text-info",
    TRANSCRIPT_READY: "text-accent",
    SCORES_SUBMITTED: "text-accent",
    ANALYSIS_PROCESSING: "text-warning",
    ANALYSIS_FAILED: "text-danger",
    ANALYSIS_GENERATED: "text-accent",
    APPROVED: "text-success",
  };

  // Friendlier wording than the raw enum for the statuses users see most.
  const LABEL_OVERRIDES: Record<string, string> = {
    DATA_READY: 'Ready to prepare',
    QUESTIONS_GENERATED: 'Guide ready',
    TRANSCRIPT_READY: 'Transcript ready',
    SCORES_SUBMITTED: 'Scores submitted',
    ANALYSIS_PROCESSING: 'Analyzing',
    ANALYSIS_GENERATED: 'Report ready',
    ANALYSIS_FAILED: 'Analysis failed',
    REVIEW_REQUIRED: 'Needs review',
    PARTIAL: 'Validation incomplete',
  };

  const label = LABEL_OVERRIDES[normalizedStatus] || normalizedStatus.replace(/_/g, ' ');

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
