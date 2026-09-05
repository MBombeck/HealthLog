"use client";

/**
 * Dashboard medication-compliance chart.
 *
 * Wired to the `medications` toggle in Settings → Dashboard. Up to v1.4.14
 * the toggle existed but the dashboard slot only rendered a static
 * placeholder (an icon + the section title), so flipping it on did nothing
 * visible. This wrapper shows daily compliance % across all of the user's
 * scheduled medications for the last N days, matching the same visual
 * pattern the other dashboard charts use (Card surface, Dracula tokens,
 * range chips in the header, ReferenceLine target at 100 % goal +
 * 80 % minimum-acceptable threshold).
 *
 * v1.4.16 A6 — feature-parity with the other charts:
 *   - Computes a 7-day trend chip in the header (signed delta, metric-
 *     aware sentiment colour: rising compliance → green, falling →
 *     orange).
 *   - Adds a 100 % goal ReferenceLine (in addition to the existing 80 %
 *     minimum-acceptable threshold) so the target range is explicitly
 *     visualised the way BP/weight charts paint their target zones.
 *
 * Data source: `GET /api/medications/intake?scope=compliance&days=N`
 * already returns `{ date, scheduled, taken }[]`. We aggregate to
 * `taken / scheduled * 100` per day; days without any scheduled doses
 * are skipped (compliance is undefined for a day with no expected
 * intakes — drawing a 0 % point on those would mis-represent the data).
 *
 * IMPORTANT: keep the recharts primitives as static imports inside
 * this wrapper. Phase 4 visual-verify (v1.4.14) proved that wrapping
 * individual primitives in `next/dynamic` breaks Recharts'
 * `findAllByType` reconciliation; the dashboard's `next/dynamic` for
 * the wrapper itself stays intact.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useRef } from "react";
import { queryKeys } from "@/lib/query-keys";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
} from "recharts";
import { ArrowDown, ArrowRight, ArrowUp, Pill } from "lucide-react";
import { ComplianceInfoTip } from "@/components/medications/card-parts/compliance-info-tip";
import { TileHeader } from "@/components/insights/tile-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import {
  useDateFormatPreference,
  useTranslations,
  useFormatters,
} from "@/lib/i18n/context";
import { formatDateShort } from "@/lib/format";
import { makeFormatters } from "@/lib/format-locale";
import { cn } from "@/lib/utils";
import { RichChartTooltip, type RichTooltipRow } from "./chart-tooltip";
import { ChartEmptyState } from "./chart-empty-state";
import { ChartErrorState } from "./chart-error-state";
import { ChartOverlayControls } from "./chart-overlay-controls";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import { useViewportWidth } from "@/hooks/use-viewport-width";
import { chooseTickInterval } from "@/lib/charts/x-axis-density";
import { apiGet } from "@/lib/api/api-fetch";
import { shouldFireDataReady } from "@/lib/charts/data-ready-latch";

interface DailyCompliancePoint {
  /** Berlin calendar day, "YYYY-MM-DD". */
  date: string;
  scheduled: number;
  taken: number;
}

interface ChartPoint {
  date: string;
  rate: number;
  timestamp: number;
}

const COLOR_LINE = "var(--dracula-purple)";
const COLOR_GOAL = "var(--dracula-green)";
const COLOR_THRESHOLD = "var(--dracula-yellow)";

/** Days for the range buttons. v1.4.15 keeps this in sync with the
 *  health-chart range presets so the dashboard reads consistently. */
const RANGE_DAYS = [7, 30, 90] as const;
type RangeDays = (typeof RANGE_DAYS)[number];

/**
 * Aggregate daily-compliance points from the `/api/medications/intake`
 * compliance scope into chart-ready rows. Days without any expected
 * intakes are skipped — compliance is undefined when nothing was due.
 *
 * Pure & deterministic so the unit test pins exact rates.
 *
 * v1.4.25 W7b — the `dateFormatter` argument lets the chart pass a
 * tz-aware formatter so a Pacific/Auckland user's X-axis tick label
 * for "2026-05-15" reads as 15.05. in their tz. Default keeps the
 * legacy `formatDateShort` so the existing unit test (which calls the
 * exported helper without arguments) stays byte-identical.
 */
export function aggregateMedicationCompliance(
  points: DailyCompliancePoint[],
  dateFormatter: (date: Date) => string = (d) => formatDateShort(d, false),
): ChartPoint[] {
  return points
    .filter((p) => p.scheduled > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => {
      const [y, m, d] = p.date.split("-").map(Number);
      // Anchor the timestamp at noon UTC of the (server-side) calendar
      // day so a tooltip and tick formatter never disagree across DST
      // boundaries.
      const ts = Date.UTC(y, m - 1, d, 12);
      const rate = Math.min(100, Math.round((p.taken / p.scheduled) * 100));
      return {
        // v1.4.25 W3b — short-form day label ("10.05." / "10. May") so
        // the X-axis ticks read cleanly on mobile even when the tick
        // density helper steps to every-7th or every-14th day. The
        // tooltip below still derives its label from `timestamp` with
        // `includeYear=true`, so the full date is preserved for the
        // tooltip read.
        date: dateFormatter(new Date(ts)),
        rate,
        timestamp: ts,
      };
    });
}

/**
 * Compute the 7-day compliance trend over the last 14 days of data —
 * mean of the most-recent 7 daily rates minus the mean of the prior 7
 * (or fewer if the user has fewer than 14 days).
 *
 * Returns `null` when fewer than 2 daily points exist (a single point
 * has no trend), or when both halves of the window collapse to < 2
 * points (insufficient signal).
 *
 * Pure & deterministic so unit tests pin the exact delta.
 *
 * Why "second-half mean − first-half mean" instead of slope-of-line:
 * the dashboard tile reports a *delta in percentage points* — a slope
 * over 7 days expressed in pp/day would multiply by 7 anyway, and the
 * mean-difference variant is more robust to a single outlier day.
 */
export function computeMedicationTrend7d(
  points: ChartPoint[],
): { delta: number; direction: "up" | "down" | "stable" } | null {
  if (points.length < 2) return null;

  // Take the most recent 14 points (sorted ascending in the input
  // because aggregateMedicationCompliance sorts by date).
  const recent = points.slice(-14);
  if (recent.length < 2) return null;

  const mid = Math.floor(recent.length / 2);
  const firstHalf = recent.slice(0, mid);
  const secondHalf = recent.slice(mid);

  if (firstHalf.length === 0 || secondHalf.length === 0) return null;

  const meanOf = (arr: ChartPoint[]) =>
    arr.reduce((s, p) => s + p.rate, 0) / arr.length;
  const delta = Math.round((meanOf(secondHalf) - meanOf(firstHalf)) * 10) / 10;

  // Same threshold the trend-arrow on tiles uses (~1 pp shift counts
  // as movement; below that is "stable" so we don't celebrate noise).
  const direction: "up" | "down" | "stable" =
    Math.abs(delta) < 1 ? "stable" : delta > 0 ? "up" : "down";

  return { delta, direction };
}

interface MedicationComplianceChartProps {
  /** Override the visible label, primarily for tests. */
  title?: string;
  /**
   * v1.4.16 phase D reconcile (H4 design) — when the user toggles the
   * dashboard comparison overlay, every other chart paints a dimmed
   * prior-period line. Compliance is a percentage-of-doses metric whose
   * "prior month" overlay would need a second window of intake events
   * (deferred to v1.4.17). We accept the prop so the parent doesn't
   * have to special-case this chart, and surface a small caption when
   * comparison is on so the user understands the asymmetry rather than
   * thinking the toggle is broken.
   */
  compareBaseline?: "none" | "lastMonth" | "lastYear";
  /**
   * v1.4.25 W7b — per-user display timezone for x-axis tick + tooltip
   * date strings. Defaults to "Europe/Berlin" so older callers stay
   * byte-identical.
   */
  userTimezone?: string;
  /**
   * v1.16.0 — fires once the compliance query has settled (initial
   * load finished). The dashboard's shared reveal gate listens here so
   * every chart cell swaps from skeleton to content in one frame.
   * Optional and repeat-safe.
   */
  onDataReady?: () => void;
}

export function MedicationComplianceChart({
  title,
  userTimezone = "Europe/Berlin",
  compareBaseline,
  onDataReady,
}: MedicationComplianceChartProps) {
  // v1.4.27 R4 RC3 — the prop is accepted so the dashboard can pass
  // `compareBaseline={compareBaseline}` uniformly across every chart.
  // The comparison overlay itself is deferred: medication compliance is
  // a percentage-of-doses metric whose prior-period overlay needs a
  // second window of intake events. Discard explicitly so the
  // destructure is intentional rather than a missed wire-up.
  void compareBaseline;
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  const [days, setDays] = useState<RangeDays>(30);
  // v1.4.25 W7b — tz-aware date formatter for the x-axis labels and
  // the tooltip's `dateLabel`. Same pattern as health-chart + mood-chart.
  // Issue #922 — the axis labels and the tooltip date follow the profile's
  // date order. The hour cycle is AUTO on purpose: this formatter renders
  // days only (`dateShortSmart` / `date`), never a clock.
  const dateFormat = useDateFormatPreference();
  const tzFmt = useMemo(
    () => makeFormatters(locale, userTimezone, "AUTO", dateFormat),
    [locale, userTimezone, dateFormat],
  );

  // v1.4.18 — three overlay toggles persisted per chart. The 7-day
  // trend chip and the goal/threshold reference lines used to render
  // unconditionally; both now key off the persisted prefs.
  const overlayPrefs = useChartOverlayPrefs("medications");
  const showTrendChip = overlayPrefs.prefs.showTrendIndicator;
  const showTargetRange = overlayPrefs.prefs.showTargetRange;
  const effectiveCompareBaseline = overlayPrefs.prefs.comparisonBaseline;

  // v1.4.19 A2 — universal tick-density helper. Pre-fix the medication
  // chart drew ONE tick per day, so a 30-day Pixel-5 window painted 30
  // overlapping labels into a 393 px gutter. The helper caps visible
  // ticks at 6 on Pixel 5 / 4 on Fold, matching the visual breathing
  // room of the weight / BMI charts.
  const viewportWidth = useViewportWidth();

  // v1.4.40 W-RSC — factory-routed key so the prefix
  // `["dashboard-medication-compliance"]` lands in
  // `medicationDependentKeys` and an intake POST refreshes the chart
  // immediately rather than waiting for `staleTime` (audit L4).
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.dashboardMedicationCompliance(days),
    queryFn: async (): Promise<DailyCompliancePoint[]> => {
      return apiGet<DailyCompliancePoint[]>(
        `/api/medications/intake?scope=compliance&days=${days}`,
      );
    },
    enabled: isAuthenticated,
  });

  // v1.16.0 — report the settled query to the dashboard's shared
  // reveal gate (see `onDataReady` prop doc).
  //
  // v1.20.1 — fire once via a ref instead of keying on the unstable
  // `onDataReady` prop. See the matching note in `health-chart.tsx`: the
  // dashboard hands every chart a fresh `() => markChartReady(id)` closure
  // each render, so depending on it re-ran this notify on every commit and
  // the per-commit passive effect kept the Radix-Popper tile anchors
  // re-committing until React's update-depth guard tripped (#185).
  const onDataReadyRef = useRef(onDataReady);
  useEffect(() => {
    onDataReadyRef.current = onDataReady;
  }, [onDataReady]);
  const dataReadyFiredRef = useRef(false);
  useEffect(() => {
    if (
      !shouldFireDataReady({
        isLoading,
        alreadyFired: dataReadyFiredRef.current,
      })
    )
      return;
    dataReadyFiredRef.current = true;
    onDataReadyRef.current?.();
  }, [isLoading]);

  const chartData = useMemo(
    () =>
      data
        ? aggregateMedicationCompliance(data, (d) => tzFmt.dateShortSmart(d))
        : [],
    [data, tzFmt],
  );

  // v1.4.43 W2-CHART-GATE — raw scheduled-dose count across every day
  // in the window. The chart bucket aggregates per-day compliance, so
  // a user with 20 scheduled doses on 2 calendar days collapses to
  // `chartData.length = 2`. Sum the `scheduled` field across the raw
  // daily points so the empty-state gate can distinguish "no doses
  // tracked" from "doses tracked but on too few days".
  const rawCount = useMemo<number>(() => {
    if (!data?.length) return 0;
    return data.reduce(
      (acc, point) =>
        acc + (Number.isFinite(point.scheduled) ? point.scheduled : 0),
      0,
    );
  }, [data]);

  // v1.4.16 A6 — 7-day trend chip. Computed off the *full* range so a
  // user toggled to "7 days" still sees a trend (which would otherwise
  // be empty if we only used the visible window). The 14-day cap inside
  // computeMedicationTrend7d() bounds the comparison window.
  const trend = useMemo(() => computeMedicationTrend7d(chartData), [chartData]);

  // v1.4.16 A6 — metric-aware sentiment for medication compliance:
  // up-good (rising compliance is the desired direction). Mirrors the
  // `directionSentiment="up-good"` rule used by the trend-card pulse +
  // mood tiles.
  const trendColor = ((): string => {
    if (!trend || trend.direction === "stable") return "text-muted-foreground";
    return trend.direction === "up" ? "text-success" : "text-warning";
  })();

  const TrendIcon = !trend
    ? null
    : trend.direction === "up"
      ? ArrowUp
      : trend.direction === "down"
        ? ArrowDown
        : ArrowRight;

  const formatTrendDelta = (delta: number): string => {
    if (Math.abs(delta) < 0.05) return "±0";
    const sign = delta > 0 ? "+" : "−";
    return `${sign}${fmt.number(Math.abs(delta), 1)}`;
  };

  const displayTitle = title ?? t("dashboard.medications");
  const yAxisFormatter = (value: number) => `${fmt.integer(value)} %`;
  const animationsEnabled = !prefersReducedMotion();

  // Accessibility — a concise spoken summary of the compliance series so a
  // screen reader announces the adherence range, the latest day and the
  // direction rather than an unlabelled graphic. Reuses the same 7-day trend
  // the chip surfaces; falls back to a first-vs-last comparison when the
  // window is too short for the trend helper.
  const complianceAriaLabel = ((): string => {
    const metric = displayTitle;
    const rates = chartData
      .map((p) => p.rate)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (rates.length === 0) {
      return t("charts.a11y.noData", { metric });
    }
    const pct = (v: number) => `${fmt.integer(v)} %`;
    const minVal = Math.min(...rates);
    const maxVal = Math.max(...rates);
    const latestVal = rates[rates.length - 1];
    let trendWord: string;
    if (trend && trend.direction !== "stable") {
      trendWord =
        trend.direction === "up"
          ? t("charts.a11y.trendUp")
          : t("charts.a11y.trendDown");
    } else {
      const delta = latestVal - rates[0];
      trendWord =
        delta > 1
          ? t("charts.a11y.trendUp")
          : delta < -1
            ? t("charts.a11y.trendDown")
            : t("charts.a11y.trendFlat");
    }
    return t("charts.a11y.summary", {
      metric,
      min: pct(minVal),
      max: pct(maxVal),
      latest: pct(latestVal),
      trend: trendWord,
    });
  })();

  // Empty-state guard: if the user has zero scheduled doses across the
  // whole window we render the title + a "no data" hint, mirroring how
  // the other charts handle the empty case (HealthChart returns null
  // entirely; here we keep the surface visible because the toggle is
  // explicit user opt-in — silence would feel like a bug).
  const hasData = chartData.length > 0;

  return (
    <div
      className="bg-card border-border rounded-xl border p-4 md:p-6"
      data-slot="medication-compliance-chart"
    >
      {/* v1.4.19 A2 — header layout split into title row + controls
          row on small screens. Pre-fix the trend chip + 4 range tabs +
          cog dropdown all sat on a single justify-between row, which
          caused the tabs to wrap mid-row on Pixel 5 (header doubled in
          height) and overflow horizontally on Galaxy Fold compact.

          Mobile (default): two stacked rows. Title + chip on row 1,
          range tabs + cog right-aligned on row 2. Tabs never overflow
          because the row owns the full card width.

          ≥sm: original side-by-side layout. */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {/* Canonical tile header (foreground h-5 icon, text-base title) so
              this card reads in the same language as its sibling HealthChart
              tiles instead of the old muted h-4 / text-sm row. */}
          <TileHeader icon={Pill} title={displayTitle} />
          {/* `?` explainer for what the adherence percentage measures —
              shares the i18n body with the per-card bars. */}
          <ComplianceInfoTip />
          {/* v1.4.18 — 7-day trend chip is now opt-in via the
              "7-day trend" overlay toggle. Default OFF; the user
              activates it from the chart settings popover. */}
          {showTrendChip && trend && TrendIcon ? (
            <span
              className={cn(
                "bg-muted/40 text-2xs inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-medium tracking-wide uppercase",
                trendColor,
              )}
              data-slot="medication-trend-chip"
              aria-label={`${t("charts.trend7dShort")} ${formatTrendDelta(trend.delta)}`}
            >
              <TrendIcon className="h-3 w-3" aria-hidden="true" />
              <span>{t("charts.trend7dShort")}</span>
              <span className="tabular-nums">
                {formatTrendDelta(trend.delta)} pp
              </span>
            </span>
          ) : null}
        </div>
        <div
          className="flex flex-nowrap items-center justify-end gap-1 self-end sm:self-auto"
          data-slot="chart-header-controls"
        >
          {RANGE_DAYS.map((r) => (
            <Button
              key={r}
              variant={days === r ? "default" : "ghost"}
              size="sm"
              className="min-h-11 px-2 text-xs sm:px-3"
              onClick={() => setDays(r)}
            >
              {r}T
            </Button>
          ))}
          {/* v1.4.18 — overlay-controls dropdown next to the range
              tabs.
              v1.4.25 W3f — the compliance card never paints a
              prior-period overlay (the heatmap doesn't support it),
              so the comparison buttons grey out when a baseline is
              already selected to signal "this metric has no
              comparison available". */}
          <ChartOverlayControls
            prefs={overlayPrefs.prefs}
            onChange={overlayPrefs.setPrefs}
            hasComparisonData={false}
          />
        </div>
      </div>

      {/* v1.4.16 phase D reconcile (H4 design) — explicit "comparison
          N/A" caption when the global toggle is on. The compliance
          heatmap doesn't render a prior-period overlay (deferred to
          v1.4.17 when the underlying intake-event window comparison
          ships). Without this caption the user toggles Vormonat and
          this card just stays static, which reads as a bug. */}
      {effectiveCompareBaseline !== "none" && (
        <p
          className="text-muted-foreground -mt-2 mb-3 text-xs"
          data-slot="medication-comparison-na"
          data-compare-baseline={effectiveCompareBaseline}
        >
          {t("comparison.notAvailableForCompliance")}
        </p>
      )}

      {isLoading ? (
        // v1.16.0 — height-matched skeleton band instead of the former
        // `h-48` spinner box; matches the painted chart body below so
        // the card never jumps when the data lands.
        <Skeleton className="h-[var(--chart-height,240px)] w-full md:h-[var(--chart-height-md,280px)]" />
      ) : isError ? (
        // v1.16.8 — a failed query paints as an ERROR with a retry
        // affordance, not as the "no data" hint. Pre-fix `isError` fell
        // through to the empty branch (data undefined → hasData false)
        // and an outage read as "no doses tracked".
        <ChartErrorState
          title={t("charts.errorTitle")}
          actionLabel={t("common.retry")}
          actionContext={displayTitle}
          onAction={() => void refetch()}
        />
      ) : !hasData ? (
        <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
          {t("charts.noData")}
        </div>
      ) : chartData.length < 3 ? (
        // v1.4.16 B1a — sparse-data placeholder consistent with the
        // BP/weight/pulse/mood charts.
        //
        // v1.4.43 W2-CHART-GATE — split the copy on the raw scheduled-
        // dose count. A user with 20 scheduled doses on 2 calendar
        // days has `chartData.length = 2`; the legacy "log more" hint
        // misled — they logged plenty, just on too few days. Surface
        // "need more days" when the raw count is already enough.
        rawCount >= 3 ? (
          <ChartEmptyState
            title={t("charts.needMoreDistinctDaysTitle")}
            description={t("charts.needMoreDistinctDaysDescription")}
          />
        ) : (
          <ChartEmptyState
            title={t("charts.emptyStateTitle")}
            description={t("charts.emptyStateDescription")}
          />
        )
      ) : (
        <div
          className="h-[var(--chart-height,240px)] touch-pan-y md:h-[var(--chart-height-md,280px)]"
          role="img"
          aria-label={complianceAriaLabel}
        >
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={chartData}
              margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="var(--border)"
                opacity={0.5}
              />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                interval={chooseTickInterval(chartData.length, viewportWidth)}
              />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
                width={48}
                tickFormatter={yAxisFormatter}
              />
              <Tooltip
                cursor={{
                  stroke: "var(--muted-foreground)",
                  strokeOpacity: 0.3,
                  strokeDasharray: "3 3",
                }}
                content={(props) => {
                  const { active, payload } = props as unknown as {
                    active?: boolean;
                    payload?: Array<{
                      value?: number;
                      color?: string;
                      payload?: ChartPoint;
                    }>;
                  };
                  if (!active || !payload?.length) return null;
                  const ts = payload[0]?.payload?.timestamp;
                  const dateLabel = ts ? tzFmt.date(new Date(ts)) : "";
                  const rate = payload[0]?.value;
                  if (typeof rate !== "number") return null;
                  // Delta vs. the 100 % goal — a positive delta means
                  // "100 % target hit" and reads as success; a
                  // negative delta is the gap to close.
                  const gap = 100 - rate;
                  let delta: string | undefined;
                  if (gap < 0.5) {
                    delta = t("charts.deltaUnchanged");
                  } else {
                    const formatted = `−${fmt.integer(gap)} pp`;
                    delta = t("charts.deltaVsTarget").replace(
                      "{delta}",
                      formatted,
                    );
                  }
                  const rows: RichTooltipRow[] = [
                    {
                      name: t("dashboard.compliance7d"),
                      value: `${fmt.integer(rate)} %`,
                      color: payload[0]?.color ?? COLOR_LINE,
                      delta,
                    },
                  ];
                  return (
                    <RichChartTooltip active label={dateLabel} rows={rows} />
                  );
                }}
              />
              {/* v1.4.18 — minimum-acceptable threshold + goal line
                  are now opt-in via the "Target range" overlay
                  toggle. Default OFF; chart renders as a clean line
                  until the user activates the overlay from the
                  settings popover. */}
              {showTargetRange ? (
                <>
                  <ReferenceLine
                    y={80}
                    stroke={COLOR_THRESHOLD}
                    strokeDasharray="3 5"
                    strokeOpacity={0.6}
                    data-slot="medication-threshold-line"
                  />
                  <ReferenceLine
                    y={100}
                    stroke={COLOR_GOAL}
                    strokeDasharray="5 5"
                    strokeOpacity={0.85}
                    data-slot="medication-goal-line"
                  />
                </>
              ) : null}
              <Line
                type="monotone"
                dataKey="rate"
                stroke={COLOR_LINE}
                strokeWidth={2}
                dot={{ r: 2, fill: COLOR_LINE }}
                activeDot={{ r: 4 }}
                connectNulls
                isAnimationActive={animationsEnabled}
                animationDuration={animationsEnabled ? 600 : 0}
                animationEasing="ease-out"
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
