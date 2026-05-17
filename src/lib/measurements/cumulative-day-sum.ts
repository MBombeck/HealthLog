/**
 * v1.4.36 W4c — Pure day-bucket sum picker for cumulative metrics.
 *
 * SLEEP_DURATION already runs this shape inline in
 * `src/app/api/analytics/route.ts` lines 198-225: pick a single
 * source per day (source-priority + device-type) then sum the
 * day's slices into one datapoint per day. The dashboard tile
 * surfaces the resulting `latest` as "X minutes asleep".
 *
 * Steps / active energy / walking distance / flights climbed /
 * time-in-daylight share the same physical shape — every iOS
 * HealthKit ingest writes minute-level slices that the dashboard
 * tile was rendering as the *latest slice* instead of the *day's
 * total*. Marc reported "Steps tile shows last-measurement-not-day-sum".
 *
 * This helper extracts the per-day-sum reduction so the route can
 * call it for every cumulative metric without copy-pasting the
 * SLEEP_DURATION branch. The source-priority pick stays in the
 * caller (it already imports `pickCanonicalSourceRows`); this
 * helper only handles the bucket-and-sum once that picker has
 * narrowed each day to its canonical source.
 */

export interface CumulativeRow {
  measuredAt: Date;
  value: number;
}

export interface DaySumPoint {
  date: Date;
  value: number;
}

/**
 * Bucket `rows` by `dayKey(measuredAt)` and sum each bucket's `value`.
 * The returned points are sorted ascending by date, with each
 * bucket's `date` set to the latest `measuredAt` seen in that
 * bucket (matches the SLEEP_DURATION branch's contract).
 *
 * Empty input returns an empty array.
 */
export function pickCumulativeDaySum<T extends CumulativeRow>(
  rows: readonly T[],
  dayKey: (d: Date) => string,
): DaySumPoint[] {
  if (rows.length === 0) return [];

  const byDay = new Map<string, { total: number; date: Date }>();
  for (const row of rows) {
    const key = dayKey(row.measuredAt);
    const slot = byDay.get(key) ?? { total: 0, date: row.measuredAt };
    slot.total += row.value;
    if (row.measuredAt > slot.date) slot.date = row.measuredAt;
    byDay.set(key, slot);
  }

  const out: DaySumPoint[] = Array.from(byDay.values()).map((s) => ({
    date: s.date,
    value: s.total,
  }));
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

/**
 * v1.4.36 W4c — Canonical set of cumulative metric types whose
 * dashboard tile should read the *day's sum* and not the latest
 * slice. Kept here so the analytics route and any other consumer
 * (Coach snapshot, exports) share the same source of truth.
 *
 * Note: SLEEP_DURATION is also cumulative but the route handles
 * it inline because the picker is the canonical sleep source ladder
 * ("sleep" metricKey vs "default"). Once Apple-Health passthrough
 * lands and the sleep ladder needs the same shared treatment it can
 * fold into this list.
 */
export const CUMULATIVE_DAY_SUM_TYPES = [
  "ACTIVITY_STEPS",
  "ACTIVE_ENERGY_BURNED",
  "WALKING_RUNNING_DISTANCE",
  "FLIGHTS_CLIMBED",
  "TIME_IN_DAYLIGHT",
] as const;

export type CumulativeDaySumType = (typeof CUMULATIVE_DAY_SUM_TYPES)[number];

export function isCumulativeDaySumType(
  type: string,
): type is CumulativeDaySumType {
  return (CUMULATIVE_DAY_SUM_TYPES as readonly string[]).includes(type);
}
