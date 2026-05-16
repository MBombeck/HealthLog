"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import {
  INSIGHTS_OVERVIEW_PATH,
  SUB_PAGE_GROUP,
  SUB_PAGE_GROUP_ORDER,
  SUB_PAGE_SLUGS,
  type SubPageGroup,
  type SubPageSlug,
} from "@/lib/insights/sub-page-metric";
import {
  hasMetricData,
  type InsightInputs,
  type InsightMetric,
} from "@/lib/insights/metric-availability";

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
  /**
   * v1.4.27 F19 — analytics + event-driven availability inputs the
   * gating helper reads. When omitted the strip falls back to its
   * pre-v1.4.27 behaviour (every pill renders) so legacy mounts
   * stay backward-compatible.
   */
  availability?: InsightInputs;
}

/**
 * v1.4.34 IW-D — a strip entry is either a flat `<Link>` pill or a
 * group "parent" pill that opens a popover containing the sub-pages
 * in the group. The discriminated union keeps the renderer branch-
 * exhaustive and lets future groups land with one new variant.
 */
type TabEntry =
  | {
      kind: "link";
      /** Pathname this pill links to. */
      href: string;
      /** Translation key for the pill label. */
      labelKey: string;
    }
  | {
      kind: "group";
      /** Group key (e.g. `"vitals"`). Used for keys + a11y wiring. */
      group: SubPageGroup;
      /** Translation key for the parent-pill label. */
      labelKey: string;
      /** Translation key for the popover header. */
      headerKey: string;
      /** Visible sub-pages inside the group (post-availability gating). */
      children: Array<{ href: string; labelKey: string; slug: SubPageSlug }>;
    };

/**
 * Slug → (label key, gating metric) mapping. Keeping the metric here
 * means the tab strip and the empty-state gates on each sub-page can
 * stay in sync from a single source of truth — adding a sub-page is
 * one row.
 */
// v1.4.33 F9 — label + gating-metric for every routed sub-page. Pill
// ORDER is owned by `SUB_PAGE_SLUGS` (which iterates the keys of
// `SUB_PAGE_METRIC`) so adding a new metric is one row in
// `sub-page-metric.ts` and the strip picks it up automatically.
const SUB_PAGE_TABS: Record<
  SubPageSlug,
  { labelKey: string; metric: InsightMetric }
> = {
  // ── vitals ──
  blutdruck: {
    labelKey: "insights.navBloodPressure",
    metric: "BLOOD_PRESSURE_SYS",
  },
  puls: { labelKey: "insights.navPulse", metric: "PULSE" },
  sauerstoff: {
    labelKey: "insights.navOxygenSaturation",
    metric: "OXYGEN_SATURATION",
  },
  koerpertemperatur: {
    labelKey: "insights.navBodyTemperature",
    metric: "BODY_TEMPERATURE",
  },
  // ── body composition ──
  gewicht: { labelKey: "insights.navWeight", metric: "WEIGHT" },
  bmi: { labelKey: "insights.navBmi", metric: "BMI" },
  // ── activity ──
  "aktive-energie": {
    labelKey: "insights.navActiveEnergy",
    metric: "ACTIVE_ENERGY_BURNED",
  },
  // v1.4.32 — workouts pill. Gate is event-driven; the
  // availability helper reads `inputs.hasWorkouts` rather than a
  // `summaries[…].count`.
  workouts: { labelKey: "insights.navWorkouts", metric: "WORKOUTS" },
  // ── sleep ──
  schlaf: { labelKey: "insights.navSleep", metric: "SLEEP_DURATION" },
  // ── cardiovascular ──
  ruhepuls: {
    labelKey: "insights.navRestingHr",
    metric: "RESTING_HEART_RATE",
  },
  hrv: { labelKey: "insights.navHrv", metric: "HEART_RATE_VARIABILITY" },
  // ── mood ──
  stimmung: { labelKey: "insights.navMood", metric: "MOOD" },
  // ── events ──
  medikamente: { labelKey: "insights.navMedication", metric: "MEDICATION" },
};

/**
 * v1.4.34 IW-D — group metadata (label + popover header) keyed by
 * `SubPageGroup`. The strip renders one parent pill per group; the
 * five wave-A HealthKit pills are the only group today.
 */
const SUB_PAGE_GROUP_META: Record<
  SubPageGroup,
  { labelKey: string; headerKey: string }
> = {
  vitals: {
    labelKey: "insights.tabStrip.vitalsParent.label",
    headerKey: "insights.tabStrip.vitalsParent.header",
  },
};

function buildTabs(availability: InsightInputs | undefined): TabEntry[] {
  const visibleSlugs = SUB_PAGE_SLUGS.filter((slug) => {
    if (!availability) return true;
    return hasMetricData(SUB_PAGE_TABS[slug].metric, availability);
  });

  const visibleSet = new Set(visibleSlugs);
  const entries: TabEntry[] = [
    {
      kind: "link",
      href: INSIGHTS_OVERVIEW_PATH,
      labelKey: "insights.navOverview",
    },
  ];

  // v1.4.34 IW-D — track which groups have already been emitted so the
  // first encountered group-member triggers the parent pill at the
  // same strip position (preserving categorical order).
  const emittedGroups = new Set<SubPageGroup>();

  for (const slug of visibleSlugs) {
    const group = SUB_PAGE_GROUP[slug];
    if (group) {
      if (emittedGroups.has(group)) continue;
      emittedGroups.add(group);
      const children = SUB_PAGE_GROUP_ORDER[group]
        .filter((childSlug) => visibleSet.has(childSlug))
        .map((childSlug) => ({
          slug: childSlug,
          href: `${INSIGHTS_OVERVIEW_PATH}/${childSlug}`,
          labelKey: SUB_PAGE_TABS[childSlug].labelKey,
        }));
      if (children.length === 0) continue;
      entries.push({
        kind: "group",
        group,
        labelKey: SUB_PAGE_GROUP_META[group].labelKey,
        headerKey: SUB_PAGE_GROUP_META[group].headerKey,
        children,
      });
      continue;
    }
    entries.push({
      kind: "link",
      href: `${INSIGHTS_OVERVIEW_PATH}/${slug}`,
      labelKey: SUB_PAGE_TABS[slug].labelKey,
    });
  }
  return entries;
}

function InsightsTabStripImpl({
  onRegenerate,
  regenerating = false,
  availability,
}: InsightsTabStripProps) {
  const { t } = useTranslations();
  const pathname = usePathname();
  // v1.4.31 — memoise the pill list so the strip's main render
  // path doesn't rebuild the array on every parent re-render. The
  // strip is wrapped in `React.memo` (see export below); the memo
  // here keeps the inner `<Link>` references stable so React's
  // reconciliation short-circuits when neither pathname nor
  // availability changed. Per
  // `.planning/research/v15-insights-blocking-bug.md` fix 2.
  const tabs = useMemo(() => buildTabs(availability), [availability]);

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
      // v1.4.28 FB-D3 — `touch-action: pan-y` lets vertical swipes that
      // begin on the sticky strip scroll the page through it. The
      // legacy `overflow-x-auto` on the outer `<nav>` claimed the
      // entire touch surface as a horizontal scroll container, so
      // vertical drags that started on the pill row never reached the
      // document. The horizontal pill scroll now lives on the inner
      // `<div>` below; the outer `<nav>` stays sticky but no longer
      // owns the gesture.
      style={{ touchAction: "pan-y" }}
      className={cn(
        // v1.4.27 MB7 / CF-72 — relative wrapper hosts the right-edge
        // fade overlay below so the user reads "there's more to
        // scroll" when the pill row overflows. The fade is a tiny
        // pointer-events-none pseudo-strip painted onto the inner
        // strip via a sibling div; it sits only on `<sm` because the
        // wider viewport above already shows every pill.
        "relative",
        "bg-background/95 sticky top-0 z-30 border-b py-2 backdrop-blur",
      )}
    >
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 [scrollbar-width:none] gap-2 overflow-x-auto [&::-webkit-scrollbar]:hidden">
          {tabs.map((tab) => {
            if (tab.kind === "link") {
              // The overview pill matches the mother page exactly; the
              // sub-page pills match a prefix so future nested routes
              // (e.g. `/insights/schlaf/2026-05-11`) still highlight the
              // parent tab.
              const isActive =
                tab.href === INSIGHTS_OVERVIEW_PATH
                  ? pathname === INSIGHTS_OVERVIEW_PATH
                  : pathname === tab.href ||
                    pathname.startsWith(`${tab.href}/`);
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
            }
            // v1.4.34 IW-D — group parent pill. Renders as a popover
            // trigger so desktop hover (`onMouseEnter` falls through to
            // Radix click semantics — tap-to-open is the same gesture
            // on every device, matching the `<Popover>` MB3 decision).
            // Sub-page navigation happens via the `<Link>` inside the
            // popover; the parent pill never navigates on its own.
            const isGroupActive = tab.children.some(
              (child) =>
                pathname === child.href ||
                pathname.startsWith(`${child.href}/`),
            );
            return (
              <Popover key={`group-${tab.group}`}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    aria-current={isGroupActive ? "page" : undefined}
                    data-slot="insights-tab-strip-group"
                    data-group={tab.group}
                    data-active={isGroupActive ? "true" : undefined}
                    className={cn(
                      "inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                      isGroupActive
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(tab.labelKey)}
                    <ChevronDown
                      className="h-3 w-3 opacity-70"
                      aria-hidden="true"
                    />
                  </button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  data-slot="insights-tab-strip-group-popover"
                  className="w-56 p-2 text-sm"
                >
                  <p className="text-muted-foreground px-2 py-1 text-[11px] font-semibold tracking-wide uppercase">
                    {t(tab.headerKey)}
                  </p>
                  <ul className="space-y-1" role="list">
                    {tab.children.map((child) => {
                      const isChildActive =
                        pathname === child.href ||
                        pathname.startsWith(`${child.href}/`);
                      return (
                        <li key={child.href}>
                          <Link
                            href={child.href}
                            aria-current={isChildActive ? "page" : undefined}
                            data-slot="insights-tab-strip-group-item"
                            data-active={isChildActive ? "true" : undefined}
                            className={cn(
                              "flex min-h-10 items-center rounded-md px-2 py-1.5 text-sm transition-colors",
                              "focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                              isChildActive
                                ? "bg-primary/10 text-primary"
                                : "text-foreground hover:bg-accent",
                            )}
                          >
                            {t(child.labelKey)}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </PopoverContent>
              </Popover>
            );
          })}
        </div>
        {/* v1.4.27 MB7 / CF-72 — right-edge fade. The gradient
            absolute-positions over the rightmost ~24 px of the strip
            so the last visible pill softly fades into the background
            colour, signalling "scroll for more" without a scrollbar.
            Only paints on `<sm` because the wider viewports above
            already fit every pill. The fade is a sibling of the
            scrollable inner row + the regenerate button so it
            visually overlays both without trapping pointer events. */}
        <div
          aria-hidden="true"
          className={cn(
            "from-background/95 pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent sm:hidden",
          )}
        />
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

/**
 * v1.4.31 — `React.memo`'d export. The strip mounts in
 * `<InsightsLayoutShell>` and gets a new `availability` prop on
 * every cache-write of the analytics or comprehensive query; without
 * the memo, every resolve cycle re-runs `buildTabs(availability)` +
 * the eight `<Link>` reconciliations on the main thread inside the
 * same window the iOS touch handler is sitting in. The memo, paired
 * with the `useMemo` on `availability` in the shell, collapses that
 * cascade so the strip only re-renders when the operator-visible
 * pill set actually changed. Per
 * `.planning/research/v15-insights-blocking-bug.md` fix 2.
 */
export const InsightsTabStrip = memo(InsightsTabStripImpl);
