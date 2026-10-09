"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import type { TrendSlope } from "@/lib/analytics/trends";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import type { ComparisonBaseline } from "@/lib/dashboard-layout";
import {
  getTrendSentiment,
  sentimentColorClass,
  type TrendDirectionSentiment,
} from "@/lib/insights/trend-sentiment";

interface SecondaryMetric {
  /** Sub-value latest reading (e.g. diastolic when latest is systolic). */
  latest: number | null;
  avg7: number | null;
  avg30: number | null;
}

interface TrendCardProps {
  label: string;
  latest: number | null;
  unit: string;
  avg7: number | null;
  avg30: number | null;
  avg7ColorClass?: string;
  avg30ColorClass?: string;
  avg7Hint?: React.ReactNode;
  avg30Hint?: React.ReactNode;
  slope30: TrendSlope | null;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Whether an upward slope is good, bad, or neutral for this metric.
   * Defaults to `"neutral"` so existing call sites that haven't been
   * updated keep the v1.4.6 behaviour (muted-foreground arrow).
   */
  directionSentiment?: TrendDirectionSentiment;
  /** Optional second value rendered next to the primary as `X / Y` (used for
   *  paired metrics like blood-pressure systolic/diastolic so a single tile
   *  shows both numbers). */
  secondary?: SecondaryMetric;
  /**
   * v1.4.15 Fix 4 — 7-day trend delta. When provided, the avg7 line
   * shows a signed delta (e.g. "+1.2 kg") next to the average and the
   * label switches from `charts.avg7dShort` (just "7d") to
   * `charts.trend7dShort` ("7d trend"). Color of the delta follows the
   * same `directionSentiment` rules as the headline arrow:
   *   - up-good metric, positive delta → green
   *   - up-bad metric, positive delta → orange
   *   - neutral metric → muted regardless of sign
   *
   * Pass `null` (default) to keep the legacy avg-only behaviour for
   * call sites that haven't been migrated yet.
   */
  trend7Delta?: number | null;
  /**
   * v1.4.16 phase B8 — comparison delta callout. When the dashboard's
   * comparison toggle is active and we can compute a baseline value,
   * the tile renders a "Δ −2.3 kg vs. last month" caption on a second
   * line below the latest value. Color follows the same metric-aware
   * sentiment rules as the headline arrow + 7d delta.
   *
   * `compareBaseline === "none"` or `compareDelta === null` keeps the
   * tile rendering exactly as before (regression guard).
   */
  compareBaseline?: ComparisonBaseline;
  compareDelta?: number | null;
  /**
   * v1.4.33 maintainer-item-1 — when the metric's most recent reading is
   * older than 7 days but the all-time count is still non-zero, the
   * caller passes a positive integer day count here. The tile renders a
   * muted "Letzter Wert vor Xd" caption underneath the value row so the
   * user sees the tile didn't disappear because of stale data — it kept
   * showing the historical value with an explicit "how old" hint.
   *
   * `null` / `undefined` suppresses the caption (current data path).
   */
  staleDays?: number | null;
  /**
   * v1.17 W1b — short text shown in the headline slot in place of the
   * "—" placeholder when `latest === null`. Used by the BD-Zielbereich
   * tile to render "collecting data" while the trailing window has too
   * few readings to narrate a confident percentage. When omitted the
   * legacy "—" placeholder renders. Rendered at a smaller size than a
   * numeric headline so the longer string fits the deterministic tile
   * height.
   */
  emptyHint?: string | null;
  /**
   * v1.28.x — optional adornment rendered directly after the unit in the
   * value row (before the trend-arrow slot). The dashboard sleep tile
   * passes the discreet source-discrepancy marker here so the hint sits
   * next to the number it annotates. Absent → the row renders exactly as
   * before (no reserved space, no layout shift).
   */
  valueAdornment?: React.ReactNode;
  /**
   * Decimal places for the headline, the averages and the deltas. Defaults
   * to 1. A whole-number metric (steps, mmHg, bpm, mg/dL) passes 0 so the
   * tile reads "121 mmHg", not "121,0 mmHg" — the precision its own
   * insights page uses.
   */
  fractionDigits?: number;
}

export function TrendCard({
  label,
  latest,
  unit,
  avg7,
  avg30,
  avg7ColorClass,
  avg30ColorClass,
  avg7Hint,
  avg30Hint,
  slope30,
  icon: Icon,
  directionSentiment = "neutral",
  secondary,
  trend7Delta = null,
  compareBaseline = "none",
  compareDelta = null,
  staleDays = null,
  emptyHint = null,
  valueAdornment = null,
  fractionDigits = 1,
}: TrendCardProps) {
  const { t, tCount } = useTranslations();
  const fmt = useFormatters();

  // v1.4.33 F5 — pick a single signal to drive both the arrow and the
  // 7-day delta value so they never disagree. `trend7Delta` is the
  // user-facing number on the tile; when present, the arrow follows
  // its sign. When the caller only supplies `slope30` (legacy tiles
  // that haven't been migrated to a delta), we project the slope over
  // a 7-day window so both signals share the same dimension. This
  // unifies the F5 audit complaint where a green arrow + orange value
  // appeared on the same tile because slope30 and trend7Delta could
  // legitimately disagree (30-day downward arc, 7-day uptick).
  const primarySignal: number | null =
    trend7Delta != null ? trend7Delta : slope30 ? slope30.slope * 7 : null;

  const TrendIcon = ((): typeof ArrowUp => {
    if (primarySignal == null) return Minus;
    if (Math.abs(primarySignal) < 0.05) return ArrowRight;
    return primarySignal > 0 ? ArrowUp : ArrowDown;
  })();

  // Sentiment is one centralized helper now — see `getTrendSentiment`
  // at the top of the file. All three tile elements (arrow, 7-day
  // delta value, comparison-overlay caption) route through the same
  // function so colour reads as "same signal" across the tile.
  const arrowSentiment = getTrendSentiment(primarySignal, directionSentiment);
  const trendColor = sentimentColorClass(arrowSentiment);

  const formatValue = (value: number) => fmt.number(value, fractionDigits);

  // v1.4.15 Fix 4 — the 7-day delta now shares the arrow's colour so
  // both elements communicate the same sentiment for the same signal.
  const deltaSentiment = getTrendSentiment(trend7Delta, directionSentiment);
  const deltaColor = sentimentColorClass(deltaSentiment);

  /**
   * v1.4.16 phase B8 — color the comparison delta with the same
   * metric-aware sentiment rules used everywhere else on the tile.
   * Tiny deltas read as stable and stay muted.
   */
  const comparisonSentiment = getTrendSentiment(
    compareDelta,
    directionSentiment,
  );
  const comparisonDeltaColor = sentimentColorClass(comparisonSentiment);

  const formatDelta = (value: number): string => {
    // Below half a step of the shown precision the delta prints as zero.
    if (Math.abs(value) < 0.5 * 10 ** -fractionDigits) return `±0`;
    const sign = value > 0 ? "+" : "−";
    return `${sign}${fmt.number(Math.abs(value), fractionDigits)}`;
  };

  // The label flips from "7d" / "7T" (mean) to "7d trend" / "7T-Trend"
  // when the call site supplies a delta. the maintainer's v1.4.15 feedback —
  // "7-Tage-Schnitt" sounds like an average, but the value next to it
  // is now a TREND. Distinct keys keep the label change in i18n.
  const avg7LabelKey =
    trend7Delta != null ? "charts.trend7dShort" : "charts.avg7dShort";

  const renderPair = (
    primary: number | null,
    secondaryValue: number | null | undefined,
  ): string => {
    if (primary === null) return "—";
    if (secondary && secondaryValue !== null && secondaryValue !== undefined) {
      return `${formatValue(primary)}/${formatValue(secondaryValue)}`;
    }
    return formatValue(primary);
  };

  return (
    <div className="bg-card border-border flex h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border p-4 md:p-6">
      {/* v1.4.25 W20a — single-line discipline + deterministic height for
          the heading row so the value row below sits at the same baseline
          across every tile. The label is locale-abbreviated upstream (see
          `dashboard.*Short` keys) so `truncate` is a layout safeguard
          rather than the primary defence against wraps. `h-5` matches
          `text-xs leading-5` ≈ 20 px; identical across every tile. */}
      <div className="flex h-5 min-w-0 items-center justify-between gap-2">
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate text-xs leading-5 font-medium tracking-wide whitespace-nowrap uppercase"
          data-slot="trend-card-label"
        >
          {label}
        </span>
        <Icon className="text-muted-foreground h-4 w-4 shrink-0" />
      </div>
      {/* v1.4.25 W20a — baseline-aligned value row. The headline value,
          unit, and trend arrow share a single flex line with
          `items-baseline` so the digits line up at the same y-coordinate
          across every tile in the strip (Weight 80 kg vs. BP 122 mmHg used
          to land at different heights when one tile had a one-line heading
          and another had a two-line wrap). The arrow slot is always
          present — when there is no signal yet, a muted "—" placeholder
          renders so the value row keeps a deterministic width. The maintainer's
          ask: "rechts neben der Zahl … der Pfeil [ist], wie gerade der
          Trend ist". */}
      <div
        className="mt-2 flex items-baseline gap-x-1.5"
        data-slot="trend-card-value-row"
      >
        {latest === null && emptyHint ? (
          // v1.17 W1b — thin-data placeholder. Renders the caller's short
          // text (e.g. "collecting data") where the numeric headline would
          // sit, at a smaller size so the longer phrase fits the tile's
          // deterministic height. No unit; the arrow slot below still
          // renders its muted placeholder so the row width stays stable.
          <span
            className="text-muted-foreground min-w-0 truncate text-base leading-none font-medium"
            data-slot="trend-card-empty-hint"
          >
            {emptyHint}
          </span>
        ) : (
          <>
            <span
              className={cn(
                "shrink-0 font-semibold tracking-tight whitespace-nowrap tabular-nums",
                // v1.8.7 — the value NEVER truncates, clips, or wraps
                // mid-number. The maintainer is emphatic: every digit of
                // the reading must render in full ("130 mmHg" must read as
                // "130", never "13" then "3 mmHg"). The headline value span
                // is `shrink-0 whitespace-nowrap` so it keeps its full
                // intrinsic width and wins the horizontal-space contest
                // against the unit. When the strip is dense (many tiles →
                // narrow column) the UNIT yields — it shrinks (`min-w-0
                // truncate`) and may ellipsis — rather than losing any
                // digit of the number. The earlier `min-w-0 truncate` on
                // this span was the bug: it let the value shrink below its
                // content width and clip the number.
                //
                // v1.4.49.4 — paired values (BP systolic/diastolic) render
                // as `131/85` and outgrow the `text-3xl` footprint on the
                // narrowest grid columns. Paired tiles drop one font step
                // (text-3xl → text-2xl) so the full pair fits; single-value
                // tiles (weight, pulse, glucose, …) keep text-3xl.
                secondary ? "text-2xl" : "text-3xl",
                // `leading-none` must come AFTER the font-size class in the
                // cn() arg list. Tailwind v4 `text-3xl` / `text-2xl` ship
                // their own default `line-height`, so `twMerge` would
                // otherwise drop the explicit `leading-none` per the
                // last-wins rule and break the W20a across-tile baseline
                // alignment (digits line up at the same y-coordinate
                // across every tile in the strip).
                "leading-none",
              )}
              data-slot="trend-card-value"
            >
              {latest !== null ? renderPair(latest, secondary?.latest) : "—"}
            </span>
            <span className="text-muted-foreground min-w-0 truncate text-sm tabular-nums">
              {unit}
            </span>
            {/* v1.28.x — optional inline adornment (e.g. the sleep tile's
                source-discrepancy marker). `self-center` keeps the icon
                vertically centred in the row without disturbing the
                baseline alignment of the value + unit pair. */}
            {valueAdornment != null ? (
              <span
                className="inline-flex shrink-0 self-center"
                data-slot="trend-card-value-adornment"
              >
                {valueAdornment}
              </span>
            ) : null}
          </>
        )}
        <span
          className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
          data-slot="trend-card-arrow"
          aria-hidden="true"
        >
          {primarySignal != null ? (
            <TrendIcon className={`h-4 w-4 ${trendColor}`} />
          ) : (
            <span className="text-muted-foreground text-xs opacity-30">—</span>
          )}
        </span>
      </div>
      {/* v1.4.29 — `min-h-[18px]` reserves the callout slot at every
          breakpoint so an empty callout doesn't drift sibling tiles
          18 px taller. v1.4.32 dropped the reservation at `sm:` (via
          `sm:min-h-0`); the v1.4.33 A3 Win 5 audit caught the
          asymmetry — a comparison-overlay run on the BD-Zielbereich
          tile expanded the strip's intrinsic height while its
          no-callout neighbours stayed short. Holding the floor across
          breakpoints makes the row's height deterministic regardless
          of which tiles render the callout. The callout itself clamps
          to one line at `<sm`; `sm:` releases the line-clamp + the
          [overflow-wrap:anywhere] fallback. */}
      <div className="mt-1 min-h-[18px]">
        {compareBaseline !== "none" && compareDelta != null && (
          <span
            className={cn(
              "line-clamp-1 inline-block max-w-full text-xs leading-snug font-medium tabular-nums sm:line-clamp-none sm:[overflow-wrap:anywhere]",
              comparisonDeltaColor,
            )}
            data-slot="tile-compare-delta"
            data-compare-baseline={compareBaseline}
            aria-label={`${formatDelta(compareDelta)}${unit ? ` ${unit}` : ""} ${t(
              compareBaseline === "lastMonth"
                ? "comparison.captionLastMonth"
                : "comparison.captionLastYear",
            )}`}
          >
            {`Δ ${formatDelta(compareDelta)}${unit ? ` ${unit}` : ""} ${t(
              compareBaseline === "lastMonth"
                ? "comparison.captionLastMonth"
                : "comparison.captionLastYear",
            )}`}
          </span>
        )}
        {/* v1.4.33 maintainer-item-1 — stale-data caption. Renders
            only when the caller passes `staleDays` (positive integer
            of days since the metric's last reading). The tile keeps
            the historical value visible because the maintainer would
            rather see "Letzter Wert vor 12d / 80,2 kg" than have the
            whole tile disappear because of a gap in logging. Ride the
            same callout-slot reservation as the comparison-overlay
            caption; on `<sm` the line-clamp keeps the 140 px height
            contract intact.

            v1.4.34 IW-B — bucket-aware copy. Days under a week stay
            silent (the tile reads as fresh); 8-30 days surfaces as
            "vor Xd"; 31-60 days collapses to "vor X Wochen"; beyond
            two months collapses to "vor X Monaten". One key per
            bucket plus a singular/plural pair so locales with
            non-English plural rules read naturally. */}
        {staleDays != null && staleDays > 7 && (
          <span
            className="text-muted-foreground line-clamp-1 inline-block max-w-full text-xs leading-snug tabular-nums sm:line-clamp-none"
            data-slot="tile-stale-hint"
            data-stale-days={staleDays}
          >
            {(() => {
              if (staleDays <= 30) {
                return t("dashboard.staleHint", { count: staleDays });
              }
              if (staleDays <= 60) {
                const weeks = Math.floor(staleDays / 7);
                return tCount("dashboard.staleHintWeeks", weeks);
              }
              const months = Math.floor(staleDays / 30);
              return tCount("dashboard.staleHintMonths", months);
            })()}
          </span>
        )}
      </div>
      <TooltipProvider>
        {/* v1.4.29 — sub-row pair clips rather than wraps at `<sm`
            so a narrow tile cannot grow vertically beyond the
            140-px contract. `sm:` releases back to the original
            wrap behaviour. */}
        <div className="text-muted-foreground mt-auto flex min-w-0 flex-nowrap items-baseline gap-x-3 overflow-hidden pt-1 text-xs leading-snug sm:flex-wrap sm:gap-y-1">
          <span className="max-w-full min-w-0 [overflow-wrap:anywhere]">
            {t(avg7LabelKey)}:{" "}
            {avg7Hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "font-medium [overflow-wrap:anywhere] tabular-nums",
                      avg7ColorClass,
                    )}
                  >
                    {avg7 !== null ? renderPair(avg7, secondary?.avg7) : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-muted border-border text-foreground">
                  <div className="space-y-1 text-xs">{avg7Hint}</div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className={cn(
                  "font-medium [overflow-wrap:anywhere] tabular-nums",
                  avg7ColorClass,
                )}
              >
                {avg7 !== null ? renderPair(avg7, secondary?.avg7) : "—"}
              </span>
            )}
            {trend7Delta != null && (
              <span
                className={cn(
                  "ml-1 font-medium [overflow-wrap:anywhere] tabular-nums",
                  deltaColor,
                )}
                data-slot="trend7-delta"
                aria-label={`7-day trend ${formatDelta(trend7Delta)}`}
              >
                ({formatDelta(trend7Delta)})
              </span>
            )}
          </span>
          <span className="max-w-full min-w-0 [overflow-wrap:anywhere]">
            {t("charts.avg30dShort")}:{" "}
            {avg30Hint ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className={cn(
                      "font-medium [overflow-wrap:anywhere] tabular-nums",
                      avg30ColorClass,
                    )}
                  >
                    {avg30 !== null ? renderPair(avg30, secondary?.avg30) : "—"}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="bg-muted border-border text-foreground">
                  <div className="space-y-1 text-xs">{avg30Hint}</div>
                </TooltipContent>
              </Tooltip>
            ) : (
              <span
                className={cn(
                  "font-medium [overflow-wrap:anywhere] tabular-nums",
                  avg30ColorClass,
                )}
              >
                {avg30 !== null ? renderPair(avg30, secondary?.avg30) : "—"}
              </span>
            )}
          </span>
          {/* v1.4.28 FB-C2 — the all-time third sub-value retired
              alongside the `avgAllTime*` props. The BD-Zielbereich
              tile was the only consumer; the same number stays
              visible on the Insights blood-pressure target panel with
              full context. Every dashboard tile now ships the same two
              sub-rows. */}
        </div>
      </TooltipProvider>
    </div>
  );
}
