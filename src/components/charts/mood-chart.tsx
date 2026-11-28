"use client";

import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { queryKeys } from "@/lib/query-keys";
import { useEffect, useState, useMemo, useRef } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardHeader, CardContent } from "@/components/ui/card";
import { TagChip } from "@/components/ui/tag-chip";
import { TileHeader } from "@/components/insights/tile-header";
import {
  useDateFormatPreference,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import { readStoredTimezone } from "@/lib/timezone-mirror";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  PERIOD_END_KEY,
  PERIOD_START_KEY,
  READINGS_KEY,
} from "@/lib/charts/range-grain";
import { ChartDataTable } from "./chart-data-table";
import { chartPointDayKey } from "@/components/day/chart-day";
import {
  ChartDayFooter,
  useChartDayLinks,
} from "@/components/day/chart-day-links";
import { ChartEmptyState } from "./chart-empty-state";
import { ChartRangeTabs } from "./chart-range-tabs";
import { ChartErrorState } from "./chart-error-state";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import type {
  ChartOverlayKey,
  ChartRangePoints,
  ComparisonBaseline,
} from "@/lib/dashboard/chart-overlay-prefs";
import { ChartOverlayControls } from "./chart-overlay-controls";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import { useViewportWidth } from "@/hooks/use-viewport-width";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { shouldFireDataReady } from "@/lib/charts/data-ready-latch";
import { moodLabelKeyForScore } from "@/lib/mood/labels";
import { apiGet } from "@/lib/api/api-fetch";
import { MoodChartPlot } from "./mood-chart/plot";
import { useMoodChartView } from "./mood-chart/use-mood-chart-view";

// --- Types ---

interface MoodAnalyticsData {
  entries: Array<{ date: string; score: number; samples: number }>;
  summary: DataSummary;
}

interface MoodChartProps {
  title?: string;
  /**
   * v1.4.16 — compact mode for embedding inside the
   * RecommendationCard. Hides the range tabs / toggle row and shrinks
   * padding. Tooltip stays intact.
   */
  mini?: boolean;
  /**
   * v1.4.16 — pin the chart to a specific rationale data
   * window regardless of any parent UI state.
   */
  windowOverride?: "last7days" | "last30days" | "last90days" | "allTime";
  /**
   * v1.4.16 — when set to "lastMonth" / "lastYear", overlay a
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
  /**
   * v1.42 — the chart is a door to its days, exactly as `HealthChart`'s
   * `dayLinks`: a click on a point (the tooltip's button on touch) opens the
   * day, the open day carries a dashed line, a row of dots marks the days
   * with entries, and the data table under the chart links each date. Daily
   * points only, never in `mini` mode.
   */
  dayLinks?: boolean;
}

// --- Constants ---

// The range tabs select a CALENDAR-DAY window ending now, matching
// `health-chart.tsx`, through the same `ChartRangeTabs` every chart drawn in
// days carries.

// MOOD_LABELS built dynamically via t() in the component

// --- Helpers ---

// --- Component ---

const MINI_RANGE_POINTS: Record<
  NonNullable<MoodChartProps["windowOverride"]>,
  ChartRangePoints
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
  dayLinks = false,
}: MoodChartProps) {
  const { isAuthenticated } = useAuth();
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
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
  const [rangePoints, setRangePoints] =
    useState<ChartRangePoints>(initialRangePoints);

  // v1.4.18 — three overlay toggles persisted per chart. Mini-mode
  // renders without controls and stays at the clean-line default.
  const overlayPrefs = useChartOverlayPrefs(chartKey);
  const showMA = !mini && overlayPrefs.prefs.showTrendIndicator;
  const showTrend = !mini && overlayPrefs.prefs.showTrendArrow;
  const showBands = !mini && overlayPrefs.prefs.showTargetRange;
  const effectiveCompareBaseline =
    !mini && chartKey ? overlayPrefs.prefs.comparisonBaseline : compareBaseline;

  // v1.30.1 — hydrate the range tab from the persisted prefs once
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

  // v1.4.19 — viewport-aware tick density helper.
  const viewportWidth = useViewportWidth();

  const displayTitle = title ?? t("charts.mood");

  // v1.4.40 — align the chart's queryKey with the dashboard's
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
  const { data, isLoading, isError, error, refetch } = useQuery({
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

  // v1.4.43 — raw mood-entry count across every day in
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

  const {
    visible,
    activeBucket,
    chartData,
    chartDataWithCompare,
    hasComparisonData,
  } = useMoodChartView({
    entries: data?.entries,
    rangePoints,
    profileTimeZone,
    tzFmt,
    showMA,
    showTrend,
    effectiveCompareBaseline,
  });

  const maxPointIndex = Math.max(0, (chartData?.length ?? 1) - 1);

  // v1.4.27 — the chart axis and the mood-list cards
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
    const rounded = fmt.number(Math.round(value * 10) / 10);
    const label = moodLabels[Math.round(value)];
    return label ? `${rounded} (${label})` : rounded;
  };

  // v1.4.16 — personal mood baseline (median over visible window).
  const personalBaseline = useMemo<number | null>(() => {
    if (!chartData?.length || chartData.length < 5) return null;
    const sorted = chartData.map((d) => d.score).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }, [chartData]);

  // v1.42 — the chart as a door to its days (`dayLinks`), through the same
  // hook every day-linked chart uses.
  const dayLinksActive = dayLinks && !mini && activeBucket === "day";
  const dayLinkSource = chartDataWithCompare ?? chartData;
  const chartDays = useChartDayLinks({
    enabled: dayLinksActive,
    days: dayLinksActive
      ? (dayLinkSource ?? []).map((point) => chartPointDayKey(point.timestamp))
      : [],
    focusFor: (index) => {
      const point = dayLinkSource?.[index];
      return point
        ? {
            label: displayTitle,
            value: formatTooltipValue(point.score),
            types: ["MOOD"],
          }
        : null;
    },
  });

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
    const fmtScore = (v: number) => fmt.number(Math.round(v * 10) / 10);
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
      error={error}
      title={t("charts.errorTitle")}
      actionLabel={t("common.retry")}
      actionContext={displayTitle}
      onAction={() => void refetch()}
      height={CHART_HEIGHT_PX}
    />
  ) : !chartData?.length ? (
    <ChartEmptyState title={t("charts.noData")} height={192} />
  ) : (visible?.days ?? 0) < 3 ? (
    // v1.4.16 — sparse-data placeholder consistent with the
    // BP/weight/pulse charts. Height tracks the chart strip's
    // shared CHART_HEIGHT_PX so the empty state preserves the
    // trend-row rhythm (v1.4.27 — was 280, now 240 to match every
    // other dashboard chart card).
    //
    // v1.4.43 — split the copy on the raw mood-entry
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
    <MoodChartPlot
      chartData={chartData}
      chartDataWithCompare={chartDataWithCompare}
      mini={mini}
      chartDays={chartDays}
      moodAriaLabel={moodAriaLabel}
      showBands={showBands}
      showTrend={showTrend}
      // The 7-day average is a daily overlay; on week or month points it is
      // not drawn and leaves no legend entry behind.
      showMA={showMA && activeBucket === "day"}
      bucket={activeBucket}
      personalBaseline={personalBaseline}
      maxPointIndex={maxPointIndex}
      tzFmt={tzFmt}
      fmt={fmt}
      viewportWidth={viewportWidth}
      formatMoodTick={formatMoodTick}
      formatTooltipValue={formatTooltipValue}
      effectiveCompareBaseline={effectiveCompareBaseline}
      hasComparisonData={hasComparisonData}
      animationsEnabled={animationsEnabled}
      t={t}
      dayLinkSource={dayLinkSource}
    />
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
        <div className="text-muted-foreground text-2xs mb-1 font-medium">
          {displayTitle}
        </div>
        {chartBody}
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        {/* v1.4.19 — mobile-first header: stack title row above
            controls row on small viewports so the bucket / comparison
            chips never push the range tabs into a 2nd line. ≥sm goes
            back to side-by-side. */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <TileHeader title={displayTitle} />
            {activeBucket !== "day" && (
              <TagChip className="hidden sm:inline-flex">
                {t(
                  activeBucket === "week"
                    ? "charts.bucketWeekly"
                    : "charts.bucketMonthly",
                )}
              </TagChip>
            )}
            {/* v1.4.16 — comparison caption (mood).
                v1.4.19 — hidden on mobile to free up the title row. */}
            {effectiveCompareBaseline !== "none" && hasComparisonData && (
              <span
                className="text-dose-accent bg-dose-accent/10 text-2xs hidden rounded-md border border-current/30 px-1.5 py-0.5 font-medium sm:inline-flex"
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
            <ChartRangeTabs
              value={rangePoints}
              onChange={(days) => {
                setRangeHydrated(true);
                setRangePoints(days);
                // v1.30.1 — persist the pick per chart, same
                // model as the overlay toggles.
                if (chartKey && !windowOverride) {
                  overlayPrefs.setPrefs({
                    ...overlayPrefs.prefs,
                    rangePoints: days,
                  });
                }
              }}
            />
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
      <CardContent>
        {chartBody}
        {!isLoading && !isError && chartData && (visible?.days ?? 0) >= 3 ? (
          <>
            <ChartDayFooter
              links={chartDays}
              points={chartData}
              // The plot's margin (8) + the y axis (65) + the x axis padding
              // (10) on the left, margin + padding on the right.
              insetLeft={8 + 65 + 10}
              insetRight={8 + 10}
            />
            {dayLinks ? (
              <ChartDataTable
                points={chartData.map((point) => ({
                  date: point.date,
                  timestamp: point.timestamp,
                  score: point.score,
                  [PERIOD_START_KEY]: point[PERIOD_START_KEY],
                  [PERIOD_END_KEY]: point[PERIOD_END_KEY],
                  [READINGS_KEY]: point[READINGS_KEY],
                }))}
                columns={[{ key: "score", label: t("charts.moodScore") }]}
                formatValue={formatTooltipValue}
                formatDate={tzFmt.date}
                bucket={activeBucket}
                metricLabel={displayTitle}
                dayLinks={dayLinksActive}
                countLabel={t("charts.dataTable.columnEntries")}
              />
            ) : null}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}
