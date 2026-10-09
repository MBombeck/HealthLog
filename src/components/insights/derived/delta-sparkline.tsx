"use client";

import { useId } from "react";
import { Area, AreaChart, ResponsiveContainer, YAxis } from "recharts";

/**
 * The recharts body of the `<SparklineDeltaTile>` inline sparkline,
 * extracted so the tile itself carries no static recharts import. The tile
 * loads this through the shared chart-runtime boundary
 * (`@/components/charts/chart-runtime`); its fixed 40 px container is owned
 * by the tile, so the async gap paints an empty band of identical size —
 * zero layout shift, pixel-identical once mounted.
 *
 * Two modes, one chart.
 *
 *  - **Trend** (the original): one series, area-filled under a sentiment
 *    stroke. Every baseline tile in the vitals grid uses this.
 *  - **Comparison** (v1.34.0): the same series against a second one, drawn
 *    index-aligned behind it as a dashed muted line with no fill. The
 *    same-time baseline needs two trajectories on one pair of axes — today's
 *    running total and the person's typical one — and nothing in the tree
 *    drew that. It is a second mode here rather than a new chart family
 *    because it is the same picture with one more line: same container, same
 *    fixed height, same shared y-domain, so the two curves are read against
 *    each other and not against two different scales.
 *
 * The comparison line renders as an `<Area>` with no fill rather than a
 * `<Line>` so the chart stays a plain `AreaChart` and both series contribute
 * to the `dataMin`/`dataMax` domain automatically.
 */
export function DeltaSparkline({
  data,
  strokeVar,
  comparisonLabel,
  domain,
}: {
  /**
   * A fixed y-domain. Omitted, the line spans its own min..max, which suits a
   * vital read against itself; a bounded score passes its scale (`[0, 100]`)
   * so a night-to-night wobble of a few points is not drawn as a cliff.
   */
  domain?: [number, number];
  /**
   * `{ i, v }` points, already length-guarded (≥2) by the tile. An optional
   * `b` on a point is the comparison series' value at the same index —
   * present on every point or on none.
   */
  data: Array<{ i: number; v: number; b?: number }>;
  /** CSS var expression for the sentiment stroke, e.g. `var(--success)`. */
  strokeVar: string;
  /**
   * Accessible name for the comparison curve, when one is present. Passed
   * through to the series so a screen reader reaching the chart is told what
   * the second line is rather than meeting an unnamed shape.
   */
  comparisonLabel?: string;
}) {
  // A stable per-instance id for the gradient <defs>. Deriving it from a
  // label slug collides when two tiles share a localized label (the gradient
  // fill on the second tile would not resolve); useId() is collision-free.
  const fillId = useId();
  const hasComparison = data.some((point) => point.b !== undefined);
  return (
    <ResponsiveContainer width="100%" height="100%">
      {/* A sparkline is decoration inside an aria-hidden wrapper: without
          the accessibility layer Recharts puts a focusable surface in it,
          and a focus stop nobody can perceive is an axe failure. */}
      <AreaChart
        data={data}
        margin={{ top: 2, right: 0, bottom: 2, left: 0 }}
        accessibilityLayer={false}
      >
        <defs>
          <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeVar} stopOpacity={0.28} />
            <stop offset="100%" stopColor={strokeVar} stopOpacity={0} />
          </linearGradient>
        </defs>
        <YAxis hide domain={domain ?? ["dataMin", "dataMax"]} />
        {/* The comparison curve sits UNDER the live one so today's line is
            never occluded by the reference it is being judged against. */}
        {hasComparison ? (
          <Area
            type="monotone"
            dataKey="b"
            name={comparisonLabel}
            stroke="var(--muted-foreground)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            fill="none"
            isAnimationActive={false}
            dot={false}
          />
        ) : null}
        <Area
          type="monotone"
          dataKey="v"
          stroke={strokeVar}
          strokeWidth={1.5}
          fill={`url(#${fillId})`}
          isAnimationActive={false}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
