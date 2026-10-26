/**
 * Day-keyed series helpers for the Insights overview's correlations: local
 * day means from raw rows, and the two joins that pair one daily series with
 * another.
 */
import type { PairedPoint } from "@/lib/analytics/correlations";
import { userDayKey } from "@/lib/tz/format";

export interface DailyValue {
  day: string;
  value: number;
}

/**
 * Derive exact local-day mean series from raw measurement rows, keyed by the
 * user's timezone via `userDayKey`. The mood series is local-day-keyed, and
 * `pairMoodWithDaily` joins on an exact YYYY-MM-DD key, so its metric
 * partners must be local-day-keyed too. A UTC-day mean (from `dailyByType`)
 * cannot be relabeled into a local-day mean, so the mean is recomputed here
 * from raw rows already on the request path. `userDayKey` formats via a
 * memoised `Intl.DateTimeFormat` — no offset arithmetic — so DST-transition
 * days (23 h / 25 h) bucket correctly and the result is host-TZ-independent
 * (CI runs UTC). `round2` mirrors the aggregator's `ROUND(AVG, 2)` so
 * correlation thresholds don't drift. Returns `{ day, value }[]` sorted ASC
 * by day, the shape `pairMoodWithDaily` expects.
 */
export function deriveDailyLocalMeans(
  rows: Array<{ measuredAt: Date; value: number }>,
  tz: string,
): DailyValue[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const r of rows) {
    const key = userDayKey(r.measuredAt, tz);
    const cur = byDay.get(key) ?? { sum: 0, count: 0 };
    cur.sum += r.value;
    cur.count += 1;
    byDay.set(key, cur);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({
      day,
      value: Math.round((stats.sum / stats.count) * 100) / 100,
    }));
}

/**
 * Daily-key inner join between two daily-aggregated series. Returns
 * `PairedPoint` shapes compatible with `significantPearsonCorrelation`.
 *
 * Inputs are sorted ASC by `day` (the aggregator's ORDER BY
 * guarantees that). The walk is O(n + m) merge-join style instead of
 * Map.lookup-per-element so it scales with the worst-case 90 buckets
 * x 90 buckets case without surprises.
 */
export function joinDailyByDay(
  a: DailyValue[],
  b: DailyValue[],
): PairedPoint[] {
  const pairs: PairedPoint[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ai = a[i];
    const bj = b[j];
    if (ai.day === bj.day) {
      pairs.push({
        a: ai.value,
        b: bj.value,
        date: new Date(`${ai.day}T12:00:00.000Z`),
      });
      i += 1;
      j += 1;
    } else if (ai.day < bj.day) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/**
 * Pair the daily mood series (left side) with a daily-aggregated
 * metric (right side). Matches the legacy `buildMoodMetricPairs`
 * helper byte-for-byte: same daily YYYY-MM-DD key, same
 * `T12:00:00.000Z` anchor for the `date` field.
 */
export function pairMoodWithDaily(
  dailyMood: DailyValue[],
  dailyMetric: DailyValue[],
): PairedPoint[] {
  if (dailyMood.length === 0 || dailyMetric.length === 0) return [];
  const metricByDay = new Map<string, number>();
  for (const m of dailyMetric) {
    metricByDay.set(m.day, m.value);
  }
  const pairs: PairedPoint[] = [];
  for (const mood of dailyMood) {
    const metric = metricByDay.get(mood.day);
    if (metric !== undefined) {
      pairs.push({
        a: mood.value,
        b: metric,
        date: new Date(`${mood.day}T12:00:00.000Z`),
      });
    }
  }
  return pairs;
}
