"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  ReferenceArea,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";

import { STAGE_COLORS } from "@/components/insights/sleep-stage-stacked-bar";
import {
  hypnogramTicks,
  type HypnogramLayout,
  type HypnogramStage,
} from "@/lib/sleep/hypnogram-layout";

/**
 * One night's stage timeline (#1419): each stage segment is a rectangle over
 * its clock range in its stage's lane, Awake at the top and Deep at the base,
 * in the stage palette the stacked bar above it uses. Recharts stays; every
 * segment is a `ReferenceArea`, because one line can carry only one colour.
 *
 * The layout (lanes, spans) and the axis ticks come from
 * `src/lib/sleep/hypnogram-layout.ts`; this component only draws them.
 */
export interface SleepHypnogramChartProps {
  layout: HypnogramLayout;
  /** Epoch ms of the night's first and last instant. */
  fromMs: number;
  toMs: number;
  /** The zone the axis reads in. */
  timeZone: string;
  stageLabels: Record<HypnogramStage, string>;
  formatTime: (ms: number) => string;
  ariaLabel: string;
}

export function SleepHypnogramChart({
  layout,
  fromMs,
  toMs,
  timeZone,
  stageLabels,
  formatTime,
  ariaLabel,
}: SleepHypnogramChartProps) {
  const ticks = useMemo(
    () => hypnogramTicks(fromMs, toMs, timeZone),
    [fromMs, toMs, timeZone],
  );
  const { lanes, spans } = layout;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      data-slot="sleep-hypnogram-chart"
      className="touch-pan-y"
    >
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart
          data={[]}
          margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
        >
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border)"
            opacity={0.3}
            vertical={false}
          />
          <XAxis
            type="number"
            dataKey="t"
            domain={[fromMs, toMs]}
            scale="time"
            ticks={ticks}
            stroke="var(--muted-foreground)"
            fontSize={10}
            tickFormatter={(v: number) => formatTime(v)}
          />
          <YAxis
            type="number"
            dataKey="lane"
            domain={[-0.5, lanes.length - 0.5]}
            ticks={lanes.map((_, i) => lanes.length - 1 - i)}
            stroke="var(--muted-foreground)"
            fontSize={10}
            width={56}
            tickFormatter={(v: number) => {
              const stage = lanes[lanes.length - 1 - v];
              return stage ? stageLabels[stage] : "";
            }}
          />
          {spans.map((span, i) => (
            <ReferenceArea
              key={`${span.stage}-${i}`}
              x1={span.x1}
              x2={span.x2}
              y1={span.lane - 0.4}
              y2={span.lane + 0.4}
              fill={STAGE_COLORS[span.stage]}
              fillOpacity={0.9}
              stroke="none"
              ifOverflow="extendDomain"
            />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
