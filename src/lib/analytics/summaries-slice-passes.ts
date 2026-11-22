/**
 * The passes of the summaries slice that run beside its aggregate reads.
 *
 * The slice is one aggregate round (`computeFromRollups` or the live
 * aggregate) followed by three passes: the year-ago baseline of each type,
 * sleep summarised per night, and the latest day of each hourly-mean type.
 * The passes used to wait for the round and then for each other, and each
 * read the user's ladder and zone again. Two of them need nothing the round
 * computes: the night walk needs only to know that the account has sleep,
 * which the coverage map already says, and the latest-day read needs only the
 * latest-per-type read, one statement of the round. They start with the
 * round now, on the one ladder the slice read, and their results are applied
 * under exactly the conditions the sequential passes checked, so the slice is
 * the same. The year-ago baseline still follows the round (it is asked for the
 * types the round found), as one read for every type instead of one per type.
 */
import type { MeasurementType } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { wireSummary } from "@/lib/analytics/trends";
import {
  readNightHistory,
  type NightHistory,
} from "@/lib/analytics/sleep-night-history";
import type { SummariesSlice } from "@/lib/analytics/summaries-slice";
import {
  HOURLY_MEAN_DAY_TYPES,
  usesHourlyMeanDay,
  windowWeighting,
} from "@/lib/measurements/day-statistic";
import { dayValue } from "@/lib/measurements/day-mean";
import type { LatestCanonicalRow } from "@/lib/measurements/latest-canonical";
import { canonicalRowsOfDay } from "@/lib/mood/linked-context";
import {
  aggregateBuckets,
  collapseRollupRowsBySource,
  loadUserSourcePriority,
} from "@/lib/rollups/measurement-read";
import type { RollupCoverageMap } from "@/lib/rollups/measurement-coverage";
import { userDayKey } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";

const DAY_MS = 24 * 60 * 60 * 1000;

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * A pass started before anyone knows whether its result is wanted. Its
 * failure is held, not thrown: it fails the slice only when the result is
 * applied, as it did when the pass ran only then.
 */
function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function unwrap<T>(settled: Settled<T>): T {
  if (!settled.ok) throw settled.error;
  return settled.value;
}

export interface SlicePasses {
  /**
   * Hand the round's latest-per-type read to the latest-day pass, which keys
   * on it; returns the same promise, so the round's statement order stays.
   */
  withLatests(
    latests: Promise<LatestCanonicalRow[]>,
  ): Promise<LatestCanonicalRow[]>;
  /** `avg30LastYear` of `types` (`computeAvg30LastYearMap`), on the slice's ladder. */
  yearAgo(
    types: ReadonlyArray<string>,
    nowMs: number,
  ): Promise<Map<string, number | null>>;
  /** Apply the passes to the round's slice, in the order they always ran. */
  apply(slice: SummariesSlice): Promise<SummariesSlice>;
}

export function startSlicePasses(
  userId: string,
  priorityJson: unknown,
  coverage: RollupCoverageMap,
): SlicePasses {
  let zone: Promise<string> | undefined;
  const tz = () => (zone ??= resolveUserTimezone(userId));
  const walkNights = () =>
    tz().then((z) => readNightHistory(userId, z, priorityJson));
  // The coverage map names every type with a live reading.
  const nights = coverage.has("SLEEP_DURATION") ? settle(walkNights()) : null;
  let dayValues: Promise<Settled<Map<string, number | null>>> | null = null;

  return {
    yearAgo: (types, nowMs) =>
      computeAvg30LastYearMap(userId, types, nowMs, priorityJson),
    withLatests(latests) {
      dayValues = settle(
        latests.then((rows) =>
          readLatestDayValues(userId, rows, priorityJson, tz),
        ),
      );
      return latests;
    },
    async apply(slice) {
      // Sleep per night: only when the slice counted sleep at all, and only
      // when the walk found a night. A walk the map did not start (a first
      // reading landed after the probe) runs now, as it always did.
      const existing = slice.summaries.SLEEP_DURATION;
      if (existing && existing.count > 0) {
        const walked = nights ? unwrap(await nights) : await walkNights();
        if (walked.nightCount > 0) applyNightSummary(slice, walked);
      }
      // The latest day of an hourly-mean type: for a type whose slice entry
      // carries a latest reading and a last-seen instant.
      const wanted = [...HOURLY_MEAN_DAY_TYPES].filter(
        (type) =>
          slice.summaries[type]?.latest != null && slice.lastSeenByType[type],
      );
      if (wanted.length > 0 && dayValues) {
        const values = unwrap(await dayValues);
        for (const type of wanted) {
          const value = values.get(type);
          if (value != null) slice.summaries[type].latest = value;
        }
      }
      return slice;
    },
  };
}

/**
 * `latest` of an hourly-mean type (pulse) is the value of its latest local
 * day, not its latest single reading.
 *
 * The dashboard's pulse tile led with the last reading a watch happened to
 * take, while the day view showed the day's pulse as the mean of its hours'
 * means (`day-mean.ts`). Both say "Pulse"; both now mean the same statistic:
 * the latest day's value, read through the same canonical-source pick and
 * the same day-mean helper the day view uses, in the person's own zone.
 * Read for every hourly-mean type the latest read found; `apply` keeps the
 * types the slice holds a latest reading for.
 */
async function readLatestDayValues(
  userId: string,
  latests: LatestCanonicalRow[],
  priorityJson: unknown,
  tz: () => Promise<string>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const seen = latests.filter(
    (row) => usesHourlyMeanDay(row.type) && row.measured_at,
  );
  if (seen.length === 0) return out;
  const zone = await tz();
  await Promise.all(
    seen.map(async (row) => {
      const type = row.type as MeasurementType;
      const day = userDayKey(new Date(row.measured_at), zone);
      const { dayStart, dayEnd } = localDayWindow(day, zone);
      const rows = await prisma.measurement.findMany({
        where: {
          userId,
          type,
          deletedAt: null,
          measuredAt: { gte: dayStart, lt: dayEnd },
        },
        select: {
          type: true,
          value: true,
          unit: true,
          measuredAt: true,
          source: true,
          deviceType: true,
        },
        orderBy: [{ measuredAt: "asc" }, { id: "asc" }],
      });
      const canonical = canonicalRowsOfDay(rows, type, day, zone, priorityJson);
      out.set(type, dayValue(type, canonical, zone));
    }),
  );
  return out;
}

/**
 * Replace the per-stage `summaries.SLEEP_DURATION` with a per-NIGHT summary.
 *
 * `SLEEP_DURATION` is stored one row per sleep STAGE per night (minutes).
 * The slice's generic aggregate therefore treats each stage as an
 * independent reading: `latest` is the most-recent STAGE (not the night),
 * `mean` / `avg7` / `avg30` average across stage rows. The dashboard sleep
 * tile and the insights overview want the per-night TIME-ASLEEP total.
 *
 * The night walk covers the whole history, like every other type here (a
 * year's cut left `avg30LastYear` and the all-time count and range short),
 * with the old nights held as a closed block (`sleep-night-history.ts`). The
 * unit stays
 * minutes, so consumers that treat the summary as minutes keep working; they
 * average nights instead of stages. The per-night `summarize()` fills the
 * slope tuples from the night points.
 */
function applyNightSummary(
  slice: SummariesSlice,
  { summary, latestNight }: NightHistory,
): void {
  slice.summaries.SLEEP_DURATION = wireSummary(summary);
  // Additive, observational: the latest night's main session saw two writer
  // buckets with clearly different asleep totals. Whole minutes, matching the
  // `/api/sleep/night` serialisation.
  slice.sleepSourceDiscrepancy = latestNight?.sourceDiscrepancy
    ? {
        deltaMinutes: Math.round(latestNight.sourceDiscrepancy.deltaMinutes),
        sources: latestNight.sourceDiscrepancy.sources.map((b) => ({
          source: b.source,
          deviceType: b.deviceType,
          asleepMinutes: Math.round(b.asleepMinutes),
        })),
      }
    : null;
}

/**
 * Year-ago 30-day baseline per type, served from the DAY rollup tier.
 *
 * `DataSummary.avg30LastYear` is the mean over the 30 days that start 395
 * days ago, which the dashboard tile uses for "current average vs the same
 * time last year". The window is exactly those 30 UTC days (the DAY-tier
 * grain), read as canonical-source DAY buckets and composed count-weighted,
 * so it is the same per-reading mean `avg30` reports for the last 30 days.
 * One read covers every type asked for; each type's buckets then collapse to
 * its canonical source and compose exactly as the per-type read did
 * (`readCanonicalRollupBuckets`, `aggregateBuckets`).
 *
 * Every type asked for is in the map; `null` when no reading falls in its
 * window, which the UI treats as "no comparison available".
 */
export async function computeAvg30LastYearMap(
  userId: string,
  types: ReadonlyArray<string>,
  now: number,
  userPriorityJson?: unknown,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (types.length === 0) return out;
  const rows = await prisma.measurementRollup.findMany({
    where: {
      userId,
      type: { in: [...types] as MeasurementType[] },
      granularity: "DAY",
      bucketStart: {
        gte: startOfUtcDay(new Date(now - 395 * DAY_MS)),
        lt: startOfUtcDay(new Date(now - 365 * DAY_MS)),
      },
    },
    orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
    select: {
      type: true,
      bucketStart: true,
      source: true,
      count: true,
      mean: true,
      minValue: true,
      maxValue: true,
    },
  });
  const byType = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byType.get(row.type);
    if (list) list.push(row);
    else byType.set(row.type, [row]);
  }
  const priority =
    byType.size === 0
      ? null
      : userPriorityJson !== undefined
        ? userPriorityJson
        : await loadUserSourcePriority(userId);
  for (const type of types) {
    const typeRows = byType.get(type) ?? [];
    const composed = aggregateBuckets(
      collapseRollupRowsBySource(
        typeRows,
        type as MeasurementType,
        priority,
      ).map((r) => ({
        day: r.bucketStart,
        count: r.count,
        mean: r.mean,
        minValue: r.minValue,
        maxValue: r.maxValue,
      })),
      windowWeighting(type),
    );
    out.set(type, composed.count > 0 ? composed.mean : null);
  }
  return out;
}
