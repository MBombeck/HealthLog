"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListOrdered, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TargetAdjustButton } from "@/components/insights/target-adjust-button";
import { TargetAdjustProvider } from "@/lib/insights/target-adjust-context";
import { metricScopeFromExplainer } from "@/components/insights/coach-metric-scope";
import { useCoachLaunch } from "@/lib/insights/coach-launch-context";
import { useScrollResetOnRoute } from "@/hooks/use-scroll-reset-on-route";
import { useTranslations } from "@/lib/i18n/context";
import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";
import { cn } from "@/lib/utils";

const INSIGHT_METRIC_RETURN_PATHS: Readonly<Record<string, true>> =
  Object.fromEntries(
    SUB_PAGE_SLUGS.map((slug) => [`/insights/${slug}`, true] as const),
  );
/**
 * v1.4.25 W4 — common visual frame for each metric sub-page.
 *
 * Each sub-page renders:
 *   - a calm header (title + optional status badge),
 *   - the canonical chart for the metric (passed in as `chart` so the
 *     page can wire the right `chartKey`, target zones, value bands, …),
 *   - secondary slot for related cards (correlation cards, per-medication
 *     lists, …).
 *
 * The shell handles focus restoration on route change — a screen-reader
 * user landing here from a tab click hears the page heading
 * automatically because we mount an `id="insights-subpage-title"`
 * h1 with `tabIndex={-1}` and focus it on mount. Sighted users get a
 * `scrollTo({ top: 0 })` so deep-scroll position from the previous
 * sub-page doesn't leak in.
 */

export interface SubPageShellProps {
  title: string;
  /**
   * v1.8.7.1 — optional back-navigation control rendered ABOVE the page
   * heading, the standard back-nav placement. Detail/values sub-pages
   * (`/insights/values/[type]`, `/insights/workouts/[id]`) pass their
   * "back to …" link here so it leads the page rather than trailing the
   * content. Omitted on the mother page and category pages reached via the
   * tab strip.
   */
  backLink?: ReactNode;
  /** Optional accent badge (status, dataset coverage, …). */
  badge?: ReactNode;
  /**
   * Optional short paragraph beneath the title, mirroring the Apple-Health
   * convention of a one-line scaffold on every metric page. The mother
   * page does not pass it; sub-pages use it to anchor the surface.
   */
  description?: string;
  /**
   * v1.8.0 — when set, the metric's static "What is X?" definition
   * renders as a muted caption directly beneath the heading. The value
   * is the metric key feeding `insights.subPage.explainer.<metric>Body`.
   * Omitted on the mother page; every routed metric sub-page passes its
   * key.
   *
   * v1.8.6 — the round `?` popover affordance next to the heading is
   * gone (it read as restless next to the title). The inline definition
   * caption stays — it is the single always-visible source of the
   * one- to two-sentence definition, no tap required.
   */
  explainerMetric?: string;
  /**
   * v1.4.27 MB7 / CF-35 — opt-in programmatic focus on mount.
   *
   * The legacy default-on `focus()` call moved screen-reader focus to
   * the heading but on mobile it also fought the soft-keyboard: a
   * sub-page navigation that landed while a form was open dismissed
   * the keyboard mid-typing. Default is now `false`; sub-pages that
   * actually want the screen-reader landing (today: none; the routed
   * sub-pages do not auto-focus anything) opt in explicitly.
   *
   * The `scrollTo({ top: 0 })` still fires unconditionally because
   * the deep-scroll reset between routed sub-pages is a sighted-user
   * affordance, not an a11y one.
   */
  focusOnMount?: boolean;
  /**
   * v1.12.6 — the Min / Max / Median / Mittelwert stat strip. It now leads
   * the canonical spine, directly ABOVE the chart, so every metric subpage
   * reads the same: intro → stat strip → chart → target → assessment.
   * Numbers-first matches how Apple Health / Withings / Oura lead a detail
   * screen. Sub-pages pass `<MetricStatStrip metric=… />`; the strip
   * self-gates (renders nothing without data), so the empty-state and
   * brand-new-metric paths stay clean. Omitted on the empty-state branch.
   */
  statStrip?: ReactNode;
  /**
   * v1.21.2 (A1) — the "Coach read" strip, mounted between the stat strip and
   * the chart. A compact two-line own-baseline + lagged-association read that
   * makes the metric feel seen-in-context. Self-gating (renders nothing until
   * its server read lands, and nothing at all when there is no baseline and no
   * driver), so the spine's rhythm holds on the empty-state and brand-new-
   * metric paths. Omitted on the empty / loading / error branches.
   */
  coachReadStrip?: ReactNode;
  /**
   * v1.8.5 W4b — measurement-diversity nudge.
   *
   * v1.8.6 — relocated from an inline block under the stat strip to a
   * `Lightbulb` glyph beside the heading (a hover / focus Tooltip carries
   * the hint copy). The node is `<MeasurementDiversityNudge>`, which is
   * self-gating: it renders the glyph only when readings cluster on one
   * weekday / time, and nothing when the spread is healthy.
   */
  diversityNudge?: ReactNode;
  /**
   * v1.8.6 — opt-in Coach launch in the page header.
   *
   * v1.18.6 (CCH-04) — RETIRED as a rendered control. With the Coach FAB
   * anchored bottom-right on every authenticated page, the per-metric
   * Coach icon was a redundant second entry point, so the shell no longer
   * paints anything for it.
   *
   * v1.21.0 (C4 H1) — re-purposed without re-adding any control. When set
   * (and `explainerMetric` maps to a Coach source), the shell registers
   * the page's metric as the launch context's ambient scope while it is
   * mounted. The global FAB then opens a conversation pre-scoped to this
   * metric with a data-aware seed question — so drilling into BP / weight
   * / sleep and tapping the FAB no longer opens a blank chat. Still no
   * second header affordance: the FAB stays the single entry point.
   */
  coachLaunch?: boolean;
  /**
   * Canonical measurement-form type for the populated page's contextual
   * capture action. Omit it for device-only or derived metrics.
   */
  captureType?: string;
  /**
   * v1.8.5 W4b — a "show all readings" entry linking to the dedicated
   * `/insights/values/<type>` subpage. Sub-pages pass the metric's
   * `MeasurementType`.
   *
   * v1.16.8 — renders as an icon button in the header action cluster
   * (left of the target-adjust gear), no longer as a full-width button
   * at the page foot.
   */
  showAllValuesType?: string;
  children: ReactNode;
}

export function SubPageShell({
  title,
  backLink,
  badge,
  description,
  explainerMetric,
  focusOnMount = false,
  statStrip,
  coachReadStrip,
  diversityNudge,
  // v1.21.0 (C4 H1) — `coachLaunch` no longer renders a control (CCH-04
  // stands) but now gates whether the page registers its metric as the
  // Coach launch context's ambient scope, so the FAB opens contextual.
  coachLaunch = false,
  captureType,
  showAllValuesType,
  children,
}: SubPageShellProps) {
  const { t } = useTranslations();
  const launch = useCoachLaunch();
  // v1.10.2 — the "show all readings" link carries the originating metric
  // page as a `from` param so the values sub-page can offer a back-link to
  // where the user drilled in from (e.g. `weight → show all values → back to
  // weight`) rather than always returning to the Insights overview.
  const pathname = usePathname();
  const captureReturnTo =
    pathname && INSIGHT_METRIC_RETURN_PATHS[pathname] ? pathname : null;
  const captureHref =
    captureType && captureReturnTo
      ? `/measurements?add=${encodeURIComponent(
          captureType,
        )}&returnTo=${encodeURIComponent(captureReturnTo)}`
      : null;
  const captureLabel = `${t("measurements.addMeasurement")}: ${title}`;
  // a11y: focus the heading on mount so a tab-strip navigation actually
  // moves screen-reader focus into the sub-page body. v1.4.27 MB7 /
  // CF-35 made the focus call opt-in via `focusOnMount` — the
  // default-on version stole focus from soft-keyboards on mobile.
  //
  // v1.4.33 IW9 — the scroll-to-top affordance moved into the shared
  // `useScrollResetOnRoute()` hook so the mother page + sub-page can't
  // both fire (which produced a visible double-snap when the chart
  // skeleton inflated between the two RAF callbacks). The hook itself
  // still defers to `requestAnimationFrame` so the scroll lands after
  // first paint, same behaviour the legacy in-line effect provided.
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  useScrollResetOnRoute();
  useEffect(() => {
    if (!focusOnMount || typeof window === "undefined") return;
    const handle = window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(handle);
  }, [focusOnMount]);

  // v1.21.0 (C4 H1) — register the page's metric as the Coach launch
  // context's ambient scope while the sub-page is mounted, so the global
  // FAB opens a conversation pre-scoped to this metric with a data-aware
  // seed question. Only when the page opted in (`coachLaunch`) and its
  // `explainerMetric` maps to a snapshot source; mobility / gait micro-
  // metrics with no map entry leave the FAB on its default snapshot. The
  // cleanup lifts the scope on navigation away.
  const registerScope = launch?.registerScope;
  useEffect(() => {
    if (!coachLaunch || !registerScope) return;
    const resolved = metricScopeFromExplainer(explainerMetric);
    if (!resolved) return;
    return registerScope(
      {
        metric: resolved.metric,
        also: resolved.also,
        window: resolved.window,
      },
      // v1.22 (W6) — `question` is now an i18n key; resolve it so the composer
      // seed reads in the user's language.
      t(resolved.question),
    );
  }, [coachLaunch, registerScope, explainerMetric, t]);

  return (
    // The target-adjust provider bridges the header gear (rendered just
    // below) to the per-metric `<TargetEditSheet>` opened from the
    // `<MetricTargetSummary>` card in the page body. It owns the sheet
    // state + renders the sheet, so the gear and the card don't have to
    // share a parent beyond this shell.
    <TargetAdjustProvider>
      <div data-slot="insights-subpage" className="space-y-3 md:space-y-4">
        {/* v1.8.7.1 — back-nav leads the page, above the heading. */}
        {backLink}
        {/* The heading + explainer indent to the cards' inner text edge so
            the page head reads as part of the card column instead of hanging
            outside it. Track the card slot inset EXACTLY (`px-4 md:px-6`) —
            never a flat `px-6`, which sat 8 px right of every card body on
            mobile and reopened the heading-vs-body step (insights left-edge
            rule: one reading edge across breakpoints). */}
        <header className="space-y-1.5 px-4 md:px-6">
          {/* v1.8.6 — the heading row pins the Coach icon top-right while the
            title / nudge / badge wrap together on the left.

            Design M2 fix: the Coach icon is a `shrink-0` sibling of the
            left group (not an `ml-auto` member of a single flex-wrap row),
            so a long or wrapped title can never isolate it or crowd it on a
            375 px screen — it stays cleanly top-right and the title text
            reflows in the space that remains.

            Design M1 fix: the row reserves a constant `min-h-10` so the
            baseline holds whether or not the self-gating diversity-nudge
            glyph (a 44 px-tall touch target) is present — category pages
            with and without a nudge now align. `items-start` keeps the
            Coach icon at the top of the row when the title wraps to two
            lines. */}
          <div className="flex min-h-10 items-start justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h1
                ref={headingRef}
                id="insights-subpage-title"
                tabIndex={-1}
                className={cn(
                  "text-xl font-semibold sm:text-2xl",
                  // a11y: sighted-keyboard users (e.g. "Skip to content")
                  // need a visible focus indicator on the programmatic
                  // `headingRef.focus()` call below. Match the focus ring
                  // vocabulary used on insights pills + Coach affordances.
                  "focus-visible:ring-ring/50 rounded-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                )}
              >
                {title}
              </h1>
              {/* v1.8.6 — the diversity nudge rides the heading as a
                `Lightbulb` glyph (the node self-gates to nothing when the
                spread is healthy), replacing the old inline block. */}
              {diversityNudge}
              {badge ? (
                <Badge variant="outline" className="border text-xs">
                  {badge}
                </Badge>
              ) : null}
            </div>
            {/* Header action cluster, pinned top-right at heading height by
              the row's `justify-between` so it aligns with the title
              regardless of badge / glyph presence or a wrapped title.

              The target-adjust gear sits to the LEFT of the Coach icon.
              It self-gates on a registered editable target (a metric with
              no numeric band registers nothing, so the gear stays hidden),
              and the Coach icon self-gates on the Coach flag + per-user
              opt-out — so the cluster collapses cleanly to one, both, or
              neither control.

              `gap-3` (12 px) keeps the siblings' extended hit areas
              (`before:-inset-1.5`, 6 px per edge) from overlapping —
              with a tighter gap the later sibling's invisible halo sat
              on top of its neighbour's clickable edge. */}
            <div className="flex shrink-0 items-center gap-3">
              {captureHref ? (
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  data-slot="metric-add-reading"
                  className={cn(
                    "text-muted-foreground hover:text-foreground relative size-10",
                    "before:absolute before:-inset-1.5 before:content-['']",
                  )}
                >
                  <Link
                    href={captureHref}
                    aria-label={captureLabel}
                    title={captureLabel}
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              ) : null}
              {/* v1.16.8 — "show all readings" rides the header cluster
                as an icon button, LEFT of the target-adjust gear (it
                used to be a full-width outline button at the page foot).
                Same 40 px box + extended hit area as its siblings; the
                label travels via aria-label + title. */}
              {showAllValuesType ? (
                <Button
                  asChild
                  variant="ghost"
                  size="icon"
                  data-slot="metric-show-all-values"
                  className={cn(
                    // Match the cluster's 40 px icon box + extended hit
                    // area (see `<TargetAdjustButton>` for the WCAG
                    // 2.5.5 note).
                    "text-muted-foreground hover:text-foreground relative size-10",
                    "before:absolute before:-inset-1.5 before:content-['']",
                  )}
                >
                  <Link
                    href={`/insights/values/${showAllValuesType}${
                      pathname ? `?from=${encodeURIComponent(pathname)}` : ""
                    }`}
                    aria-label={t("insights.subPage.showAllValues")}
                    title={t("insights.subPage.showAllValues")}
                  >
                    <ListOrdered className="size-4" aria-hidden="true" />
                  </Link>
                </Button>
              ) : null}
              <TargetAdjustButton />
              {/* v1.18.6 (CCH-04) — the per-metric Coach launch icon is
                gone. With the Coach FAB anchored bottom-right on every
                authenticated page, a second Coach affordance in each
                metric header was redundant. The `coachLaunch` prop is
                still accepted (every metric page passes it) but no longer
                paints a control — the FAB is the single Coach entry. */}
              {/* v1.16.8 — the v1.16.4 customise cog is gone: the sticky
                tab strip above already carries the same control on every
                insights surface, so the header copy was a duplicate. */}
            </div>
          </div>
          {explainerMetric ? (
            // v1.8.4 — surface the metric's static definition inline,
            // directly beneath the heading.
            //
            // v1.8.5 W4a — render the explainer body as the *single* caption
            // under the heading. Pre-v1.8.5 both this paragraph and the
            // `description` below it stacked, so every metric page opened
            // with two near-duplicative muted captions before any data — the
            // root of the "airy / static under the heading" feel. The
            // explainer body is the definition, so it wins; the description
            // only renders when no explainer is set (the mother page and any
            // future explainer-less sub-page).
            //
            // v1.8.6 — this caption is now the only surface for the
            // definition; the round `?` popover that used to read the same
            // string was removed.
            <p
              data-slot="metric-explainer-inline"
              className="text-foreground text-sm leading-relaxed"
            >
              {t(`insights.subPage.explainer.${explainerMetric}Body`)}
            </p>
          ) : null}
          {description && !explainerMetric ? (
            <p className="text-muted-foreground text-sm">{description}</p>
          ) : null}
        </header>
        {/* v1.12.6 — the Min / Max / Median / Mittelwert stat strip LEADS
          the spine, directly above the chart. Self-gating (renders nothing
          without data), so the spacing rhythm holds on the empty-state and
          brand-new-metric paths. Numbers-first is the Apple-Health /
          Withings / Oura detail-screen convention.

          v1.12.8 — the stats are chart-reactive: the chart reports the
          per-type Min / Max / Median / Mean for the data under its active
          range tab (7 / 30 / 90 / All), and the page threads it back into the
          strip so the numbers always reflect the range the chart paints. No
          drag, no pill — the range tab is the single selector. */}
        {statStrip}
        {/* v1.21.2 (A1) — the "Coach read" strip sits between the numbers-first
          stat strip and the chart, so the spine reads intro → numbers → Coach
          read → chart → target → assessment. Self-gating, so the rhythm holds
          when the strip has nothing to say. */}
        {coachReadStrip}
        {/* v1.12.6 — the canonical spine body: intro (header) → stat strip
          (above) → chart → target card → assessment. The page renders
          chart → target → assessment as `children`. */}
        {children}
        {/* v1.16.8 — the foot-of-page "show all readings" button moved
          into the header cluster as an icon button (left of the
          target-adjust gear), so the page body ends on its content. */}
      </div>
    </TargetAdjustProvider>
  );
}
