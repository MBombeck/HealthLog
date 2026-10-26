"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { chartPointDayKey } from "@/components/day/chart-day";
import {
  ChartDayFooter,
  useChartDayLinks,
} from "@/components/day/chart-day-links";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import { useRecordCapabilities } from "@/hooks/use-record-capabilities";
import { useViewportWidth } from "@/hooks/use-viewport-width";
import { axisTickUnitSuffix } from "@/lib/charts/axis-unit";
import { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import {
  useDateFormatPreference,
  useFormatters,
  useTranslations,
} from "@/lib/i18n/context";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import { ChartDataTable } from "./chart-data-table";
import { ChartEmptyState } from "./chart-empty-state";
import { ChartErrorState } from "./chart-error-state";
import { DEFAULT_CHART_RANGE } from "./chart-range-tabs";
import { ChartFooterReserve } from "./chart-skeleton";
import { ChartBandOverlay } from "./health-chart/band-overlay";
import { HealthChartHeader } from "./health-chart/chart-header";
import {
  annotationLayers,
  baselineLayers,
  openDayLayers,
  seriesLayers,
  targetZoneLayers,
  verticalMarkerLayers,
} from "./health-chart/chart-layers";
import { makeTooltipContent } from "./health-chart/chart-tooltip-content";
import {
  axisValueFormatters,
  dayFocusFor,
  getTypeLabel,
  makeDayKeyFormatter,
  pointIndexXAxis,
  resolveAnnotationPositions,
  resolveVerticalMarkerPositions,
} from "./health-chart/series-math";
import type { HealthChartProps } from "./health-chart/types";
import {
  useHealthChartLabels,
  useHealthChartOverlays,
} from "./health-chart/use-health-chart-overlays";
import { useHealthChartSeries } from "./health-chart/use-health-chart-series";
import { useHealthChartView } from "./health-chart/use-health-chart-view";
import { resolveMiniRangePoints } from "./mini-window";

/**
 * A metric over time: the line, the overlays a person can switch on (the
 * 7-day average, the trend, the target range, the prior period), reference
 * bands and zones, annotations and event markers, the range tabs, the
 * tooltip, and the days as doors. The parts live in `./health-chart/`: the
 * series read, the derived view, the overlays and labels, the header, the
 * plot layers and the tooltip; this component wires them together.
 */
export function HealthChart({
  types,
  title,
  colors = ["var(--chart-1)", "var(--chart-3)", "var(--chart-4)"],
  unit,
  yAxisUnit,
  valueMode = "raw",
  yAxisWidth = 76,
  showYAxisUnit = true,
  valueBands,
  targetZones,
  mini = false,
  windowOverride,
  compareBaseline = "none",
  chartKey,
  overlayControls = true,
  annotations,
  verticalMarkers,
  userTimezone: userTimezoneProp,
  valueScale = 1,
  valueOffset = 0,
  onVisibleStats,
  titleIcon,
  onDataReady,
  preloadedSeries,
  preloadedCoverageDays,
  showDataTable = false,
  dayLinks = false,
}: HealthChartProps) {
  const { isAuthenticated, user } = useAuth();
  // A mount without the prop used to pin Europe/Berlin, so those charts cut
  // days in Berlin for every user whatever their profile said.
  const userTimezone = userTimezoneProp || user?.timezone || DEFAULT_TIMEZONE;
  const { t, locale } = useTranslations();
  const fmt = useFormatters();
  // Every timestamp the chart labels encodes a CALENDAR DAY (noon UTC of a
  // profile-zone day key, or a bucket start), so labels render UTC-pinned
  // and the encoded day paints verbatim in every zone (#490); the profile's
  // date order decides how it is spelled (#922). Bucketing still uses the
  // profile zone.
  const dateFormat = useDateFormatPreference();
  const tzFmt = useMemo(
    () => makeBucketLabelFormatters(locale, dateFormat),
    [locale, dateFormat],
  );
  const dayKeyFormatter = useMemo(
    () => makeDayKeyFormatter(userTimezone),
    [userTimezone],
  );
  // A `windowOverride` pins the range (mini mode hides the tabs anyway).
  const initialRangePoints = windowOverride
    ? resolveMiniRangePoints(windowOverride)
    : DEFAULT_CHART_RANGE;
  const [rangePoints, setRangePoints] = useState(initialRangePoints);

  // The overlay toggles and the comparison persist per chart; an unbound
  // chart (mini mode, ad-hoc use) gets the clean-line default and skips the
  // layout read.
  const overlayPrefs = useChartOverlayPrefs(chartKey);
  const showMA = overlayPrefs.prefs.showTrendIndicator;
  const showTrend = overlayPrefs.prefs.showTrendArrow;
  const showBands = overlayPrefs.prefs.showTargetRange;
  const effectiveCompareBaseline = chartKey
    ? overlayPrefs.prefs.comparisonBaseline
    : compareBaseline;

  // Adopt the persisted range tab once the prefs arrive. Adjusted during
  // render (React's documented escape hatch, not an effect), so the first
  // render that sees the prefs already reflects them; `rangeHydrated` stops a
  // later refetch from stomping a range picked this session. Pinned charts
  // never adopt one.
  const [rangeHydrated, setRangeHydrated] = useState(false);
  if (
    !windowOverride &&
    chartKey &&
    !rangeHydrated &&
    typeof overlayPrefs.prefs.rangePoints === "number"
  ) {
    setRangeHydrated(true);
    setRangePoints(overlayPrefs.prefs.rangePoints);
  }

  // Viewport-aware tick density: 4 to 10 labels, whatever the point count.
  const viewportWidth = useViewportWidth();

  // `useAuth()` is the person at the keyboard, and under a switch that is the
  // delegate: dividing the owner's weights by the delegate's height squared
  // gives a plausible BMI that is somebody else's. Inside a shared record the
  // chart draws no BMI rather than a wrong one.
  const { inSharedRecord } = useRecordCapabilities();
  const bmiDivisor =
    valueMode === "bmi" && !inSharedRecord && user?.heightCm
      ? (user.heightCm / 100) ** 2
      : null;

  const { data, isLoading, isError, error, isPlaceholderData, refetch } =
    useHealthChartSeries({
      types,
      valueMode,
      bmiDivisor,
      valueScale,
      valueOffset,
      userTimezone,
      dayKeyFormatter,
      tzFmt,
      rangePoints,
      effectiveCompareBaseline,
      preloadedSeries,
      preloadedCoverageDays,
      enabled: isAuthenticated,
      onDataReady,
    });

  const {
    visibleSlice,
    chartData,
    visibleStatsByType,
    chartDataWithCompare,
    hasComparisonData,
    activeBucket,
    bucketCaption,
    yDomain,
    yTicks,
  } = useHealthChartView({
    data,
    rangePoints,
    types,
    userTimezone,
    tzFmt,
    showMA,
    showTrend,
    effectiveCompareBaseline,
    mini,
    isLoading,
    isError,
    onVisibleStats,
  });

  const [containerWidth, setContainerWidth] = useState<number | null>(null);
  const overlays = useHealthChartOverlays({
    showBands,
    showTrend,
    valueBands,
    targetZones,
    yDomain,
    chartData,
    types,
    unit,
    valueMode,
    t,
    fmt,
    plotWidth: containerWidth ?? viewportWidth,
  });
  const { visibleBands, visibleTargetZones, trendInfo, personalBaselines } =
    overlays;

  const { useDecimalAxis, formatAxisValue, formatTooltipValue } =
    axisValueFormatters(yDomain, fmt, yTicks);

  const { primaryType, chartAriaLabel, dataTableColumns } =
    useHealthChartLabels({
      types,
      valueMode,
      t,
      fmt,
      chartData,
      chartDataWithCompare,
      visibleStatsByType,
      showDataTable,
      mini,
    });

  // An empty window keeps the card shell and paints "no data in this range"
  // inside it, rather than leaving an unexplained gap.
  const maxPointIndex = Math.max(0, (chartData?.length ?? 1) - 1);

  const annotationPositions = resolveAnnotationPositions(
    annotations,
    chartData,
  );
  const verticalMarkerPositions = resolveVerticalMarkerPositions(
    verticalMarkers,
    chartData,
  );

  // The days as doors: daily points only (a week or month point averages
  // many days and has no one day to open).
  const dayLinksActive = dayLinks && !mini && activeBucket === "day";
  const dayLinkSource = chartDataWithCompare ?? chartData;
  const chartDays = useChartDayLinks({
    enabled: dayLinksActive,
    days: dayLinksActive
      ? (dayLinkSource ?? []).map((point) => chartPointDayKey(point.timestamp))
      : [],
    focusFor: (index) =>
      dayFocusFor(dayLinkSource?.[index], {
        types,
        title,
        unit,
        valueMode,
        fmt,
        formatTooltipValue,
      }),
  });
  const openDayIndex = chartDays.openIndex;
  const openDayPoint =
    openDayIndex !== undefined ? chartData?.[openDayIndex] : undefined;

  const showContextDetails = showMA || showTrend || showBands;
  const animationsEnabled = !prefersReducedMotion();
  const label = (type: string) => getTypeLabel(type, valueMode, t);

  // Mini mode fits the rationale card: tighter padding, no tabs or toggles.
  const containerClass = mini
    ? "bg-card border-border rounded-md border p-2"
    : "bg-card border-border rounded-xl border p-4 md:p-6";
  // The height reads from `--chart-height` so a mount can override it: 140 px
  // in mini mode, else 240 px, and 280 px from `md` up.
  const chartHeightClass = mini
    ? "h-[var(--chart-height,140px)]"
    : "h-[var(--chart-height,240px)] md:h-[var(--chart-height-md,280px)]";

  return (
    <div className={containerClass} data-slot={mini ? "chart-mini" : undefined}>
      {!mini && (
        <HealthChartHeader
          title={title}
          titleIcon={titleIcon}
          bucketCaption={bucketCaption}
          compareBaseline={effectiveCompareBaseline}
          hasComparisonData={hasComparisonData}
          rangePoints={rangePoints}
          onRangeChange={(days) => {
            setRangeHydrated(true);
            setRangePoints(days);
            // The pick persists per chart, like the overlay toggles, so it
            // survives a remount.
            if (chartKey && !windowOverride) {
              overlayPrefs.setPrefs({
                ...overlayPrefs.prefs,
                rangePoints: days,
              });
            }
          }}
          overlayPrefs={overlayPrefs}
          showOverlayControls={Boolean(chartKey && overlayControls)}
        />
      )}

      {mini && (
        <div className="text-muted-foreground text-2xs mb-1 font-medium tracking-wider uppercase">
          {title}
        </div>
      )}

      {!mini && showTrend && trendInfo.length > 0 ? (
        <div className="text-muted-foreground mb-3 flex flex-wrap gap-3 text-xs">
          {trendInfo.map((info) => (
            <span key={info}>{info}</span>
          ))}
        </div>
      ) : null}

      {isLoading ? (
        // A skeleton in the exact box the painted chart takes, so the card
        // height never jumps when the data lands.
        <>
          <Skeleton className={`w-full ${chartHeightClass}`} />
          {mini ? null : (
            <ChartFooterReserve
              dayLinks={dayLinksActive}
              dataTable={showDataTable}
            />
          )}
        </>
      ) : isError ? (
        // A failed read is an error with retry, never "no data in this
        // range": an outage must not read as "you have no measurements".
        <ChartErrorState
          error={error}
          title={t("charts.errorTitle")}
          actionLabel={t("common.retry")}
          actionContext={title}
          onAction={() => void refetch()}
        />
      ) : !chartData?.length ? (
        // Only a window with no daily point at all withholds the plot; any
        // real data, even one day, is drawn (with the sparse caption below).
        <ChartEmptyState
          title={t("charts.noDataInRangeTitle")}
          description={t("charts.noDataInRangeDescription")}
        />
      ) : (
        <>
          <div
            // The other half of `keepPreviousData`: while the re-keyed range
            // still fetches, the previous range stays painted but dimmed and
            // inert, so it cannot masquerade as the new one.
            aria-busy={isPlaceholderData}
            className={`relative ${chartHeightClass} transition-opacity ${
              isPlaceholderData ? "pointer-events-none opacity-50" : ""
            }`}
          >
            {visibleBands.length > 0 ? (
              <ChartBandOverlay bands={visibleBands} yAxisWidth={yAxisWidth} />
            ) : null}

            <div
              // A stable hook for the browser suite, rendered by the data
              // branch only, so a check does not depend on Recharts' markup.
              data-slot="chart-plot"
              {...chartDays.plotProps}
              className={`relative z-10 h-full touch-pan-y ${chartDays.plotClassName}`}
              role="img"
              aria-label={chartAriaLabel}
            >
              <ResponsiveContainer
                width="100%"
                height="100%"
                onResize={setContainerWidth}
              >
                <ComposedChart
                  data={chartDataWithCompare ?? chartData}
                  margin={{
                    top: 10,
                    right: 8 + overlays.rightRoom,
                    bottom: 8,
                    left: 8,
                  }}
                  accessibilityLayer
                  onClick={chartDays.onChartClick}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    opacity={0.5}
                  />
                  <XAxis
                    {...pointIndexXAxis({
                      chartData,
                      formatDate: tzFmt.date,
                      viewportWidth,
                      containerWidth,
                      yAxisWidth,
                      rightRoom: overlays.rightRoom,
                    })}
                  />
                  <YAxis
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    width={yAxisWidth}
                    tickMargin={10}
                    domain={yDomain}
                    ticks={yTicks}
                    tickFormatter={(value) =>
                      typeof value === "number"
                        ? formatAxisValue(
                            useDecimalAxis ? value : Math.round(value),
                          )
                        : String(value)
                    }
                    unit={
                      showYAxisUnit
                        ? axisTickUnitSuffix(yAxisUnit ?? unit)
                        : undefined
                    }
                  />
                  {targetZoneLayers(visibleTargetZones, maxPointIndex)}
                  {annotationLayers(annotationPositions, viewportWidth)}
                  {verticalMarkerLayers(verticalMarkerPositions, yDomain)}
                  {openDayLayers(openDayIndex, openDayPoint, types, colors)}
                  {baselineLayers(
                    showTrend,
                    types,
                    colors,
                    personalBaselines,
                    t,
                    overlays.besidePlot,
                  )}
                  <Tooltip
                    filterNull={false}
                    // On a touch screen the tooltip is the way to the day: it
                    // stays where the tap put it and takes taps.
                    {...chartDays.tooltipProps}
                    cursor={{
                      stroke: "var(--muted-foreground)",
                      strokeOpacity: 0.3,
                      strokeDasharray: "3 3",
                    }}
                    content={makeTooltipContent({
                      chartData,
                      dayLinkSource,
                      personalBaselines,
                      compareBaseline: effectiveCompareBaseline,
                      bucketCaption,
                      unit,
                      t,
                      fmt,
                      dateLabelFor: tzFmt.date,
                      formatValue: formatTooltipValue,
                      tooltipAction: chartDays.tooltipAction,
                    })}
                  />
                  {showContextDetails && (
                    <Legend
                      wrapperStyle={{
                        fontSize: "0.875rem",
                        fontFamily: "inherit",
                        fontWeight: "normal",
                      }}
                    />
                  )}
                  {seriesLayers({
                    types,
                    colors,
                    label,
                    t,
                    mini,
                    showBands,
                    showMA,
                    showTrend,
                    compareBaseline: effectiveCompareBaseline,
                    hasComparisonData,
                    animationsEnabled,
                  })}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            {/* With fewer than three daily points the chart still paints
                every reading; this note says more days fill out the trend. */}
            {!mini && (chartData?.length ?? 0) < 3 ? (
              <p
                className="text-muted-foreground mt-2 text-center text-xs"
                data-slot="chart-sparse-caption"
              >
                {t("charts.sparseDataCaption")}
              </p>
            ) : null}
          </div>
          {chartData ? (
            <ChartDayFooter
              links={chartDays}
              points={chartData}
              // The plot's margin (8) + the y axis + the x axis padding (10)
              // on the left, margin + padding on the right.
              insetLeft={8 + yAxisWidth + 10}
              insetRight={8 + overlays.rightRoom + 10}
            />
          ) : null}
          {/* The points the chart just drew, as a table, read from the same
              expression `<ComposedChart data>` is handed. Inside this branch
              on purpose: an empty window shows the empty state and no table. */}
          {showDataTable && !mini && dataTableColumns.length > 0 ? (
            <ChartDataTable
              points={chartDataWithCompare ?? chartData ?? []}
              columns={dataTableColumns}
              unit={unit}
              formatValue={formatTooltipValue}
              formatDate={tzFmt.date}
              bucket={visibleSlice?.bucketType ?? "day"}
              metricLabel={getTypeLabel(primaryType, valueMode, t)}
              dayLinks={dayLinksActive}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
