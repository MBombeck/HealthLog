/**
 * The grain a chart draws its range tab at, and the calendar stretch each
 * folded point stands for.
 *
 * The tab decides the grain, not an off-by-one span threshold: 7 and 30 days
 * draw one point per day, 90 days one point per ISO week, and All picks week
 * or month (or day, on a history shorter than 90 days) from the span of the
 * data. Until the tabs were relabelled as day
 * windows, "90" was the last 90 readings, which for someone measuring twice a
 * week spanned far more than 90 days and drew weekly means; a 90-day window
 * never exceeds 90 days, so the span threshold quietly turned it daily. Naming
 * the grain per tab makes that a decision instead of a side effect.
 *
 * Every chart with the range tabs reads this one function, and the points,
 * the caption chip, the tooltip and the data table read its answer.
 */
import type { ChartRangePoints } from "@/lib/dashboard/chart-overlay-prefs";

import { MS_PER_DAY } from "@/lib/time-constants";

import type { ChartBucketType } from "./bucket-time-series";

/** The grain of each fixed-window tab. All (`0`) goes by the data's span. */
export const RANGE_TAB_GRAIN = {
  7: "day",
  30: "day",
  90: "week",
} as const satisfies Record<Exclude<ChartRangePoints, 0>, ChartBucketType>;

/**
 * The grain for a range tab. `timestamps` are the visible points' instants
 * (any order) and only matter for All, which goes by their span: daily up to
 * 90 days, weekly up to 730, monthly beyond.
 */
export function pickRangeBucket(
  range: ChartRangePoints,
  timestamps: readonly number[],
): ChartBucketType {
  if (range !== 0) return RANGE_TAB_GRAIN[range];
  let first = Infinity;
  let last = -Infinity;
  for (const t of timestamps) {
    if (t < first) first = t;
    if (t > last) last = t;
  }
  const spanDays =
    timestamps.length < 2 ? 0 : Math.round((last - first) / MS_PER_DAY);
  if (spanDays > 730) return "month";
  if (spanDays > 90) return "week";
  return "day";
}

/**
 * The first day a calendar-day window admits, as the UTC midnight that
 * encodes it. The charts keep a day when its noon-UTC timestamp is at or
 * after `cutoffMs`; this returns the earliest such day, so a period clipped
 * to it names exactly the days the slice holds.
 */
export function firstWindowDayUtc(cutoffMs: number): number {
  const noon = MS_PER_DAY / 2;
  return Math.ceil((cutoffMs - noon) / MS_PER_DAY) * MS_PER_DAY;
}

export interface BucketPeriod {
  /** First calendar day the point covers, as UTC midnight. */
  start: number;
  /** Last calendar day the point covers, as UTC midnight. */
  end: number;
}

/**
 * The days a week or month point covers: its calendar week or month, clipped
 * to the window. The week the window opens in and the week that is still
 * running are shorter, and the label says so by naming their actual days
 * rather than a full Monday to Sunday.
 *
 * `bucketStart` is the bucket key `bucketTimeSeries` emits (UTC midnight of
 * the Monday or of the 1st). `firstDay` is null on All, which has no window
 * start to clip to.
 */
export function bucketPeriod(
  bucketStart: number,
  bucket: Exclude<ChartBucketType, "day">,
  { firstDay, lastDay }: { firstDay: number | null; lastDay: number },
): BucketPeriod {
  const date = new Date(bucketStart);
  const fullEnd =
    bucket === "week"
      ? bucketStart + 6 * MS_PER_DAY
      : Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0);
  const start =
    firstDay === null ? bucketStart : Math.max(bucketStart, firstDay);
  const end = Math.max(start, Math.min(fullEnd, lastDay));
  return { start, end };
}

/**
 * Where a folded point stores its period and its reading count, so the
 * tooltip and the data table read the same values the bucketing wrote.
 */
export const PERIOD_START_KEY = "__periodStart";
export const PERIOD_END_KEY = "__periodEnd";
export const READINGS_KEY = "__readings";

/**
 * A point's date as the tooltip and the data table print it: the day for a
 * daily point, the covered days for a week or month ("17.11.2026–22.11.2026"
 * for a week still running).
 */
export function pointPeriodLabel(
  point: {
    timestamp: number;
    [PERIOD_START_KEY]?: unknown;
    [PERIOD_END_KEY]?: unknown;
  },
  formatDate: (date: Date) => string,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const start = point[PERIOD_START_KEY];
  const end = point[PERIOD_END_KEY];
  if (typeof start !== "number" || typeof end !== "number") {
    return formatDate(new Date(point.timestamp));
  }
  if (start === end) return formatDate(new Date(start));
  return t("charts.bucketPeriod", {
    start: formatDate(new Date(start)),
    end: formatDate(new Date(end)),
  });
}
