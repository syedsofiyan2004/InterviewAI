import { Quote } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

type EvidenceTone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const toneClasses: Record<EvidenceTone, string> = {
  neutral: 'border-l-border-strong',
  success: 'border-l-success',
  warning: 'border-l-warning',
  danger: 'border-l-danger',
  accent: 'border-l-accent',
};

export function EvidenceCard({
  title,
  excerpt,
  source,
  tone = 'accent',
  className,
}: {
  title?: string;
  excerpt: string;
  source?: string;
  tone?: EvidenceTone;
  className?: string;
}) {
  return (
    <article className={cn('evidence-card', toneClasses[tone], className)}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 rounded-full bg-accent/10 p-2 text-accent">
          <Quote size={15} />
        </span>
        <div className="min-w-0 flex-1">
          {title && <p className="text-sm font-semibold text-text-primary">{title}</p>}
          <p className="mt-1 text-sm leading-6 text-text-secondary evidence-quote">{excerpt}</p>
          {source && <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{source}</p>}
        </div>
      </div>
    </article>
  );
}
