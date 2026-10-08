"use client";

/**
 * v1.25.3 — per-instrument screener trend chart.
 *
 * v1.25.5 — aligned to the dashboard's chart language exactly: a single
 * `type="monotone"` line over the primary colour with a soft gradient area
 * fill beneath (same `fillOpacity` + margins the dashboard line charts use),
 * the shared grid / axis tokens, and `RichChartTooltip`. The earlier
 * severity-band `ReferenceArea`s — unique to this surface — are gone so it
 * reads like every other trend; the band still surfaces in the tooltip.
 *
 * v1.27.9 — back on the surface, but only inside the per-instrument detail
 * (opened from a card): the landing stays free of any score curve, so the
 * trend is opt-in behind a deliberate click. The Y domain and band wording
 * come from the instrument registry, so the WHO-5 (0–100, higher = better)
 * and the SCI (0–32, higher = better) render through the same component.
 *
 * One instrument at a time: the ranges and band sets differ, so the parent
 * pins which series this paints.
 */
import { useMemo } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { RichChartTooltip, type RichTooltipRow } from "../charts/chart-tooltip";
import { CHART_HEIGHT_PX } from "@/lib/charts/constants";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import {
  useDisplayTimezone,
  useTranslations,
  useFormatters,
} from "@/lib/i18n/context";
import {
  ChartDayFooter,
  OPEN_DAY_LINE,
  useChartDayLinks,
} from "../day/chart-day-links";
import { dateKeyOfInstant } from "../day/day-url";
import { INSTRUMENTS } from "@/lib/mental-health/instruments";

import type { AssessmentRow, InstrumentId } from "./types";

interface ChartPoint {
  timestamp: number;
  value: number;
  band: string;
}

export function AssessmentHistoryChart({
  instrument,
  rows,
}: {
  instrument: InstrumentId;
  /** Rows for THIS instrument, any order (sorted internally, ascending time). */
  rows: AssessmentRow[];
}) {
  const { t } = useTranslations();
  const fmt = useFormatters();
  const def = INSTRUMENTS[instrument];

  const points = useMemo<ChartPoint[]>(() => {
    return [...rows]
      .sort(
        (a, b) => new Date(a.takenAt).getTime() - new Date(b.takenAt).getTime(),
      )
      .map((r) => ({
        timestamp: new Date(r.takenAt).getTime(),
        value: r.totalScore,
        band: r.severityBand,
      }));
  }, [rows]);

  // v1.42 — each result opens the day it was taken on, through the doors
  // every day-linked chart has. The dated list under the chart is the
  // keyboard way to the same days.
  const timeZone = useDisplayTimezone();
  const chartDays = useChartDayLinks({
    enabled: true,
    days: points.map((point) => dateKeyOfInstant(point.timestamp, timeZone)),
    focusFor: (index) => {
      const point = points[index];
      return point
        ? {
            label: t(`mentalHealth.instrument.${def.i18nKey}`),
            value: String(point.value),
          }
        : null;
    },
  });
  const openPoint =
    chartDays.openIndex !== undefined ? points[chartDays.openIndex] : undefined;

  const animate = !prefersReducedMotion();
  const primary = "var(--primary)";
  const gradientId = `mh-trend-${instrument}`;

  if (points.length === 0) {
    return (
      <p className="text-muted-foreground py-10 text-center text-sm">
        {t("mentalHealth.history.empty")}
      </p>
    );
  }

  return (
    <div>
      <div
        data-slot="chart-plot"
        {...chartDays.plotProps}
        className={chartDays.plotClassName}
      >
        <ResponsiveContainer width="100%" height={CHART_HEIGHT_PX}>
          <ComposedChart
            data={points}
            margin={{ top: 10, right: 8, bottom: 8, left: 8 }}
            onClick={chartDays.onChartClick}
          >
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={primary} stopOpacity={0.18} />
                <stop offset="95%" stopColor={primary} stopOpacity={0} />
              </linearGradient>
            </defs>
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
              tickFormatter={(ts: number) => fmt.dateShortSmart(new Date(ts))}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              stroke="var(--border)"
              minTickGap={32}
            />
            <YAxis
              domain={[0, def.maxScore]}
              allowDecimals={false}
              tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
              stroke="var(--border)"
              width={32}
            />
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
                const rowsOut: RichTooltipRow[] = [
                  {
                    name: t("mentalHealth.history.totalLabel"),
                    value: String(point.value),
                    color: primary,
                  },
                  {
                    name: t("mentalHealth.history.bandLabel"),
                    value: t(`mentalHealth.band.${instrument}.${point.band}`),
                    color: "var(--muted-foreground)",
                  },
                ];
                return (
                  <RichChartTooltip
                    active
                    label={fmt.dateShortSmart(new Date(point.timestamp))}
                    rows={rowsOut}
                    action={chartDays.tooltipAction(points.indexOf(point))}
                  />
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke="none"
              fill={`url(#${gradientId})`}
              isAnimationActive={animate}
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
        // The margin (8) + the y axis (32) on the left, the margin on the right.
        insetLeft={8 + 32}
        insetRight={8}
      />
    </div>
  );
}
