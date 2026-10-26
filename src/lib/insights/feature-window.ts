/**
 * The window arithmetic the feature extractor and the signals-of-day builder
 * share: a reading list as trend points, a mean over a days-ago window, and
 * a spread rounded to the payload's one decimal. A leaf module, so the
 * signals-of-day builder does not import the extractor that re-exports it.
 */
import type { DataPoint } from "@/lib/analytics/trends";
import { readingsMean } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import { standardDeviation, type VarianceKind } from "@/lib/stats/spread";

/**
 * A spread rounded to the payload's one decimal, `null` below two values: a
 * single reading has no spread to report, not a spread of zero.
 */
export function roundedSpread(
  values: readonly number[],
  kind: VarianceKind,
): number | null {
  if (values.length < 2) return null;
  const sd = standardDeviation(values, kind);
  return sd === null ? null : Math.round(sd * 10) / 10;
}

export function toDataPoints(
  records: Array<{ value: number; measuredAt: Date }>,
): DataPoint[] {
  return records.map((r) => ({ date: r.measuredAt, value: r.value }));
}

/**
 * Compute average of values within a time window (days ago from now).
 *
 * `day` names the type and the zone its days are read in. For a type whose
 * day is the mean of its hours' means (pulse, see `day-mean.ts`) the window
 * is then the mean of its day values; every other type keeps the plain mean.
 */
export function avgInWindow(
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  fromDaysAgo: number,
  toDaysAgo: number = 0,
  day?: { type: string; tz: string },
): number | null {
  const fromMs = now - fromDaysAgo * 24 * 60 * 60 * 1000;
  const toMs = now - toDaysAgo * 24 * 60 * 60 * 1000;
  const filtered = records.filter((r) => {
    const t = r.measuredAt.getTime();
    return t >= fromMs && t <= toMs;
  });
  if (filtered.length === 0) return null;
  if (day && usesHourlyMeanDay(day.type)) {
    const mean = readingsMean(day.type, filtered, day.tz);
    return mean === null ? null : Math.round(mean * 100) / 100;
  }
  const sum = filtered.reduce((s, r) => s + r.value, 0);
  return Math.round((sum / filtered.length) * 100) / 100;
}
