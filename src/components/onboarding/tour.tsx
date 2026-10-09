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

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { useTranslations } from "@/lib/i18n/context";
import {
  buildTourStops,
  currentStop,
  deriveProgress,
  initTourState,
  isTourFinished,
  nextStep,
  prevStep,
  skipTour,
  stepCounter,
  dropRedirectedStop,
  stopRouteRedirected,
  type TourModuleMap,
  type TourState,
  type TourStop,
  type TourStopId,
} from "@/lib/onboarding/tour-state";

interface TourProps {
  /**
   * Resolved module map (`GET /api/auth/me`'s `modules`). Stops whose
   * page belongs to a switched-off module are dropped; the counter total
   * tracks the resolved list so "Schritt n/total" stays honest.
   */
  modules?: TourModuleMap;
  /**
   * v1.18.6 — open at this stop id (the persisted resume point). When
   * the id is absent from the resolved list the tour starts at the top.
   */
  resumeFromStopId?: string | null;
  /**
   * v1.18.6 — narrow the tour to a single module card (the per-page
   * "Diese Tour zeigen" re-entry). When set, the overlay shows just
   * that stop with a Done button and no cross-page navigation.
   */
  filterToStop?: TourStopId;
  /**
   * v1.18.6 — fire-and-forget progress checkpoint on every step change
   * + terminal. The launcher PATCHes it so a reload resumes correctly.
   * Not called for the single-stop re-entry (`filterToStop`).
   */
  onProgress?: (progress: ReturnType<typeof deriveProgress>) => void;
  /**
   * Called when the tour finishes (Done OR Skip OR Esc). Receives the
   * terminal outcome so the launcher can audit the difference.
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
/**
 * The rendered element carrying a tour id. A control can exist twice with the
 * same id, one per shell (the dashboard's add button is a dropdown on the
 * desktop rail and a sheet trigger on the phone shell), with the other one
 * hidden; the stop anchors on the one that is actually laid out.
 */
function findTourTarget(targetId: string): HTMLElement | null {
  const all = document.querySelectorAll<HTMLElement>(
    `[data-tour-id="${CSS.escape(targetId)}"]`,
  );
  for (const el of all) {
    if (el.getClientRects().length > 0) return el;
  }
  return all[0] ?? null;
}

function measureTarget(targetId: string | null): SpotlightRect | null {
  if (!targetId) return null;
  if (typeof document === "undefined") return null;
  const el = findTourTarget(targetId);
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

/** Resolved placement — the geometric placements plus the sheet fallback. */
export type ResolvedPlacement = TourStop["placement"] | "sheet";

/**
 * Decide tooltip position. The intent is to sit beside the target
 * along the requested axis, but flip to the opposite edge if there
 * isn't enough room — vertical fallbacks prefer ABOVE the target so
 * the footer buttons can never be pushed under the viewport bottom.
 * Returns absolute viewport coordinates that the UI uses with
 * `position: fixed`. Falls back to centred when there is no spotlight
 * rect, and to `"sheet"` (caller renders a bottom sheet on EVERY
 * viewport width) when the target is off-screen or no candidate fits.
 *
 * Pure function of its inputs (viewport passed explicitly) so the
 * Node-environment vitest suite can exercise it without jsdom.
 */
export function computeTooltipPosition(
  rect: SpotlightRect | null,
  placement: TourStop["placement"],
  tooltipSize: { width: number; height: number },
  viewport: { width: number; height: number },
): { top: number; left: number; placement: ResolvedPlacement } {
  const vw = viewport.width;
  const vh = viewport.height;
  if (!rect) {
    return {
      top: Math.max(16, (vh - tooltipSize.height) / 2),
      left: Math.max(16, (vw - tooltipSize.width) / 2),
      placement: "center",
    };
  }
  // Target entirely outside the visible viewport (e.g. an anchor below
  // the fold that scrollIntoView could not bring in, or mid-scroll):
  // every anchored candidate would point at nothing and risk landing
  // off-screen. Render the sheet fallback instead — on ALL viewports.
  const targetVisible =
    rect.top < vh - COLLISION_PAD &&
    rect.top + rect.height > COLLISION_PAD &&
    rect.left < vw - COLLISION_PAD &&
    rect.left + rect.width > COLLISION_PAD;
  if (!targetVisible) {
    return { top: 0, left: 0, placement: "sheet" };
  }
  const GAP = 12;
  const candidates: Array<{
    placement: TourStop["placement"];
    top: number;
    left: number;
  }> = [];

  const centredLeft = Math.min(
    Math.max(16, rect.left + rect.width / 2 - tooltipSize.width / 2),
    vw - tooltipSize.width - 16,
  );
  const vertical = (side: "top" | "bottom") => ({
    placement: side,
    top:
      side === "bottom"
        ? rect.top + rect.height + GAP
        : rect.top - tooltipSize.height - GAP,
    left: centredLeft,
  });
  const horizontal = (side: "left" | "right") => ({
    placement: side,
    top: Math.min(
      Math.max(16, rect.top + rect.height / 2 - tooltipSize.height / 2),
      vh - tooltipSize.height - 16,
    ),
    left:
      side === "right"
        ? rect.left + rect.width + GAP
        : rect.left - tooltipSize.width - GAP,
  });

  if (placement === "bottom" || placement === "center") {
    candidates.push(vertical("bottom"), vertical("top"));
  } else if (placement === "top") {
    candidates.push(vertical("top"), vertical("bottom"));
  } else {
    // Side placements: requested side first, then the opposite side,
    // then the vertical axis — above before below, so a target low in
    // the viewport flips the card upwards instead of clipping its
    // footer under the fold.
    candidates.push(
      horizontal(placement),
      horizontal(placement === "right" ? "left" : "right"),
      vertical("top"),
      vertical("bottom"),
    );
  }
  // Pick the first candidate that fully fits the viewport — by
  // construction its bottom edge sits ≥ COLLISION_PAD above the
  // viewport bottom. If NONE fits (target visible but crowded on every
  // side), fall back to the sheet rather than clamping a card over an
  // arbitrary region: the sheet keeps the footer buttons reachable on
  // every viewport, which is the property the tour cannot lose.
  for (const c of candidates) {
    if (
      c.top >= COLLISION_PAD &&
      c.left >= COLLISION_PAD &&
      c.top + tooltipSize.height <= vh - COLLISION_PAD &&
      c.left + tooltipSize.width <= vw - COLLISION_PAD
    ) {
      return c;
    }
  }
  return { top: 0, left: 0, placement: "sheet" };
}

const TOOLTIP_WIDTH = 320;
const TOOLTIP_HEIGHT = 220; // enough headroom for two-line title + 4-line body + footer
/** Minimum gap the tooltip keeps from every viewport edge. */
const COLLISION_PAD = 8;
/** Below this viewport width the tooltip renders as a bottom sheet. */
const SHEET_BREAKPOINT = 480;

export function OnboardingTour({
  modules,
  resumeFromStopId,
  filterToStop,
  onProgress,
  onClose,
}: TourProps) {
  const { t } = useTranslations();
  const router = useRouter();
  const pathname = usePathname();

  const stops = useMemo(
    () => buildTourStops({ modules, filterToStop }),
    [modules, filterToStop],
  );
  // Single-stop re-entry never resumes from a checkpoint — it opens on
  // the one card the page asked for.
  const [state, setState] = useState<TourState>(() =>
    initTourState(stops, filterToStop ? null : resumeFromStopId),
  );
  const [rect, setRect] = useState<SpotlightRect | null>(null);
  // Which stop the tour last navigated for, from where, and whether that
  // stop's page was reached; and which way the person was travelling, so a
  // stop whose page redirects is stepped past in the same direction.
  const navRef = useRef<{
    stopId: string | null;
    pushedFrom: string | null;
    arrived: boolean;
  }>({ stopId: null, pushedFrom: null, arrived: false });
  const directionRef = useRef<"forward" | "back">("forward");
  // The navigation effect reads the latest `onClose` without re-running on
  // its identity (the launcher passes a fresh closure every render).
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const stop = currentStop(state);

  // v1.18.6 — cross-page step change. A stop on another route triggers a
  // `router.push` first; the overlay survives the navigation because it is
  // mounted at the app-shell level (not inside the dashboard). After the
  // route settles we must wait for the new page's anchor to MOUNT before
  // measuring — anchoring against a not-yet-rendered (0×0) target would snap
  // the spotlight to centre-screen. We poll on rAF with a bounded retry, then
  // give up to the centred fallback so the tour never blocks indefinitely.
  //
  // We intentionally *don't* MutationObserver the whole document — the
  // targets are stable once mounted; bounded rAF polling on step change plus
  // re-measuring on scroll/resize is plenty.
  useEffect(() => {
    if (!stop) return;
    if (typeof document === "undefined") return;

    let raf = 0;
    let cancelled = false;
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

    // Navigate to the stop's route if we're not already there. Same-route
    // stops (the two dashboard stops while on `/`, or the wrap-up which has
    // no route) skip the push. `filterToStop` re-entry never navigates — it
    // runs on the page the user is already viewing.
    //
    // One push per stop. A page that sends the person elsewhere (the Coach
    // page redirects to `/insights` while the Coach is unavailable) would
    // otherwise be pushed again on every pathname change, a loop between the
    // two pages; such a stop is dropped and the tour moves on.
    if (!filterToStop && stop.route) {
      if (navRef.current.stopId !== stop.id) {
        navRef.current = { stopId: stop.id, pushedFrom: null, arrived: false };
      }
      const nav = navRef.current;
      if (pathname === stop.route) {
        nav.arrived = true;
      } else if (
        stopRouteRedirected({
          stopRoute: stop.route,
          pathname,
          pushedFrom: nav.pushedFrom,
          arrived: nav.arrived,
        })
      ) {
        const direction = directionRef.current;
        queueMicrotask(() =>
          setState((prev) => {
            if (currentStop(prev)?.id !== stop.id) return prev;
            const next = dropRedirectedStop(prev, direction);
            if (isTourFinished(next)) {
              queueMicrotask(() => onCloseRef.current("completed"));
            }
            return next;
          }),
        );
        return;
      } else if (nav.pushedFrom === null) {
        nav.pushedFrom = pathname;
        router.push(stop.route);
      }
    }

    const measureNow = () => {
      if (cancelled) return;
      setRect(measureTarget(stop.targetId));
    };
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measureNow);
    };

    // Wait for the anchor to mount (after navigation it isn't in the DOM on
    // the first frame). Bounded poll: ~40 frames (~650 ms) before falling
    // back to the centred tooltip via `measureTarget` returning null.
    let attempts = 0;
    const MAX_ATTEMPTS = 40;
    const settleAndMeasure = () => {
      if (cancelled) return;
      const el = stop.targetId ? findTourTarget(stop.targetId) : null;
      if (el) {
        // Bring the anchor into view BEFORE measuring — anchors below the
        // fold positioned the popover under the viewport bottom otherwise.
        // Reduced-motion users get an instant jump, not a smooth scroll.
        el.scrollIntoView?.({
          block: "center",
          inline: "nearest",
          behavior: reduceMotion ? "auto" : "smooth",
        });
        measure();
        return;
      }
      // Centred / route-less stop (wrap-up): measure immediately.
      if (!stop.targetId) {
        measureNow();
        return;
      }
      attempts += 1;
      if (attempts < MAX_ATTEMPTS) {
        raf = requestAnimationFrame(settleAndMeasure);
      } else {
        // Anchor never mounted — centre the tooltip rather than block.
        measureNow();
      }
    };
    settleAndMeasure();

    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
    // `pathname` is intentionally a dep: after the route settles the effect
    // re-runs and the anchor poll finds the now-mounted target.
  }, [stop, filterToStop, router, pathname]);

  // v1.18.6 — fire-and-forget progress checkpoint on every step / terminal
  // transition so a mid-tour reload resumes at the right module. Skipped for
  // the single-stop re-entry (it isn't "the tour", just one card).
  useEffect(() => {
    if (filterToStop || !onProgress) return;
    onProgress(deriveProgress(state));
  }, [state, filterToStop, onProgress]);

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
    directionRef.current = "forward";
    setState((prev) => {
      const next = nextStep(prev);
      if (isTourFinished(next) && next.outcome === "completed") {
        queueMicrotask(() => onClose("completed"));
      }
      return next;
    });
  }, [onClose]);

  const handlePrev = useCallback(() => {
    directionRef.current = "back";
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
  // Responsive sizing: the card never claims more width than the viewport
  // minus the collision padding, and very small viewports skip the anchored
  // popover entirely in favour of a bottom sheet — anchoring a 20 rem card
  // next to a target on a ~400 px screen always ends up clipped.
  const viewportWidth =
    typeof window !== "undefined" ? window.innerWidth : 1024;
  const viewportHeight =
    typeof window !== "undefined" ? window.innerHeight : 768;
  const tooltipWidth = Math.min(
    TOOLTIP_WIDTH,
    viewportWidth - COLLISION_PAD * 2,
  );
  const tooltipPos = computeTooltipPosition(
    rect,
    stop.placement,
    { width: tooltipWidth, height: TOOLTIP_HEIGHT },
    { width: viewportWidth, height: viewportHeight },
  );
  // The sheet renders on narrow viewports unconditionally AND on any
  // viewport when the resolver found no anchored placement that keeps
  // the whole card (footer included) inside the viewport.
  const asSheet =
    viewportWidth < SHEET_BREAKPOINT || tooltipPos.placement === "sheet";

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
        rect.top > 0 ? { top: 0, left: 0, width: vw, height: rect.top } : null,
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
      ].filter(
        (
          r,
        ): r is { top: number; left: number; width: number; height: number } =>
          r !== null,
      )
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
      {dimRects ? (
        dimRects.map((r, idx) => (
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
      ) : (
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
        data-placement={asSheet ? "sheet" : tooltipPos.placement}
        className={
          asSheet
            ? // Bottom-sheet fallback — full-width on small screens,
              // centred above the bottom edge on wide ones (`mx-auto` +
              // `max-w`). Used on EVERY viewport when no anchored
              // placement keeps the footer buttons inside the viewport.
              "bg-card border-border pointer-events-auto absolute inset-x-2 bottom-2 mx-auto max-h-[70vh] max-w-[22rem] overflow-x-hidden overflow-y-auto rounded-xl border p-4 shadow-2xl md:p-6"
            : "bg-card border-border pointer-events-auto absolute max-w-[22rem] overflow-x-hidden overflow-y-auto rounded-xl border p-4 shadow-2xl md:p-6"
        }
        style={
          asSheet
            ? undefined
            : {
                top: `${tooltipPos.top}px`,
                left: `${tooltipPos.left}px`,
                width: `${tooltipWidth}px`,
                // Hard guarantee: the card's bottom edge stays ≥
                // COLLISION_PAD above the viewport bottom even when the
                // real content outgrows the TOOLTIP_HEIGHT estimate the
                // resolver positioned with — the card scrolls internally
                // instead of pushing its footer below the fold.
                maxHeight: `${Math.max(
                  0,
                  viewportHeight - tooltipPos.top - COLLISION_PAD,
                )}px`,
              }
        }
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
        {/* `flex-wrap` keeps long localised labels (Skip / Back / Next) from
            forcing a horizontal scrollbar inside the card — the row wraps
            instead, so the primary action is always reachable. */}
        <footer className="mt-4 flex flex-wrap items-center justify-between gap-2">
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
