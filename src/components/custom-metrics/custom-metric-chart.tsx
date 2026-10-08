"use client";

import { useMemo, useState } from "react";
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

import { Button } from "@/components/ui/button";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import {
  useDisplayTimezone,
  useTranslations,
  useFormatters,
} from "@/lib/i18n/context";
import { ChartDataTable } from "../charts/chart-data-table";
import { RichChartTooltip, type RichTooltipRow } from "../charts/chart-tooltip";
import {
  ChartDayFooter,
  OPEN_DAY_LINE,
  dayAnchor,
  useChartDayLinks,
} from "../day/chart-day-links";
import { dateKeyOfInstant } from "../day/day-url";
import { formatMetricValue } from "./format-value";
import type { CustomMetricEntryDto } from "./types";

/**
 * v1.25.5 — per-custom-metric trend chart, in the dashboard's visual language.
 *
 * A single line over time, the optional target window painted as a shaded
 * `ReferenceArea` band with dashed bound lines, range tabs (30 / 90 / 365 /
 * all), and the shared rich tooltip. The band uses a MUTED primary fill — never
 * a danger colour. Mirrors `lab-biomarker-chart`. Reads entries LIVE (no
 * rollup tier).
 */

const RANGE_DAYS = [
  { key: "30", days: 30 },
  { key: "90", days: 90 },
  { key: "365", days: 365 },
  { key: "all", days: 0 },
] as const;

type RangeKey = (typeof RANGE_DAYS)[number]["key"];

interface ChartPoint {
  timestamp: number;
  value: number;
}

export function CustomMetricChart({
  entries,
  name,
  unit,
  targetLow,
  targetHigh,
  decimals,
}: {
  /** The metric's name: the day's focus label and the data table's caption. */
  name: string;
  /** Entries for this metric, any order (sorted internally). */
  entries: CustomMetricEntryDto[];
  unit: string;
  targetLow: number | null;
  targetHigh: number | null;
  decimals: number | null;
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [range, setRange] = useState<RangeKey>("365");
  const [nowMs] = useState(() => Date.now());

  const points = useMemo<ChartPoint[]>(() => {
    const sorted = [...entries].sort(
      (a, b) =>
        new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime(),
    );
    const days = RANGE_DAYS.find((r) => r.key === range)?.days ?? 0;
    const filtered =
      days > 0
        ? sorted.filter((r) => {
            const ageMs = nowMs - new Date(r.measuredAt).getTime();
            return ageMs <= days * 24 * 60 * 60 * 1000;
          })
        : sorted;
    return filtered.map((r) => ({
      timestamp: new Date(r.measuredAt).getTime(),
      value: r.value,
    }));
  }, [entries, range, nowMs]);

  const yDomain = useMemo<[number, number]>(() => {
    const candidates = points.map((p) => p.value);
    if (targetLow != null) candidates.push(targetLow);
    if (targetHigh != null) candidates.push(targetHigh);
    if (candidates.length === 0) return [0, 1];
    const min = Math.min(...candidates);
    const max = Math.max(...candidates);
    const pad = (max - min || Math.abs(max) || 1) * 0.1;
    return [min - pad, max + pad];
  }, [points, targetLow, targetHigh]);

  // v1.42 — each value opens its day (the calendar day of its instant in
  // the record's zone) through the doors every day-linked chart has.
  const timeZone = useDisplayTimezone();
  const pointDays = points.map((point) =>
    dateKeyOfInstant(point.timestamp, timeZone),
  );
  const chartDays = useChartDayLinks({
    enabled: true,
    days: pointDays,
    focusFor: (index) => {
      const point = points[index];
      return point
        ? { label: name, value: formatMetricValue(point.value, decimals), unit }
        : null;
    },
  });
  const openPoint =
    chartDays.openIndex !== undefined ? points[chartDays.openIndex] : undefined;

  const animate = !prefersReducedMotion();
  const primary = "var(--primary)";

  return (
    <div className="space-y-3">
      <div className="flex justify-end gap-1">
        {RANGE_DAYS.map((r) => (
          <Button
            key={r.key}
            size="sm"
            variant={range === r.key ? "secondary" : "ghost"}
            aria-pressed={range === r.key}
            className="h-7 px-2 text-xs"
            onClick={() => setRange(r.key)}
          >
            {t(`customMetrics.chart.range.${r.key}`)}
          </Button>
        ))}
      </div>

      {points.length === 0 ? (
        <p className="text-muted-foreground py-10 text-center text-sm">
          {t("customMetrics.chart.empty")}
        </p>
      ) : (
        <div>
          <div
            data-slot="chart-plot"
            {...chartDays.plotProps}
            className={chartDays.plotClassName}
          >
            <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
              <ComposedChart
                data={points}
                margin={{ top: 8, right: 12, bottom: 4, left: 0 }}
                onClick={chartDays.onChartClick}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="var(--border)"
                  vertical={false}
                />
                <XAxis
                  dataKey="timestamp"
                  type="number"
                  scale="time"
                  domain={["dataMin", "dataMax"]}
                  tickFormatter={(ts: number) =>
                    fmt.dateShortSmart(new Date(ts))
                  }
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  stroke="var(--border)"
                  minTickGap={32}
                />
                <YAxis
                  domain={yDomain}
                  tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  stroke="var(--border)"
                  width={44}
                  tickFormatter={(v: number) => formatMetricValue(v, decimals)}
                />
                {targetLow != null && targetHigh != null ? (
                  <ReferenceArea
                    y1={targetLow}
                    y2={targetHigh}
                    fill={primary}
                    fillOpacity={0.1}
                    stroke="none"
                  />
                ) : null}
                {targetLow != null ? (
                  <ReferenceLine
                    y={targetLow}
                    stroke={primary}
                    strokeOpacity={0.4}
                    strokeDasharray="4 4"
                  />
                ) : null}
                {targetHigh != null ? (
                  <ReferenceLine
                    y={targetHigh}
                    stroke={primary}
                    strokeOpacity={0.4}
                    strokeDasharray="4 4"
                  />
                ) : null}
                {openPoint ? (
                  <ReferenceLine x={openPoint.timestamp} {...OPEN_DAY_LINE} />
                ) : null}
                <Tooltip
                  {...chartDays.tooltipProps}
                  content={(props) => {
                    const active = props.active ?? false;
                    const payload = props.payload as
                      ReadonlyArray<{ payload?: ChartPoint }> | undefined;
                    const point = payload?.[0]?.payload;
                    if (!active || !point) {
                      return <RichChartTooltip active={false} rows={[]} />;
                    }
                    const rows: RichTooltipRow[] = [
                      {
                        name: t("customMetrics.chart.valueLabel"),
                        value: `${formatMetricValue(point.value, decimals)} ${unit}`,
                        color: primary,
                      },
                    ];
                    return (
                      <RichChartTooltip
                        active
                        label={fmt.dateShortSmart(new Date(point.timestamp))}
                        rows={rows}
                        action={chartDays.tooltipAction(points.indexOf(point))}
                      />
                    );
                  }}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke={primary}
                  strokeWidth={2}
                  dot={{ r: 3, fill: primary }}
                  activeDot={{ r: 5 }}
                  isAnimationActive={animate}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <ChartDayFooter
            links={chartDays}
            points={points}
            axis="time"
            // The y axis (44) on the left, the margin (12) on the right.
            insetLeft={44}
            insetRight={12}
          />
          <ChartDataTable
            points={points.map((point, index) => ({
              date: pointDays[index]!,
              timestamp: dayAnchor(pointDays[index]!),
              value: point.value,
            }))}
            columns={[{ key: "value", label: name }]}
            unit={unit}
            formatValue={(value) => formatMetricValue(value, decimals)}
            formatDate={(date) => fmt.dateShortSmartCalendar(date)}
            bucket="day"
            metricLabel={name}
            dayLinks
          />
        </div>
      )}
    </div>
  );
}
