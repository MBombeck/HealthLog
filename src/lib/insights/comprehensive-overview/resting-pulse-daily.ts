/**
 * The overview's daily resting-pulse series, the mood × pulse correlation's
 * partner.
 *
 * The correlation is labelled "Resting pulse (bpm)", so it is scored against
 * the RESTING series, not the raw PULSE day-mean: the aggregator's
 * `dailyByType.PULSE` is a per-day AVG that folds in workout HR for
 * Apple-Health users and inflates the "resting" figure. The clean
 * RESTING_HEART_RATE rows win; only without them does the low-percentile
 * daily proxy over raw pulse stand in. The proxy folds in Postgres (#1023):
 * it needs one percentile per day, and reading the raw samples to get it
 * walked 130 000 rows per page view on a watch that records once a minute.
 *
 * Keyed on `userDayKey(d, userTz)`: its only pairing partner is the mood
 * series, which is local-day-keyed, and a UTC key here would offset every
 * evening logger west of UTC by one day and sell a lag-1 correlation as
 * same-day. Unlike the mood side, this series builds from raw rows, so it
 * re-keys directly with no rollup-tier change.
 */
import { prisma } from "@/lib/db";
import { resolveRestingPulseSeries } from "@/lib/analytics/resting-pulse";
import { readRestingPulseProxy } from "@/lib/analytics/resting-pulse-read";
import { userDayKey } from "@/lib/tz/format";

import type { DailyValue } from "./daily-series";

export async function readRestingPulseDaily(
  userId: string,
  since: Date,
  userTz: string,
): Promise<DailyValue[]> {
  const restingPulseRows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "RESTING_HEART_RATE",
      deletedAt: null,
      measuredAt: { gte: since },
    },
    select: { measuredAt: true, value: true },
  });
  const localDayKey = (d: Date) => userDayKey(d, userTz);
  const restingPulseSeries =
    restingPulseRows.length > 0
      ? resolveRestingPulseSeries({
          restingSamples: restingPulseRows,
          pulseSamples: [],
          dayKeyOf: localDayKey,
        }).series
      : await readRestingPulseProxy({
          userId,
          since,
          timeZone: userTz,
        });
  const restingByDay = new Map<string, { sum: number; count: number }>();
  for (const s of restingPulseSeries) {
    const key = localDayKey(s.measuredAt);
    const cur = restingByDay.get(key) ?? { sum: 0, count: 0 };
    cur.sum += s.value;
    cur.count += 1;
    restingByDay.set(key, cur);
  }
  return Array.from(restingByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({ day, value: stats.sum / stats.count }));
}
