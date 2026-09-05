"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
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
import { useEffect, useState, useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { TagChip } from "@/components/ui/tag-chip";
import { TileHeader } from "@/components/insights/tile-header";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import { readStoredTimezone } from "@/lib/timezone-mirror";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  bucketTimeSeries,
  pickBucket,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import { RichChartTooltip, type RichTooltipRow } from "./chart-tooltip";
import { ChartEmptyState } from "./chart-empty-state";
import { ChartErrorState } from "./chart-error-state";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { shiftDailySeriesForward } from "@/lib/charts/comparison-shift";
import type {
  ChartOverlayKey,
  ComparisonBaseline,
} from "@/lib/dashboard-layout";
import { ChartOverlayControls } from "./chart-overlay-controls";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import { useViewportWidth } from "@/hooks/use-viewport-width";
import { computeTickPositions } from "@/lib/charts/x-axis-density";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { shouldFireDataReady } from "@/lib/charts/data-ready-latch";
import { moodLabelKeyForScore } from "@/lib/mood/labels";
import { apiGet } from "@/lib/api/api-fetch";

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
   * v1.16.0 — fires once the mood analytics query has settled (initial
   * load finished). The dashboard's shared reveal gate listens here so
   * every chart cell swaps from skeleton to content in one frame —
   * pre-fix the cheap `/api/mood/analytics` read made this chart paint
   * visibly before its measurement siblings. Optional and repeat-safe.
   */
  onDataReady?: () => void;
}

// --- Constants ---

// The range tabs select a CALENDAR-DAY window ending now, matching
// `health-chart.tsx` (see the note there). Until v1.37.29 this chart
// sliced the last N LOGGED DAYS out of the whole history instead — the
// same "7" tab meant seven calendar days on a weight chart and seven
// logged days (possibly weeks apart) on the mood chart one card over.
const TIME_RANGES_KEYS = [
  {
    labelKey: "charts.days7Label",
    days: 7,
    titleKey: "charts.days7Title",
  },
  {
    labelKey: "charts.days30Label",
    days: 30,
    titleKey: "charts.days30Title",
  },
  {
    labelKey: "charts.days90Label",
    days: 90,
    titleKey: "charts.days90Title",
  },
  {
    labelKey: "charts.daysAllLabel",
    days: 0,
    titleKey: "charts.daysAllTitle",
  },
] as const;

// MOOD_LABELS built dynamically via t() in the component

// v1.12.6 — mood-level bands ride the same Dracula good→bad ramp the mood
// heatmap and distribution chart already use (red → orange → yellow →
// green), so the three mood surfaces read as one palette instead of the
// chart's former three-band red/orange/green that skipped the yellow rung.
// Tokens, not raw hex, so a theme change flows through one source.
const VALUE_BANDS = [
  { min: 1, max: 2, color: "var(--dracula-red)", opacity: 0.16 },
  { min: 2, max: 3, color: "var(--dracula-orange)", opacity: 0.18 },
  { min: 3, max: 3.5, color: "var(--dracula-yellow)", opacity: 0.18 },
  { min: 3.5, max: 5, color: "var(--dracula-green)", opacity: 0.2 },
] as const;

// The mood line + overlays use the same hues the rest of the Insights
// charts do — purple primary (matching HealthChart), pink moving average,
// cyan trend — as tokens rather than the former hand-picked hex.
const COLOR_MAIN = "var(--dracula-purple)";
const COLOR_MA = "var(--dracula-pink)";
const COLOR_TREND = "var(--dracula-cyan)";

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
export function aggregateMoodEntries(
  entries: MoodEntryDay[],
  /**
   * The calendar the week / month boundaries are drawn in. Required rather
   * than defaulted for the same reason `bucketTimeSeries` requires it: a
   * default would leave a forgotten caller quietly bucketing someone else's
   * evening into the wrong month.
   */
  timeZone: string,
): {
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
    { bucket, timeZone },
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
  onDataReady,
}: MoodChartProps) {
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();
  // Issue #490 — x-axis tick + tooltip date labels. Every timestamp this
  // chart formats encodes a CALENDAR DAY (noon-UTC of a server day key,
  // or a `bucketTimeSeries` Berlin-day UTC-midnight bucket start), so
  // labels render UTC-pinned via `makeBucketLabelFormatters` — the
  // encoded day paints verbatim in every profile zone (a profile-tz
  // formatter shifted week/month bucket labels for zones west of Berlin).
  // Issue #922 — the UTC pin decides WHICH day the label names; the
  // profile's date order decides how it is spelled. Both travel.
  const dateFormat = useDateFormatPreference();
  const tzFmt = useMemo(
    () => makeBucketLabelFormatters(locale, dateFormat),
    [locale, dateFormat],
  );
  // The bucket BOUNDARIES follow the profile, even though the bucket LABELS
  // stay UTC-pinned (see above): a week that starts on the wrong day puts a
  // reading in the wrong bar, which is a different mistake from a label that
  // reads a few hours off.
  const profileTimeZone = readStoredTimezone() || DEFAULT_TIMEZONE;
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

  // v1.30.1 M2 — hydrate the range tab from the persisted prefs once
  // they arrive; see health-chart.tsx for the full rationale (the
  // dashboard-layout query resolves after mount, and `rangePoints`
  // stays local state because several memos depend on it by identity).
  // Adjusted during render, not an effect — React's documented "adjust
  // state during render" pattern (a second state flag rather than a
  // ref, since the lint rule bans ref reads during render).
  const [rangeHydrated, setRangeHydrated] = useState(false);
  if (
    !mini &&
    !windowOverride &&
    chartKey &&
    !rangeHydrated &&
    typeof overlayPrefs.prefs.rangePoints === "number"
  ) {
    setRangeHydrated(true);
    setRangePoints(overlayPrefs.prefs.rangePoints);
  }

  // v1.4.19 A2 — viewport-aware tick density helper.
  const viewportWidth = useViewportWidth();

  const displayTitle = title ?? t("charts.mood");

  // v1.4.40 W-RSC — align the chart's queryKey with the dashboard's
  // `useQuery({ queryKey: queryKeys.moodAnalytics() })` call against the
  // same `/api/mood/analytics` endpoint. Pre-fix the chart fetched its
  // own copy under `["mood-chart-data"]` (audit C1) — TanStack treated
  // the two keys as separate cache slots and the cold-mount dashboard
  // fired the request twice (once at `app/page.tsx:291`, once here on
  // the chart's first render). The dedup eliminates a ~22 KB round-trip
  // and frees one pg pool slot per cold mount.
  //
  // `staleTime: 60_000` matches the dashboard's `DASHBOARD_QUERY_OPTS`
  // so a route swing back to the dashboard within a minute keeps the
  // cache fresh; the chart's own subscription becomes the cache writer
  // for any insights / mood sub-page that mounts the chart without the
  // dashboard parent having fetched first.
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: queryKeys.moodAnalytics(),
    queryFn: async (): Promise<MoodAnalyticsData> => {
      return apiGet<MoodAnalyticsData>("/api/mood/analytics");
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  // v1.16.0 — report the settled query to the dashboard's shared reveal
  // gate (see `onDataReady` prop doc). Must run BEFORE the
  // empty-entries early return below so a no-data mount still unblocks
  // the row.
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

  // v1.4.43 W2-CHART-GATE — raw mood-entry count across every day in
  // the window. `entries[].samples` carries the per-day raw count
  // straight from the analytics endpoint; summing it produces the
  // total entries the user logged, independent of how many calendar
  // days they hit. Used by the empty-state gate to distinguish "few
  // entries" from "few days".
  const rawCount = useMemo<number>(() => {
    if (!data?.entries?.length) return 0;
    return data.entries.reduce(
      (acc, entry) =>
        acc + (Number.isFinite(entry.samples) ? entry.samples : 0),
      0,
    );
  }, [data]);

  const chartData = useMemo((): ChartDataPoint[] | undefined => {
    if (!data?.entries?.length) return undefined;

    const allPoints: ChartDataPoint[] = data.entries
      .map((entry) => ({
        date: tzFmt.dateShortSmart(new Date(dayKeyToTimestamp(entry.date))),
        timestamp: dayKeyToTimestamp(entry.date),
        pointIndex: 0,
        score: entry.score,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    // v1.37.29 — a calendar-day window, not "the last N logged days":
    // the tabs promise days, and the measurement charts window by days.
    const cutoff = new Date().getTime() - rangePoints * 86_400_000;
    const sliced =
      rangePoints > 0
        ? allPoints.filter((point) => point.timestamp >= cutoff)
        : allPoints;

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
            { bucket: bucketType, timeZone: profileTimeZone },
          ).points.map((point) => ({
            date: tzFmt.dateShortSmart(new Date(point.timestamp)),
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
  }, [data, rangePoints, showMA, showTrend, tzFmt, profileTimeZone]);

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
      const dayKey = tzFmt.dateShortSmart(new Date(row.timestamp));
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
    const cutoff = new Date().getTime() - rangePoints * 86_400_000;
    const sorted = [...data.entries].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    // v1.37.29 — the same calendar-day window `chartData` applies, so the
    // chip describes the points actually painted.
    const sliced =
      rangePoints > 0
        ? sorted.filter((entry) => dayKeyToTimestamp(entry.date) >= cutoff)
        : sorted;
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

  // v1.16.8 — only an EMPTY success hides the card (the dashboard gates
  // the mount on `hasMood` anyway). A failed query must keep the card
  // mounted so the error state + retry affordance below can paint;
  // pre-fix the `return null` made an outage erase the widget entirely.
  if (!isLoading && !isError && !data?.entries?.length) return null;

  // v1.13.1 — TRENDS-ROW MOOD CARD HEIGHT. In mini mode the title +
  // chart body render inside the exact same flat shell `<HealthChart
  // mini>` uses (`bg-card border-border rounded-md border p-2` with a
  // plain `<div>` title), instead of the `<Card>/<CardHeader>/
  // <CardTitle>` chrome that stacked extra vertical space above and
  // below the "Stimmung" heading. Aligning the STRUCTURE — not just
  // the padding values — makes the three trend cards share one title
  // baseline and one height. Full (non-mini) mode keeps the Card path.
  // Accessibility — a concise spoken summary of the visible mood line so a
  // screen reader announces the score range, the latest value and the
  // direction rather than an unlabelled graphic.
  const moodAriaLabel = (() => {
    const metric = displayTitle;
    const scores = (chartData ?? [])
      .map((d) => d.score)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    if (scores.length === 0) {
      return t("charts.a11y.noData", { metric });
    }
    const fmtScore = (v: number) => String(Math.round(v * 10) / 10);
    const minVal = Math.min(...scores);
    const maxVal = Math.max(...scores);
    const latestVal = scores[scores.length - 1];
    const firstVal = scores[0];
    const epsilon = 0.1;
    const delta = latestVal - firstVal;
    const trend =
      delta > epsilon
        ? t("charts.a11y.trendUp")
        : delta < -epsilon
          ? t("charts.a11y.trendDown")
          : t("charts.a11y.trendFlat");
    return t("charts.a11y.summary", {
      metric,
      min: fmtScore(minVal),
      max: fmtScore(maxVal),
      latest: fmtScore(latestVal),
      trend,
    });
  })();

  const chartBody = isLoading ? (
    // v1.16.0 — height-matched skeleton band instead of the former
    // `h-48` spinner box: the loading state occupies the same box the
    // painted chart will (mini 140 px / full 200-220 px), so the card
    // never jumps when the data lands.
    <Skeleton
      className={
        mini
          ? "h-[var(--chart-height,140px)] w-full"
          : "h-[var(--chart-height,200px)] w-full md:h-[var(--chart-height-md,220px)]"
      }
    />
  ) : isError ? (
    // v1.16.8 — a failed query paints as an ERROR with a retry
    // affordance instead of unmounting the card (see the gate above).
    <ChartErrorState
      title={t("charts.errorTitle")}
      actionLabel={t("common.retry")}
      actionContext={displayTitle}
      onAction={() => void refetch()}
      height={CHART_HEIGHT_PX}
    />
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
    //
    // v1.4.43 W2-CHART-GATE — split the copy on the raw mood-entry
    // count. A user with 50 mood entries across 2 calendar days
    // sees `chartData.length = 2` (daily-aggregated) but the raw
    // count (sum of `samples`) is 50. Surface "need more days"
    // in that scenario so the call-to-action matches reality.
    rawCount >= 3 ? (
      <ChartEmptyState
        title={t("charts.needMoreDistinctDaysTitle")}
        description={t("charts.needMoreDistinctDaysDescription")}
        height={CHART_HEIGHT_PX}
      />
    ) : (
      <ChartEmptyState
        title={t("charts.emptyStateTitle")}
        description={t("charts.emptyStateDescription")}
        height={CHART_HEIGHT_PX}
      />
    )
  ) : (
    <div
      // v1.12.7 — the mood line plots a 1–5 score band; the former
      // 240/280 px full-mode height left a tall dead strip below the
      // line on the mood subpage. Tighten the default to 200/220 px so
      // the chart fits its content without the empty gap. A per-mount
      // `--chart-height` override (trends-row mini, etc.) still wins, so
      // only the unoverridden full-mode mount shrinks.
      className={`${
        mini
          ? "h-[var(--chart-height,140px)]"
          : "h-[var(--chart-height,200px)] md:h-[var(--chart-height-md,220px)]"
      } touch-pan-y`}
      role="img"
      aria-label={moodAriaLabel}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart
          data={chartDataWithCompare ?? chartData}
          margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
          accessibilityLayer
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
                new Date(chartData[Math.round(value)]?.timestamp ?? Date.now()),
              )
            }
            // v1.4.29 — Recharts ignores `interval` on numeric
            // axes; pass explicit tick positions instead.
            ticks={computeTickPositions(chartData ?? [], viewportWidth)}
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
                ChartDataPoint | undefined;
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
                    const formatted = `${sign}${Math.abs(diff).toFixed(1)}`;
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
                    const formatted = `${sign}${Math.abs(diff).toFixed(1)}`;
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
              return <RichChartTooltip active label={dateLabel} rows={rows} />;
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
  );

  // v1.13.1 — mini mode: flat shell that exactly mirrors `<HealthChart
  // mini>` (bg-card border rounded-md p-2 + plain `<div>` title), so the
  // three trend cards share one title baseline and one height.
  if (mini) {
    return (
      <div
        data-slot="chart-mini"
        className="bg-card border-border rounded-md border p-2"
      >
        <div className="text-muted-foreground text-2xs mb-1 font-medium tracking-wider uppercase">
          {displayTitle}
        </div>
        {chartBody}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        {/* v1.4.19 A2 — mobile-first header: stack title row above
            controls row on small viewports so the bucket / comparison
            chips never push the range tabs into a 2nd line. ≥sm goes
            back to side-by-side. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <TileHeader title={displayTitle} />
            {activeBucket !== "day" && (
              <TagChip className="hidden tracking-wide uppercase sm:inline-flex">
                {t(
                  activeBucket === "week"
                    ? "charts.bucketWeekly"
                    : "charts.bucketMonthly",
                )}
              </TagChip>
            )}
            {/* v1.4.16 B8 — comparison caption (mood).
                v1.4.19 A2 — hidden on mobile to free up the title row. */}
            {effectiveCompareBaseline !== "none" && hasComparisonData && (
              <span
                className="text-dose-accent bg-dose-accent/10 text-2xs hidden rounded-md border border-current/30 px-1.5 py-0.5 font-medium tracking-wide uppercase sm:inline-flex"
                data-slot="chart-compare-caption"
              >
                {t(
                  effectiveCompareBaseline === "lastMonth"
                    ? "comparison.captionLastMonth"
                    : "comparison.captionLastYear",
                )}
              </span>
            )}
            {effectiveCompareBaseline !== "none" && !hasComparisonData && (
              <span
                className="text-muted-foreground bg-muted/40 text-2xs hidden rounded-md px-1.5 py-0.5 font-medium tracking-wide sm:inline-flex"
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
          <div
            className="flex flex-nowrap items-center justify-end gap-1 self-end sm:self-auto"
            data-slot="chart-header-controls"
          >
            {TIME_RANGES_KEYS.map((r) => (
              <Button
                key={r.labelKey}
                variant={rangePoints === r.days ? "default" : "ghost"}
                aria-pressed={rangePoints === r.days}
                size="sm"
                className="min-h-11 px-2 text-xs sm:px-3"
                onClick={() => {
                  setRangeHydrated(true);
                  setRangePoints(r.days);
                  // v1.30.1 M2 — persist the pick per chart, same
                  // model as the overlay toggles.
                  if (chartKey && !windowOverride) {
                    overlayPrefs.setPrefs({
                      ...overlayPrefs.prefs,
                      rangePoints: r.days,
                    });
                  }
                }}
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
        </div>
      </CardHeader>
      <CardContent>{chartBody}</CardContent>
    </Card>
  );
}
