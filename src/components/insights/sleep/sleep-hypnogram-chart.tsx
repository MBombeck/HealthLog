"use client";

import { useMemo } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { RichChartTooltip } from "@/components/charts/chart-tooltip";
import { STAGE_COLORS } from "@/components/insights/sleep-stage-stacked-bar";
import {
  hypnogramTicks,
  type HypnogramLayout,
  type HypnogramStage,
} from "@/lib/sleep/hypnogram-layout";
import {
  buildOverlayRows,
  rawKey,
  soloKey,
  type OverlayLineInput,
  type OverlayRow,
} from "@/lib/sleep/overlay-lines";

/**
 * One night's stage timeline (#1419): each stage segment is a rectangle over
 * its clock range in its stage's lane, Awake at the top and Deep at the base,
 * in the stage palette the stacked bar above it uses. Recharts stays; every
 * segment is a `ReferenceArea`, because one line can carry only one colour.
 *
 * The layout (lanes, spans) and the axis ticks come from
 * `src/lib/sleep/hypnogram-layout.ts`; this component only draws them.
 *
 * Night metrics (pulse, HRV, breathing, …) can be laid over the stages as
 * thin lines, at most two. Each line has its own scale filling the plot, so
 * two metrics of different units share the space without a second axis; the
 * card names each line's range beside its toggle and the tooltip gives the
 * reading at the moment under the pointer, with the stage it fell in. While
 * lines are shown the stage bands step back a little, and each line runs on
 * a halo of the card colour so it stays legible over every stage colour.
 */
export interface HypnogramOverlayLine extends OverlayLineInput {
  label: string;
  color: string;
  /** The reading as the tooltip shows it, unit included. */
  format: (value: number) => string;
}

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
  /** Lines over the stages, on the night's overlay grid. */
  overlay?: {
    gridFromMs: number;
    bucketMs: number;
    lines: HypnogramOverlayLine[];
  };
}

/** The stage in force at `t`; a measured stage wins over the in-bed span. */
function stageAt(layout: HypnogramLayout, t: number): HypnogramStage | null {
  let hit: HypnogramStage | null = null;
  for (const span of layout.spans) {
    if (t < span.x1 || t >= span.x2) continue;
    if (span.stage !== "IN_BED") return span.stage;
    hit = span.stage;
  }
  return hit;
}

/** Lines with up to this many readings draw a dot on each reading. */
const DOTTED_MAX_POINTS = 30;

interface ReadingDotProps {
  cx?: number;
  cy?: number;
  index?: number;
  payload?: OverlayRow;
}

/**
 * A dot on a reading, and nothing on a row the line only passes through: a
 * bridged gap is drawn as a line, never marked as if it had been measured.
 * A sparse line marks every reading (`dotted`); any line marks a reading no
 * line reaches, larger and on a halo, since that point is all of it there is.
 */
function ReadingDot({
  cx,
  cy,
  payload,
  lineKey,
  dotted,
  color,
}: ReadingDotProps & { lineKey: string; dotted: boolean; color: string }) {
  if (
    cx === undefined ||
    cy === undefined ||
    typeof payload?.[rawKey(lineKey)] !== "number"
  ) {
    return <g />;
  }
  if (payload[soloKey(lineKey)] === 1) {
    return (
      <circle
        cx={cx}
        cy={cy}
        r={3}
        fill={color}
        stroke="var(--card)"
        strokeWidth={1.5}
      />
    );
  }
  return dotted ? <circle cx={cx} cy={cy} r={2.25} fill={color} /> : <g />;
}

export function SleepHypnogramChart({
  layout,
  fromMs,
  toMs,
  timeZone,
  stageLabels,
  formatTime,
  ariaLabel,
  overlay,
}: SleepHypnogramChartProps) {
  const ticks = useMemo(
    () => hypnogramTicks(fromMs, toMs, timeZone),
    [fromMs, toMs, timeZone],
  );
  const { lanes, spans } = layout;
  const lines = overlay?.lines ?? [];
  const { rows, domains } = useMemo(
    () =>
      overlay && overlay.lines.length > 0
        ? buildOverlayRows({ ...overlay, fromMs, toMs })
        : { rows: [] as OverlayRow[], domains: {} },
    [overlay, fromMs, toMs],
  );
  const hasLines = lines.length > 0 && rows.length > 0;

  return (
    <div
      role="img"
      aria-label={ariaLabel}
      data-slot="sleep-hypnogram-chart"
      data-overlay-lines={lines.map((l) => l.key).join(" ") || undefined}
      className="touch-pan-y"
    >
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart
          data={hasLines ? rows : []}
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
              fillOpacity={hasLines ? 0.55 : 0.9}
              stroke="none"
              ifOverflow="extendDomain"
            />
          ))}
          {hasLines
            ? lines.map((line) => (
                <YAxis
                  key={`axis-${line.key}`}
                  yAxisId={line.key}
                  type="number"
                  hide
                  domain={domains[line.key] ?? ["auto", "auto"]}
                />
              ))
            : null}
          {hasLines
            ? lines.flatMap((line) => {
                const dotted = line.points.length <= DOTTED_MAX_POINTS;
                return [
                  <Line
                    key={`halo-${line.key}`}
                    yAxisId={line.key}
                    dataKey={line.key}
                    type="linear"
                    stroke="var(--card)"
                    strokeWidth={4}
                    strokeOpacity={0.85}
                    dot={false}
                    activeDot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                    tooltipType="none"
                    legendType="none"
                  />,
                  <Line
                    key={`line-${line.key}`}
                    yAxisId={line.key}
                    dataKey={line.key}
                    type="linear"
                    stroke={line.color}
                    strokeWidth={1.75}
                    dot={(props: ReadingDotProps) => (
                      <ReadingDot
                        key={`dot-${line.key}-${props.index}`}
                        {...props}
                        lineKey={line.key}
                        dotted={dotted}
                        color={line.color}
                      />
                    )}
                    activeDot={{ r: 3, fill: line.color, strokeWidth: 0 }}
                    connectNulls={false}
                    isAnimationActive={false}
                    legendType="none"
                  />,
                ];
              })
            : null}
          {hasLines ? (
            <Tooltip
              filterNull={false}
              cursor={{
                stroke: "var(--muted-foreground)",
                strokeOpacity: 0.4,
                strokeDasharray: "3 3",
              }}
              content={({ active, payload }) => {
                const row = payload?.[0]?.payload as OverlayRow | undefined;
                if (!active || !row) return null;
                const stage = stageAt(layout, row.t);
                return (
                  <RichChartTooltip
                    active
                    label={formatTime(row.t)}
                    rows={[
                      ...(stage
                        ? [
                            {
                              name: stageLabels[stage],
                              value: "",
                              color: STAGE_COLORS[stage] ?? "var(--border)",
                            },
                          ]
                        : []),
                      ...lines.flatMap((line) => {
                        const value = row[rawKey(line.key)];
                        return typeof value === "number"
                          ? [
                              {
                                name: line.label,
                                value: line.format(value),
                                color: line.color,
                              },
                            ]
                          : [];
                      }),
                    ]}
                  />
                );
              }}
            />
          ) : null}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
