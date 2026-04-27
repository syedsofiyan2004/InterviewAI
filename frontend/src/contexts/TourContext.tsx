'use client';
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { api } from '@/lib/api';

export async function checkTourStatus(): Promise<boolean> {
  try {
    const data = await api.getUserPreferences();
    return data.tour_completed === true;
  } catch {
    // Fallback to localStorage if API fails
    return typeof window !== 'undefined' && localStorage.getItem('minfy_tour_done') === 'true';
  }
}

export async function markTourDone(): Promise<void> {
  try {
    await api.updateUserPreferences({ tour_completed: true });
  } catch {
    // Fallback
  }
  if (typeof window !== 'undefined') {
    localStorage.setItem('minfy_tour_done', 'true');
  }
}

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
        markTourDone(); // calls API + localStorage
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
    markTourDone(); // calls API + localStorage
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
