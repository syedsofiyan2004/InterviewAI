'use client';
import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import { api } from '@/lib/api';

const DEFAULT_TOUR_KEY = 'global';

function tourStorageKey(tourKey: string) {
  return `minfy_tour_done_${tourKey}`;
}

export async function checkTourStatus(tourKey = DEFAULT_TOUR_KEY): Promise<boolean> {
  try {
    const data = await api.getUserPreferences();
    return data.tour_completed === true || data.completed_tours?.[tourKey] === true;
  } catch {
    // Fallback to localStorage if API fails
    return typeof window !== 'undefined'
      && (localStorage.getItem(tourStorageKey(tourKey)) === 'true' || localStorage.getItem('minfy_tour_done') === 'true');
  }
}

export async function markTourDone(tourKey = DEFAULT_TOUR_KEY): Promise<void> {
  try {
    await api.updateUserPreferences({ tour_key: tourKey });
  } catch {
    // Fallback
  }
  if (typeof window !== 'undefined') {
    localStorage.setItem(tourStorageKey(tourKey), 'true');
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
  startTour: (steps: TourStep[], tourKey?: string) => void;
  nextStep: () => void;
  prevStep: () => void;
  endTour: () => void;
};

const TourContext = createContext<TourContextType | null>(null);

export function TourProvider({ children }: { children: ReactNode }) {
  const [steps, setSteps] = useState<TourStep[]>([]);
  const [currentStep, setCurrentStep] = useState(0);
  const [isActive, setIsActive] = useState(false);
  const [activeTourKey, setActiveTourKey] = useState(DEFAULT_TOUR_KEY);

  const startTour = useCallback((newSteps: TourStep[], tourKey = DEFAULT_TOUR_KEY) => {
    if (!newSteps.length) return;
    setSteps(newSteps);
    setCurrentStep(0);
    setActiveTourKey(tourKey);
    setIsActive(true);
  }, []);

  const nextStep = useCallback(() => {
    setCurrentStep(prev => {
      if (prev >= steps.length - 1) {
        setIsActive(false);
        markTourDone(activeTourKey); // calls API + localStorage
        return 0;
      }
      return prev + 1;
    });
  }, [steps.length, activeTourKey]);

  const prevStep = useCallback(() => {
    setCurrentStep(prev => Math.max(0, prev - 1));
  }, []);

  const endTour = useCallback(() => {
    setIsActive(false);
    markTourDone(activeTourKey); // calls API + localStorage
  }, [activeTourKey]);

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
