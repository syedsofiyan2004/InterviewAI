'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { X, ArrowRight, Lightbulb, ChevronLeft } from 'lucide-react';
import { useTour } from '@/contexts/TourContext';

type Rect = { top: number; left: number; width: number; height: number; right: number; bottom: number };

const TOOLTIP_W = 300;
const TOOLTIP_H = 180;
const GAP = 12;
const PULSE_COLOR = '#267A6B';

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
        outline-offset: 5px !important;
        border-radius: 10px !important;
        animation: tourPulseRing 1.15s ease-in-out infinite !important;
        position: relative !important;
        z-index: 9999 !important;
        transition: outline 120ms ease, box-shadow 120ms ease !important;
      }
      .tour-tooltip-card {
        opacity: 0;
        transform: translate3d(0, 8px, 0) scale(0.985);
        animation: tourTooltipIn 160ms cubic-bezier(.2,.8,.2,1) forwards;
        transition: top 140ms cubic-bezier(.2,.8,.2,1), left 140ms cubic-bezier(.2,.8,.2,1);
      }
      .tour-vignette {
        opacity: 0;
        animation: tourVignetteIn 140ms ease-out forwards;
        transition: background 140ms ease-out;
      }
      @keyframes tourTooltipIn {
        to { opacity: 1; transform: translate3d(0, 0, 0) scale(1); }
      }
      @keyframes tourVignetteIn {
        to { opacity: 1; }
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
          timer = setTimeout(tryFindElement, 80);
        }
        return;
      }

      // Element found — add highlight
      el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
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
            timer = setTimeout(tryFindElement, 80);
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
      }, 40);
    };

    timer = setTimeout(tryFindElement, 40);

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
        className="tour-vignette"
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
        className="tour-tooltip-card"
        style={{
          position: 'fixed',
          top: finalTooltipPos.top,
          left: finalTooltipPos.left,
          width: TOOLTIP_W,
          zIndex: 10001,
          background: 'hsl(222 47% 12% / 0.96)',
          borderRadius: 16,
          boxShadow: '0 24px 72px rgba(0,0,0,0.38), inset 0 1px 0 rgba(255,255,255,0.06)',
          border: '1px solid hsl(217 33% 20%)',
          padding: '16px 18px 14px',
          pointerEvents: 'auto',
        }}
      >
        {/* Header: step indicator + close */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{
              width: 22, height: 22, borderRadius: 6,
              background: 'hsl(166 52% 58%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Lightbulb size={12} color="#fff" />
            </div>
            <span style={{ fontSize: 11, fontWeight: 600, color: 'hsl(166 52% 58%)', letterSpacing: '0.02em' }}>
              Step {currentStep + 1} of {steps.length}
            </span>
          </div>
          <button
            onClick={endTour}
            style={{
              background: 'none', border: 'none', cursor: 'pointer',
              padding: '2px 4px', borderRadius: 4, color: 'hsl(215 16% 47%)',
              display: 'flex', alignItems: 'center',
            }}
            title="Skip tour"
          >
            <X size={13} />
          </button>
        </div>

        {/* Title + body */}
        <p style={{ fontSize: 13.5, fontWeight: 700, color: 'hsl(210 40% 98%)', margin: '0 0 6px', lineHeight: 1.35 }}>
          {step.title}
        </p>
        <p style={{ fontSize: 12, color: 'hsl(215 20% 75%)', margin: '0 0 14px', lineHeight: 1.65 }}>
          {step.body}
        </p>

        {/* Divider */}
        <div style={{ height: 1, background: 'hsl(217 33% 20%)', margin: '0 -18px 12px' }} />

        {/* Footer: dots + nav buttons */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            {steps.map((_, i) => (
              <div key={i} style={{
                height: 6,
                width: i === currentStep ? 18 : 6,
                borderRadius: 3,
                background: i < currentStep ? 'hsl(166 52% 66%)' : i === currentStep ? 'hsl(166 52% 58%)' : 'hsl(217 33% 20%)',
                transition: 'all 0.25s ease',
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {!isFirst && (
              <button
                onClick={prevStep}
                style={{
                  background: 'transparent', border: '1px solid hsl(217 33% 20%)',
                  borderRadius: 8, padding: '5px 10px',
                  fontSize: 12, fontWeight: 500, color: 'hsl(215 20% 75%)',
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
                background: 'hsl(166 52% 58%)', color: 'hsl(170 80% 8%)',
                border: 'none', borderRadius: 8, padding: '6px 14px',
                fontSize: 12, fontWeight: 600, cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 5,
                boxShadow: '0 12px 26px rgba(38,122,107,0.24)',
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
