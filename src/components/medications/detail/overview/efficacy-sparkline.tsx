"use client";

/**
 * The effect card's small chart: the target's daily values, a line at the
 * start, and the before and after means as dashed lines on their own side.
 * Plain SVG, no chart library: the overview stays out of the Recharts chunk,
 * and a sparkline has no axes to speak of. The values come from the server's
 * effect DTO as they are; nothing is recomputed.
 */

import { useId } from "react";

const W = 300;
const H = 64;
const PAD = 4;

export interface SparkPoint {
  t: string;
  value: number;
}

export function EfficacySparkline({
  series,
  startAt,
  beforeMean,
  afterMean,
  label,
}: {
  series: SparkPoint[];
  startAt: string | null;
  beforeMean: number | null;
  afterMean: number | null;
  /** What the chart shows, for a screen reader. */
  label: string;
}) {
  const id = useId();
  if (series.length < 2) return null;
  const times = series.map((p) => Date.parse(p.t));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times);
  const values = series.map((p) => p.value);
  for (const mean of [beforeMean, afterMean]) {
    if (mean !== null) values.push(mean);
  }
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const x = (ms: number) =>
    t1 === t0 ? W / 2 : PAD + ((ms - t0) / (t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - 2 * PAD);
  const path = series
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(times[i])},${y(p.value)}`)
    .join(" ");
  const startMs = startAt ? Date.parse(startAt) : null;
  const sx =
    startMs !== null && startMs >= t0 && startMs <= t1 ? x(startMs) : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-16 w-full overflow-visible"
      role="img"
      aria-labelledby={id}
      data-slot="medication-effect-sparkline"
    >
      <title id={id}>{label}</title>
      {sx !== null && (
        <line
          x1={sx}
          x2={sx}
          y1={0}
          y2={H}
          stroke="var(--muted-foreground)"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {beforeMean !== null && sx !== null && (
        <line
          x1={PAD}
          x2={sx}
          y1={y(beforeMean)}
          y2={y(beforeMean)}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {afterMean !== null && sx !== null && (
        <line
          x1={sx}
          x2={W - PAD}
          y1={y(afterMean)}
          y2={y(afterMean)}
          stroke="var(--muted-foreground)"
          strokeDasharray="3 3"
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      )}
      <path
        d={path}
        fill="none"
        stroke="var(--chart-1)"
        strokeWidth={1.75}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
