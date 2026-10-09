"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartDataTable } from "@/components/charts/chart-data-table";
import { ChartEmptyState } from "@/components/charts/chart-empty-state";
import { ChartErrorState } from "@/components/charts/chart-error-state";
import {
  ChartRangeTabs,
  DEFAULT_CHART_RANGE,
  rangeWindowDays,
} from "@/components/charts/chart-range-tabs";
import {
  RichChartTooltip,
  type RichTooltipRow,
} from "@/components/charts/chart-tooltip";
import {
  ChartDayFooter,
  OPEN_DAY_LINE,
  dayAnchor,
  useChartDayLinks,
} from "@/components/day/chart-day-links";
import { TileHeader } from "@/components/insights/tile-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/use-auth";
import { useChartOverlayPrefs } from "@/hooks/use-chart-overlay-prefs";
import { apiGet } from "@/lib/api/api-fetch";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import type { ChartOverlayKey, ChartRangePoints } from "@/lib/dashboard-layout";
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import type { ScoreHistoryId } from "@/lib/insights/score-history-ids";
import { queryKeys } from "@/lib/query-keys";

/**
 * v1.42 — a score's daily course on its page, for the scores that have no
 * stored measurement series to chart: the health score, readiness and the
 * sleep score (the nightly recovery, stress and strain scores are stored and
 * ride `<HealthChart>`).
 *
 * The same card as the metric charts: the range tabs every chart offers,
 * remembered per score page like theirs, each point a door to its day (click,
 * or on touch the tooltip's button), and the data table as the keyboard way
 * to the same days. The person's usual range is shaded behind the line when
 * the server could form one.
 *
 * A health-score point flagged `seamBreak` starts a new segment: the recipe
 * changed there, the values either side are averages of different things,
 * so no line joins them. The segments alternate between two series keys, so
 * each is drawn by a line that has no value on its neighbour's days.
 */

/** Matches the response schema at `scoreHistoryResponse`. */
interface ScoreHistoryResponse {
  score: ScoreHistoryId;
  days: number;
  points: Array<{ day: string; value: number; seamBreak: boolean }>;
  band: { lo: number; hi: number; n: number } | null;
}

interface ChartRow {
  day: string;
  timestamp: number;
  value: number;
  /** The value on even segments, absent on odd ones. */
  even?: number;
  /** The value on odd segments, absent on even ones. */
  odd?: number;
}

/** Points past this many draw the line alone; the dots would merge. */
const MAX_DOTTED_POINTS = 90;
const Y_AXIS_WIDTH = 36;
const MARGIN = { top: 10, right: 8, bottom: 8, left: 0 } as const;

const TIMEOUT_MS = 8_000;

/**
 * The points as chart rows: each on its day's noon-UTC anchor, its value on
 * the series key of its segment. Segments alternate between the two keys, so
 * the line of one never reaches into its neighbour. Exported for its test.
 */
export function toChartRows(
  points: ReadonlyArray<{ day: string; value: number; seamBreak: boolean }>,
): ChartRow[] {
  const rows: ChartRow[] = [];
  let segment = 0;
  for (const [index, point] of points.entries()) {
    if (index > 0 && point.seamBreak) segment += 1;
    rows.push({
      day: point.day,
      timestamp: dayAnchor(point.day),
      value: point.value,
      ...(segment % 2 === 0 ? { even: point.value } : { odd: point.value }),
    });
  }
  return rows;
}

export interface ScoreTrendChartProps {
  score: ScoreHistoryId;
  /** The slot the range tab is remembered under. */
  chartKey: ChartOverlayKey;
  /** The line's colour, a CSS variable reference. */
  color: string;
  /** The score's name: the table caption and the opened day's label. */
  label: string;
}

export function ScoreTrendChart({
  score,
  chartKey,
  color,
  label,
}: ScoreTrendChartProps) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const { isAuthenticated } = useAuth();

  const overlayPrefs = useChartOverlayPrefs(chartKey);
  const [picked, setPicked] = useState<ChartRangePoints | null>(null);
  const range = picked ?? overlayPrefs.prefs.rangePoints ?? DEFAULT_CHART_RANGE;
  const days = rangeWindowDays(range);

  const query = useQuery({
    queryKey: queryKeys.insightsScoreHistory(score, days),
    queryFn: async (): Promise<ScoreHistoryResponse> => {
      const params = new URLSearchParams({ score, days: String(days) });
      return apiGet<ScoreHistoryResponse>(
        `/api/insights/score-history?${params.toString()}`,
        { signal: AbortSignal.timeout(TIMEOUT_MS) },
      );
    },
    enabled: isAuthenticated,
    staleTime: 60_000,
    retry: 0,
    // A range change keeps the previous series painted, dimmed and inert,
    // until the new one lands, so the card does not jump.
    placeholderData: keepPreviousData,
  });

  const rows = useMemo<ChartRow[]>(
    () => toChartRows(query.data?.points ?? []),
    [query.data],
  );
  const hasSeam = (query.data?.points ?? []).some((p) => p.seamBreak);
  const band = query.data?.band ?? null;

  const chartDays = useChartDayLinks({
    enabled: rows.length > 0,
    days: rows.map((row) => row.day),
    focusFor: (index) => {
      const row = rows[index];
      return row ? { label, value: String(row.value) } : null;
    },
  });
  const openRow =
    chartDays.openIndex !== undefined ? rows[chartDays.openIndex] : undefined;

  const animate = !prefersReducedMotion();
  const dot = rows.length <= MAX_DOTTED_POINTS ? { r: 3, fill: color } : false;
  const heightClass =
    "h-[var(--chart-height,240px)] md:h-[var(--chart-height-md,280px)]";

  function selectRange(next: ChartRangePoints) {
    setPicked(next);
    overlayPrefs.setPrefs({ ...overlayPrefs.prefs, rangePoints: next });
  }

  return (
    <div
      data-slot="score-trend-chart"
      data-score={score}
      data-range={range}
      className="bg-card border-border rounded-xl border p-4 md:p-6"
    >
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <TileHeader
          icon={History}
          title={t("insights.derived.scores.historyTitle")}
        />
        <div
          className="flex flex-nowrap items-center justify-end gap-1 self-end sm:self-auto"
          data-slot="chart-header-controls"
        >
          <ChartRangeTabs value={range} onChange={selectRange} />
        </div>
      </div>

      {query.isLoading ? (
        <Skeleton className={`w-full ${heightClass}`} />
      ) : query.isError ? (
        <ChartErrorState
          title={t("charts.errorTitle")}
          actionLabel={t("common.retry")}
          actionContext={label}
          onAction={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <ChartEmptyState
          title={t("charts.noDataInRangeTitle")}
          description={t("insights.scoreHistory.emptyDescription")}
        />
      ) : (
        <>
          <div
            aria-busy={query.isPlaceholderData}
            className={`relative ${heightClass} transition-opacity ${
              query.isPlaceholderData ? "pointer-events-none opacity-50" : ""
            }`}
          >
            <div
              data-slot="chart-plot"
              {...chartDays.plotProps}
              className={`h-full touch-pan-y ${chartDays.plotClassName}`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart
                  data={rows}
                  margin={MARGIN}
                  accessibilityLayer
                  onClick={chartDays.onChartClick}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke="var(--border)"
                    opacity={0.5}
                  />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    scale="time"
                    domain={["dataMin", "dataMax"]}
                    // Each point sits at its day's noon-UTC anchor; the
                    // calendar formatter reads it in UTC, so a tick never
                    // names the neighbouring day.
                    tickFormatter={(ts: number) =>
                      fmt.dateShortSmartCalendar(new Date(ts))
                    }
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={32}
                    padding={{ left: 10, right: 10 }}
                    tickMargin={10}
                  />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 25, 50, 75, 100]}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                    tickLine={false}
                    axisLine={false}
                    width={Y_AXIS_WIDTH}
                    tickMargin={6}
                  />
                  {band ? (
                    <ReferenceArea
                      y1={band.lo}
                      y2={band.hi}
                      fill={color}
                      fillOpacity={0.12}
                      strokeOpacity={0}
                      ifOverflow="discard"
                    />
                  ) : null}
                  {openRow ? (
                    <ReferenceLine x={openRow.timestamp} {...OPEN_DAY_LINE} />
                  ) : null}
                  <Tooltip
                    {...chartDays.tooltipProps}
                    cursor={{
                      stroke: "var(--muted-foreground)",
                      strokeOpacity: 0.3,
                      strokeDasharray: "3 3",
                    }}
                    content={(props) => {
                      const payload = props.payload as
                        ReadonlyArray<{ payload?: ChartRow }> | undefined;
                      const row = payload?.[0]?.payload;
                      if (!props.active || !row) {
                        return <RichChartTooltip active={false} rows={[]} />;
                      }
                      const tooltipRows: RichTooltipRow[] = [
                        { name: label, value: String(row.value), color },
                      ];
                      return (
                        <RichChartTooltip
                          active
                          label={fmt.dateShortSmartCalendar(row.day)}
                          rows={tooltipRows}
                          action={chartDays.tooltipAction(rows.indexOf(row))}
                        />
                      );
                    }}
                  />
                  {(["even", "odd"] as const).map((key) => (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      name={label}
                      stroke={color}
                      strokeWidth={2}
                      dot={dot}
                      activeDot={{ r: 5 }}
                      connectNulls={false}
                      isAnimationActive={animate}
                    />
                  ))}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
          <ChartDayFooter
            links={chartDays}
            points={rows}
            axis="time"
            // The y axis on the left, plus the x axis padding (10) on both
            // sides and the plot's right margin.
            insetLeft={MARGIN.left + Y_AXIS_WIDTH + 10}
            insetRight={MARGIN.right + 10}
          />
          {band || hasSeam ? (
            <div className="mt-2 space-y-1">
              {band ? (
                <p
                  data-slot="score-trend-band"
                  className="text-muted-foreground text-xs"
                >
                  {t("insights.scoreHistory.usualRange", {
                    lo: band.lo,
                    hi: band.hi,
                  })}
                </p>
              ) : null}
              {hasSeam ? (
                <p
                  data-slot="score-trend-seam"
                  className="text-muted-foreground text-xs"
                >
                  {t("insights.scoreHistory.seam")}
                </p>
              ) : null}
            </div>
          ) : null}
          <ChartDataTable
            points={rows.map((row) => ({
              date: row.day,
              timestamp: row.timestamp,
              value: row.value,
            }))}
            columns={[{ key: "value", label }]}
            formatValue={(value) => String(value)}
            formatDate={(date) => fmt.dateShortSmartCalendar(date)}
            bucket="day"
            metricLabel={label}
            dayLinks
          />
        </>
      )}
    </div>
  );
}
