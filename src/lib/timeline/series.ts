/**
 * Value series for the timeline: monthly, weekly or daily means beside the
 * lanes (v1.42, #613).
 *
 * Three ways in, by zoom:
 *
 *   - **all (month)**: the months of the last five years come from the rollup
 *     tier, MONTH buckets folded from the canonical-source DAY rows. Those
 *     buckets cut at UTC midnight, so a reading in the first or last hours of
 *     a month can sit in the neighbouring month. For a monthly mean over
 *     dozens of days that is a rounding matter, and it is accepted here; the
 *     day view, where it is not, never reads the rollups. The rollups fold
 *     only five years (`ROLLUP_FOLD_WINDOW_MS`); the months before that come
 *     from one live query over the record's own local days, cached per record
 *     in the analytics bucket, which every measurement write marks stale.
 *   - **year (week)** and **quarter (day)**: live over the record's local
 *     days, a year at most.
 *
 * Every value is the mean of the bucket's days, each day weighing one (a
 * cumulative type's days are its day totals), matching the charts. A series
 * without a point is not sent. `MOOD` is the mood score, read from the
 * entries' own dates.
 */
import type { MeasurementType } from "@/generated/prisma/enums";

import { caches, cached } from "@/lib/cache/server-cache";
import { readLocalDailyStats } from "@/lib/day/daily-stats";
import type { TimelineSeries } from "@/lib/day/contract";
import { prisma } from "@/lib/db";
import { isCumulativeDaySumType } from "@/lib/measurements/cumulative-day-sum";
import { readCanonicalRollupBuckets } from "@/lib/rollups/measurement-read";
import { ROLLUP_FOLD_WINDOW_MS } from "@/lib/rollups/measurement-rollups";
import { dateOnlyKey } from "@/lib/tz/date-only";
import { shiftDateKey, userDayKey, weekdayOfDateKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

export type SeriesGranularity = TimelineSeries["granularity"];

/**
 * How long the months before the fold window stay cached. They change only
 * when an old reading is imported or deleted, and either write marks the
 * entry stale at once.
 */
const PRE_FOLD_TTL_MS = 6 * 3_600_000;

/** The series key for the mood score. */
export const MOOD_SERIES_KEY = "MOOD";

/** The bucket a local day belongs to, named by its first day. */
export function bucketKey(day: string, granularity: SeriesGranularity): string {
  if (granularity === "day") return day;
  if (granularity === "month") return `${day.slice(0, 7)}-01`;
  // Weeks start on Monday.
  const offset = (weekdayOfDateKey(day) + 6) % 7;
  return shiftDateKey(day, -offset);
}

/** Fold a day series into buckets: the mean of the bucket's days. */
export function foldDays(
  days: ReadonlyMap<string, number>,
  granularity: SeriesGranularity,
): Array<{ t: string; mean: number }> {
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const [day, value] of days) {
    const key = bucketKey(day, granularity);
    const slot = buckets.get(key) ?? { sum: 0, n: 0 };
    slot.sum += value;
    slot.n += 1;
    buckets.set(key, slot);
  }
  return [...buckets]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, { sum, n }]) => ({ t, mean: Math.round((sum / n) * 100) / 100 }));
}

async function latestUnit(
  userId: string,
  type: MeasurementType,
): Promise<string | null> {
  const row = await prisma.measurement.findFirst({
    where: { userId, type, deletedAt: null },
    orderBy: { measuredAt: "desc" },
    select: { unit: true },
  });
  return row?.unit ?? null;
}

/** Months older than the rollup fold window, live and cached. */
async function preFoldMonths(args: {
  userId: string;
  type: MeasurementType;
  tz: string;
  from: Date;
  boundary: Date;
  priorityJson: unknown;
}): Promise<Array<{ t: string; mean: number }>> {
  if (args.from >= args.boundary) return [];
  // Keyed under the record's `${userId}|` prefix: every measurement write
  // marks it stale with the rest of the analytics bucket.
  const key = `${args.userId}|timeline-pre-fold|${args.type}|${args.tz}|${dateOnlyKey(args.from)}|${dateOnlyKey(args.boundary)}`;
  return cached(
    caches.analytics,
    key,
    async () => {
      const stats = await readLocalDailyStats({
        userId: args.userId,
        types: [args.type],
        from: args.from,
        to: args.boundary,
        tz: args.tz,
        priorityJson: args.priorityJson,
      });
      return foldDays(stats.get(args.type) ?? new Map(), "month");
    },
    undefined,
    PRE_FOLD_TTL_MS,
  ) as Promise<Array<{ t: string; mean: number }>>;
}

async function monthlyFromRollups(args: {
  userId: string;
  type: MeasurementType;
  from: Date;
  to: Date;
  priorityJson: unknown;
}): Promise<Array<{ t: string; mean: number }>> {
  const rows = await readCanonicalRollupBuckets({
    userId: args.userId,
    type: args.type,
    granularity: "MONTH",
    from: args.from,
    to: args.to,
    toInclusive: true,
    userPriorityJson: args.priorityJson,
  });
  const cumulative = isCumulativeDaySumType(args.type);
  return rows.map((r) => {
    const value = cumulative
      ? (r.sumValue ?? r.mean * r.count) / Math.max(1, r.days)
      : Number.isFinite(r.dayMean)
        ? r.dayMean
        : r.mean;
    return {
      t: `${dateOnlyKey(r.bucketStart).slice(0, 7)}-01`,
      mean: Math.round(value * 100) / 100,
    };
  });
}

async function measurementSeries(args: {
  userId: string;
  type: MeasurementType;
  from: string;
  to: string;
  tz: string;
  granularity: SeriesGranularity;
  priorityJson: unknown;
  now: Date;
}): Promise<TimelineSeries | null> {
  const start = startOfLocalDayKey(args.from, args.tz);
  const end = startOfLocalDayKey(shiftDateKey(args.to, 1), args.tz);
  let points: Array<{ t: string; mean: number }>;
  if (args.granularity === "month") {
    // The fold boundary rounded up to a month start, so no month is half
    // live and half rolled up.
    const raw = new Date(args.now.getTime() - ROLLUP_FOLD_WINDOW_MS);
    const boundaryKey = bucketKey(
      shiftDateKey(userDayKey(raw, args.tz), 31),
      "month",
    );
    const boundary = startOfLocalDayKey(boundaryKey, args.tz);
    const [older, recent] = await Promise.all([
      preFoldMonths({
        userId: args.userId,
        type: args.type,
        tz: args.tz,
        from: start,
        boundary: boundary < end ? boundary : end,
        priorityJson: args.priorityJson,
      }),
      end > boundary
        ? monthlyFromRollups({
            userId: args.userId,
            type: args.type,
            from: boundary > start ? boundary : start,
            to: end,
            priorityJson: args.priorityJson,
          })
        : Promise.resolve([]),
    ]);
    const merged = new Map<string, number>();
    for (const p of [...older, ...recent]) merged.set(p.t, p.mean);
    points = [...merged]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([t, mean]) => ({ t, mean }));
  } else {
    const stats = await readLocalDailyStats({
      userId: args.userId,
      types: [args.type],
      from: start,
      to: end,
      tz: args.tz,
      priorityJson: args.priorityJson,
    });
    points = foldDays(stats.get(args.type) ?? new Map(), args.granularity);
  }
  if (points.length === 0) return null;
  return {
    key: args.type,
    unit: await latestUnit(args.userId, args.type),
    granularity: args.granularity,
    points,
  };
}

async function moodSeries(args: {
  userId: string;
  from: string;
  to: string;
  granularity: SeriesGranularity;
}): Promise<TimelineSeries | null> {
  const rows = await prisma.moodEntry.groupBy({
    by: ["date"],
    where: {
      userId: args.userId,
      deletedAt: null,
      date: { gte: args.from, lte: args.to },
    },
    _avg: { score: true },
  });
  const days = new Map<string, number>();
  for (const row of rows) {
    if (row._avg.score !== null) days.set(row.date, row._avg.score);
  }
  const points = foldDays(days, args.granularity);
  if (points.length === 0) return null;
  return {
    key: MOOD_SERIES_KEY,
    unit: null,
    granularity: args.granularity,
    points,
  };
}

export async function loadTimelineSeries(args: {
  userId: string;
  keys: readonly string[];
  from: string;
  to: string;
  tz: string;
  granularity: SeriesGranularity;
  priorityJson: unknown;
  now?: Date;
}): Promise<TimelineSeries[]> {
  const now = args.now ?? new Date();
  const out = await Promise.all(
    args.keys.map((key) =>
      key === MOOD_SERIES_KEY
        ? moodSeries(args)
        : measurementSeries({ ...args, type: key as MeasurementType, now }),
    ),
  );
  return out.filter((s): s is TimelineSeries => s !== null);
}
