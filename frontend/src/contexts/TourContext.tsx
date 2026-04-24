'use client';
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';

export type TourStep = {
  targetId: string;       // DOM element id to highlight
  title: string;
  body: string;
  position: 'top' | 'bottom' | 'left' | 'right';
};

type TourContextType = {
  steps: TourStep[];
  currentStep: number;
  isActive: boolean;
  startTour: (steps: TourStep[]) => void;
  nextStep: () => void;
  prevStep: () => void;
  endTour: () => void;
};

const TourContext = createContext<TourContextType | null>(null);

export function TourProvider({ children }: { children: ReactNode }) {
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [isActive, setIsActive] = useState(false);

  const startTour = useCallback((newSteps: TourStep[]) => {
    setSteps(newSteps);
    setCurrentStep(0);
    setIsActive(true);
  }, []);

  const nextStep = useCallback(() => {
    setCurrentStep(prev => {
      if (prev >= steps.length - 1) {
        setIsActive(false);
        localStorage.setItem('minfy_tour_done', 'true');
        return 0;
      }
      return prev + 1;
    });
  }, [steps.length]);

  const prevStep = useCallback(() => {
    setCurrentStep(prev => Math.max(0, prev - 1));
  }, []);

  const endTour = useCallback(() => {
    setIsActive(false);
    localStorage.setItem('minfy_tour_done', 'true');
  }, []);

  return (
    <TourContext.Provider value={{ steps, currentStep, isActive, startTour, nextStep, prevStep, endTour }}>
      {children}
    </TourContext.Provider>
  );
}

export function useTour() {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used inside TourProvider');
  return ctx;
}
