'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { X, ArrowRight, Lightbulb, ChevronLeft } from 'lucide-react';
import { useTour } from '@/contexts/TourContext';

type Rect = { top: number; left: number; width: number; height: number; right: number; bottom: number };

const TOOLTIP_W = 300;
const TOOLTIP_H = 180;
const GAP = 14;
const PULSE_COLOR = '#4F46E5';

export function TourOverlay() {
  const { steps, currentStep, isActive, nextStep, prevStep, endTour } = useTour();
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const prevElRef = useRef<HTMLElement | null>(null);

  // Inject pulse keyframes once into <head>
  useEffect(() => {
    const styleId = 'tour-pulse-style';
    if (document.getElementById(styleId)) return;
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes tourPulseRing {
        0%   { box-shadow: 0 0 0 0px ${PULSE_COLOR}55, 0 0 0 0px ${PULSE_COLOR}22; }
        50%  { box-shadow: 0 0 0 6px ${PULSE_COLOR}33, 0 0 0 12px ${PULSE_COLOR}11; }
        100% { box-shadow: 0 0 0 0px ${PULSE_COLOR}00, 0 0 0 0px ${PULSE_COLOR}00; }
      }
      .tour-pulse-target {
        outline: 2px solid ${PULSE_COLOR} !important;
        outline-offset: 4px !important;
        border-radius: 8px !important;
        animation: tourPulseRing 1.6s ease-in-out infinite !important;
        position: relative !important;
        z-index: 9999 !important;
        transition: outline 0.2s !important;
      }
    `;
    document.head.appendChild(style);
  }, []);

  const clearHighlight = useCallback(() => {
    if (prevElRef.current) {
      prevElRef.current.classList.remove('tour-pulse-target');
      prevElRef.current = null;
    }
  }, []);

  const calcTooltipPos = useCallback((rect: Rect, preferred: string) => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const pad = 12;
    const directions = [preferred, 'bottom', 'top', 'right', 'left'];

    for (const dir of directions) {
      let top = 0;
      let left = 0;

      if (dir === 'bottom') {
        top  = rect.top + rect.height + GAP;
        left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
      } else if (dir === 'top') {
        top  = rect.top - TOOLTIP_H - GAP;
        left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
      } else if (dir === 'right') {
        top  = rect.top + rect.height / 2 - TOOLTIP_H / 2;
        left = rect.right + GAP;
      } else {
        top  = rect.top + rect.height / 2 - TOOLTIP_H / 2;
        left = rect.left - TOOLTIP_W - GAP;
      }

      left = Math.max(pad, Math.min(left, vw - TOOLTIP_W - pad));
      top  = Math.max(pad, Math.min(top,  vh - TOOLTIP_H - pad));

      const fitsH = top  + TOOLTIP_H < vh - pad;
      const fitsV = left + TOOLTIP_W < vw - pad;
      if (fitsH && fitsV) return { top, left };
    }

    return {
      top:  vh / 2 - TOOLTIP_H / 2,
      left: vw / 2 - TOOLTIP_W / 2,
    };
  }, []);

  useEffect(() => {
    if (!isActive || !steps[currentStep]) {
      clearHighlight();
      setTargetRect(null);
      return;
    }

    clearHighlight();

    const step = steps[currentStep];
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout>;

    const tryFindElement = () => {
      const el = document.getElementById(step.targetId);

      if (!el) {
        // Element not in DOM yet — retry
        if (attempts < 15) {
          attempts++;
          timer = setTimeout(tryFindElement, 200);
        }
        return;
      }

      // Element found — add highlight
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('tour-pulse-target');
      prevElRef.current = el;

      // Wait for scroll to settle then measure
      timer = setTimeout(() => {
        const rect = el.getBoundingClientRect();

        // If rect is zero, element not visible yet — retry
        if (rect.width === 0 && rect.height === 0) {
          if (attempts < 15) {
            attempts++;
            el.classList.remove('tour-pulse-target');
            timer = setTimeout(tryFindElement, 200);
          }
          return;
        }

        const r = {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          right: rect.right,
          bottom: rect.bottom,
        };
        setTargetRect(r);
        setTooltipPos(calcTooltipPos(r, step.position));
      }, 400);
    };

    // Start first attempt after short delay
    timer = setTimeout(tryFindElement, 300);

    return () => {
      clearTimeout(timer);
    };
  }, [isActive, currentStep, steps, clearHighlight, calcTooltipPos]);

  useEffect(() => {
    if (!isActive) return;
    const onResize = () => {
      const step = steps[currentStep];
      if (!step) return;
      const el = document.getElementById(step.targetId);
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const r = { 
        top: rect.top, 
        left: rect.left, 
        width: rect.width, 
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      };
      setTargetRect(r);
      setTooltipPos(calcTooltipPos(r, step.position));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isActive, currentStep, steps, calcTooltipPos]);

  useEffect(() => () => clearHighlight(), [clearHighlight]);

  if (!isActive || !steps[currentStep]) return null;

  // If targetRect is null (element not found yet), show tooltip 
  // centered on screen so the user at least sees the guidance
  const rect = targetRect ?? {
    top: window.innerHeight / 2 - 20,
    left: window.innerWidth / 2 - 20,
    width: 40,
    height: 40,
    right: window.innerWidth / 2 + 20,
    bottom: window.innerHeight / 2 + 20,
  };

  const step = steps[currentStep];
  const isLast  = currentStep === steps.length - 1;
  const isFirst = currentStep === 0;

  const finalTooltipPos = targetRect ? tooltipPos : calcTooltipPos(rect, step.position);

  return (
    <>
      {/* Subtle radial vignette — NO full dark overlay */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9990,
          pointerEvents: 'none',
          background: `radial-gradient(
            ellipse 70% 60% at ${rect.left + rect.width / 2}px
            ${rect.top + rect.height / 2}px,
            transparent 40%,
            rgba(0,0,0,0.18) 100%
          )`,
        }}
      />

      {/* Tooltip card */}
      <div
        style={{
          position: 'fixed',
          top: finalTooltipPos.top,
          left: finalTooltipPos.left,
          width: TOOLTIP_W,
          zIndex: 10001,
          background: '#ffffff',
          borderRadius: 14,
          boxShadow: '0 4px 6px -1px rgba(0,0,0,0.08), 0 12px 32px rgba(0,0,0,0.14)',
          border: '1px solid #E5E7EB',
          padding: '16px 18px 14px',
          pointerEvents: 'auto',
        }}
      >
        {/* Header: step indicator + close */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              background: '#4F46E5',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Lightbulb size={12} color="#fff" />
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#4F46E5', letterSpacing: '0.02em' }}>
              Step {currentStep + 1} of {steps.length}
            </span>
          </div>
          <button
            onClick={endTour}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '2px 4px', borderRadius: 4, color: '#9CA3AF',
              display: 'flex', alignItems: 'center',
            }}
            title="Skip tour"
          >
            <X size={13} />
          </button>
        </div>

        {/* Title + body */}
        <p style={{ fontSize: 13.5, fontWeight: 700, color: '#111827', margin: '0 0 6px', lineHeight: 1.35 }}>
          {step.title}
        </p>
        <p style={{ fontSize: 12, color: '#6B7280', margin: '0 0 14px', lineHeight: 1.65 }}>
          {step.body}
        </p>

        {/* Divider */}
        <div style={{ height: 1, background: '#F3F4F6', margin: '0 -18px 12px' }} />

        {/* Footer: dots + nav buttons */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {steps.map((_, i) => (
              <div key={i} style={{
                height: 6,
                width: i === currentStep ? 18 : 6,
                borderRadius: 3,
                background: i < currentStep ? '#A5B4FC' : i === currentStep ? '#4F46E5' : '#E5E7EB',
                transition: 'all 0.25s ease',
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {!isFirst && (
              <button
                onClick={prevStep}
                style={{
                  background: 'none', border: '1px solid #E5E7EB',
                  borderRadius: 8, padding: '5px 10px',
                  fontSize: 12, fontWeight: 500, color: '#6B7280',
                  cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4,
                }}
              >
                <ChevronLeft size={12} />
                Back
              </button>
            )}
            <button
              onClick={nextStep}
              style={{
                background: '#4F46E5', color: '#fff',
                border: 'none', borderRadius: 8, padding: '6px 14px',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 5,
                boxShadow: '0 2px 8px rgba(79,70,229,0.35)',
              }}
            >
              {isLast ? 'Done ✓' : 'Next'}
              {!isLast && <ArrowRight size={12} />}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
