"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import {
  ResponsiveContainer,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceArea,
  ReferenceLine,
} from "recharts";
import { Loader2 } from "lucide-react";
import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useTranslations } from "@/lib/i18n/context";
import { makeFormatters } from "@/lib/format-locale";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  bucketTimeSeries,
  pickBucket,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import { RichChartTooltip, type RichTooltipRow } from "./chart-tooltip";
import { ChartEmptyState } from "./chart-empty-state";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { shiftDailySeriesForward } from "@/lib/charts/comparison-shift";
import type {
  ChartOverlayKey,
  ComparisonBaseline,
} from "@/lib/dashboard-layout";
import { ChartOverlayControls } from "./chart-overlay-controls";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import { useViewportWidth } from "@/hooks/use-viewport-width";
import { chooseTickInterval } from "@/lib/charts/x-axis-density";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { moodLabelKeyForScore } from "@/lib/mood/labels";

// --- Types ---

interface MoodAnalyticsData {
  entries: Array<{ date: string; score: number; samples: number }>;
  summary: DataSummary;
}

interface ChartDataPoint {
  date: string;
  timestamp: number;
  pointIndex: number;
  score: number;
  ma?: number;
  trend?: number;
  /** v1.4.16 B8 — prior-period overlay value. */
  scoreCompare?: number;
}

interface MoodChartProps {
  title?: string;
  /**
   * v1.4.16 B5c — compact mode for embedding inside the
   * RecommendationCard. Hides the range tabs / toggle row and shrinks
   * padding. Tooltip stays intact.
   */
  mini?: boolean;
  /**
   * v1.4.16 B5c — pin the chart to a specific rationale data
   * window regardless of any parent UI state.
   */
  windowOverride?: "last7days" | "last30days" | "last90days" | "allTime";
  /**
   * v1.4.16 B8 — when set to "lastMonth" / "lastYear", overlay a
   * dimmed prior-period mood line beneath the current series. Same
   * shift mechanic the BP/weight/pulse chart uses; the mood score is
   * a single metric so only one comparison line is drawn.
   */
  compareBaseline?: ComparisonBaseline;
  /**
   * v1.4.18 — per-chart overlay-prefs key. When supplied, the chart
   * mounts the overlay-controls dropdown and reads its three toggle
   * states from the persisted user prefs. Omit (default) when the
   * chart is being rendered ad-hoc on /insights or any other read-
   * only surface — the cog stays hidden and overlays are clean.
   */
  chartKey?: ChartOverlayKey;
  /**
   * v1.4.25 W7b — per-user display timezone. When passed, the x-axis
   * tick labels and tooltip date render in the user's tz. Defaults to
   * "Europe/Berlin" so older mount sites stay byte-identical.
   */
  userTimezone?: string;
}

// --- Constants ---

const TIME_RANGES_KEYS = [
  {
    labelKey: "charts.points7Label",
    points: 7,
    titleKey: "charts.points7Title",
  },
  {
    labelKey: "charts.points30Label",
    points: 30,
    titleKey: "charts.points30Title",
  },
  {
    labelKey: "charts.points90Label",
    points: 90,
    titleKey: "charts.points90Title",
  },
  {
    labelKey: "charts.pointsAllLabel",
    points: 0,
    titleKey: "charts.pointsAllTitle",
  },
] as const;

// MOOD_LABELS built dynamically via t() in the component

const VALUE_BANDS = [
  { min: 1, max: 2, color: "#ff5555", opacity: 0.16 },
  { min: 2, max: 3, color: "#ffb86c", opacity: 0.18 },
  { min: 3, max: 5, color: "#50fa7b", opacity: 0.2 },
] as const;

const COLOR_MAIN = "#d6acff";
const COLOR_MA = "#ff79c6";
const COLOR_TREND = "#8be9fd";

// --- Helpers ---

function dayKeyToTimestamp(dayKey: string): number {
  const [year, month, day] = dayKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12, 0, 0);
}

function movingAverageByPoints(
  data: Array<{ date: Date; value: number }>,
  windowSize: number,
): Array<{ date: Date; value: number }> {
  if (data.length === 0) return [];

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());

  return sorted.map((point, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const window = sorted.slice(start, index + 1);
    const avg =
      window.reduce((sum, item) => sum + item.value, 0) / window.length;
    return {
      date: point.date,
      value: Math.round(avg * 100) / 100,
    };
  });
}

function buildTrendLine(data: Array<{ date: Date; value: number }>): {
  points: Array<{ date: Date; value: number }>;
  slopePerDay: number;
} | null {
  if (data.length < 2) return null;

  const sorted = [...data].sort((a, b) => a.date.getTime() - b.date.getTime());
  const startTime = sorted[0].date.getTime();
  const points = sorted.map((p) => ({
    x: (p.date.getTime() - startTime) / 86400000,
    y: p.value,
  }));

  const n = points.length;
  const sumX = points.reduce((s, p) => s + p.x, 0);
  const sumY = points.reduce((s, p) => s + p.y, 0);
  const sumXY = points.reduce((s, p) => s + p.x * p.y, 0);
  const sumXX = points.reduce((s, p) => s + p.x * p.x, 0);

  const denominator = n * sumXX - sumX * sumX;
  if (denominator === 0) return null;

  const slope = (n * sumXY - sumX * sumY) / denominator;
  const intercept = (sumY - slope * sumX) / n;

  return {
    points: sorted.map((p) => ({
      date: p.date,
      value:
        Math.round(
          (intercept + slope * ((p.date.getTime() - startTime) / 86400000)) *
            100,
        ) / 100,
    })),
    slopePerDay: slope,
  };
}

// --- Aggregation helpers (exported for unit tests) ---

interface MoodEntryDay {
  date: string; // "YYYY-MM-DD" Berlin
  score: number;
}

/**
 * Pick the time bucket for a window of mood entries based on the same
 * thresholds the dashboard charts use. Pure: no DOM/i18n side-effects.
 *
 * - ≤ 90 days → "day"   (raw daily averages)
 * - 91-730   → "week"  (ISO weekly mean)
 * - > 730    → "month" (Berlin calendar monthly mean)
 */
export function pickMoodBucket(entries: MoodEntryDay[]): ChartBucketType {
  if (entries.length < 2) return "day";
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const firstTs = dayKeyToTimestamp(sorted[0].date);
  const lastTs = dayKeyToTimestamp(sorted[sorted.length - 1].date);
  const rangeDays = Math.round((lastTs - firstTs) / (24 * 60 * 60 * 1000));
  return pickBucket(rangeDays);
}

/**
 * Aggregate daily mood entries into the bucket chosen by `pickMoodBucket`.
 * Returns `{ timestamp, score }` rows so the chart can render them
 * without re-formatting. Days/weeks/months without an observation are
 * skipped, never emitted as 0.
 *
 * Pure & deterministic so the unit test can pin the exact aggregated
 * mean per bucket.
 */
export function aggregateMoodEntries(entries: MoodEntryDay[]): {
  bucket: ChartBucketType;
  points: Array<{ timestamp: number; score: number }>;
} {
  if (entries.length === 0) return { bucket: "day", points: [] };

  const bucket = pickMoodBucket(entries);
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  if (bucket === "day") {
    return {
      bucket,
      points: sorted.map((entry) => ({
        timestamp: dayKeyToTimestamp(entry.date),
        score: entry.score,
      })),
    };
  }

  const out = bucketTimeSeries(
    sorted.map((entry) => ({
      timestamp: dayKeyToTimestamp(entry.date),
      values: { score: entry.score },
    })),
    { bucket },
  );

  return {
    bucket,
    points: out.points.map((point) => ({
      timestamp: point.timestamp,
      score: point.values.score,
    })),
  };
}

// --- Component ---

const MINI_RANGE_POINTS: Record<
  NonNullable<MoodChartProps["windowOverride"]>,
  number
> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  allTime: 0,
};

export function MoodChart({
  title,
  mini = false,
  windowOverride,
  compareBaseline = "none",
  chartKey,
  userTimezone = "Europe/Berlin",
}: MoodChartProps) {
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();
  // v1.4.25 W7b — tz-aware formatter for x-axis tick labels + tooltip
  // date strings.
  const tzFmt = useMemo(
    () => makeFormatters(locale, userTimezone),
    [locale, userTimezone],
  );
  const initialRangePoints = windowOverride
    ? MINI_RANGE_POINTS[windowOverride]
    : 30;
  const [rangePoints, setRangePoints] = useState(initialRangePoints);

  // v1.4.18 — three overlay toggles persisted per chart. Mini-mode
  // renders without controls and stays at the clean-line default.
  const overlayPrefs = useChartOverlayPrefs(chartKey);
  const showMA = !mini && overlayPrefs.prefs.showTrendIndicator;
  const showTrend = !mini && overlayPrefs.prefs.showTrendArrow;
  const showBands = !mini && overlayPrefs.prefs.showTargetRange;
  const effectiveCompareBaseline =
    !mini && chartKey ? overlayPrefs.prefs.comparisonBaseline : compareBaseline;

  // v1.4.19 A2 — viewport-aware tick density helper.
  const viewportWidth = useViewportWidth();

  const displayTitle = title ?? t("charts.mood");

  const { data, isLoading } = useQuery({
    queryKey: ["mood-chart-data"],
    queryFn: async (): Promise<MoodAnalyticsData> => {
      const res = await fetch("/api/mood/analytics");
      if (!res.ok) throw new Error("Failed to fetch mood analytics");
      const json = await res.json();
      return json.data as MoodAnalyticsData;
    },
    enabled: isAuthenticated,
  });

  const chartData = useMemo((): ChartDataPoint[] | undefined => {
    if (!data?.entries?.length) return undefined;

    const allPoints: ChartDataPoint[] = data.entries
      .map((entry) => ({
        date: tzFmt.dateShort(new Date(dayKeyToTimestamp(entry.date))),
        timestamp: dayKeyToTimestamp(entry.date),
        pointIndex: 0,
        score: entry.score,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    const sliced = rangePoints > 0 ? allPoints.slice(-rangePoints) : allPoints;

    // v1.4.15 Fix 3: parity with health-chart's auto-bucketing. Other
    // dashboard charts (BP, weight, pulse) auto-aggregate to weekly /
    // monthly when the visible range is long enough that drawing every
    // daily point would clutter the chart; the mood chart used to show
    // raw points only, which made multi-month windows unreadable.
    // Using the same `pickBucket()` thresholds the rest of the
    // dashboard uses (≤90d → day, 91-730d → week, >730d → month) keeps
    // the bucketing chip consistent across metrics.
    const rangeDays =
      sliced.length < 2
        ? 0
        : Math.round(
            (sliced[sliced.length - 1].timestamp - sliced[0].timestamp) /
              (24 * 60 * 60 * 1000),
          );
    const bucketType = pickBucket(rangeDays);

    const visibleData: ChartDataPoint[] =
      bucketType === "day"
        ? sliced
        : bucketTimeSeries(
            sliced.map((p) => ({
              timestamp: p.timestamp,
              values: { score: p.score },
            })),
            { bucket: bucketType },
          ).points.map((point) => ({
            date: tzFmt.dateShort(new Date(point.timestamp)),
            timestamp: point.timestamp,
            pointIndex: 0,
            score: point.values.score,
          }));

    const enriched: ChartDataPoint[] = visibleData.map((d, index) => ({
      ...d,
      pointIndex: index,
    }));

    if (showMA) {
      const scoreData = enriched.map((d) => ({
        date: new Date(d.timestamp),
        value: d.score,
      }));

      if (scoreData.length >= 2) {
        const ma = movingAverageByPoints(scoreData, 7);
        for (const point of ma) {
          const pointTimestamp = point.date.getTime();
          const existing = enriched.find((d) => d.timestamp === pointTimestamp);
          if (existing) {
            existing.ma = point.value;
          }
        }
      }
    }

    if (showTrend) {
      const scoreData = enriched.map((d) => ({
        date: new Date(d.timestamp),
        value: d.score,
      }));

      if (scoreData.length >= 2) {
        const trend = buildTrendLine(scoreData);
        if (trend) {
          for (const point of trend.points) {
            const pointTimestamp = point.date.getTime();
            const existing = enriched.find(
              (d) => d.timestamp === pointTimestamp,
            );
            if (existing) {
              existing.trend = point.value;
            }
          }
        }
      }
    }

    return enriched;
  }, [data, rangePoints, showMA, showTrend, tzFmt]);

  /**
   * v1.4.16 B8 — comparison overlay merged into chartData.
   *
   * Same mechanic as HealthChart: shift the full mood-entries history
   * forward by 30 / 365 days, key by the existing `date` formatter, and
   * stamp the prior-period score onto each visible point as
   * `scoreCompare`. The Recharts <Line dataKey="scoreCompare" />
   * below renders the dimmed dashed overlay.
   */
  const chartDataWithCompare = useMemo<ChartDataPoint[] | undefined>(() => {
    if (!chartData || effectiveCompareBaseline === "none") return chartData;
    if (!data?.entries?.length) return chartData;

    const shifted = shiftDailySeriesForward(
      data.entries.map((entry) => ({
        timestamp: dayKeyToTimestamp(entry.date),
        score: entry.score,
      })),
      effectiveCompareBaseline,
    );

    const shiftedByDay = new Map<string, number>();
    for (const row of shifted) {
      const dayKey = tzFmt.dateShort(new Date(row.timestamp));
      if (typeof row.score === "number" && Number.isFinite(row.score)) {
        shiftedByDay.set(dayKey, row.score);
      }
    }

    return chartData.map((point) => {
      const compareValue = shiftedByDay.get(point.date);
      if (typeof compareValue === "number" && Number.isFinite(compareValue)) {
        return { ...point, scoreCompare: compareValue };
      }
      return point;
    });
  }, [chartData, effectiveCompareBaseline, data, tzFmt]);

  const hasComparisonData = useMemo(() => {
    if (effectiveCompareBaseline === "none" || !chartDataWithCompare)
      return false;
    return chartDataWithCompare.some((point) =>
      typeof point.scoreCompare === "number"
        ? Number.isFinite(point.scoreCompare)
        : false,
    );
  }, [chartDataWithCompare, effectiveCompareBaseline]);

  // Mirror the activeBucket calculation from health-chart so the chip
  // in the header reflects the *same* aggregation chartData used.
  // Computed independently of chartData so an empty/loading dataset
  // doesn't crash the chip render.
  const activeBucket: ChartBucketType = useMemo(() => {
    if (!data?.entries?.length) return "day";
    const sorted = [...data.entries].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const sliced = rangePoints > 0 ? sorted.slice(-rangePoints) : sorted;
    if (sliced.length < 2) return "day";
    const firstTs = dayKeyToTimestamp(sliced[0].date);
    const lastTs = dayKeyToTimestamp(sliced[sliced.length - 1].date);
    const rangeDays = Math.round((lastTs - firstTs) / (24 * 60 * 60 * 1000));
    return pickBucket(rangeDays);
  }, [data, rangePoints]);

  const maxPointIndex = Math.max(0, (chartData?.length ?? 1) - 1);

  // v1.4.27 B6 / BL-P6-11 — the chart axis and the mood-list cards
  // share `MOOD_LABEL_KEYS` so a polishing-pass copy update lands in
  // both surfaces. The shared resolver maps a numeric score back to
  // the canonical key set under `mood.level*`.
  const moodLabels: Record<number, string> = {
    1: t(moodLabelKeyForScore(1) ?? "mood.levelLausig"),
    2: t(moodLabelKeyForScore(2) ?? "mood.levelSchlecht"),
    3: t(moodLabelKeyForScore(3) ?? "mood.levelOkay"),
    4: t(moodLabelKeyForScore(4) ?? "mood.levelGut"),
    5: t(moodLabelKeyForScore(5) ?? "mood.levelSuperGut"),
  };

  // v1.4.18 — emoji glyph map removed. the maintainer explicitly rejected
  // smileys in the mood chart; the line now uses plain Recharts dots
  // and the y-axis already labels each integer (very low / low / okay
  // / good / great) so the chart is fully scannable without a glyph.

  const formatMoodTick = (value: number): string => {
    return moodLabels[value] ?? String(value);
  };

  const formatTooltipValue = (value: number): string => {
    const rounded = Math.round(value * 10) / 10;
    const label = moodLabels[Math.round(value)];
    return label ? `${rounded} (${label})` : String(rounded);
  };

  // v1.4.16 B1a — personal mood baseline (median over visible window).
  const personalBaseline = useMemo<number | null>(() => {
    if (!chartData?.length || chartData.length < 5) return null;
    const sorted = chartData.map((d) => d.score).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }, [chartData]);

  const animationsEnabled = !prefersReducedMotion();

  if (!isLoading && !data?.entries?.length) return null;

  return (
    <Card
      data-slot={mini ? "chart-mini" : undefined}
      // v1.4.28 R3c-Insights — collapse the Card envelope in mini
      // mode (FB-K1). The default `<Card>` paints `py-6 gap-6` —
      // ~48 px of vertical chrome that pulled the mood mini chart
      // band ~52 px lower than the `<HealthChart mini>` siblings
      // in the trends row. The mini override gives mood the same
      // `~p-2` shell HealthChart uses so the chart series anchor
      // at the same top edge across BP / weight / mood tiles.
      //
      // D-H5 follow-up — the Card primitive carries `rounded-xl
      // border bg-card shadow-sm` by default. HealthChart mini
      // paints `rounded-md border bg-card` (no shadow). Without an
      // explicit `rounded-md` override the mood tile painted a
      // visibly heavier corner radius than BP / weight in the same
      // row. Align to the `rounded-md` shell so the three trend
      // tiles share one corner radius.
      className={
        mini ? "gap-1 rounded-md py-2 shadow-none" : undefined
      }
    >
      <CardHeader
        className={
          mini ? "px-2 pb-1 [&]:gap-0.5" : "pb-2"
        }
      >
        {/* v1.4.19 A2 — mobile-first header: stack title row above
            controls row on small viewports so the bucket / comparison
            chips never push the range tabs into a 2nd line. ≥sm goes
            back to side-by-side. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle
              className={
                mini
                  ? "text-muted-foreground text-[10px] font-medium tracking-wider uppercase"
                  : "text-base font-medium"
              }
            >
              {displayTitle}
            </CardTitle>
            {activeBucket !== "day" && !mini && (
              <span className="bg-muted/40 text-muted-foreground hidden rounded-md px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase sm:inline-flex">
                {t(
                  activeBucket === "week"
                    ? "charts.bucketWeekly"
                    : "charts.bucketMonthly",
                )}
              </span>
            )}
            {/* v1.4.16 B8 — comparison caption (mood).
                v1.4.19 A2 — hidden on mobile to free up the title row. */}
            {!mini &&
              effectiveCompareBaseline !== "none" &&
              hasComparisonData && (
                <span
                  className="text-dracula-purple bg-dracula-purple/10 hidden rounded-md border border-current/30 px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase sm:inline-flex"
                  data-slot="chart-compare-caption"
                >
                  {t(
                    effectiveCompareBaseline === "lastMonth"
                      ? "comparison.captionLastMonth"
                      : "comparison.captionLastYear",
                  )}
                </span>
              )}
            {!mini &&
              effectiveCompareBaseline !== "none" &&
              !hasComparisonData && (
                <span
                  className="text-muted-foreground bg-muted/40 hidden rounded-md px-1.5 py-0.5 text-[10px] font-medium tracking-wide sm:inline-flex"
                  data-slot="chart-compare-unavailable"
                >
                  {t(
                    effectiveCompareBaseline === "lastMonth"
                      ? "comparison.unavailable.lastMonth"
                      : "comparison.unavailable.lastYear",
                  )}
                </span>
              )}
          </div>
          {!mini && (
            <div
              className="flex flex-nowrap items-center justify-end gap-1 self-end sm:self-auto"
              data-slot="chart-header-controls"
            >
              {TIME_RANGES_KEYS.map((r) => (
                <Button
                  key={r.labelKey}
                  variant={rangePoints === r.points ? "default" : "ghost"}
                  size="sm"
                  className="min-h-11 px-2 text-xs sm:px-3"
                  onClick={() => setRangePoints(r.points)}
                  title={t(r.titleKey)}
                  data-slot="chart-range-tab"
                >
                  {t(r.labelKey)}
                </Button>
              ))}
              {/* v1.4.18 — overlay-controls dropdown next to the
                  range tabs. Only painted when the chart is bound to
                  a persistent chartKey; ad-hoc usages (/insights mood
                  preview, recommendation card) stay clean. */}
              {chartKey ? (
                <ChartOverlayControls
                  prefs={overlayPrefs.prefs}
                  onChange={overlayPrefs.setPrefs}
                  hasComparisonData={hasComparisonData}
                />
              ) : null}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className={mini ? "px-2" : undefined}>
        {isLoading ? (
          <div className="flex h-48 items-center justify-center">
            <Loader2 className="text-primary h-6 w-6 animate-spin motion-reduce:animate-none" />
          </div>
        ) : !chartData?.length ? (
          <div className="text-muted-foreground flex h-48 items-center justify-center text-sm">
            {t("charts.noData")}
          </div>
        ) : chartData.length < 3 ? (
          // v1.4.16 B1a — sparse-data placeholder consistent with the
          // BP/weight/pulse charts. Height tracks the chart strip's
          // shared CHART_HEIGHT_PX so the empty state preserves the
          // trend-row rhythm (v1.4.27 — was 280, now 240 to match every
          // other dashboard chart card).
          <ChartEmptyState
            title={t("charts.emptyStateTitle")}
            description={t("charts.emptyStateDescription")}
            height={CHART_HEIGHT_PX}
          />
        ) : (
          <div
            className={`${
              mini
                ? "h-[var(--chart-height,140px)]"
                : "h-[var(--chart-height,240px)] md:h-[var(--chart-height-md,280px)]"
            } touch-pan-y`}
          >
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={chartDataWithCompare ?? chartData}
                margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
              >
                {/* v1.4.25 W3 — the mood chart's YAxis is pinned to
                    five mood-score ticks ([1,2,3,4,5]), which Recharts
                    syncs with CartesianGrid by default. That left the
                    mini variant painting five horizontal lines while
                    the BP / Weight / Pulse minis painted six (their
                    auto-generated YAxis ticks land on six bands in
                    typical health ranges). The explicit coordinates
                    generator below produces six evenly-spaced lines
                    so the trends row reads as a single rhythm. */}
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  opacity={0.5}
                  horizontalCoordinatesGenerator={({ offset }) => {
                    // `offset` carries the chart's plot-area metrics.
                    // Six evenly-spaced y-coordinates inside the plot
                    // area (top + 4 intermediate + bottom) match the
                    // density of the BP/Weight/Pulse minis.
                    const top = offset.top ?? 0;
                    const height = offset.height ?? 0;
                    if (height <= 0) return [];
                    const lines = 6;
                    return Array.from({ length: lines }, (_, i) =>
                      Math.round(top + (height * i) / (lines - 1)),
                    );
                  }}
                />
                {showBands &&
                  VALUE_BANDS.map((band) => (
                    <ReferenceArea
                      key={`band-${band.min}-${band.max}`}
                      y1={band.min}
                      y2={band.max}
                      fill={band.color}
                      fillOpacity={band.opacity}
                      strokeOpacity={0}
                      ifOverflow="discard"
                    />
                  ))}
                {/* v1.4.18 — personal-baseline gated behind the
                    Trend toggle (maintainer: "only when a trend is being
                    displayed"). Default OFF. */}
                {showTrend && personalBaseline != null && (
                  <ReferenceLine
                    y={personalBaseline}
                    stroke={COLOR_MAIN}
                    strokeDasharray="2 4"
                    strokeOpacity={0.4}
                    strokeWidth={1}
                    ifOverflow="discard"
                    label={{
                      value: t("charts.personalBaseline"),
                      position: "insideTopLeft",
                      fill: "var(--muted-foreground)",
                      fontSize: 10,
                      opacity: 0.7,
                    }}
                  />
                )}
                <XAxis
                  type="number"
                  dataKey="pointIndex"
                  domain={[0, maxPointIndex]}
                  allowDecimals={false}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(value: number) =>
                    tzFmt.date(
                      new Date(
                        chartData[Math.round(value)]?.timestamp ?? Date.now(),
                      ),
                    )
                  }
                  interval={chooseTickInterval(
                    chartData?.length ?? 0,
                    viewportWidth,
                  )}
                  padding={{ left: 10, right: 10 }}
                  tickMargin={10}
                />
                <YAxis
                  domain={[1, 5]}
                  ticks={[1, 2, 3, 4, 5]}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={65}
                  tickMargin={10}
                  tickFormatter={formatMoodTick}
                />
                <Tooltip
                  cursor={{
                    stroke: "var(--muted-foreground)",
                    strokeOpacity: 0.3,
                    strokeDasharray: "3 3",
                  }}
                  content={(props) => {
                    const {
                      active,
                      payload,
                      label: rechartsLabel,
                    } = props as unknown as {
                      active?: boolean;
                      payload?: Array<{
                        name?: string;
                        value?: number;
                        color?: string;
                        dataKey?: string;
                        payload?: ChartDataPoint;
                      }>;
                      label?: number;
                    };
                    if (!active || !payload?.length) return null;
                    const ts =
                      payload[0]?.payload?.timestamp ??
                      (typeof rechartsLabel === "number"
                        ? chartData?.[Math.round(rechartsLabel)]?.timestamp
                        : undefined);
                    const dateLabel = ts ? tzFmt.date(new Date(ts)) : "";
                    const rows: RichTooltipRow[] = [];
                    const hoverPoint = payload[0]?.payload as
                      | ChartDataPoint
                      | undefined;
                    for (const item of payload) {
                      if (typeof item.value !== "number") continue;
                      const dataKey = String(item.dataKey ?? "");
                      // Skip auxiliary lines (`ma`, `trend`,
                      // `scoreCompare`). Comparison value rendered as
                      // delta on the primary row + own row below.
                      if (
                        dataKey === "ma" ||
                        dataKey === "trend" ||
                        dataKey === "scoreCompare"
                      )
                        continue;
                      let delta: string | undefined;
                      const compareValue =
                        effectiveCompareBaseline !== "none" && hoverPoint
                          ? hoverPoint.scoreCompare
                          : undefined;
                      if (
                        effectiveCompareBaseline !== "none" &&
                        typeof compareValue === "number" &&
                        Number.isFinite(compareValue)
                      ) {
                        const diff = item.value - compareValue;
                        if (Math.abs(diff) < 0.05) {
                          delta = t("charts.deltaUnchanged");
                        } else {
                          const sign = diff > 0 ? "+" : "−";
                          const formatted = `${sign}${Math.abs(diff).toFixed(
                            1,
                          )}`;
                          delta = t(
                            effectiveCompareBaseline === "lastMonth"
                              ? "comparison.deltaVs.lastMonth"
                              : "comparison.deltaVs.lastYear",
                          ).replace("{delta}", formatted);
                        }
                      } else if (personalBaseline != null) {
                        const diff = item.value - personalBaseline;
                        if (Math.abs(diff) < 0.05) {
                          delta = t("charts.deltaUnchanged");
                        } else {
                          const sign = diff > 0 ? "+" : "−";
                          const formatted = `${sign}${Math.abs(diff).toFixed(
                            1,
                          )}`;
                          delta = t("charts.deltaVsBaseline").replace(
                            "{delta}",
                            formatted,
                          );
                        }
                      }
                      rows.push({
                        name: t("charts.moodScore"),
                        value: formatTooltipValue(item.value),
                        color: item.color ?? COLOR_MAIN,
                        delta,
                      });
                      if (
                        effectiveCompareBaseline !== "none" &&
                        typeof compareValue === "number" &&
                        Number.isFinite(compareValue)
                      ) {
                        rows.push({
                          name: `${t("charts.moodScore")} · ${t(
                            "comparison.tooltipPrior",
                          )}`,
                          value: formatTooltipValue(compareValue),
                          color: item.color ?? COLOR_MAIN,
                        });
                      }
                    }
                    if (rows.length === 0) return null;
                    return (
                      <RichChartTooltip active label={dateLabel} rows={rows} />
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="score"
                  name="score"
                  stroke={COLOR_MAIN}
                  strokeWidth={2}
                  dot={{ r: 3, fill: COLOR_MAIN }}
                  activeDot={{ r: 5 }}
                  connectNulls
                  isAnimationActive={animationsEnabled}
                  animationDuration={animationsEnabled ? 600 : 0}
                  animationEasing="ease-out"
                />
                {showMA && (
                  <Line
                    type="monotone"
                    dataKey="ma"
                    name="ma"
                    stroke={COLOR_MA}
                    strokeWidth={1.5}
                    strokeDasharray="5 5"
                    dot={false}
                    connectNulls
                  />
                )}
                {showTrend && (
                  <Line
                    type="linear"
                    dataKey="trend"
                    name="trend"
                    stroke={COLOR_TREND}
                    strokeWidth={1}
                    strokeDasharray="8 4"
                    dot={false}
                    connectNulls
                  />
                )}
                {/* v1.4.16 B8 — comparison overlay (mood). Same
                    dimmed dashed treatment the BP/weight/pulse chart
                    uses; mood is a single metric so we only render
                    one overlay line. Suppressed when there's no prior
                    data via hasComparisonData. */}
                {effectiveCompareBaseline !== "none" && hasComparisonData && (
                  <Line
                    type="monotone"
                    dataKey="scoreCompare"
                    name="scoreCompare"
                    stroke={COLOR_MAIN}
                    strokeWidth={1.25}
                    strokeDasharray="4 3"
                    strokeOpacity={0.45}
                    dot={false}
                    connectNulls
                    isAnimationActive={animationsEnabled}
                    animationDuration={animationsEnabled ? 600 : 0}
                    animationEasing="ease-out"
                    legendType="none"
                    data-slot="chart-compare-line-mood"
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
