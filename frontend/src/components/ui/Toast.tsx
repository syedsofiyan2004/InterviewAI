'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, X, Info, TriangleAlert } from 'lucide-react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type ToastType = 'success' | 'error' | 'info' | 'warning';

interface ToastProps {
  message: string;
  type?: ToastType;
  duration?: number;
  onClose: () => void;
}

export function Toast({
  message,
  type = 'info',
  duration = 3000,
  onClose
}: ToastProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setIsVisible(true));
    const timer = setTimeout(() => {
      setIsVisible(false);
      setTimeout(onClose, 300); // Wait for exit animation
    }, duration);

    return () => {
      window.cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [duration, onClose]);

  const icons = {
    success: <CheckCircle2 size={18} className="text-success" />,
    error: <AlertCircle size={18} className="text-danger" />,
    info: <Info size={18} className="text-info" />,
    warning: <TriangleAlert size={18} className="text-warning" />
  };

  return (
    <div className={cn(
      "ui-toast fixed bottom-6 right-6 z-[100] flex items-center gap-3 rounded-xl px-4 py-3 transition-all duration-300",
      isVisible ? "opacity-100 translate-y-0 scale-100" : "opacity-0 translate-y-4 scale-95"
    )}
      role={type === 'error' ? 'alert' : 'status'}
      aria-live={type === 'error' ? 'assertive' : 'polite'}
    >
      <div className="flex-shrink-0">
        {icons[type]}
      </div>
      <p className="text-sm font-medium text-text-primary pr-2">
        {message}
      </p>
      <button 
        type="button"
        onClick={() => {
          setIsVisible(false);
          setTimeout(onClose, 300);
        }}
        className="p-0.5 rounded-md text-text-muted hover:text-text-primary transition-colors"
        aria-label="Dismiss notification"
      >
        <X size={14} />
      </button>
    </div>
  );
}
