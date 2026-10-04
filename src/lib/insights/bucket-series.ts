/**
 * Shared "daily + monthly" bucketing for per-card insight payloads.
 *
 * The seven KI insight generators previously all clipped to `.slice(-30)`
 * which gave the model a one-month window. v1.4.6 widens the window to
 * roughly three years per metric while keeping the prompt token budget
 * under control:
 *
 *   - The most recent `dailyDays` (default 360) days are summarised as
 *     daily means, indexed by `dayOffset` (0 = today, 359 = 359 days ago).
 *   - Older history up to ~36 months ago is summarised as 30-day
 *     monthly means, indexed by `monthOffset` (12 = the bucket starting
 *     360 days ago and going back 30 more days, …, 35 = ~36 months ago).
 *
 * Empty buckets are skipped — a user with only a handful of measurements
 * does not produce 360 zero-rows of noise.
 */

import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";
import { readingsMean } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DailyBucket {
  /** 0 = today (user-local), 359 = 359 days ago. */
  dayOffset: number;
  value: number;
  n: number;
}

export interface MonthlyBucket {
  /**
   * 12 = the 30-day window starting `dailyDays` days ago,
   * 35 = the 30-day window starting (`dailyDays` + 23 * 30) days ago.
   * The number is consistent with the convention that monthOffset 12
   * is "between 12 and 13 months back" so months 1-12 live in `daily`.
   */
  monthOffset: number;
  value: number;
  n: number;
}

export interface BucketedSeries {
  daily: DailyBucket[];
  monthly: MonthlyBucket[];
}

export interface BucketOptions {
  /** Number of recent days summarised as daily means. Default 360. */
  dailyDays?: number;
  /** Number of 30-day monthly windows to add after the daily window. Default 24. */
  monthlyMonths?: number;
  /** Reference "now". Default new Date(). */
  now?: Date;
  /**
   * IANA timezone the day buckets are keyed in. Defaults to
   * `DEFAULT_TIMEZONE` (Europe/Berlin) so legacy / test callers keep their
   * behaviour, but every per-user surface MUST pass the resolved
   * `User.timezone` so a near-midnight reading lands on the user's own
   * calendar day (and the "today / N-days-ago" framing is offset-correct
   * for non-Berlin self-hosters). Pre-v1.4.40 these helpers hard-pinned
   * Berlin; this threads the user TZ the display surfaces already use.
   */
  tz?: string;
  /**
   * The measurement type, when known. For a type whose day is the mean of its
   * hours' means (pulse, `day-mean.ts`) a daily bucket's value is that day
   * value and a monthly bucket's the mean of its days; `n` stays the number
   * of readings.
   */
  type?: string;
}

/**
 * UTC midnight of the user-local calendar day containing `date`.
 *
 * Anchors on the `YYYY-MM-DD` day key in `tz` (DST-immune via Intl) and
 * re-projects it to a UTC midnight so all downstream calendar arithmetic
 * runs in a space where every day is exactly 86_400_000 ms wide.
 */
function utcMidnightOfUserDay(date: Date, tz: string): number {
  const [year, month, day] = userDayKey(date, tz).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/**
 * Convert a `dayOffset` (0 = today in Berlin, 1 = yesterday, …) back to
 * the `YYYY-MM-DD` Berlin calendar day key the offset refers to.
 *
 * The naive `new Date(now − dayOffset·86_400_000)` then formatting in
 * `Europe/Berlin` is OFF-BY-ONE-DAY across DST boundaries — the day of
 * the spring-forward is 23h long and the day of the fall-back is 25h
 * long, so a 24h subtraction crawls past the boundary by one hour and
 * silently lands on the wrong calendar day for ~2 days/year.
 *
 * This helper anchors on Berlin Y-M-D first (DST-immune via Intl), then
 * does the subtraction in UTC-of-Y-M-D space where every day is exactly
 * 86_400_000 ms wide — so calendar arithmetic stays exact.
 *
 * Exported so the cross-metric `pairDailyBuckets` helpers in
 * `blood-pressure-status.ts`, `weight-status.ts`, `mood-status.ts`,
 * etc. all use the same source of truth.
 *
 * `tz` defaults to Berlin only so legacy callers keep working; per-user
 * surfaces pass the resolved `User.timezone`.
 */
export function dayOffsetToDayKey(
  now: Date,
  dayOffset: number,
  tz: string = DEFAULT_TIMEZONE,
): string {
  const todayMidnight = utcMidnightOfUserDay(now, tz);
  // Subtraction in UTC-anchored user-day space: every day is 24h wide
  // because both endpoints are UTC midnights of consecutive user-local
  // calendar days, regardless of how long the wall-clock day actually was.
  const targetUtc = new Date(todayMidnight - dayOffset * MS_PER_DAY);
  // Read the Y-M-D off the UTC fields directly — we anchored at UTC
  // midnight, so `getUTC*` gives back the Berlin calendar day exactly.
  const year = targetUtc.getUTCFullYear();
  const month = String(targetUtc.getUTCMonth() + 1).padStart(2, "0");
  const day = String(targetUtc.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Day offset between two user-local-day timestamps, in whole days.
 * Always non-negative when `today >= record`.
 */
function dayOffsetUser(
  record: Date,
  todayMidnight: number,
  tz: string,
): number {
  const recordMidnight = utcMidnightOfUserDay(record, tz);
  return Math.round((todayMidnight - recordMidnight) / MS_PER_DAY);
}

export function bucketSeries(
  records: Array<{ measuredAt: Date; value: number }>,
  options: BucketOptions = {},
): BucketedSeries {
  const dailyDays = options.dailyDays ?? 360;
  const monthlyMonths = options.monthlyMonths ?? 24;
  const monthSize = 30;
  const tz = options.tz ?? DEFAULT_TIMEZONE;

  const todayMidnight = utcMidnightOfUserDay(options.now ?? new Date(), tz);

  const daily = new Map<number, { sum: number; n: number }>();
  const monthly = new Map<number, { sum: number; n: number }>();
  // An hourly-mean type keeps each bucket's readings for its mean of days.
  const hourly = options.type !== undefined && usesHourlyMeanDay(options.type);
  const dailyRows = new Map<
    number,
    Array<{ measuredAt: Date; value: number }>
  >();
  const monthlyRows = new Map<
    number,
    Array<{ measuredAt: Date; value: number }>
  >();
  const keep = (
    rows: Map<number, Array<{ measuredAt: Date; value: number }>>,
    key: number,
    record: { measuredAt: Date; value: number },
  ) => {
    if (!hourly) return;
    const list = rows.get(key);
    if (list) list.push(record);
    else rows.set(key, [record]);
  };

  // monthOffset 12 → first 30-day window past the daily horizon. Keeping
  // the labelling stable regardless of `dailyDays` so prompts stay
  // readable across the canonical 360 / fallback 180 configurations.
  const monthOffsetBase = Math.round(dailyDays / monthSize);
  const monthlyMaxOffset = monthOffsetBase + monthlyMonths - 1;

  for (const record of records) {
    const offset = dayOffsetUser(record.measuredAt, todayMidnight, tz);
    if (offset < 0) continue; // future timestamp — ignore

    if (offset < dailyDays) {
      const bucket = daily.get(offset) ?? { sum: 0, n: 0 };
      bucket.sum += record.value;
      bucket.n += 1;
      daily.set(offset, bucket);
      keep(dailyRows, offset, record);
      continue;
    }

    const monthOffset =
      monthOffsetBase + Math.floor((offset - dailyDays) / monthSize);
    if (monthOffset > monthlyMaxOffset) continue;
    const bucket = monthly.get(monthOffset) ?? { sum: 0, n: 0 };
    bucket.sum += record.value;
    bucket.n += 1;
    monthly.set(monthOffset, bucket);
    keep(monthlyRows, monthOffset, record);
  }
  const meanOf = (
    rows: Map<number, Array<{ measuredAt: Date; value: number }>>,
    key: number,
    agg: { sum: number; n: number },
  ) => {
    const list = rows.get(key);
    return list
      ? (readingsMean(options.type!, list, tz) ?? agg.sum / agg.n)
      : agg.sum / agg.n;
  };

  const dailyOut: DailyBucket[] = Array.from(daily.entries())
    .sort(([a], [b]) => a - b)
    .map(([dayOffset, agg]) => ({
      dayOffset,
      value: round(meanOf(dailyRows, dayOffset, agg)),
      n: agg.n,
    }));

  const monthlyOut: MonthlyBucket[] = Array.from(monthly.entries())
    .sort(([a], [b]) => a - b)
    .map(([monthOffset, agg]) => ({
      monthOffset,
      value: round(meanOf(monthlyRows, monthOffset, agg)),
      n: agg.n,
    }));

  return { daily: dailyOut, monthly: monthlyOut };
}

/**
 * Apply the v1.4.6 "shrink the daily window if the JSON is too big"
 * guard. Returns the input unchanged when the serialised payload would
 * stay under `maxBytes`; otherwise re-buckets with the smaller daily
 * window so the model still sees the monthly slice.
 *
 * The guard is intentionally a re-bucket rather than a slice because
 * the daily array is ordered oldest → newest (low offset is recent);
 * `.slice` would silently bias the window away from the present.
 */
export function applyPayloadBudget(
  records: Array<{ measuredAt: Date; value: number }>,
  options: BucketOptions = {},
  maxBytes = 50_000,
  fallbackDailyDays = 180,
): BucketedSeries {
  const series = bucketSeries(records, options);
  const size = JSON.stringify(series).length;
  if (size <= maxBytes) return series;
  return bucketSeries(records, { ...options, dailyDays: fallbackDailyDays });
}
