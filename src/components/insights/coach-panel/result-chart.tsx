"use client";

/**
 * v1.39.4 — the chart of one Coach result table, drawn from the spec the
 * server chose (`src/lib/ai/coach/results/chart-spec.ts`): a line over the
 * periods, bars (vertical, or horizontal for many categories), or a
 * histogram over bins. The component never decides the chart type itself.
 *
 * Recessive axes (no axis line, no tick marks, muted ticks), horizontal grid
 * lines only, the shared rich tooltip, and series colours from
 * `var(--chart-1..5)` in series order. Two series (blood pressure) get
 * legend buttons that hide or show a series (`aria-pressed`); the last
 * visible one cannot be hidden. A period without a reading stays a gap in
 * the line, and each reading is a dot, so a lone reading is still visible.
 *
 * Exported only through `src/components/charts/chart-runtime.ts`; the call
 * site loads it with `next/dynamic` so recharts stays in its one chunk.
 */
import { useMemo, useState, type ReactElement } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { RichChartTooltip } from "@/components/charts/chart-tooltip";
import { chartCategoryRows } from "@/lib/ai/coach/results/chart-spec";
import type {
  CoachChartSpec,
  CoachResultColumn,
  CoachResultTable,
} from "@/lib/ai/coach/types";
import { makeBucketLabelFormatters } from "@/lib/charts/bucket-label";
import { niceAxis } from "@/lib/charts/nice-axis";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";
import { useDateFormatPreference, useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

/** The chart band's height; matches the mini chart skeleton's box. */
export const RESULT_CHART_HEIGHT_PX = 160;
/** Row height of a horizontal bar. */
const HORIZONTAL_BAR_ROW_PX = 26;

const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

const TICK = { fontSize: 11, fill: "var(--muted-foreground)" };
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

export interface CoachResultChartProps {
  result: CoachResultTable;
  /** Label of the folded bar in a category chart. */
  otherLabel: string;
  /** The plot's accessible name; it points at the table for the values. */
  label: string;
}

interface Point {
  x: string;
  [series: string]: string | number | null;
}

function usePeriodLabel(): (key: string) => string {
  const { locale } = useTranslations();
  const dateFormat = useDateFormatPreference();
  return useMemo(() => {
    const fmt = makeBucketLabelFormatters(locale, dateFormat);
    const month = new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    return (key: string) => {
      if (DAY_KEY.test(key)) {
        return fmt.dateShortSmartCalendar(key);
      }
      if (MONTH_KEY.test(key)) {
        return month.format(new Date(`${key}-01T12:00:00Z`));
      }
      return key;
    };
  }, [locale, dateFormat]);
}

function useValueFormat(): (
  value: number,
  column: CoachResultColumn | undefined,
) => string {
  const { locale } = useTranslations();
  const dateFormat = useDateFormatPreference();
  return useMemo(() => {
    const fmt = makeBucketLabelFormatters(locale, dateFormat);
    return (value, column) => {
      const text =
        column?.kind === "count"
          ? fmt.integer(value)
          : fmt.number(value, column?.decimals ?? 1);
      return column?.unit ? `${text} ${column.unit}` : text;
    };
  }, [locale, dateFormat]);
}

export function CoachResultChart({
  result,
  otherLabel,
  label,
}: CoachResultChartProps) {
  const spec = result.chart;
  if (!spec) return null;
  if (spec.kind === "histogram") {
    return <HistogramChart result={result} spec={spec} label={label} />;
  }
  // v1.41 — the contract is in place; no table carries this kind yet, and the
  // table view stays available until the chart lands.
  if (spec.kind === "compare") return null;
  if (spec.kind === "bar" && spec.orientation === "horizontal") {
    return (
      <CategoryBarChart
        result={result}
        spec={spec}
        otherLabel={otherLabel}
        label={label}
      />
    );
  }
  return (
    <SeriesChart
      result={result}
      spec={spec}
      otherLabel={otherLabel}
      label={label}
    />
  );
}

/**
 * The plot band: one `role="img"` with the summary as its name. The legend
 * buttons stay outside it, and recharts' own keyboard layer is off, so the
 * image holds nothing focusable.
 */
function PlotBand({
  height,
  label,
  children,
}: {
  height: number;
  label: string;
  children: ReactElement;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      style={{ height }}
      className="w-full"
      data-slot="coach-result-chart-plot"
    >
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

// ── Line and vertical bars ─────────────────────────────────────────────────

function SeriesChart({
  result,
  spec,
  otherLabel,
  label,
}: {
  result: CoachResultTable;
  spec: Extract<CoachChartSpec, { kind: "line" | "bar" }>;
  otherLabel: string;
  label: string;
}) {
  const periodLabel = usePeriodLabel();
  const valueFormat = useValueFormat();
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const animate = !prefersReducedMotion();
  const byKey = useMemo(
    () => new Map(result.columns.map((column) => [column.key, column])),
    [result.columns],
  );
  const xColumn = byKey.get(spec.x);
  const isPeriod = xColumn?.kind === "period";

  const points = useMemo<Point[]>(() => {
    if (spec.kind === "bar" && !isPeriod) {
      return chartCategoryRows(result, spec, otherLabel).map((row) => ({
        x: row.label,
        [spec.series[0]]: row.value,
      }));
    }
    const xIndex = result.columns.findIndex((c) => c.key === spec.x);
    const indexes = spec.series.map((key) =>
      result.columns.findIndex((c) => c.key === key),
    );
    return result.rows.map((row) => {
      const point: Point = { x: String(row[xIndex] ?? "") };
      spec.series.forEach((key, i) => {
        const cell = row[indexes[i]];
        point[key] = typeof cell === "number" ? cell : null;
      });
      return point;
    });
  }, [result, spec, isPeriod, otherLabel]);

  const tickLabel = (x: string) => (isPeriod ? periodLabel(x) : x);
  const colorOf = (key: string) =>
    SERIES_COLORS[spec.series.indexOf(key) % SERIES_COLORS.length];
  const visible = spec.series.filter((key) => !hidden.has(key));
  // Evenly stepped ticks over what is shown; bars start at the baseline.
  const yAxis = niceAxis(
    points.flatMap((point) =>
      visible.map((key) => point[key] as number | null),
    ),
    { zero: spec.kind === "bar" },
  );

  const tooltip = (props: {
    active?: boolean;
    payload?: ReadonlyArray<{ payload?: Point }>;
  }) => {
    const point = props.payload?.[0]?.payload;
    if (!props.active || !point) {
      return <RichChartTooltip active={false} rows={[]} />;
    }
    const rows = visible.flatMap((key) => {
      const value = point[key];
      if (typeof value !== "number") return [];
      const column = byKey.get(key);
      return [
        {
          name: column?.label ?? key,
          value: valueFormat(value, column),
          color: colorOf(key),
        },
      ];
    });
    return <RichChartTooltip active label={tickLabel(point.x)} rows={rows} />;
  };

  const axes = (
    <>
      <CartesianGrid
        strokeDasharray="3 3"
        stroke="var(--border)"
        vertical={false}
      />
      <XAxis
        dataKey="x"
        tickFormatter={tickLabel}
        tick={TICK}
        axisLine={false}
        tickLine={false}
        minTickGap={24}
      />
      <YAxis
        tick={TICK}
        axisLine={false}
        tickLine={false}
        width={40}
        {...(yAxis
          ? { domain: yAxis.domain, ticks: yAxis.ticks, interval: 0 }
          : {
              domain: spec.kind === "bar" ? [0, "auto"] : ["auto", "auto"],
            })}
      />
      <Tooltip content={tooltip} cursor={{ fill: "var(--muted)" }} />
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      {spec.series.length > 1 ? (
        <SeriesLegend
          series={spec.series.map((key) => ({
            key,
            label: byKey.get(key)?.label ?? key,
          }))}
          hidden={hidden}
          onToggle={(key) =>
            setHidden((current) => {
              const next = new Set(current);
              if (next.has(key)) next.delete(key);
              else if (spec.series.length - next.size > 1) next.add(key);
              return next;
            })
          }
        />
      ) : null}
      <PlotBand height={RESULT_CHART_HEIGHT_PX} label={label}>
        {spec.kind === "line" ? (
          <LineChart
            accessibilityLayer={false}
            data={points}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            {axes}
            {visible.map((key) => (
              <Line
                key={key}
                type="monotone"
                dataKey={key}
                name={byKey.get(key)?.label ?? key}
                stroke={colorOf(key)}
                strokeWidth={2}
                dot={{ r: 2.5, strokeWidth: 0, fill: colorOf(key) }}
                activeDot={{ r: 4 }}
                connectNulls={false}
                isAnimationActive={animate}
              />
            ))}
          </LineChart>
        ) : (
          <BarChart
            accessibilityLayer={false}
            data={points}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
          >
            {axes}
            {visible.map((key) => (
              <Bar
                key={key}
                dataKey={key}
                name={byKey.get(key)?.label ?? key}
                fill={colorOf(key)}
                radius={[2, 2, 0, 0]}
                isAnimationActive={animate}
              />
            ))}
          </BarChart>
        )}
      </PlotBand>
    </div>
  );
}

function SeriesLegend({
  series,
  hidden,
  onToggle,
}: {
  series: Array<{ key: string; label: string }>;
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  return (
    <div
      data-slot="coach-result-chart-legend"
      className="flex flex-wrap items-center gap-1.5"
    >
      {series.map(({ key, label }, index) => {
        const shown = !hidden.has(key);
        return (
          <button
            key={key}
            type="button"
            aria-pressed={shown}
            onClick={() => onToggle(key)}
            className={cn(
              "focus-visible:ring-ring/50 inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors outline-none focus-visible:ring-2 motion-reduce:transition-none sm:min-h-8",
              shown
                ? "border-border text-foreground"
                : "border-border/60 text-muted-foreground",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "inline-block size-2 rounded-full",
                !shown && "opacity-40",
              )}
              style={{
                backgroundColor: SERIES_COLORS[index % SERIES_COLORS.length],
              }}
            />
            {label}
          </button>
        );
      })}
    </div>
  );
}

// ── Horizontal category bars ───────────────────────────────────────────────

function CategoryBarChart({
  result,
  spec,
  otherLabel,
  label,
}: {
  result: CoachResultTable;
  spec: Extract<CoachChartSpec, { kind: "bar" }>;
  otherLabel: string;
  label: string;
}) {
  const valueFormat = useValueFormat();
  const animate = !prefersReducedMotion();
  const column = result.columns.find((c) => c.key === spec.series[0]);
  const rows = useMemo(
    () => chartCategoryRows(result, spec, otherLabel),
    [result, spec, otherLabel],
  );
  const height = Math.max(
    RESULT_CHART_HEIGHT_PX,
    rows.length * HORIZONTAL_BAR_ROW_PX + 16,
  );
  return (
    <PlotBand height={height} label={label}>
      <BarChart
        accessibilityLayer={false}
        data={rows}
        layout="vertical"
        margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--border)"
          horizontal={false}
        />
        <XAxis
          type="number"
          tick={TICK}
          axisLine={false}
          tickLine={false}
          allowDecimals={false}
        />
        <YAxis
          type="category"
          dataKey="label"
          tick={TICK}
          axisLine={false}
          tickLine={false}
          width={96}
        />
        <Tooltip
          cursor={{ fill: "var(--muted)" }}
          content={(props) => {
            const payload = props.payload as
              | ReadonlyArray<{ payload?: { label: string; value: number } }>
              | undefined;
            const row = payload?.[0]?.payload;
            if (!props.active || !row) {
              return <RichChartTooltip active={false} rows={[]} />;
            }
            return (
              <RichChartTooltip
                active
                label={row.label}
                rows={[
                  {
                    name: column?.label ?? spec.series[0],
                    value: valueFormat(row.value, column),
                    color: SERIES_COLORS[0],
                  },
                ]}
              />
            );
          }}
        />
        <Bar
          dataKey="value"
          fill={SERIES_COLORS[0]}
          radius={[0, 2, 2, 0]}
          isAnimationActive={animate}
        />
      </BarChart>
    </PlotBand>
  );
}

// ── Histogram ──────────────────────────────────────────────────────────────

function HistogramChart({
  result,
  spec,
  label,
}: {
  result: CoachResultTable;
  spec: Extract<CoachChartSpec, { kind: "histogram" }>;
  label: string;
}) {
  const valueFormat = useValueFormat();
  const animate = !prefersReducedMotion();
  const countColumn = result.columns.find((c) => c.kind === "count");
  const data = useMemo(
    () =>
      spec.bins.map((bin, index) => {
        const label = result.rows[index]?.[0];
        return {
          x:
            typeof label === "string"
              ? label
              : `${bin.from}–${bin.to}${spec.unit ? ` ${spec.unit}` : ""}`,
          from: bin.from,
          count: bin.count,
        };
      }),
    [spec, result.rows],
  );
  return (
    <PlotBand height={RESULT_CHART_HEIGHT_PX} label={label}>
      <BarChart
        accessibilityLayer={false}
        data={data}
        barCategoryGap={1}
        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
      >
        <CartesianGrid
          strokeDasharray="3 3"
          stroke="var(--border)"
          vertical={false}
        />
        <XAxis
          dataKey="from"
          tick={TICK}
          axisLine={false}
          tickLine={false}
          minTickGap={16}
        />
        <YAxis
          tick={TICK}
          axisLine={false}
          tickLine={false}
          width={32}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: "var(--muted)" }}
          content={(props) => {
            const payload = props.payload as
              | ReadonlyArray<{ payload?: { x: string; count: number } }>
              | undefined;
            const bin = payload?.[0]?.payload;
            if (!props.active || !bin) {
              return <RichChartTooltip active={false} rows={[]} />;
            }
            return (
              <RichChartTooltip
                active
                label={bin.x}
                rows={[
                  {
                    name: countColumn?.label ?? "",
                    value: valueFormat(bin.count, countColumn),
                    color: SERIES_COLORS[0],
                  },
                ]}
              />
            );
          }}
        />
        <Bar
          dataKey="count"
          fill={SERIES_COLORS[0]}
          radius={[2, 2, 0, 0]}
          isAnimationActive={animate}
        />
      </BarChart>
    </PlotBand>
  );
}
