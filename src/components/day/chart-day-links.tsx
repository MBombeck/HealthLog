"use client";

import { useCallback, useMemo, useRef } from "react";

import type { DateKey } from "@/lib/day/contract";
import { prefersReducedMotion } from "@/lib/charts/reduced-motion";

import {
  ChartDayCaption,
  DayRug,
  useCoarsePointer,
  type ChartDayAxis,
  type ChartDayMark,
} from "./chart-day";
import { openDay, useOpenDay, type DayFocus } from "./day-layer-controller";
import { isOpenableDay } from "./day-url";
import { useTodayKey } from "./use-today-key";

/**
 * The day view's doors on any Recharts chart drawn in days, in one place.
 *
 * `HealthChart` was the first chart to open its days; every other chart with
 * a date axis (the sleep stages, a lab marker, the mood line, a bar per day)
 * takes the same doors through this hook, so a click, a tap, the tooltip's
 * button, the dashed line through the open day and the row of dots under the
 * axis behave the same on every page:
 *
 *   - a click, or a tap, on the plot opens the day of the point under it.
 *     On a fine pointer hovering still shows the tooltip; on a touch screen
 *     the tap opens the day at once, and the day puts the tapped value at
 *     its top. A scroll that grazes the chart is a pan, not a tap, and opens
 *     nothing;
 *   - the open day is marked with `OPEN_DAY_LINE` (a dashed vertical line)
 *     at `openIndex`;
 *   - `ChartDayFooter` draws the row of day dots and the one-line caption.
 *
 * The caller says, per drawn point and in data order, which calendar day the
 * point stands for, or `null` when it stands for none (a week or month
 * average, a synthetic "now" point, a day with nothing on it). A day in the
 * future never opens.
 */

/** The props of the dashed line through the open day, for `<ReferenceLine>`. */
export const OPEN_DAY_LINE = {
  stroke: "var(--muted-foreground)",
  strokeDasharray: "3 3",
  strokeOpacity: 0.7,
  ifOverflow: "discard",
} as const;

/** What a chart's click handler receives from Recharts. */
interface ChartClickState {
  activeTooltipIndex?: unknown;
  activeLabel?: unknown;
}

export interface ChartDayLinksOptions {
  /** Off for a mini chart, a coarse bucket, or a surface on the NOT-here list. */
  enabled: boolean;
  /** Per drawn point, in data order: its calendar day, or null. */
  days: ReadonlyArray<DateKey | null>;
  /** What the day shows at its top when opened from point `index`. */
  focusFor?: (index: number) => Omit<DayFocus, "date"> | null;
  /**
   * For a chart whose plotted series are not the chart's `data` (several
   * `<Line data>` arrays on one time axis): the point index of the click's
   * x value. Defaults to Recharts' `activeTooltipIndex`.
   */
  indexOfClick?: (state: ChartClickState) => number | null;
}

export interface ChartDayLinks {
  active: boolean;
  coarse: boolean;
  /** Index of the open day's point, for the dashed line. */
  openIndex: number | undefined;
  /** The open day itself, for charts that mark it by value. */
  openDay: DateKey | null;
  /** Open the day of point `index` (no-op without a day). */
  open: (index: number) => void;
  /** True when point `index` has a day that opens. */
  canOpen: (index: number) => boolean;
  /** Spread on the element around `<ResponsiveContainer>`. */
  plotProps: {
    ref: React.RefObject<HTMLDivElement | null>;
    "data-day-links"?: "true";
  };
  /** Class for the same element: a pointer cursor on a fine pointer. */
  plotClassName: string;
  /** Pass as the Recharts chart's `onClick`. */
  onChartClick:
    ((state: ChartClickState | null | undefined) => void) | undefined;
  /**
   * Spread on `<Tooltip>`. On touch, and under reduced motion, the tooltip
   * does not glide: Recharts slides it from where it last was for 400 ms,
   * which on a tap drew a box sweeping across the chart while the day was
   * already opening.
   */
  tooltipProps: { isAnimationActive?: boolean };
}

export function useChartDayLinks({
  enabled,
  days,
  focusFor,
  indexOfClick,
}: ChartDayLinksOptions): ChartDayLinks {
  const coarse = useCoarsePointer();
  const openKey = useOpenDay();
  const today = useTodayKey();
  const plotRef = useRef<HTMLDivElement>(null);

  const canOpen = useCallback(
    (index: number) => enabled && isOpenableDay(days[index] ?? null, today),
    [enabled, days, today],
  );

  const open = useCallback(
    (index: number) => {
      if (!canOpen(index)) return;
      const date = days[index] as DateKey;
      const focus = focusFor?.(index) ?? null;
      openDay(date, {
        focus: focus ? { ...focus, date } : null,
        trigger: plotRef.current,
      });
    },
    [canOpen, days, focusFor],
  );

  const openIndex = useMemo(() => {
    if (!enabled || openKey === null) return undefined;
    const at = days.lastIndexOf(openKey);
    return at === -1 ? undefined : at;
  }, [enabled, openKey, days]);

  const onChartClick = enabled
    ? (state: ChartClickState | null | undefined) => {
        if (!state) return;
        const index = indexOfClick
          ? indexOfClick(state)
          : Number(state.activeTooltipIndex);
        if (index === null || !Number.isInteger(index)) return;
        open(index);
      }
    : undefined;

  return {
    active: enabled,
    coarse,
    openIndex,
    openDay: enabled ? openKey : null,
    open,
    canOpen,
    plotProps: {
      ref: plotRef,
      "data-day-links": enabled ? "true" : undefined,
    },
    plotClassName: enabled && !coarse ? "cursor-pointer" : "",
    onChartClick,
    tooltipProps:
      coarse || prefersReducedMotion() ? { isAnimationActive: false } : {},
  };
}

/**
 * The row of day dots and the caption under a day-linked chart. Nothing when
 * the chart is not day-linked or draws no points.
 */
export function ChartDayFooter({
  links,
  points,
  axis = "index",
  insetLeft,
  insetRight,
  mark = "point",
}: {
  links: Pick<ChartDayLinks, "active" | "coarse">;
  /** The drawn points' noon-UTC day anchors (or instants), in data order. */
  points: ReadonlyArray<{ timestamp: number }>;
  axis?: ChartDayAxis;
  insetLeft: number;
  insetRight: number;
  mark?: ChartDayMark;
}) {
  if (!links.active || points.length === 0) return null;
  return (
    <>
      <DayRug
        points={points}
        axis={axis}
        insetLeft={insetLeft}
        insetRight={insetRight}
      />
      <ChartDayCaption coarse={links.coarse} mark={mark} />
    </>
  );
}

/** A day key's noon-UTC anchor, the timestamp a daily point is drawn at. */
export function dayAnchor(day: DateKey): number {
  return Date.parse(`${day}T12:00:00.000Z`);
}
