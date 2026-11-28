"use client";

import { useEffect, useRef, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListOrdered, Plus } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { InfoPopover } from "@/components/ui/info-popover";
import { Button } from "@/components/ui/button";
import { TargetAdjustButton } from "@/components/insights/target-adjust-button";
import { TargetAdjustProvider } from "@/lib/insights/target-adjust-context";
import { useCoachMetricScope } from "@/components/insights/use-coach-metric-scope";
import { useScrollResetOnRoute } from "@/hooks/use-scroll-reset-on-route";
import { useTranslations } from "@/lib/i18n/context";
import { SUB_PAGE_SLUGS } from "@/lib/insights/sub-page-metric";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/ui/page-header";
import {
  MedicalDisclaimer,
  type DisclaimerVariant,
} from "@/components/common/medical-disclaimer";
import { ChartContextProvider } from "@/components/charts/health-chart/context-scope";

const INSIGHT_METRIC_RETURN_PATHS: Readonly<Record<string, true>> =
  Object.fromEntries(
    SUB_PAGE_SLUGS.map((slug) => [`/insights/${slug}`, true] as const),
  );
/**
 * v1.4.25 — common visual frame for each metric sub-page.
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
   * What the page is, behind the (i) beside the title, for a page without a
   * metric definition (`explainerMetric`). There is no sentence under the
   * title: the page opens on its title and its numbers.
   */
  info?: string;
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
   * Interpolation values for the explainer sentence, for a definition that
   * names figures in the reader's own unit (the glucose cut-points).
   */
  explainerParams?: Record<string, string>;
  /**
   * v1.4.27 — opt-in programmatic focus on mount.
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
   * The page's one self-description note, closing the spine. A metric page
   * says once that HealthLog does not diagnose; a page about associations
   * (mood, medication effect) says once that a pattern is not a cause. No
   * tile, caption or explainer on the page repeats it.
   */
  disclaimer?: DisclaimerVariant;
  /**
   * v1.21.2 — the "Coach read" strip, mounted between the stat strip and
   * the chart. A compact two-line own-baseline + lagged-association read that
   * makes the metric feel seen-in-context. Self-gating (renders nothing until
   * its server read lands, and nothing at all when there is no baseline and no
   * driver), so the spine's rhythm holds on the empty-state and brand-new-
   * metric paths. Omitted on the empty / loading / error branches.
   */
  coachReadStrip?: ReactNode;
  /**
   * v1.8.5 — measurement-diversity nudge.
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
   * v1.18.6 — RETIRED as a rendered control. With the Coach FAB
   * anchored bottom-right on every authenticated page, the per-metric
   * Coach icon was a redundant second entry point, so the shell no longer
   * paints anything for it.
   *
   * v1.21.0 — re-purposed without re-adding any control. When set
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
   * v1.8.5 — a "show all readings" entry linking to the dedicated
   * `/insights/values/<type>` subpage. Sub-pages pass the metric's
   * `MeasurementType`.
   *
   * v1.16.8 — renders as an icon button in the header action cluster
   * (left of the target-adjust gear), no longer as a full-width button
   * at the page foot.
   */
  showAllValuesType?: string;
  /**
   * A page-owned action that opens something in place rather than linking
   * away (the workouts page's "Log workout"). Leads the header cluster, in
   * the same 40 px ghost-icon shape as its siblings; the page owns the
   * control and whatever it opens.
   */
  headerAction?: ReactNode;
  /**
   * Draw what happened around the metric on the page's charts: medication
   * changes and illness episodes as quiet marks, cycle phases behind a
   * switch (`src/lib/charts/context-markers.ts`). Every full-size
   * `HealthChart` in the page reads them; a chart with nothing around it
   * draws as before.
   */
  chartContext?: boolean;
  children: ReactNode;
}

/**
 * The header's add action — one plus, one shape, on every Insights page that
 * offers one. A 40 px ghost icon with the extended hit area its cluster
 * siblings carry; the accessible name rides on `aria-label` and `title`.
 *
 * Two forms: `href` links to a capture form elsewhere (the measurement pages'
 * `captureType`), `onClick` opens something in place (the workouts and mood
 * pages). A page never draws its own "log an entry" text link instead.
 */
export function SubPageAddButton({
  label,
  href,
  onClick,
  slot,
}: {
  label: string;
  href?: string;
  onClick?: () => void;
  /** `data-slot` for tests; defaults to the shared one. */
  slot?: string;
}) {
  const className = cn(
    "text-muted-foreground hover:text-foreground relative size-10",
    "before:absolute before:-inset-1.5 before:content-['']",
  );
  const icon = <Plus className="size-4" aria-hidden="true" />;
  if (href) {
    return (
      <Button
        asChild
        variant="ghost"
        size="icon"
        data-slot={slot ?? "metric-add-reading"}
        data-header-add=""
        className={className}
      >
        <Link href={href} aria-label={label} title={label}>
          {icon}
        </Link>
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-slot={slot ?? "metric-add-reading"}
      data-header-add=""
      aria-label={label}
      title={label}
      onClick={onClick}
      className={className}
    >
      {icon}
    </Button>
  );
}

export function SubPageShell({
  title,
  backLink,
  badge,
  info,
  explainerMetric,
  explainerParams,
  focusOnMount = false,
  statStrip,
  disclaimer = "notDiagnosis",
  coachReadStrip,
  diversityNudge,
  // v1.21.0 — `coachLaunch` no longer renders a control (CCH-04
  // stands) but now gates whether the page registers its metric as the
  // Coach launch context's ambient scope, so the FAB opens contextual.
  coachLaunch = false,
  captureType,
  showAllValuesType,
  headerAction,
  chartContext = false,
  children,
}: SubPageShellProps) {
  const { t } = useTranslations();
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
  // v1.4.33 — the scroll-to-top affordance moved into the shared
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

  // v1.21.0 — register the page's metric as the Coach launch context's
  // ambient scope while the sub-page is mounted, only when the page opted in
  // (`coachLaunch`); see `useCoachMetricScope`.
  useCoachMetricScope(coachLaunch ? explainerMetric : undefined);

  return (
    // The target-adjust provider bridges the header gear (rendered just
    // below) to the per-metric `<TargetEditSheet>` opened from the
    // `<MetricTargetSummary>` card in the page body. It owns the sheet
    // state + renders the sheet, so the gear and the card don't have to
    // share a parent beyond this shell.
    <TargetAdjustProvider>
      <div data-slot="insights-subpage" className="space-y-4">
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
          {/* The heading row is the canonical PageHeader: the H1 on the
            page-title tier, a programmatic focus target after a client
            navigation, with the diversity nudge and the badge beside it
            (outside the heading's name) and the action cluster pinned
            top-right. The row keeps a constant `min-h-10` so the baseline
            holds whether or not the 44 px nudge glyph is present. */}
          <PageHeader
            title={title}
            titleId="insights-subpage-title"
            headingRef={headingRef}
            focusable
            className="[&_[data-slot=page-header-row]]:min-h-10"
            titleAccessory={
              explainerMetric || info || diversityNudge || badge ? (
                <span className="inline-flex items-center gap-1">
                  {/* The definition sits behind the (i): the page opens on
                    its title alone. */}
                  {explainerMetric || info ? (
                    <InfoPopover
                      align="start"
                      triggerDataSlot={
                        explainerMetric
                          ? "metric-explainer-trigger"
                          : "sub-page-info"
                      }
                      bodyDataSlot="metric-explainer"
                      content={
                        explainerMetric
                          ? t(
                              `insights.subPage.explainer.${explainerMetric}Body`,
                              explainerParams,
                            )
                          : info
                      }
                    />
                  ) : null}
                  {/* v1.8.6 — the diversity nudge rides the heading as a
                    `Lightbulb` glyph (the node self-gates to nothing when
                    the spread is healthy). */}
                  {diversityNudge}
                  {badge ? (
                    <Badge variant="outline" className="border text-xs">
                      {badge}
                    </Badge>
                  ) : null}
                </span>
              ) : undefined
            }
            actions={
              <>
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
                  {headerAction}
                  {captureHref ? (
                    <SubPageAddButton label={captureLabel} href={captureHref} />
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
                          pathname
                            ? `?from=${encodeURIComponent(pathname)}`
                            : ""
                        }`}
                        aria-label={t("insights.subPage.showAllValues")}
                        title={t("insights.subPage.showAllValues")}
                      >
                        <ListOrdered className="size-4" aria-hidden="true" />
                      </Link>
                    </Button>
                  ) : null}
                  <TargetAdjustButton />
                </div>
              </>
            }
          />
        </header>
        {/* The stat strip leads the spine, directly above the chart, and
          self-gates without data. Its numbers follow the chart's active range
          tab (7 / 30 / 90 / All), which the page threads back into it. */}
        {statStrip}
        {/* v1.21.2 — the "Coach read" strip sits between the numbers-first
          stat strip and the chart, so the spine reads intro → numbers → Coach
          read → chart → target → assessment. Self-gating, so the rhythm holds
          when the strip has nothing to say. */}
        {coachReadStrip}
        {/* v1.12.6 — the canonical spine body: intro (header) → stat strip
          (above) → chart → target card → assessment. The page renders
          chart → target → assessment as `children`. */}
        <ChartContextProvider enabled={chartContext}>
          {children}
        </ChartContextProvider>
        <MedicalDisclaimer variant={disclaimer} />
      </div>
    </TargetAdjustProvider>
  );
}
