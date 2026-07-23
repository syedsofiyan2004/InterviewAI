'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: 'danger' | 'info';
}

export function ConfirmDialog({
  isOpen,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  onConfirm,
  onCancel,
  variant = 'danger'
}: ConfirmDialogProps) {
  const [isVisible, setIsVisible] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const timer = isOpen
      ? window.requestAnimationFrame(() => setIsVisible(true))
      : window.setTimeout(() => setIsVisible(false), 200);

    return () => {
      if (isOpen) window.cancelAnimationFrame(timer);
      else window.clearTimeout(timer);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    lastFocusedElementRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const focusTimer = window.setTimeout(() => cancelButtonRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = previousOverflow;
      window.setTimeout(() => lastFocusedElementRef.current?.focus(), 0);
    };
  }, [isOpen, onCancel]);

  if (!isOpen && !isVisible) return null;

  return (
    <div className={cn(
      "fixed inset-0 z-50 flex items-center justify-center p-4 transition-opacity duration-200",
      isOpen ? "opacity-100" : "opacity-0"
    )}>
      <div
        className="absolute inset-0 bg-background/80"
        onClick={onCancel}
        aria-hidden="true"
      />
      
      <div
        ref={dialogRef}
        role={variant === 'danger' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className={cn(
        "ui-panel relative w-full max-w-md rounded-2xl p-6 transition-all duration-200",
        isOpen ? "scale-100 translate-y-0" : "scale-95 translate-y-4"
      )}>
        <button 
          type="button"
          onClick={onCancel}
          className="absolute top-4 right-4 p-1 rounded-md text-text-muted hover:text-text-primary transition-colors"
          aria-label="Close confirmation dialog"
        >
          <X size={18} />
        </button>

        <div className="flex gap-4">
          <div className={cn(
            "flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center",
            variant === 'danger' ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"
          )}>
            <AlertTriangle size={20} />
          </div>

          <div className="flex-1 pt-1">
            <h3 id={titleId} className="text-lg font-semibold text-text-primary">{title}</h3>
            <p id={descriptionId} className="text-sm text-text-secondary mt-2 leading-relaxed">
              {description}
            </p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 mt-8">
          <button
            ref={cancelButtonRef}
            type="button"
            onClick={onCancel}
            className="btn-secondary px-4 py-2 text-sm font-medium"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className={cn(
              "px-4 py-2 text-sm font-semibold text-white rounded-lg transition-all shadow-sm",
              variant === 'danger' ? "bg-danger hover:bg-danger/90" : "bg-accent hover:bg-accent/90"
            )}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
