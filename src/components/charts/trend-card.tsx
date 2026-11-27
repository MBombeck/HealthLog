"use client";

import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import type { TrendSlope } from "@/lib/analytics/trends";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useTranslations, useFormatters } from "@/lib/i18n/context";
import type { ComparisonBaseline } from "@/lib/dashboard/chart-overlay-prefs";
import {
  getTrendSentiment,
  sentimentColorClass,
  type TrendDirectionSentiment,
} from "@/lib/insights/trend-sentiment";
import { TrendTile } from "@/components/ui/trend-tile";
import { TileHeader } from "@/components/insights/tile-header";
import type { MetricName } from "@/lib/measurements/type-label-keys";

interface SecondaryMetric {
  /** Sub-value latest reading (e.g. diastolic when latest is systolic). */
  latest: number | null;
  avg7: number | null;
  avg30: number | null;
  /** The second value's 7-day trend, printed beside the first ("+3/+1"). */
  trend7Delta?: number | null;
}

/**
 * An average whose colour has a meaning: a tap shows what the colour says.
 * The tile is a link to the metric's page, and this tap opens the hint, not
 * the page.
 */
function HintedValue({
  hint,
  className,
  children,
}: {
  hint: React.ReactNode;
  className: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="contents"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <Popover>
        <PopoverTrigger
          className={cn(
            // On touch the trigger is 44 px tall; the negative margin keeps
            // the tile's line where it was.
            "focus-visible:ring-ring/50 rounded-sm underline decoration-dotted underline-offset-2 focus-visible:ring-2 focus-visible:outline-none pointer-coarse:-my-3.5 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center",
            className,
          )}
        >
          {children}
        </PopoverTrigger>
        <PopoverContent className="space-y-1">{hint}</PopoverContent>
      </Popover>
    </span>
  );
}

interface TrendCardProps {
  /** A metric's `MetricName` shows its short form; see `TileHeader`. */
  label: string | MetricName;
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
   * v1.4.15 — 7-day trend delta. When provided, the avg7 line
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
   * v1.4.16 — comparison delta callout. When the dashboard's
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
   * v1.4.33 — when the metric's most recent reading is
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
   * v1.17 — short text shown in the headline slot in place of the
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

  // v1.4.33 — pick a single signal to drive both the arrow and the
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

  // v1.4.15 — the 7-day delta now shares the arrow's colour so
  // both elements communicate the same sentiment for the same signal.
  const deltaSentiment = getTrendSentiment(trend7Delta, directionSentiment);
  const deltaColor = sentimentColorClass(deltaSentiment);

  /**
   * v1.4.16 — color the comparison delta with the same
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
  const trendText = [trend7Delta, secondary?.trend7Delta]
    .flatMap((d) => (d == null ? [] : [formatDelta(d)]))
    .join("/");

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

  // A mean, coloured against its band; a coloured one opens what the colour
  // says.
  const mean = (
    value: number | null,
    second: number | null | undefined,
    colorClass: string | undefined,
    hint: React.ReactNode,
  ) => {
    const className = cn(
      "font-medium [overflow-wrap:anywhere] tabular-nums",
      colorClass,
    );
    const text = value !== null ? renderPair(value, second) : "—";
    return hint ? (
      <HintedValue hint={hint} className={className}>
        {text}
      </HintedValue>
    ) : (
      <span className={className}>{text}</span>
    );
  };

  return (
    <TrendTile data-slot="trend-card">
      {/* The heading is the tile header every other metric tile uses
          (`TileHeader`, UI standards §1): foreground icon on the left,
          title beside it, on ONE line (`reserveLines={1}`). The strip passes
          the glossary's short form (`MetricName`: "Resting HR", "BP",
          "HRV (SDNN)"), the full name stays the tooltip and the accessible
          name, and a title that still does not fit ends in an ellipsis. One
          line in every tile keeps the value rows on one baseline. */}
      <TileHeader
        icon={Icon}
        title={label}
        reserveLines={1}
        className="min-w-0"
      />
      {/* The value row: value, unit and the trend arrow on one baseline,
          the same in every tile, so the digits line up across the strip.
          The arrow slot keeps its width when there is no signal yet. */}
      <div
        className="mt-3 flex items-baseline gap-x-1.5"
        data-slot="trend-card-value-row"
      >
        {latest === null && emptyHint ? (
          // v1.17 — thin-data placeholder. Renders the caller's short
          // text (e.g. "collecting data") where the numeric headline would
          // sit, at a smaller size so the longer phrase fits the tile's
          // deterministic height. No unit; the arrow slot below still
          // keeps its width (empty) so the row width stays stable.
          <span
            className="text-muted-foreground min-w-0 truncate text-base leading-none font-medium"
            data-slot="trend-card-empty-hint"
          >
            {emptyHint}
          </span>
        ) : (
          // The reading: the value, then the unit, on one line. The unit
          // never shows as a fragment: when value and unit do not both fit
          // beside the arrow, the unit wraps to a second line that this box
          // clips away, whole (`overflow-y: clip`). It stays in the DOM, so
          // the accessible name still reads "120/77 mmHg". One rule for
          // every tile; the value itself never wraps or clips.
          <span
            data-slot="trend-card-reading"
            className={cn(
              "flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 overflow-y-clip",
              // One line high, so a wrapped unit is clipped whole. A pair
              // (120/77) is a font step smaller; the top inset puts its
              // baseline where a single value's sits (Inter at
              // `leading-none`: the baseline is 0.864 em down, so the 6 px
              // smaller font sits about 0.37 rem higher, measured).
              secondary ? "h-7.5 pt-[0.375rem]" : "h-7.5",
            )}
          >
            <span
              className={cn(
                "shrink-0 font-semibold tracking-tight whitespace-nowrap tabular-nums",
                // The value never truncates, clips or wraps mid-number: it
                // keeps its full width, and the unit yields whole when both
                // do not fit (the reading box above). A pair (131/85) is one
                // font step smaller than a single value.
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
            <span
              data-slot="trend-card-unit"
              className="text-muted-foreground shrink-0 text-sm leading-none whitespace-nowrap tabular-nums"
            >
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
          </span>
        )}
        <span
          className="ml-auto inline-flex h-4 w-4 shrink-0 items-center justify-center"
          data-slot="trend-card-arrow"
          aria-hidden="true"
        >
          {/* No signal yet: the slot stays empty and keeps its width, so the
              value row lines up across the grid. It never prints a glyph
              of its own; a dash beside the value read as a value. */}
          {primarySignal != null ? (
            <TrendIcon className={`h-4 w-4 ${trendColor}`} />
          ) : null}
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
          >
            {/* The sign reads aloud; the Δ glyph does not. */}
            <span aria-hidden="true">Δ </span>
            {`${formatDelta(compareDelta)}${unit ? ` ${unit}` : ""} ${t(
              compareBaseline === "lastMonth"
                ? "comparison.captionLastMonth"
                : "comparison.captionLastYear",
            )}`}
          </span>
        )}
        {/* v1.4.33 — stale-data caption. Renders
            only when the caller passes `staleDays` (positive integer
            of days since the metric's last reading). The tile keeps
            the historical value visible because the maintainer would
            rather see "Letzter Wert vor 12d / 80,2 kg" than have the
            whole tile disappear because of a gap in logging. Ride the
            same callout-slot reservation as the comparison-overlay
            caption; on `<sm` the line-clamp keeps the 140 px height
            contract intact.

            v1.4.34 — bucket-aware copy. Days under a week stay
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
      {/* The two means, one row each and the same in every tile, so the
          rows line up across the strip: "7d 82.5 (+0.2)" and "30d 83.0".
          The short window label is the chart tabs' own; the long one
          ("7-day trend") is the accessible name. A row that still does not
          fit ends in an ellipsis rather than wrapping. */}
      <div className="text-muted-foreground mt-auto flex min-w-0 flex-col gap-0.5 pt-1 text-xs leading-snug">
        <span
          className="min-w-0 truncate whitespace-nowrap"
          data-slot="trend-card-mean-7"
        >
          <span aria-hidden="true">{t("charts.avg7dShort")} </span>
          <span className="sr-only">
            {t(
              trend7Delta != null ? "charts.trend7dShort" : "charts.days7Title",
            )}
            :{" "}
          </span>
          {mean(avg7, secondary?.avg7, avg7ColorClass, avg7Hint)}
          {trend7Delta != null && (
            <span
              className={cn("ml-1 font-medium tabular-nums", deltaColor)}
              data-slot="trend7-delta"
              aria-label={`${t("charts.trend7dShort")} ${trendText}`}
            >
              ({trendText})
            </span>
          )}
        </span>
        <span
          className="min-w-0 truncate whitespace-nowrap"
          data-slot="trend-card-mean-30"
        >
          <span aria-hidden="true">{t("charts.avg30dShort")} </span>
          <span className="sr-only">{t("charts.days30Title")}: </span>
          {mean(avg30, secondary?.avg30, avg30ColorClass, avg30Hint)}
        </span>
      </div>
    </TrendTile>
  );
}
