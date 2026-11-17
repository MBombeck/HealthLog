"use client";

import { useMemo } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  ChartDayFooter,
  OPEN_DAY_LINE,
  dayAnchor,
  useChartDayLinks,
} from "@/components/day/chart-day-links";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useFormatters } from "@/lib/i18n/context";
import { formatNutrientAmount } from "@/lib/nutrients/format-amount";

import { ChartDataTable } from "./chart-data-table";
import { RichChartTooltip, type RichTooltipRow } from "./chart-tooltip";

/**
 * v1.29 — 30-day daily bar chart for the nutrients hydration / caffeine
 * cards. One bar per day (dense series — 0 for an unlogged day, summed
 * across sources), an optional thin dashed EFSA reference line, no
 * attainment colouring (ui-standards.md: value stays foreground, the bar +
 * reference line ARE the context). Registered in
 * `src/components/charts/chart-runtime.ts` — never import recharts
 * directly at the call site.
 */

interface NutrientDailyBarChartProps {
  /** Dense day series, ascending (oldest first). */
  days: ReadonlyArray<{ day: string; amount: number }>;
  unit: string;
  /** Already-localised tooltip row label (e.g. "Water"). */
  valueLabel: string;
  /** Optional dashed reference line value (EFSA target / ceiling). */
  referenceValue?: number | null;
  /**
   * v1.42 — each bar opens its day, through the doors every day-linked
   * chart has (click, the tooltip's button on touch, the dashed line, the
   * row of dots, the data table). A day logged as nothing has no bar to
   * open.
   */
  dayLinks?: boolean;
}

export function NutrientDailyBarChart({
  days,
  unit,
  valueLabel,
  referenceValue,
  dayLinks = false,
}: NutrientDailyBarChartProps) {
  const fmt = useFormatters();
  // The raw day totals: the card's headline prints 82,5 g, so the bar and its
  // tooltip must not say 82 g for the same day. Every number below goes
  // through the cards' one formatter.
  const points = useMemo(
    () => days.map((d) => ({ day: d.day, amount: d.amount })),
    [days],
  );
  const formatAmount = (value: number) => formatNutrientAmount(fmt, value);

  const yDomain = useMemo<[number, number]>(() => {
    const values = points.map((p) => p.amount);
    if (referenceValue != null) values.push(referenceValue);
    const max = values.length > 0 ? Math.max(...values) : 1;
    return [0, max > 0 ? max * 1.15 : 1];
  }, [points, referenceValue]);

  const animate = !prefersReducedMotion();
  const barColor = "var(--info)";

  const chartDays = useChartDayLinks({
    enabled: dayLinks,
    days: points.map((p) => (p.amount > 0 ? p.day : null)),
    focusFor: (index) => {
      const point = points[index];
      return point
        ? { label: valueLabel, value: formatAmount(point.amount), unit }
        : null;
    },
  });
  const logged = points.filter((p) => p.amount > 0);

  return (
    <>
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
              dataKey="day"
              tickFormatter={(day: string) => fmt.dateShortSmartCalendar(day)}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              stroke="var(--border)"
              minTickGap={24}
            />
            <YAxis
              domain={yDomain}
              tickFormatter={(value: number) => formatAmount(value)}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              stroke="var(--border)"
              width={44}
            />
            {referenceValue != null ? (
              <ReferenceLine
                y={referenceValue}
                stroke="var(--muted-foreground)"
                strokeOpacity={0.6}
                strokeDasharray="4 4"
              />
            ) : null}
            {chartDays.openIndex !== undefined ? (
              <ReferenceLine
                x={points[chartDays.openIndex]?.day}
                {...OPEN_DAY_LINE}
              />
            ) : null}
            <Tooltip
              {...chartDays.tooltipProps}
              content={(props) => {
                const active = props.active ?? false;
                const payload = props.payload as
                  | ReadonlyArray<{ payload?: { day: string; amount: number } }>
                  | undefined;
                const point = payload?.[0]?.payload;
                if (!active || !point) {
                  return <RichChartTooltip active={false} rows={[]} />;
                }
                const rows: RichTooltipRow[] = [
                  {
                    name: valueLabel,
                    value: `${formatAmount(point.amount)} ${unit}`,
                    color: barColor,
                  },
                ];
                return (
                  <RichChartTooltip
                    active
                    label={fmt.dateShortSmartCalendar(point.day)}
                    rows={rows}
                    action={chartDays.tooltipAction(points.indexOf(point))}
                  />
                );
              }}
            />
            <Bar
              dataKey="amount"
              fill={barColor}
              radius={[2, 2, 0, 0]}
              isAnimationActive={animate}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartDayFooter
        links={chartDays}
        points={points.map((p) => ({ timestamp: dayAnchor(p.day) }))}
        axis="band"
        // The y axis (44) on the left, the margin (12) on the right.
        insetLeft={44}
        insetRight={12}
      />
      {chartDays.active && logged.length > 0 ? (
        <ChartDataTable
          points={logged.map((p) => ({
            date: p.day,
            timestamp: dayAnchor(p.day),
            amount: p.amount,
          }))}
          columns={[{ key: "amount", label: valueLabel }]}
          unit={unit}
          formatValue={(value) => formatAmount(value)}
          formatDate={(date) => fmt.dateShortSmartCalendar(date)}
          bucket="day"
          metricLabel={valueLabel}
          dayLinks
        />
      ) : null}
    </>
  );
}
