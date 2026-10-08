"use client";

import { useMemo, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { ChartDataTable } from "@/components/charts/chart-data-table";
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
import { useFormatters, useTranslations } from "@/lib/i18n/context";
import {
  MOOD_DIMENSIONS,
  MOOD_DIMENSION_WINDOWS,
  type MoodDimensionWindow,
} from "@/lib/mood/dimensions";
import { cn } from "@/lib/utils";

/**
 * v1.37 — the five level-A dimensions over time.
 *
 * Each dimension is drawn in the orientation the person answered it in and
 * under the label they read, so a high stress line means a stressful stretch
 * rather than a good one. Nothing is flipped for the picture's convenience;
 * the legend says which way each scale runs.
 *
 * A dimension nobody has answered is not drawn and is named underneath as not
 * recorded. Drawing it flat through the middle would put five answers on the
 * chart for a question that was asked once.
 */

export interface MoodDimensionPointData {
  date: string;
  value: number;
  samples: number;
}

export interface MoodDimensionSummaryData {
  key: string;
  present: boolean;
  inverse: boolean;
  min: number;
  max: number;
  count: number;
  avg7: number | null;
  avg30: number | null;
  avg90: number | null;
  latest: number | null;
  latestDate: string | null;
  newestDaysAgo: number | null;
  series: MoodDimensionPointData[];
}

/** One colour per dimension, from the same semantic set the other charts use. */
const COLOR_BY_KEY: Record<string, string> = {
  a1: "var(--chart-1)",
  a2: "var(--destructive)",
  a3: "var(--dracula-orange)",
  a4: "var(--info)",
  a5: "var(--success)",
};

function meanForWindow(
  summary: MoodDimensionSummaryData,
  window: MoodDimensionWindow,
): number | null {
  if (window === 7) return summary.avg7;
  if (window === 30) return summary.avg30;
  return summary.avg90;
}

export function MoodDimensionTrends({
  dimensions,
}: {
  dimensions: MoodDimensionSummaryData[];
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const [window, setWindow] = useState<MoodDimensionWindow>(30);

  const present = dimensions.filter((d) => d.present);
  const missing = dimensions.filter((d) => !d.present);

  const chartData = useMemo(() => {
    const byDate = new Map<string, Record<string, number | string>>();
    for (const summary of present) {
      for (const point of summary.series) {
        const row = byDate.get(point.date) ?? { date: point.date };
        row[summary.key] = point.value;
        byDate.set(point.date, row);
      }
    }
    const rows = [...byDate.values()].sort((a, b) =>
      String(a.date).localeCompare(String(b.date)),
    );
    // The series carry the longest window; the shorter ones are a slice of the
    // same points rather than a second read.
    return rows.slice(Math.max(0, rows.length - window));
  }, [present, window]);

  const labelFor = (key: string) => {
    const dimension = MOOD_DIMENSIONS.find((d) => d.key === key);
    return dimension ? t(dimension.labelKey) : key;
  };

  // v1.42 — each answered day opens its day, through the doors every
  // day-linked chart has.
  const rowDays = chartData.map((row) => String(row.date));
  const chartDays = useChartDayLinks({
    enabled: present.length > 0 && chartData.length > 0,
    days: rowDays,
  });

  if (present.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        {t("insights.mood.dimensions.none")}
      </p>
    );
  }

  return (
    <div className="space-y-3" data-slot="mood-dimension-trends">
      <div className="flex flex-wrap items-center gap-1.5">
        {MOOD_DIMENSION_WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setWindow(option)}
            aria-pressed={window === option}
            className={cn(
              "min-h-9 rounded-full border px-3 text-xs transition-colors",
              window === option
                ? "border-primary bg-primary/15 text-primary"
                : "border-border/70 text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            {t("insights.mood.dimensions.window", { days: option })}
          </button>
        ))}
      </div>

      <div
        data-slot="chart-plot"
        {...chartDays.plotProps}
        className={cn(
          "h-[clamp(160px,34vh,220px)] w-full",
          chartDays.plotClassName,
        )}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={chartData}
            margin={{ top: 4, right: 8, bottom: 0, left: -20 }}
            onClick={chartDays.onChartClick}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              tickFormatter={(value: string) =>
                fmt.dateShortSmartCalendar(value)
              }
              minTickGap={24}
            />
            <YAxis
              domain={[0, 10]}
              ticks={[0, 5, 10]}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            />
            {chartDays.openIndex !== undefined ? (
              <ReferenceLine
                x={rowDays[chartDays.openIndex]}
                {...OPEN_DAY_LINE}
              />
            ) : null}
            <Tooltip
              {...chartDays.tooltipProps}
              content={(props) => {
                const payload = props.payload as unknown as
                  | ReadonlyArray<{
                      dataKey?: string | number;
                      value?: number;
                      color?: string;
                      payload?: Record<string, number | string>;
                    }>
                  | undefined;
                const row = payload?.[0]?.payload;
                if (!props.active || !row) {
                  return <RichChartTooltip active={false} rows={[]} />;
                }
                const rows: RichTooltipRow[] = (payload ?? [])
                  .filter((item) => typeof item.value === "number")
                  .map((item) => ({
                    name: labelFor(String(item.dataKey)),
                    value: String(item.value),
                    color: item.color ?? "var(--chart-1)",
                  }));
                return (
                  <RichChartTooltip
                    active
                    label={fmt.dateShortSmartCalendar(String(row.date))}
                    rows={rows}
                  />
                );
              }}
            />
            {present.map((summary) => (
              <Line
                key={summary.key}
                type="monotone"
                dataKey={summary.key}
                name={summary.key}
                stroke={COLOR_BY_KEY[summary.key] ?? "var(--chart-1)"}
                strokeWidth={2}
                dot={false}
                // A gap is a day nobody answered; joining across it would draw
                // a value that was never given.
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ChartDayFooter
        links={chartDays}
        points={rowDays.map((day) => ({ timestamp: dayAnchor(day) }))}
        // The y axis (60) less the plot's negative left margin (20); the
        // margin (8) on the right.
        insetLeft={60 - 20}
        insetRight={8}
      />
      {chartDays.active ? (
        <ChartDataTable
          points={chartData.map((row) => ({
            ...row,
            date: String(row.date),
            timestamp: dayAnchor(String(row.date)),
          }))}
          columns={present.map((summary) => ({
            key: summary.key,
            label: labelFor(summary.key),
          }))}
          formatValue={(value) => String(value)}
          formatDate={(date) => fmt.dateShortSmartCalendar(date)}
          bucket="day"
          metricLabel={t("insights.mood.dimensions.title")}
          dayLinks
        />
      ) : null}

      <ul className="space-y-1.5">
        {present.map((summary) => {
          const mean = meanForWindow(summary, window);
          const dimension = MOOD_DIMENSIONS.find((d) => d.key === summary.key);
          return (
            <li
              key={summary.key}
              className="flex items-baseline justify-between gap-3 text-sm"
            >
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className="inline-block size-2 shrink-0 rounded-full"
                  style={{
                    background: COLOR_BY_KEY[summary.key] ?? "var(--chart-1)",
                  }}
                />
                <span>{labelFor(summary.key)}</span>
                {summary.inverse && dimension ? (
                  <span className="text-muted-foreground text-xs">
                    {t("insights.mood.dimensions.higherIsMore", {
                      anchor: t(dimension.highAnchorKey),
                    })}
                  </span>
                ) : null}
              </span>
              <span className="text-foreground shrink-0 tabular-nums">
                {mean === null
                  ? t("insights.mood.dimensions.noneInWindow")
                  : mean}
              </span>
            </li>
          );
        })}
      </ul>

      {missing.length > 0 ? (
        <p className="text-muted-foreground text-xs">
          {t("insights.mood.dimensions.notRecorded", {
            list: missing.map((d) => labelFor(d.key)).join(", "),
          })}
        </p>
      ) : null}
    </div>
  );
}
