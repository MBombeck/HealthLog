"use client";

import type { ReactNode } from "react";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

/**
 * Self-contained correlation scatter chart used by /insights.
 *
 * The insights page renders four near-identical scatter cards (weight vs BP,
 * BP vs medication continuity, mood vs BP, mood vs weight) inside `length >= 5`
 * gates below the fold. Recharts is ~108 KiB Brotli, so we want the bundle
 * split — but the previous attempt (v1.5 phase 4) split at the *primitive*
 * level (each `XAxis`/`YAxis`/`Scatter`/etc. wrapped in `next/dynamic`). That
 * breaks Recharts because the chart relies on `findAllByType(child)` against
 * the original component identity to discover its own children — once each
 * primitive is wrapped in a `next/dynamic` HOC the identity check fails and
 * the chart renders empty axes / no data points.
 *
 * The correct seam is one level higher: a single self-contained component
 * that statically imports every Recharts symbol it needs internally. The
 * insights page then dynamic-imports *this wrapper* (matching the existing
 * HealthChart / MoodChart pattern) so Recharts still ships in the deferred
 * chunk while child-type detection keeps working.
 */

export interface ScatterAxisConfig {
  /** Object key in `data` that supplies the value. */
  dataKey: string;
  /** Tooltip / a11y name for the axis. */
  name: string;
  /** Optional unit suffix shown by Recharts in tooltip / axis. */
  unit?: string;
  /** Optional axis label rendered below (X) the plot area. */
  label?: string;
  /** Optional fixed numeric domain (e.g. mood 1..5). */
  domain?: [number, number];
  /** Optional explicit tick values. */
  ticks?: number[];
  /** Optional formatter for tick labels. */
  tickFormatter?: (value: number) => string;
}

export interface ScatterCorrelationChartProps<
  T extends Record<string, number>,
> {
  /** Data array. May be undefined while a parent query is loading; the
   * insights cards already gate rendering behind a `length >= 5` check. */
  data: T[] | undefined;
  /** Marker fill colour, e.g. "var(--dracula-cyan)". */
  fill: string;
  xAxis: ScatterAxisConfig;
  yAxis: ScatterAxisConfig;
  /**
   * Optional tooltip value formatter. Mirrors Recharts' `Formatter<ValueType,
   * NameType>` signature; values may be string/number/ReadonlyArray and
   * either side may be undefined while the tooltip is hydrating. Recharts
   * also passes (item, index, payload) — we keep the rest-args open so
   * existing inline formatters (which only read value+name) work as-is.
   */
  tooltipFormatter?: (
    value: number | string | ReadonlyArray<number | string> | undefined,
    name: number | string | undefined,
    ...rest: unknown[]
  ) => [ReactNode, number | string] | ReactNode;
  /** Plot height in pixels. Defaults to 250 to match existing layout. */
  height?: number;
}

export function ScatterCorrelationChart<T extends Record<string, number>>({
  data,
  fill,
  xAxis,
  yAxis,
  tooltipFormatter,
  height = 250,
}: ScatterCorrelationChartProps<T>) {
  // v1.4.27 MB7 / CF-37 — drop the fixed pixel height in favour of a
  // responsive aspect-ratio on mobile so the chart never compresses
  // below readable axes. The `aspect-square` ratio at `<sm` keeps the
  // plot area as a centred square (matches Apple Health correlation
  // viz); from `sm:` upwards the chart falls back to the legacy
  // pixel-height contract via a 3:2 aspect-ratio fallback that
  // approximates the previous 250 px shape.
  return (
    <div
      className="touch-pan-y aspect-square sm:aspect-[3/2] sm:h-auto"
      style={{ height: undefined }}
      data-explicit-height={height}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 10, right: 20, bottom: 36, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis
            dataKey={xAxis.dataKey}
            type="number"
            name={xAxis.name}
            unit={xAxis.unit}
            tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
            tickMargin={8}
            height={52}
            interval="preserveStartEnd"
            padding={{ left: 8, right: 8 }}
            stroke="var(--dracula-comment)"
            domain={xAxis.domain}
            ticks={xAxis.ticks}
            tickFormatter={xAxis.tickFormatter}
            label={
              xAxis.label
                ? {
                    value: xAxis.label,
                    position: "bottom",
                    fontSize: 12,
                    fill: "var(--dracula-comment)",
                  }
                : undefined
            }
          />
          <YAxis
            dataKey={yAxis.dataKey}
            type="number"
            name={yAxis.name}
            unit={yAxis.unit}
            tick={{ fontSize: 12, fill: "var(--dracula-fg)" }}
            stroke="var(--dracula-comment)"
            domain={yAxis.domain}
            ticks={yAxis.ticks}
            tickFormatter={yAxis.tickFormatter}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              fontSize: "0.75rem",
            }}
            itemStyle={{ color: "var(--dracula-fg)" }}
            labelStyle={{ color: "var(--dracula-fg)" }}
            formatter={tooltipFormatter}
          />
          <Scatter data={data} fill={fill} opacity={0.8} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}
