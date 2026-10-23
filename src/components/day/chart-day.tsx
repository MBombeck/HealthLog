"use client";

import { useSyncExternalStore } from "react";
import { ArrowRight } from "lucide-react";

import type { DateKey } from "@/lib/day/contract";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { useTranslations } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";

import { useOpenDay } from "./day-layer-controller";
import { isOpenableDay } from "./day-url";
import { useDayIndex } from "./use-day";
import { useTodayKey } from "./use-today-key";

/**
 * The day view's entry points on a value chart.
 *
 *   - On a fine pointer, a click on the plot opens the day of the point under
 *     the cursor; hovering keeps showing the tooltip as before.
 *   - On a touch screen a tap shows the value, as it always did, and the
 *     tooltip carries "View the whole day". Two steps on purpose: a point is
 *     a small target, and one tap that opened a sheet would open days by
 *     accident. A date in a list is a bigger target and opens in one tap.
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
 * Where a day's dot sits under a time axis drawn from real instants (a lab
 * result at 08:10, a questionnaire in the evening), given the calendar day
 * each point stands for. The span is the first to the last of those days,
 * both included: a noon anchor tested against the instants dropped the first
 * day when its reading came after noon UTC, the last when its reading came
 * before, and a single reading never had a dot. The dot then sits along the
 * instants' own span, held to its ends.
 */
export function timeRugFraction(
  day: DateKey,
  points: readonly RugPoint[],
  days: ReadonlyArray<DateKey | null>,
): number | null {
  const keys = days.filter((d): d is DateKey => d !== null).sort();
  if (keys.length === 0 || points.length === 0) return null;
  if (day < keys[0]! || day > keys[keys.length - 1]!) return null;
  const first = points[0]!.timestamp;
  const last = points[points.length - 1]!.timestamp;
  if (last === first) return 0.5;
  const t = Date.parse(`${day}T12:00:00.000Z`);
  return Math.min(1, Math.max(0, (t - first) / (last - first)));
}

/**
 * The rug's dots: each day that holds anything, where it sits along the plot.
 *
 * On an index or band axis a day has a place only if it is one of the
 * chart's points, because the axis spaces points, not days. A day between
 * two points used to be interpolated into the gap between them, so a sparse
 * series (blood pressure taken twice a week beside a mood logged every day)
 * squeezed a week of other days into one gap and their dots ran together
 * into bars. A time axis spaces days and keeps every day of its span.
 */
export function rugEntries(
  days: readonly string[],
  points: readonly RugPoint[],
  axis: ChartDayAxis,
  pointDays?: ReadonlyArray<DateKey | null>,
): Array<{ day: string; at: number }> {
  const onPoints =
    axis === "time"
      ? null
      : new Set(points.map((point) => chartPointDayKey(point.timestamp)));
  return days
    .filter((day) => onPoints === null || onPoints.has(day))
    .map((day) => ({
      day,
      at:
        axis === "time" && pointDays !== undefined
          ? timeRugFraction(day as DateKey, points, pointDays)
          : rugFraction(day as DateKey, points, axis),
    }))
    .filter((entry): entry is { day: string; at: number } => entry.at !== null);
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
  pointDays,
  insetLeft,
  insetRight,
  axis = "index",
}: {
  points: readonly RugPoint[];
  /**
   * The calendar day of each point, in data order (the `days` the chart hands
   * `useChartDayLinks`). A time axis drawn from real instants places its dots
   * by these; without them every point is read as a noon-UTC day anchor.
   */
  pointDays?: ReadonlyArray<DateKey | null>;
  insetLeft: number;
  insetRight: number;
  axis?: ChartDayAxis;
}) {
  const today = useTodayKey();
  const open = useOpenDay();
  const byDays = axis === "time" && pointDays !== undefined;
  const dayKeys = byDays
    ? pointDays.filter((d): d is DateKey => d !== null).sort()
    : [];
  const first = points[0];
  const last = points[points.length - 1];
  const from = byDays
    ? (dayKeys[0] ?? null)
    : first
      ? chartPointDayKey(first.timestamp)
      : null;
  const to = byDays
    ? (dayKeys[dayKeys.length - 1] ?? null)
    : last
      ? chartPointDayKey(last.timestamp)
      : null;
  const index = useDayIndex(from, to);
  const data = index.data;
  const notable = new Set(data?.notable ?? []);
  const days = rugEntries(
    Object.keys(data?.days ?? {}).filter((day) => isOpenableDay(day, today)),
    points,
    axis,
    byDays ? pointDays : undefined,
  );
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
