"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  INSIGHTS_OVERVIEW_PATH,
  SUB_PAGE_SLUGS,
  type SubPageSlug,
} from "@/lib/insights/sub-page-metric";

/**
 * v1.4.25 W4 — routed tab strip for `/insights`.
 *
 * Behaviour evolved from the v1.4.25 W3 scroll-anchor version: each pill
 * is now a `<Link>` to a routed sub-page (`/insights/blutdruck` …),
 * `usePathname()` decides the active pill, and the strip is mounted in
 * `src/app/insights/layout.tsx` so it persists across navigation
 * without re-rendering. The CoachDrawer is NOT mounted in this layout —
 * the drawer lives in the mother page's body only (Marc directive
 * 2026-05-11).
 *
 * Pills:
 *   - "Overview" (the mother page) is the first pill and matches when
 *     `pathname === "/insights"` exactly.
 *   - The seven metric slugs each map to their own sub-route.
 *
 * Accessibility:
 *   - `<nav aria-label>` mirrors the legacy label.
 *   - Active pill gets `aria-current="page"`.
 *   - The regenerate button has an `aria-label` so the icon-only
 *     affordance is announced. The button only renders when
 *     `onRegenerate` is wired — sub-pages don't carry the regenerate
 *     handler today (the mother page owns the advisor query and
 *     forwards the trigger via the layout slot).
 *   - `prefers-reduced-motion` honoured at the global level (no
 *     scroll-into-view here — Next.js routing handles focus + scroll).
 */

export interface InsightsTabStripProps {
  /**
   * Optional regenerate handler. Only the mother page passes this;
   * sub-pages render the strip without the right-slot button.
   * Wiring the strip in `layout.tsx` means we'd need a layout-level
   * advisor query — for v1.4.25 we keep the strip stateless and the
   * regenerate affordance on the mother page only.
   */
  onRegenerate?: () => void;
  /** Spinner state — disables the button and swaps the icon. */
  regenerating?: boolean;
}

interface TabEntry {
  /** Pathname this pill links to. */
  href: string;
  /** Translation key for the pill label. */
  labelKey: string;
}

function buildTabs(): TabEntry[] {
  const subPages: Record<SubPageSlug, string> = {
    blutdruck: "insights.navBloodPressure",
    gewicht: "insights.navWeight",
    puls: "insights.navPulse",
    stimmung: "insights.navMood",
    medikamente: "insights.navMedication",
    bmi: "insights.navBmi",
    schlaf: "insights.navSleep",
  };
  return [
    { href: INSIGHTS_OVERVIEW_PATH, labelKey: "insights.navOverview" },
    ...SUB_PAGE_SLUGS.map((slug) => ({
      href: `${INSIGHTS_OVERVIEW_PATH}/${slug}`,
      labelKey: subPages[slug],
    })),
  ];
}

export function InsightsTabStrip({
  onRegenerate,
  regenerating = false,
}: InsightsTabStripProps) {
  const { t } = useTranslations();
  const pathname = usePathname();
  const tabs = buildTabs();

  // Fire success toast on the falling edge of `regenerating`. Same
  // rising-edge ref guard as the W3 implementation so the toast fires
  // exactly once per regenerate cycle.
  const lastRegeneratingRef = useRef<boolean>(regenerating);
  useEffect(() => {
    if (lastRegeneratingRef.current && !regenerating) {
      toast.success(t("insights.regenerateSuccess"));
    }
    lastRegeneratingRef.current = regenerating;
  }, [regenerating, t]);

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
          {tabs.map((tab) => {
            // The overview pill matches the mother page exactly; the
            // sub-page pills match a prefix so future nested routes
            // (e.g. `/insights/schlaf/2026-05-11`) still highlight the
            // parent tab.
            const isActive =
              tab.href === INSIGHTS_OVERVIEW_PATH
                ? pathname === INSIGHTS_OVERVIEW_PATH
                : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                data-slot="insights-tab-strip-pill"
                data-active={isActive ? "true" : undefined}
                className={cn(
                  // 44px touch-target floor (W8.3) — pills are primary
                  // navigation; the regenerate icon-button to the right
                  // already meets the same minimum.
                  "inline-flex min-h-11 shrink-0 items-center rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                  isActive
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
              >
                {t(tab.labelKey)}
              </Link>
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
              // 44×44 touch target — same WCAG 2.5.5 floor the pill row
              // now honours via `min-h-11`. The button stays circular so
              // its visual weight matches the existing top-bar icon
              // buttons.
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
