"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

import type { DateKey } from "@/lib/day/contract";

import { TooltipDayAction, useCoarsePointer } from "./chart-day";
import { openDay, useOpenDay } from "./day-layer-controller";
import { isOpenableDay } from "./day-url";
import { useTodayKey } from "./use-today-key";

/**
 * The day view's doors on a calendar heatmap (mood, intake), the cell twin of
 * `useChartDayLinks`:
 *
 *   - fine pointer: hovering a cell shows its tooltip, a click opens its day;
 *   - touch: a tap pins the tooltip, and the tooltip's button ("View the
 *     whole day", the same calm 44 px row every chart's tooltip carries)
 *     opens it. Two steps, as on a chart: a cell is a small target. A tap
 *     outside or Escape clears the tooltip;
 *   - the open day's cell carries a dashed outline, the heatmap's form of
 *     the dashed line a chart draws through it (`OPEN_DAY_CELL`);
 *   - the keyboard and screen-reader way to a day is the heatmap's data
 *     table (`ChartDataTable` with `dayLinks`), as for every chart.
 *
 * A cell opens only when its day holds an entry and is not in the future.
 */

/** The dashed outline drawn over the open day's cell. */
export const OPEN_DAY_CELL = {
  fill: "none",
  stroke: "var(--foreground)",
  strokeWidth: 1.5,
  strokeDasharray: "3 2",
} as const;

interface HeatmapTooltip {
  x: number;
  y: number;
  text: string;
  /** A touch tooltip stays after the finger lifts. */
  pinned?: boolean;
  /** The day a pinned tooltip offers to open. */
  day?: DateKey;
}

export interface HeatmapCellInput {
  dateKey: string;
  /** True when the day holds an entry this heatmap shows. */
  hasEntry: boolean;
  /** The cell's text, for the tooltip. */
  describe: () => string;
}

/**
 * Where the heatmap tooltip sits beside the pointer: 10 px to its right,
 * clamped so a tap near the right border keeps at least 200 px of room, and
 * never wider than the room to the right edge less an 8 px gutter. The box
 * shrinks to fit that room and wraps its text, so it cannot run past the
 * edge; the width cap keeps the gutter the clamp meant to leave.
 */
export function tooltipBox(
  x: number,
  viewportWidth: number,
): { left: number; maxWidth: number } {
  const left = Math.max(8, Math.min(x + 10, viewportWidth - 200 - 8));
  return { left, maxWidth: viewportWidth - left - 8 };
}

export function useHeatmapDay(containerRef: RefObject<HTMLElement | null>) {
  const [tooltip, setTooltip] = useState<HeatmapTooltip | null>(null);
  // The pointer type of the last press decides whether the click that
  // follows opens the day (mouse, pen) or only pinned the tooltip (touch).
  const lastPointer = useRef<string>("mouse");
  const today = useTodayKey();
  const openKey = useOpenDay();
  const coarse = useCoarsePointer();

  // A tap outside the heatmap clears a pinned tooltip.
  useEffect(() => {
    if (!tooltip?.pinned) return;
    const handlePointer = (event: PointerEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if (!container.contains(event.target as Node)) setTooltip(null);
    };
    document.addEventListener("pointerdown", handlePointer, true);
    return () =>
      document.removeEventListener("pointerdown", handlePointer, true);
  }, [tooltip?.pinned, containerRef]);

  // Escape dismisses any open tooltip.
  useEffect(() => {
    if (!tooltip) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTooltip(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [tooltip]);

  const canOpen = (cell: HeatmapCellInput): boolean =>
    cell.hasEntry && isOpenableDay(cell.dateKey, today);

  const open = (day: DateKey) => {
    setTooltip(null);
    openDay(day, { trigger: containerRef.current as HTMLElement | null });
  };

  /** Spread on a cell's `<rect>`. */
  const cellProps = (cell: HeatmapCellInput) => {
    const openable = canOpen(cell);
    return {
      "data-day": cell.dateKey,
      "data-open": openable && openKey === cell.dateKey ? "true" : undefined,
      className: openable ? "cursor-pointer" : undefined,
      onPointerEnter: (e: React.PointerEvent) => {
        // A touch enter fires just before `pointerdown`; the pinned
        // tooltip below takes over with its real coordinates.
        if (e.pointerType === "touch") return;
        setTooltip({ x: e.clientX, y: e.clientY, text: cell.describe() });
      },
      onPointerLeave: (e: React.PointerEvent) => {
        if (e.pointerType === "touch") return;
        setTooltip((prev) => (prev?.pinned ? prev : null));
      },
      onPointerDown: (e: React.PointerEvent) => {
        lastPointer.current = e.pointerType;
        if (e.pointerType !== "touch") return;
        setTooltip({
          x: e.clientX,
          y: e.clientY,
          text: cell.describe(),
          pinned: true,
          day: openable ? cell.dateKey : undefined,
        });
      },
      onClick: () => {
        if (lastPointer.current === "touch") return;
        if (!openable) return;
        open(cell.dateKey);
      },
    };
  };

  /** Spread on the heatmap's `<svg>`. */
  const svgProps = {
    onMouseLeave: () => setTooltip((prev) => (prev?.pinned ? prev : null)),
  };

  const tooltipNode = tooltip ? (
    <div
      data-slot="heatmap-tooltip"
      className={`bg-popover text-popover-foreground border-border fixed z-50 max-w-[calc(100vw-1rem)] rounded-md border px-2.5 py-1.5 text-xs shadow-md ${
        tooltip.day ? "pointer-events-auto" : "pointer-events-none"
      }`}
      style={{
        ...(typeof window !== "undefined"
          ? tooltipBox(tooltip.x, window.innerWidth)
          : { left: tooltip.x + 10 }),
        top: tooltip.y - 30,
      }}
    >
      {tooltip.text}
      {tooltip.day ? (
        <TooltipDayAction onOpen={() => open(tooltip.day as DateKey)} />
      ) : null}
    </div>
  ) : null;

  return { cellProps, svgProps, tooltipNode, openKey, coarse };
}
