/**
 * Value series for the timeline: quarterly, monthly or weekly means beside
 * the lanes (v1.42, #613).
 *
 * The bucket comes with the zoom (`timelineBucket` in `load-timeline.ts`),
 * and the source with the window's length:
 *
 *   - **longer than a year** (`all`): the last five years come from the
 *     rollup tier, MONTH buckets folded from the canonical-source DAY rows
 *     and, for quarters, folded once more here, each month weighing its days.
 *     Those buckets cut at UTC midnight, so a reading in the first or last
 *     hours of a month can sit in the neighbouring month. For a mean over
 *     dozens of days that is a rounding matter, and it is accepted here; the
 *     day view, where it is not, never reads the rollups. The rollups fold
 *     only five years (`ROLLUP_FOLD_WINDOW_MS`); the buckets before that come
 *     from one live query over the record's own local days, cached per record
 *     in the analytics bucket, which every measurement write marks stale.
 *   - **a year or less** (`year`, `quarter`, a short `all`): live over the
 *     record's local days.
 *
 * Every value is the mean of the bucket's days, each day weighing one (a
 * cumulative type's days are its day totals, a pulse-like type's day is the
 * mean of its hourly means, `daily-stats.ts`), matching the charts. Sleep is
 * the exception to both sources: it is stored one row per stage, so a day
 * mean or a rolled-up month would average stage fragments (and count an
 * in-bed row beside the stages inside it). Its value is the night's time
 * asleep as the sleep page reads it (`reconstructSleepNights`), one per
 * night keyed by its wake day, and a bucket's mean is the mean of its
 * nights. Each
 * point carries the readings behind it, so the chart can mark a mean that
 * rests on one or two. A bucket without a reading is not sent, and a series
 * without a point is not sent. `MOOD` is the mood score, read from the
 * entries' own dates; its count is the entries.
 */
import type { MeasurementType } from "@/generated/prisma/enums";

import { reconstructSleepNights } from "@/lib/analytics/sleep-night";
import { caches, cached } from "@/lib/cache/server-cache";
import { readLocalDailyCells, type DayCell } from "@/lib/day/daily-stats";
import type { TimelineBucket, TimelineSeries } from "@/lib/day/contract";
import { prisma } from "@/lib/db";
import { isCumulativeDaySumType } from "@/lib/measurements/cumulative-day-sum";
import { readCanonicalRollupBuckets } from "@/lib/rollups/measurement-read";
import { ROLLUP_FOLD_WINDOW_MS } from "@/lib/rollups/measurement-rollups";
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import {
  daysBetweenDateKeys,
  shiftDateKey,
  userDayKey,
  weekdayOfDateKey,
} from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";

export type SeriesPoint = TimelineSeries["points"][number];

/**
 * How long the buckets before the fold window stay cached. They change only
 * when an old reading is imported or deleted, and either write marks the
 * entry stale at once.
 */
const PRE_FOLD_TTL_MS = 6 * 3_600_000;

/** Windows longer than this read the rollup tier rather than live days. */
const LIVE_WINDOW_MAX_DAYS = 366;

/** The series key for the mood score. */
export const MOOD_SERIES_KEY = "MOOD";

/** The bucket a local day belongs to, named by its first day. */
export function bucketKey(day: string, bucket: TimelineBucket): string {
  if (bucket === "day") return day;
  if (bucket === "month") return `${day.slice(0, 7)}-01`;
  if (bucket === "quarter") {
    const month = Number(day.slice(5, 7));
    const first = month - ((month - 1) % 3);
    return `${day.slice(0, 4)}-${String(first).padStart(2, "0")}-01`;
  }
  // Weeks start on Monday.
  const offset = (weekdayOfDateKey(day) + 6) % 7;
  return shiftDateKey(day, -offset);
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Fold a day series into buckets: the mean of the bucket's days, and the
 * readings behind them.
 */
export function foldDays(
  days: ReadonlyMap<string, DayCell>,
  bucket: TimelineBucket,
): SeriesPoint[] {
  const buckets = new Map<string, { sum: number; n: number; count: number }>();
  for (const [day, cell] of days) {
    const key = bucketKey(day, bucket);
    const slot = buckets.get(key) ?? { sum: 0, n: 0, count: 0 };
    slot.sum += cell.value;
    slot.n += 1;
    slot.count += cell.count;
    buckets.set(key, slot);
  }
  return [...buckets]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([t, { sum, n, count }]) => ({ t, mean: round2(sum / n), count }));
}

/** A month from the rollup tier: its day mean, its days, its readings. */
export interface RolledMonth {
  t: string;
  mean: number;
  days: number;
  count: number;
}

/**
 * Fold rolled-up months into `bucket`: each month weighs its days, so a
 * quarter's mean is the mean of its days exactly as a live fold makes it.
 */
export function foldMonths(
  months: readonly RolledMonth[],
  bucket: Exclude<TimelineBucket, "week" | "day">,
): SeriesPoint[] {
  const buckets = new Map<
    string,
    { sum: number; days: number; count: number }
  >();
  for (const m of months) {
    const key = bucketKey(m.t, bucket);
    const slot = buckets.get(key) ?? { sum: 0, days: 0, count: 0 };
    slot.sum += m.mean * m.days;
    slot.days += m.days;
    slot.count += m.count;
    buckets.set(key, slot);
  }
  return [...buckets]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .filter(([, b]) => b.days > 0 && b.count > 0)
    .map(([t, { sum, days, count }]) => ({
      t,
      mean: round2(sum / days),
      count,
    }));
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

/** Buckets older than the rollup fold window, live and cached. */
async function preFoldBuckets(args: {
  userId: string;
  type: MeasurementType;
  tz: string;
  from: Date;
  boundary: Date;
  bucket: TimelineBucket;
  priorityJson: unknown;
}): Promise<SeriesPoint[]> {
  if (args.from >= args.boundary) return [];
  // Keyed under the record's `${userId}|` prefix: every measurement write
  // marks it stale with the rest of the analytics bucket.
  const key = `${args.userId}|timeline-pre-fold|${args.type}|${args.bucket}|${args.tz}|${dateOnlyKey(args.from)}|${dateOnlyKey(args.boundary)}`;
  return cached(
    caches.analytics,
    key,
    async () => {
      const cells = await readLocalDailyCells({
        userId: args.userId,
        types: [args.type],
        from: args.from,
        to: args.boundary,
        tz: args.tz,
        priorityJson: args.priorityJson,
      });
      return foldDays(cells.get(args.type) ?? new Map(), args.bucket);
    },
    undefined,
    PRE_FOLD_TTL_MS,
  ) as Promise<SeriesPoint[]>;
}

async function monthsFromRollups(args: {
  userId: string;
  type: MeasurementType;
  from: Date;
  to: Date;
  priorityJson: unknown;
}): Promise<RolledMonth[]> {
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
      mean: value,
      days: Math.max(1, r.days),
      count: r.count,
    };
  });
}

/** Whether `[from, to]` is long enough to read the rollup tier. */
function readsRollups(from: string, to: string): boolean {
  const days = daysBetweenDateKeys(from, to);
  return days >= LIVE_WINDOW_MAX_DAYS;
}

/** Sleep is read a year of stage rows at a time, so no read holds more. */
const SLEEP_CHUNK_DAYS = 366;

/**
 * Margin read around each chunk, so a night that crosses the chunk's edge is
 * read whole in the chunk its wake day belongs to and not cut in two.
 */
const SLEEP_CHUNK_MARGIN_MS = 24 * 3_600_000;

/**
 * Time asleep per night for the nights that woke in `[from, to]` (local
 * day keys), each a cell of one reading. The stage rows are read a year at
 * a time and folded into nights before the next year is read, so a decade
 * of nights never sits in memory as rows at once.
 */
export async function readNightCells(args: {
  userId: string;
  from: string;
  to: string;
  tz: string;
  priorityJson: unknown;
}): Promise<Map<string, DayCell>> {
  const out = new Map<string, DayCell>();
  for (
    let chunkFrom = args.from;
    chunkFrom <= args.to;
    chunkFrom = shiftDateKey(chunkFrom, SLEEP_CHUNK_DAYS)
  ) {
    const next = shiftDateKey(chunkFrom, SLEEP_CHUNK_DAYS);
    const chunkTo = next > args.to ? args.to : shiftDateKey(next, -1);
    const start = startOfLocalDayKey(chunkFrom, args.tz);
    const end = startOfLocalDayKey(shiftDateKey(chunkTo, 1), args.tz);
    const rows = await prisma.measurement.findMany({
      where: {
        userId: args.userId,
        type: "SLEEP_DURATION",
        deletedAt: null,
        measuredAt: {
          gte: new Date(start.getTime() - SLEEP_CHUNK_MARGIN_MS),
          lt: new Date(end.getTime() + SLEEP_CHUNK_MARGIN_MS),
        },
      },
      orderBy: { measuredAt: "asc" },
      select: {
        value: true,
        measuredAt: true,
        sleepStage: true,
        source: true,
        deviceType: true,
      },
    });
    for (const night of reconstructSleepNights(
      rows,
      args.tz,
      args.priorityJson,
    )) {
      if (night.night < chunkFrom || night.night > chunkTo) continue;
      if (night.asleepMinutes <= 0) continue;
      out.set(night.night, { value: night.asleepMinutes, count: 1 });
    }
  }
  return out;
}

/** The sleep series: the mean time asleep of each bucket's nights. */
async function sleepPoints(args: {
  userId: string;
  from: string;
  to: string;
  tz: string;
  bucket: TimelineBucket;
  priorityJson: unknown;
}): Promise<SeriesPoint[]> {
  const read = async () => foldDays(await readNightCells(args), args.bucket);
  if (!readsRollups(args.from, args.to)) return read();
  // A long window is cached under the record's prefix: every measurement
  // write marks it stale with the rest of the analytics bucket.
  const key = `${args.userId}|timeline-sleep|${args.bucket}|${args.tz}|${args.from}|${args.to}`;
  return cached(
    caches.analytics,
    key,
    read,
    undefined,
    PRE_FOLD_TTL_MS,
  ) as Promise<SeriesPoint[]>;
}

async function measurementSeries(args: {
  userId: string;
  type: MeasurementType;
  from: string;
  to: string;
  tz: string;
  bucket: TimelineBucket;
  priorityJson: unknown;
  now: Date;
}): Promise<TimelineSeries | null> {
  const start = startOfLocalDayKey(args.from, args.tz);
  const end = startOfLocalDayKey(shiftDateKey(args.to, 1), args.tz);
  let points: SeriesPoint[];
  // Sleep reads its nights at every length. Weeks and days never read the
  // rollups: their windows are short (a `day` range is under six weeks), and
  // the rollups cut at UTC midnight.
  if (args.type === "SLEEP_DURATION") {
    points = await sleepPoints(args);
  } else if (
    args.bucket !== "week" &&
    args.bucket !== "day" &&
    readsRollups(args.from, args.to)
  ) {
    const bucket = args.bucket;
    // The fold boundary rounded up to a bucket start, so no bucket is half
    // live and half rolled up.
    const raw = new Date(args.now.getTime() - ROLLUP_FOLD_WINDOW_MS);
    const boundaryKey = bucketKey(
      shiftDateKey(userDayKey(raw, args.tz), bucket === "quarter" ? 92 : 31),
      bucket,
    );
    const boundary = startOfLocalDayKey(boundaryKey, args.tz);
    // The live days end at the local boundary; the rolled-up months start at
    // the boundary month. The rollup tier keys its months by the UTC
    // calendar, so the window is compared by UTC date: west of UTC the local
    // midnight of the boundary month comes hours after that month's UTC
    // start, and a read from it left the month out.
    const rollupFrom = dayKeyAsUtcMidnight(
      boundaryKey > args.from ? boundaryKey : args.from,
    );
    const [older, recent] = await Promise.all([
      preFoldBuckets({
        userId: args.userId,
        type: args.type,
        tz: args.tz,
        from: start,
        boundary: boundary < end ? boundary : end,
        bucket,
        priorityJson: args.priorityJson,
      }),
      end > boundary
        ? monthsFromRollups({
            userId: args.userId,
            type: args.type,
            from: rollupFrom,
            to: dayKeyAsUtcMidnight(args.to),
            priorityJson: args.priorityJson,
          }).then((months) => foldMonths(months, bucket))
        : Promise.resolve([]),
    ]);
    const merged = new Map<string, SeriesPoint>();
    for (const p of [...older, ...recent]) merged.set(p.t, p);
    points = [...merged.values()].sort((a, b) => a.t.localeCompare(b.t));
  } else {
    const cells = await readLocalDailyCells({
      userId: args.userId,
      types: [args.type],
      from: start,
      to: end,
      tz: args.tz,
      priorityJson: args.priorityJson,
    });
    points = foldDays(cells.get(args.type) ?? new Map(), args.bucket);
  }
  if (points.length === 0) return null;
  return {
    key: args.type,
    unit: await latestUnit(args.userId, args.type),
    points,
  };
}

async function moodSeries(args: {
  userId: string;
  from: string;
  to: string;
  bucket: TimelineBucket;
}): Promise<TimelineSeries | null> {
  const rows = await prisma.moodEntry.groupBy({
    by: ["date"],
    where: {
      userId: args.userId,
      deletedAt: null,
      date: { gte: args.from, lte: args.to },
    },
    _avg: { score: true },
    _count: { score: true },
  });
  const days = new Map<string, DayCell>();
  for (const row of rows) {
    if (row._avg.score !== null && row._count.score > 0) {
      days.set(row.date, { value: row._avg.score, count: row._count.score });
    }
  }
  const points = foldDays(days, args.bucket);
  if (points.length === 0) return null;
  return {
    key: MOOD_SERIES_KEY,
    unit: null,
    points,
  };
}

export async function loadTimelineSeries(args: {
  userId: string;
  keys: readonly string[];
  from: string;
  to: string;
  tz: string;
  bucket: TimelineBucket;
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
