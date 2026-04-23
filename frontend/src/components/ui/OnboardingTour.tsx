'use client';

import { useState, useEffect, useCallback } from 'react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Step {
  targetId: string;
  title: string;
  body: string;
}

const steps: Step[] = [
  {
    targetId: 'tour-stats',
    title: 'Your evaluation hub',
    body: 'All your interview evaluations live here. Each card shows a live count by status.',
  },
  {
    targetId: 'tour-new-btn',
    title: 'Start an evaluation',
    body: "Click here to begin. You'll enter candidate details, upload the interview transcript and job description, then trigger the AI analysis.",
  },
  {
    targetId: 'tour-table',
    title: 'Track every candidate',
    body: 'Your evaluations appear here sorted by date. Click any row to see the full AI assessment report.',
  },
  {
    targetId: 'tour-sidebar-footer',
    title: 'Your workspace',
    body: 'Toggle dark mode, or sign out here. Your session is secured by AWS Cognito.',
  },
];

export function OnboardingTour() {
  const [currentStep, setCurrentStep] = useState(0);
  const [isVisible, setIsVisible] = useState(false);
  const [spotlightRect, setSpotlightRect] = useState<DOMRect | null>(null);

  const completeTour = useCallback(() => {
    localStorage.setItem('interviewai_tour_complete', 'true');
    setIsVisible(false);
    // Cleanup highlight class
    steps.forEach(step => {
      document.getElementById(step.targetId)?.classList.remove('tour-highlight');
    });
  }, []);

  useEffect(() => {
    const isComplete = localStorage.getItem('interviewai_tour_complete');
    if (!isComplete) {
      // Delay slightly to ensure elements are rendered
      const timer = setTimeout(() => setIsVisible(true), 1000);
      return () => clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    if (!isVisible) return;

    const step = steps[currentStep];
    const element = document.getElementById(step.targetId);

    if (element) {
      const rect = element.getBoundingClientRect();
      setSpotlightRect(rect);
      
      // Clear other highlights
      steps.forEach(s => {
        document.getElementById(s.targetId)?.classList.remove('tour-highlight');
      });
      // Add highlight to current
      element.classList.add('tour-highlight');

      // Scroll into view if needed
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentStep, isVisible]);

  if (!isVisible || !spotlightRect) return null;

  const step = steps[currentStep];
  const isLastStep = currentStep === steps.length - 1;

  // Calculate tooltip position (relative to fixed viewport container)
  const tooltipTop = spotlightRect.bottom + 12;
  const tooltipLeft = Math.max(16, Math.min(window.innerWidth - 340, spotlightRect.left));

  return (
    <div className="fixed inset-0 z-[100] pointer-events-none">
      {/* Background Overlay */}
      <div 
        className="absolute inset-0 bg-black/40 pointer-events-auto" 
        style={{ 
          clipPath: `polygon(
            0% 0%, 0% 100%, 
            ${spotlightRect.left}px 100%, 
            ${spotlightRect.left}px ${spotlightRect.top}px, 
            ${spotlightRect.right}px ${spotlightRect.top}px, 
            ${spotlightRect.right}px ${spotlightRect.bottom}px, 
            ${spotlightRect.left}px ${spotlightRect.bottom}px, 
            ${spotlightRect.left}px 100%, 
            100% 100%, 100% 0%
          )` 
        }} 
      />

      {/* Tooltip Card */}
      <div 
        className="absolute z-[101] max-w-xs w-[calc(100vw-32px)] pointer-events-auto transition-all duration-300"
        style={{ 
          top: tooltipTop > window.innerHeight - 220 ? spotlightRect.top - 180 : tooltipTop,
          left: tooltipLeft 
        }}
      >
        <div className="bg-surface-elevated border border-accent rounded-xl p-5 shadow-2xl space-y-4">
          <div className="space-y-1">
            <h3 className="text-base font-bold text-text-primary">{step.title}</h3>
            <p className="text-sm text-text-secondary leading-relaxed">{step.body}</p>
          </div>
          
          <div className="flex items-center justify-between pt-2">
            <button 
              onClick={completeTour}
              className="text-xs text-text-muted hover:text-text-primary transition-colors font-medium"
            >
              Skip tour
            </button>
            <div className="flex items-center gap-3">
              <span className="text-[10px] font-semibold text-text-muted">
                {currentStep + 1} of {steps.length}
              </span>
              <button 
                onClick={() => isLastStep ? completeTour() : setCurrentStep(prev => prev + 1)}
                className="px-4 py-2 bg-accent text-accent-foreground text-xs font-bold rounded-lg hover:opacity-90 transition-all flex items-center gap-1.5"
              >
                {isLastStep ? 'Got it' : (
                  <>
                    Next
                    <span className="text-lg leading-none">→</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
        {/* Subtle arrow pointing to element */}
        <div 
          className={cn(
            "absolute w-3 h-3 bg-surface-elevated border-l border-t border-accent rotate-45 transition-all duration-300",
            tooltipTop > window.innerHeight - 200 ? "bottom-[-7px] border-l-0 border-t-0 border-r border-b" : "top-[-7px]"
          )}
          style={{ left: Math.min(spotlightRect.width / 2 + (spotlightRect.left - tooltipLeft), 280) }}
        />
      </div>

      <style jsx global>{`
        .tour-highlight {
          position: relative !important;
          z-index: 101 !important;
          outline: 2px solid var(--accent) !important;
          outline-offset: 4px !important;
        }
      `}</style>
    </div>
  );
}
