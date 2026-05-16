"use client";

/**
 * v1.4.15 Phase B5 — onboarding spotlight tour.
 *
 * After a new user finishes the wizard at `/onboarding` and lands on
 * the dashboard, this overlay walks them through 4–5 key features
 * (tile strip, quick-add menu, insights, integrations, achievements).
 *
 * Architecture decisions:
 * - **No new dependency.** Project package.json carries no
 *   `react-joyride`/`intro.js`/`shepherd` already, and the tour is
 *   small enough that an in-house spotlight + tooltip is preferable
 *   to a 30 KB add. We render a fixed full-viewport overlay with a
 *   dark backdrop and one rectangular cutout aligned to the live
 *   target via measured `getBoundingClientRect()`. The tooltip is
 *   absolutely positioned next to the cutout.
 * - **`data-tour-id` not class names.** Targets are looked up by a
 *   stable data attribute that's not affected by Tailwind churn.
 *   Each target's location is re-measured on `resize` and `scroll`
 *   so the cutout follows the element.
 * - **Graceful degradation.** If the target element is missing
 *   (mobile breakpoint, conditional render), we drop the cutout and
 *   render the tooltip centred on screen so the user can still
 *   advance through the tour.
 * - **Accessibility:** the dialog uses `role="dialog"` +
 *   `aria-modal="true"` + `aria-labelledby`, focus moves to the
 *   primary action on every step, ESC = skip, Tab is trapped inside
 *   the tooltip, and a live region announces the step transition.
 *   `prefers-reduced-motion` disables the cutout fade.
 *
 * The component is mounted by a sibling launcher that decides *when*
 * to start the tour (server flag + localStorage). This component
 * itself is dumb — caller hands it `onClose` (called on Skip OR Done)
 * plus `outcome` (so the launcher can persist `completed` vs
 * `skipped` to the API + audit log).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import {
  buildTourStops,
  currentStop,
  initTourState,
  isTourFinished,
  nextStep,
  prevStep,
  skipTour,
  stepCounter,
  type TourStop,
} from "@/lib/onboarding/tour-state";

interface TourProps {
  /**
   * Whether the achievements page exists and should be a tour stop.
   * The launcher passes `false` if B4 hasn't shipped to skip the
   * stop without renumbering.
   */
  includeAchievements?: boolean;
  /**
   * Called when the tour finishes (Done OR Skip OR Esc OR Backdrop
   * click). Receives the terminal outcome so the launcher can audit
   * the difference.
   */
  onClose: (outcome: "completed" | "skipped") => void;
}

interface SpotlightRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Re-measure the target element. Returns `null` if the element is
 * not in the DOM or has zero dimensions — caller renders a centred
 * tooltip in that case.
 */
function measureTarget(targetId: string | null): SpotlightRect | null {
  if (!targetId) return null;
  if (typeof document === "undefined") return null;
  const el = document.querySelector<HTMLElement>(
    `[data-tour-id="${CSS.escape(targetId)}"]`,
  );
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  // Pad the cutout slightly so the highlight isn't flush against
  // the target's text.
  const PAD = 8;
  return {
    top: rect.top - PAD,
    left: rect.left - PAD,
    width: rect.width + PAD * 2,
    height: rect.height + PAD * 2,
  };
}

/**
 * Decide tooltip position. The intent is to sit beside the target
 * along the requested axis, but flip to the opposite edge if there
 * isn't enough room. Returns absolute viewport coordinates that the
 * UI uses with `position: fixed`. Falls back to centred when there
 * is no spotlight rect.
 */
function computeTooltipPosition(
  rect: SpotlightRect | null,
  placement: TourStop["placement"],
  tooltipSize: { width: number; height: number },
): { top: number; left: number; placement: TourStop["placement"] } {
  if (typeof window === "undefined") return { top: 0, left: 0, placement };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!rect) {
    return {
      top: Math.max(16, (vh - tooltipSize.height) / 2),
      left: Math.max(16, (vw - tooltipSize.width) / 2),
      placement: "center",
    };
  }
  const GAP = 12;
  const candidates: Array<{
    placement: TourStop["placement"];
    top: number;
    left: number;
  }> = [];

  if (placement === "bottom" || placement === "top" || placement === "center") {
    candidates.push({
      placement: "bottom",
      top: rect.top + rect.height + GAP,
      left: Math.min(
        Math.max(16, rect.left + rect.width / 2 - tooltipSize.width / 2),
        vw - tooltipSize.width - 16,
      ),
    });
    candidates.push({
      placement: "top",
      top: rect.top - tooltipSize.height - GAP,
      left: Math.min(
        Math.max(16, rect.left + rect.width / 2 - tooltipSize.width / 2),
        vw - tooltipSize.width - 16,
      ),
    });
  }
  if (placement === "right" || placement === "left") {
    candidates.push({
      placement: "right",
      top: Math.min(
        Math.max(16, rect.top + rect.height / 2 - tooltipSize.height / 2),
        vh - tooltipSize.height - 16,
      ),
      left: rect.left + rect.width + GAP,
    });
    candidates.push({
      placement: "left",
      top: Math.min(
        Math.max(16, rect.top + rect.height / 2 - tooltipSize.height / 2),
        vh - tooltipSize.height - 16,
      ),
      left: rect.left - tooltipSize.width - GAP,
    });
  }
  // Pick the first candidate that fits the viewport; otherwise the
  // first candidate (the renderer will clamp inside the box).
  for (const c of candidates) {
    if (
      c.top >= 8 &&
      c.left >= 8 &&
      c.top + tooltipSize.height <= vh - 8 &&
      c.left + tooltipSize.width <= vw - 8
    ) {
      return c;
    }
  }
  // Last-resort: centred bottom of viewport.
  return {
    placement: "center",
    top: Math.max(16, (vh - tooltipSize.height) / 2),
    left: Math.max(16, (vw - tooltipSize.width) / 2),
  };
}

const TOOLTIP_WIDTH = 320;
const TOOLTIP_HEIGHT = 220; // enough headroom for two-line title + 4-line body + footer

export function OnboardingTour({
  includeAchievements = true,
  onClose,
}: TourProps) {
  const { t } = useTranslations();

  const stops = useMemo(
    () => buildTourStops({ includeAchievements }),
    [includeAchievements],
  );
  const [state, setState] = useState(() => initTourState(stops));
  const [rect, setRect] = useState<SpotlightRect | null>(null);

  const stop = currentStop(state);

  // Re-measure on step change, viewport resize, and scroll. We intentionally
  // *don't* MutationObserver the whole document — the targets are stable in
  // the layout and re-measuring on rAF after scroll/resize is plenty.
  useEffect(() => {
    if (!stop) return;
    let raf = 0;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setRect(measureTarget(stop.targetId));
      });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [stop]);

  // Focus management — moves focus to the primary action when the
  // step changes so keyboard users can hit Enter to advance. The
  // tooltip ref + `previousFocus` carry the focus-trap contract: tab
  // cycles inside the tooltip, and on close the originally-focused
  // element (e.g. the Settings → Account "Restart" button) regains
  // focus.
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!stop) return;
    primaryRef.current?.focus();
  }, [stop]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    return () => {
      previousFocusRef.current?.focus?.();
    };
  }, []);

  // Keyboard shortcuts: Esc = skip, ArrowLeft / ArrowRight = nav,
  // Enter = next/done. We attach to window so the listener works
  // regardless of which element holds focus inside the tooltip.
  const handleSkip = useCallback(() => {
    setState((prev) => {
      const next = skipTour(prev);
      if (isTourFinished(next)) {
        // Defer the parent onClose so it doesn't run inside the
        // setState callback (which React calls during render in
        // strict-mode dev).
        queueMicrotask(() => onClose("skipped"));
      }
      return next;
    });
  }, [onClose]);

  const handleNext = useCallback(() => {
    setState((prev) => {
      const next = nextStep(prev);
      if (isTourFinished(next) && next.outcome === "completed") {
        queueMicrotask(() => onClose("completed"));
      }
      return next;
    });
  }, [onClose]);

  const handlePrev = useCallback(() => {
    setState((prev) => prevStep(prev));
  }, []);

  useEffect(() => {
    if (!stop) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        handleSkip();
      } else if (e.key === "Tab") {
        // Trap focus inside the tooltip so the user can't tab onto the
        // dimmed page underneath while the tour is active.
        const root = tooltipRef.current;
        if (!root) return;
        const focusables = Array.from(
          root.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey) {
          if (active === first || !root.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else if (active === last) {
          e.preventDefault();
          first.focus();
        }
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        // Don't hijack Enter inside form inputs (none exist in the
        // tour itself but be defensive against future content).
        const target = e.target as HTMLElement | null;
        if (
          target &&
          (target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.isContentEditable)
        ) {
          return;
        }
        e.preventDefault();
        handleNext();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrev();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stop, handleSkip, handleNext, handlePrev]);

  if (!stop) return null;

  const counter = stepCounter(state);
  const isLast = counter.current === counter.total;
  const tooltipPos = computeTooltipPosition(rect, stop.placement, {
    width: TOOLTIP_WIDTH,
    height: TOOLTIP_HEIGHT,
  });

  // v1.4.33 F2 — onboarding overlay was a single full-viewport `<button>`
  // with a `clip-path` punching a hole around the spotlight. The clip-path
  // only changed PAINT — the button's hit-box still covered every pixel,
  // so every click on the underlying page (Hinzufügen, sidebar links,
  // header avatar) hit the dim layer and triggered Skip without forwarding
  // the click to the real target. New users were effectively locked out.
  //
  // Initial fix (f9b8f3bd) split the dim into four rectangles around the
  // spotlight with `pointer-events: auto` + an `onClick={handleSkip}` on
  // each. That made the spotlight region click-through but kept blocking
  // every other interactive element on the page (the header sits ABOVE
  // the tile-strip spotlight, so the top dim strip still ate the click on
  // the Hinzufügen dropdown — the very target the F2 audit named).
  //
  // The right contract: the dim is purely VISUAL. The whole tour layer is
  // `pointer-events: none`, and only the tooltip card opts back into hit
  // testing. Skip lives where users expect it — the explicit "Skip tour"
  // button in the tooltip footer. The page underneath stays fully usable,
  // matching the spotlight-tour conventions used by Joyride, Shepherd,
  // and Intro.js. The four-panel split survives because it still serves
  // the visual purpose of NOT dimming the spotlighted target, but the
  // panels are now non-interactive `<div>`s without their own click
  // handlers.
  const backdropClass =
    "pointer-events-none absolute bg-black/70 transition-opacity duration-150 motion-reduce:transition-none";
  const vw = typeof window !== "undefined" ? window.innerWidth : 0;
  const vh = typeof window !== "undefined" ? window.innerHeight : 0;
  const dimRects = rect
    ? [
        // Top strip — full width above spotlight.
        rect.top > 0
          ? { top: 0, left: 0, width: vw, height: rect.top }
          : null,
        // Bottom strip — full width below spotlight.
        rect.top + rect.height < vh
          ? {
              top: rect.top + rect.height,
              left: 0,
              width: vw,
              height: vh - (rect.top + rect.height),
            }
          : null,
        // Left strip — only the band beside the spotlight.
        rect.left > 0
          ? {
              top: rect.top,
              left: 0,
              width: rect.left,
              height: rect.height,
            }
          : null,
        // Right strip — only the band beside the spotlight.
        rect.left + rect.width < vw
          ? {
              top: rect.top,
              left: rect.left + rect.width,
              width: vw - (rect.left + rect.width),
              height: rect.height,
            }
          : null,
      ].filter((r): r is { top: number; left: number; width: number; height: number } => r !== null)
    : null;

  return (
    <div
      data-testid="onboarding-tour"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-tour-title"
      // `pointer-events-none` on the root: the outer container does NOT
      // capture clicks. Only the tooltip card opts back in via
      // `pointer-events-auto` below. This guarantees that every pixel of
      // the underlying page — both inside AND outside the spotlight —
      // passes pointer events through normally; the tour is purely a
      // visual overlay with its own self-contained controls.
      className="pointer-events-none fixed inset-0 z-[200]"
    >
      {/* Spotlight outline — purely visual ring around the highlighted
          target. */}
      {rect ? (
        <div
          aria-hidden="true"
          data-testid="onboarding-tour-spotlight"
          className="ring-primary/80 pointer-events-none absolute rounded-lg ring-2 ring-offset-2 ring-offset-transparent"
          style={{
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            height: `${rect.height}px`,
          }}
        />
      ) : null}

      {/* Dim panels — purely visual. Each panel sits OUTSIDE the spotlight
          rect so the spotlighted target keeps its full brightness. The
          panels are `pointer-events-none` so the page underneath stays
          fully clickable: the user can drive the Hinzufügen dropdown,
          sidebar links, or header avatar mid-tour and only the
          tooltip-footer Skip / Back / Next buttons drive tour state. */}
      {dimRects
        ? dimRects.map((r, idx) => (
            <div
              key={idx}
              aria-hidden="true"
              data-testid="onboarding-tour-dim"
              className={backdropClass}
              style={{
                top: `${r.top}px`,
                left: `${r.left}px`,
                width: `${r.width}px`,
                height: `${r.height}px`,
              }}
            />
          ))
        : (
          // Center-placement fallback — no spotlight target available.
          // Render a single full-cover dim layer. Still purely visual:
          // skip / back / next live on the tooltip itself.
          <div
            aria-hidden="true"
            data-testid="onboarding-tour-dim"
            className={`${backdropClass} inset-0`}
          />
        )}

      {/* Polite live region — announces the current step to screen readers. */}
      <p className="sr-only" aria-live="polite">
        {t("onboarding.tour.stepOf", {
          current: counter.current,
          total: counter.total,
        })}
        {": "}
        {t(stop.titleKey)}
      </p>

      {/* Tooltip card — the only interactive surface in the tour.
          `pointer-events-auto` opts back into click capture against the
          root's `pointer-events-none`, so the card's buttons (Skip /
          Back / Next) work while every other pixel of the overlay
          passes clicks through to the underlying page. */}
      <div
        ref={tooltipRef}
        data-testid="onboarding-tour-tooltip"
        data-placement={tooltipPos.placement}
        className="bg-card border-border pointer-events-auto absolute max-h-[80vh] overflow-y-auto rounded-xl border p-5 shadow-2xl"
        style={{
          top: `${tooltipPos.top}px`,
          left: `${tooltipPos.left}px`,
          width: `${TOOLTIP_WIDTH}px`,
        }}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase tabular-nums">
              {t("onboarding.tour.stepOf", {
                current: counter.current,
                total: counter.total,
              })}
            </p>
            <h2
              id="onboarding-tour-title"
              className="mt-1 text-base font-semibold tracking-tight"
            >
              {t(stop.titleKey)}
            </h2>
          </div>
        </header>

        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          {t(stop.bodyKey)}
        </p>

        {/* v1.4.15 H4 design: tour footer buttons reach the WCAG 2.5.5
            44 px tap-target floor on mobile. The `size="sm"` default
            of `h-8` clipped to ~32 px which the maintainer reported as too small
            on the iPad / iPhone PWA shell. Bumping to `min-h-11` (44 px)
            keeps the desktop visual close enough — the buttons grow
            ~4 px taller — while making mobile usable. */}
        <footer className="mt-5 flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleSkip}
            className="text-muted-foreground hover:text-foreground min-h-11"
          >
            {t("onboarding.tour.skip")}
          </Button>
          <div className="flex items-center gap-2">
            {counter.current > 1 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handlePrev}
                className="min-h-11"
              >
                {t("onboarding.tour.back")}
              </Button>
            )}
            <Button
              ref={primaryRef}
              type="button"
              size="sm"
              onClick={handleNext}
              data-testid="onboarding-tour-primary"
              className="min-h-11"
            >
              {isLast ? t("onboarding.tour.done") : t("onboarding.tour.next")}
            </Button>
          </div>
        </footer>
      </div>
    </div>
  );
}
