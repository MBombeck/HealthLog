"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/**
 * v1.4.25 W3 — dedicated tab strip for `/insights`.
 *
 * Extracted from the inline `<InsightsSectionNav>` that lived inside
 * `src/app/insights/page.tsx` so the regenerate affordance can sit on
 * the same row as the metric pills. Up to v1.4.24 the regenerate
 * button lived inside the hero band's action row, which scrolled away
 * the moment the user started reading the per-metric cards. Marc's
 * directive (2026-05-14): the affordance has to stay reachable while
 * the user is deep in a section.
 *
 * Behaviour:
 *   - Six pills (BP / Weight / Pulse / Mood / Meds / BMI), each
 *     scroll-anchored to the matching `<section id="section-{slug}">`
 *     in the page. IntersectionObserver tracks which section is in
 *     the active band so the matching pill highlights.
 *   - Right slot: a 44×44 icon-only `<RefreshCw>` button. Clicking it
 *     fires the `onRegenerate` handler the page hands down and pops a
 *     sonner toast with `t("insights.regenerateSuccess")` once the
 *     advisor query confirms. While the regenerate is in-flight the
 *     icon swaps to a spinner and the button is disabled.
 *
 * Accessibility:
 *   - `<nav aria-label>` mirrors the legacy nav's label so screen-reader
 *     landmark traversal stays familiar ("Skip to section").
 *   - Pill `aria-current="location"` flips with the scroll-anchor.
 *   - The regenerate button has `aria-label={t("insights.regenerateAnalysis")}`
 *     so the icon-only affordance is announced. Tooltip via `title`
 *     mirrors the aria-label for sighted users.
 *   - `prefers-reduced-motion` gates the smooth-scroll on pill clicks.
 *
 * Layout: sticky `top-0` strip with `backdrop-blur` and `bg-background/95`
 * — same surface treatment as the original `<InsightsSectionNav>` so
 * the visual rhythm of the page is unchanged.
 */

export interface InsightsTabStripProps {
  /**
   * Handler the page passes from `useInsightsAdvisorQuery().regenerate`.
   * When supplied, the right-side icon button is enabled; when omitted,
   * the button hides so the strip stays clean on surfaces that don't
   * own the advisor query (e.g. a future preview).
   */
  onRegenerate?: () => void;
  /** Spinner state — disables the button and swaps the icon. */
  regenerating?: boolean;
}

const SECTION_IDS = [
  "section-bp",
  "section-weight",
  "section-pulse",
  "section-mood",
  "section-meds",
  "section-bmi",
] as const;

const SECTION_LABEL_KEYS: Record<(typeof SECTION_IDS)[number], string> = {
  "section-bp": "insights.navBloodPressure",
  "section-weight": "insights.navWeight",
  "section-pulse": "insights.navPulse",
  "section-mood": "insights.navMood",
  "section-meds": "insights.navMedication",
  "section-bmi": "insights.navBmi",
};

export function InsightsTabStrip({
  onRegenerate,
  regenerating = false,
}: InsightsTabStripProps) {
  const { t } = useTranslations();
  const [activeId, setActiveId] = useState<string>(SECTION_IDS[0]);
  const observerRef = useRef<IntersectionObserver | null>(null);
  // Track which regenerate call we've already toasted so the success
  // toast only fires on the rising edge (true → false). Without this
  // the toast pops every render where `regenerating` is false.
  const lastRegeneratingRef = useRef<boolean>(regenerating);

  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        // v1.4.22 W5 reconcile (Code-MED-4) — pick the entry with the
        // highest intersectionRatio in the band rather than the
        // observer-supplied last entry. Three sections briefly
        // visible during a fast scroll otherwise made the active
        // pill jump to whichever one came last in the batch.
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        const top = visible[0];
        if (top) {
          setActiveId((current) =>
            current === top.target.id ? current : top.target.id,
          );
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );

    for (const id of SECTION_IDS) {
      const el = document.getElementById(id);
      if (el) observerRef.current.observe(el);
    }

    return () => observerRef.current?.disconnect();
  }, []);

  useEffect(() => {
    // Fire the success toast on the falling edge of `regenerating`
    // (rising-edge guard via the ref). Skips the toast on first
    // mount when the parent passes a "false" regenerating value.
    if (lastRegeneratingRef.current && !regenerating) {
      toast.success(t("insights.regenerateSuccess"));
    }
    lastRegeneratingRef.current = regenerating;
  }, [regenerating, t]);

  function scrollTo(id: string) {
    const el = document.getElementById(id);
    if (!el) return;
    // v1.4.22 W5 reconcile (Design-H1) — gate smooth scrolling behind
    // `prefers-reduced-motion`; honour the user's OS-level pref.
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
    });
  }

  const regenerateLabel = t("insights.regenerateAnalysis");

  return (
    <nav
      data-slot="insights-tab-strip"
      aria-label={t("insights.navAriaLabel")}
      className={cn(
        "bg-background/95 sticky top-0 z-30 overflow-x-auto border-b py-2 backdrop-blur",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 [scrollbar-width:none] gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {SECTION_IDS.map((id) => {
            const isActive = activeId === id;
            return (
              <button
                key={id}
                onClick={() => scrollTo(id)}
                aria-current={isActive ? "location" : undefined}
                data-slot="insights-tab-strip-pill"
                data-active={isActive ? "true" : undefined}
                className={cn(
                  "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {t(SECTION_LABEL_KEYS[id])}
              </button>
            );
          })}
        </div>
        {onRegenerate && (
          <button
            type="button"
            onClick={onRegenerate}
            disabled={regenerating}
            aria-label={regenerateLabel}
            title={regenerateLabel}
            data-slot="insights-tab-strip-regenerate"
            className={cn(
              // 44×44 touch target — Marc directive 2026-05-14. The
              // pill row above sits 28px tall; the button breaks the
              // band height intentionally so the touch target meets
              // the WCAG 2.5.5 minimum without forcing the pills to
              // grow.
              "inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full",
              "text-muted-foreground hover:text-foreground hover:bg-accent",
              "transition-colors",
              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
          >
            {regenerating ? (
              <Loader2
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <RefreshCw className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        )}
      </div>
    </nav>
  );
}
