"use client";

import { useSyncExternalStore } from "react";
import { ArrowRight } from "lucide-react";

import type { DateKey } from "@/lib/day/contract";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { openDay, useOpenDay, type DayFocus } from "./day-layer-controller";
import { isOpenableDay } from "./day-url";
import { useDayIndex } from "./use-day";
import { useTodayKey } from "./use-today-key";

/**
 * The day view's entry points on a value chart.
 *
 *   - On a fine pointer, a click on the plot opens the day of the point under
 *     the cursor; hovering keeps showing the tooltip as before.
 *   - On a touch screen a tap shows the value, as it always did, and the
 *     tooltip carries "View the whole day". Two steps on purpose: one tap
 *     that opened a sheet would fire on every scroll that grazed the chart.
 *   - Under the axis, a quiet row of dots marks the days that hold anything,
 *     a ring the days with a notable observation. Decoration for the eye; the
 *     keyboard and screen-reader way to a day is the chart's data table.
 *
 * Only a chart drawn in days takes part: a week or month point is an average
 * of many days and has no single day to open.
 */

const COARSE_QUERY = "(pointer: coarse)";

function subscribeCoarse(callback: () => void): () => void {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const mql = window.matchMedia(COARSE_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

/** True on a touch-first device, where a tap must not open a sheet. */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(
    subscribeCoarse,
    () =>
      typeof window !== "undefined" && !!window.matchMedia
        ? window.matchMedia(COARSE_QUERY).matches
        : false,
    () => false,
  );
}

/**
 * The calendar day of a daily chart point. Daily points sit at noon UTC of
 * their day key, so the UTC date is the day the chart bucketed them into,
 * whatever zone the reader is in.
 */
export function chartPointDayKey(timestamp: number): DateKey {
  return dateOnlyKey(new Date(timestamp));
}

/** Open the day of a chart point, carrying the value as the day's focus. */
export function openChartDay(
  timestamp: number,
  focus: Omit<DayFocus, "date"> | null,
  trigger?: HTMLElement | null,
): void {
  const date = chartPointDayKey(timestamp);
  openDay(date, {
    focus: focus ? { ...focus, date } : null,
    trigger: trigger ?? null,
  });
}

/** The tooltip's way to the day on a touch screen. */
export function TooltipDayAction({ onOpen }: { onOpen: () => void }) {
  const { t } = useTranslations();
  return (
    <button
      type="button"
      data-slot="chart-tooltip-open-day"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="bg-muted hover:bg-muted/80 focus-visible:ring-ring/50 mt-2.5 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors focus-visible:ring-[3px] focus-visible:outline-none"
    >
      {t("day.viewWholeDay")}
      <ArrowRight className="size-4" aria-hidden="true" />
    </button>
  );
}

interface RugPoint {
  timestamp: number;
}

/**
 * Where a day sits along a chart whose x axis is the point index: the
 * fractional index between the two points around it. Null outside the drawn
 * span (and so for a day the chart has no neighbours for).
 */
export function rugPosition(
  day: DateKey,
  points: readonly RugPoint[],
): number | null {
  if (points.length === 0) return null;
  const t = Date.parse(`${day}T12:00:00.000Z`);
  const first = points[0]!.timestamp;
  const last = points[points.length - 1]!.timestamp;
  if (t < first || t > last) return null;
  if (points.length === 1) return 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i]!.timestamp;
    const b = points[i + 1]!.timestamp;
    if (t >= a && t <= b) return b === a ? i : i + (t - a) / (b - a);
  }
  return points.length - 1;
}

/**
 * How a chart spreads its points along the x axis, which decides where a
 * day's dot sits under it:
 *
 *   - `index`: the axis is the point index, the first point at the left edge
 *     of the plot and the last at the right (`HealthChart`, the mood line, a
 *     category line chart);
 *   - `band`: one band per point, the point at the band's centre (a bar
 *     chart);
 *   - `time`: the axis is the timestamp itself, from the first point to the
 *     last (a lab chart, any `scale="time"` axis).
 */
export type ChartDayAxis = "index" | "band" | "time";

/**
 * Where along the plot (0 at the left edge, 1 at the right) a day's dot
 * belongs, or null outside the drawn span.
 */
export function rugFraction(
  day: DateKey,
  points: readonly RugPoint[],
  axis: ChartDayAxis,
): number | null {
  const at = rugPosition(day, points);
  if (at === null) return null;
  const n = points.length;
  if (axis === "band") return (at + 0.5) / n;
  if (n === 1) return 0.5;
  if (axis === "time") {
    const first = points[0]!.timestamp;
    const last = points[n - 1]!.timestamp;
    const t = Date.parse(`${day}T12:00:00.000Z`);
    return last === first ? 0.5 : (t - first) / (last - first);
  }
  return at / (n - 1);
}

/**
 * The row of day dots under a daily chart. `insetLeft` / `insetRight` are the
 * pixels between the chart box and the first and last point (margin, axis,
 * padding), so a dot lands under its day.
 *
 * The row is always drawn at its full height, dots or not: the index that
 * fills it arrives after the chart, and a row that appeared then would push
 * everything under the chart down by its height.
 */
export function DayRug({
  points,
  insetLeft,
  insetRight,
  axis = "index",
}: {
  points: readonly RugPoint[];
  insetLeft: number;
  insetRight: number;
  axis?: ChartDayAxis;
}) {
  const today = useTodayKey();
  const open = useOpenDay();
  const first = points[0];
  const last = points[points.length - 1];
  const from = first ? chartPointDayKey(first.timestamp) : null;
  const to = last ? chartPointDayKey(last.timestamp) : null;
  const index = useDayIndex(from, to);
  const data = index.data;
  const notable = new Set(data?.notable ?? []);
  const days = Object.keys(data?.days ?? {})
    .filter((day) => isOpenableDay(day, today))
    .map((day) => ({ day, at: rugFraction(day, points, axis) }))
    .filter((entry): entry is { day: string; at: number } => entry.at !== null);
  return (
    <div
      aria-hidden="true"
      data-slot="day-rug"
      data-axis={axis}
      className="pointer-events-none relative h-3"
      style={{ marginLeft: insetLeft, marginRight: insetRight }}
    >
      {days.map(({ day, at }) => {
        const isOpen = day === open;
        const isNotable = notable.has(day);
        return (
          <span
            key={day}
            data-day={day}
            data-notable={isNotable ? "true" : undefined}
            data-open={isOpen ? "true" : undefined}
            className={cn(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
              isOpen
                ? "bg-foreground size-[7px]"
                : isNotable
                  ? "border-muted-foreground size-[7px] border-[1.5px]"
                  : "bg-muted-foreground/55 size-1",
            )}
            style={{ left: `${at * 100}%` }}
          />
        );
      })}
    </div>
  );
}

/**
 * What a day-linked surface is made of, which names the thing to click in
 * the caption: a point on a line, a bar, or a cell of a calendar.
 */
export type ChartDayMark = "point" | "bar" | "cell";

const HINT_KEYS: Record<ChartDayMark, { fine: string; coarse: string }> = {
  point: { fine: "day.chartHint", coarse: "day.chartHintTouch" },
  bar: { fine: "day.chartHintBar", coarse: "day.chartHintTouchBar" },
  cell: { fine: "day.chartHintCell", coarse: "day.chartHintTouchCell" },
};

/**
 * The one line under a day-linked chart: what the dots mean (when the chart
 * has the row of dots), and the click.
 */
export function ChartDayCaption({
  coarse,
  mark = "point",
  rug = true,
}: {
  coarse: boolean;
  mark?: ChartDayMark;
  rug?: boolean;
}) {
  const { t } = useTranslations();
  const hint = HINT_KEYS[mark];
  return (
    <p
      data-slot="chart-day-caption"
      className="text-muted-foreground mt-1 flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs"
    >
      {rug ? <span>{t("day.rugLegend")}</span> : null}
      <span>{coarse ? t(hint.coarse) : t(hint.fine)}</span>
    </p>
  );
}
