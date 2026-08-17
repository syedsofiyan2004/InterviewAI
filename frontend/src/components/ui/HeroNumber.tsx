import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function HeroNumber({
  value,
  suffix,
  label,
  tone = 'accent',
  className,
}: {
  value: string | number;
  suffix?: string;
  label: string;
  tone?: 'accent' | 'success' | 'warning' | 'danger' | 'neutral';
  className?: string;
}) {
  const toneClass = {
    accent: 'text-accent border-accent/30',
    success: 'text-success border-success/30',
    warning: 'text-warning border-warning/30',
    danger: 'text-danger border-danger/30',
    neutral: 'text-text-primary border-border',
  }[tone];

  return (
    <div className={cn('hero-number-card', toneClass, className)}>
      <p className="hero-number-value">
        {value}
        {suffix && <span className="ml-1 text-[0.42em] font-semibold text-text-muted">{suffix}</span>}
      </p>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide text-text-muted">{label}</p>
    </div>
  );
}
