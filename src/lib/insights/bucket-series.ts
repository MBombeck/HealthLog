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

import { toBerlinYmd as toBerlinYmdStrings } from "@/lib/tz/resolver";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface DailyBucket {
  /** 0 = today (Berlin), 359 = 359 days ago. */
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
}

interface BerlinYmd {
  year: number;
  month: number;
  day: number;
}

function toBerlinYmd(date: Date): BerlinYmd {
  const parts = toBerlinYmdStrings(date);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  };
}

/** UTC midnight of the Berlin calendar day containing `date`. */
function utcMidnightOfBerlinDay(date: Date): number {
  const { year, month, day } = toBerlinYmd(date);
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
 */
export function dayOffsetToBerlinDayKey(now: Date, dayOffset: number): string {
  const todayMidnight = utcMidnightOfBerlinDay(now);
  // Subtraction in UTC-anchored Berlin-day space: every day is 24h wide
  // because both endpoints are UTC midnights of consecutive Berlin
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
 * Day offset between two Berlin-day timestamps, in whole days.
 * Always non-negative when `today >= record`.
 */
function dayOffsetBerlin(record: Date, todayMidnight: number): number {
  const recordMidnight = utcMidnightOfBerlinDay(record);
  return Math.round((todayMidnight - recordMidnight) / MS_PER_DAY);
}

export function bucketSeries(
  records: Array<{ measuredAt: Date; value: number }>,
  options: BucketOptions = {},
): BucketedSeries {
  const dailyDays = options.dailyDays ?? 360;
  const monthlyMonths = options.monthlyMonths ?? 24;
  const monthSize = 30;

  const todayMidnight = utcMidnightOfBerlinDay(options.now ?? new Date());

  const daily = new Map<number, { sum: number; n: number }>();
  const monthly = new Map<number, { sum: number; n: number }>();

  // monthOffset 12 → first 30-day window past the daily horizon. Keeping
  // the labelling stable regardless of `dailyDays` so prompts stay
  // readable across the canonical 360 / fallback 180 configurations.
  const monthOffsetBase = Math.round(dailyDays / monthSize);
  const monthlyMaxOffset = monthOffsetBase + monthlyMonths - 1;

  for (const record of records) {
    const offset = dayOffsetBerlin(record.measuredAt, todayMidnight);
    if (offset < 0) continue; // future timestamp — ignore

    if (offset < dailyDays) {
      const bucket = daily.get(offset) ?? { sum: 0, n: 0 };
      bucket.sum += record.value;
      bucket.n += 1;
      daily.set(offset, bucket);
      continue;
    }

    const monthOffset =
      monthOffsetBase + Math.floor((offset - dailyDays) / monthSize);
    if (monthOffset > monthlyMaxOffset) continue;
    const bucket = monthly.get(monthOffset) ?? { sum: 0, n: 0 };
    bucket.sum += record.value;
    bucket.n += 1;
    monthly.set(monthOffset, bucket);
  }

  const dailyOut: DailyBucket[] = Array.from(daily.entries())
    .sort(([a], [b]) => a - b)
    .map(([dayOffset, agg]) => ({
      dayOffset,
      value: round(agg.sum / agg.n),
      n: agg.n,
    }));

  const monthlyOut: MonthlyBucket[] = Array.from(monthly.entries())
    .sort(([a], [b]) => a - b)
    .map(([monthOffset, agg]) => ({
      monthOffset,
      value: round(agg.sum / agg.n),
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
