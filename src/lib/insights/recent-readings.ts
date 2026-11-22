/**
 * The raw readings a per-metric status snapshot reads: the latest 365, and
 * never less than the last 30 days.
 *
 * The snapshots used to read `take: 365` rows. For a type read a few times a
 * day that reaches back months; for a dense stream (a watch's pulse every
 * few minutes, hourly folds of an imported history) it reached back hours,
 * and the "last 30 days" figures built on it (in-target share, the latest day
 * against the one before) were computed over a sliver of one day. When the
 * latest 365 readings do not reach back 30 days, the last 30 days are read by
 * time instead: as rows while they number at most {@link DENSE_READ_CAP},
 * and folded to one reading per local hour in Postgres beyond it
 * (`readHourCells`). A watch writing a reading every few seconds holds a
 * million rows in 30 days; the capped row read this replaces returned the
 * newest 60 000 of them, under two days, and every 30-day figure was built
 * on those. The longer tail of every snapshot comes from the rollup tier,
 * not from here.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { isCumulativeDaySumType } from "@/lib/measurements/cumulative-day-sum";
import {
  countReadingsUpTo,
  readHourCells,
} from "@/lib/measurements/dense-bucket-read";
import { readNewestRowsPerType } from "@/lib/measurements/newest-per-type";

export const RECENT_READINGS = 365;
export const RECENT_MIN_DAYS = 30;
/** Raw rows a reader holds before it reads hour cells instead. */
export const DENSE_READ_CAP = 60_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RecentReading {
  value: number;
  measuredAt: Date;
}

/** Oldest first. */
export async function readRecentReadings(
  userId: string,
  type: MeasurementType,
  timeZone: string,
  now: Date = new Date(),
): Promise<RecentReading[]> {
  const latest = await prisma.measurement.findMany({
    where: { userId, type, deletedAt: null },
    orderBy: { measuredAt: "desc" },
    take: RECENT_READINGS,
    select: { value: true, measuredAt: true },
  });
  const since = new Date(now.getTime() - RECENT_MIN_DAYS * DAY_MS);
  const oldest = latest.at(-1);
  if (
    latest.length < RECENT_READINGS ||
    !oldest ||
    oldest.measuredAt <= since
  ) {
    return latest.reverse();
  }
  return readWindowReadings(userId, type, since, timeZone);
}

/**
 * Every reading of the window, oldest first: the rows themselves while they
 * fit under {@link DENSE_READ_CAP}, one reading per local hour beyond it.
 */
async function readWindowReadings(
  userId: string,
  type: MeasurementType,
  since: Date,
  timeZone: string,
): Promise<RecentReading[]> {
  const count = await countReadingsUpTo({
    userId,
    type,
    since,
    cap: DENSE_READ_CAP,
  });
  if (count <= DENSE_READ_CAP) {
    return prisma.measurement.findMany({
      where: { userId, type, deletedAt: null, measuredAt: { gte: since } },
      orderBy: { measuredAt: "asc" },
      select: { value: true, measuredAt: true },
    });
  }
  annotate({
    action: { name: "insights.recent-readings.hour-cells" },
    meta: { type, cap: DENSE_READ_CAP },
  });
  const cells = await readHourCells({
    userId,
    type,
    since,
    timeZone,
    summed: isCumulativeDaySumType(type),
    bySource: false,
  });
  return cells.map((c) => ({ value: c.value, measuredAt: c.measuredAt }));
}

/**
 * The latest `perType` readings of every type in `types`, oldest first, for
 * the multi-metric overview, and never less than the last 30 days of a type:
 * the rule {@link readRecentReadings} applies to one type, applied to each.
 * It read the newest 5 000 rows across all types at once, so a dense stream
 * (pulse every few minutes) filled the whole read within days and every other
 * type fell out of the overview. One index descent per type now bounds each
 * type on its own; the descent is `readNewestRowsPerType`'s, so the statement
 * that keeps the planner on it exists once. A type whose newest `perType`
 * readings span less than 30 days (a watch's pulse fills 365 in a quarter of
 * an hour) is read over the 30 days instead, as rows or hour cells.
 */
export async function readLatestReadingsPerType(
  userId: string,
  types: readonly MeasurementType[],
  timeZone: string,
  now: Date = new Date(),
  perType: number = RECENT_READINGS,
): Promise<Array<RecentReading & { type: MeasurementType }>> {
  if (types.length === 0) return [];
  const { rows } = await readNewestRowsPerType(userId, types, {
    perTypeCap: perType,
  });
  const since = new Date(now.getTime() - RECENT_MIN_DAYS * DAY_MS);
  const byType = new Map<MeasurementType, RecentReading[]>();
  for (const r of rows) {
    const list = byType.get(r.type) ?? [];
    list.push({ value: r.value, measuredAt: r.measuredAt });
    byType.set(r.type, list);
  }
  const out: Array<RecentReading & { type: MeasurementType }> = [];
  for (const type of types) {
    const list = byType.get(type);
    if (!list) continue;
    // Oldest first, so the first row is the oldest of the newest `perType`.
    const shortWindow = list.length >= perType && list[0].measuredAt > since;
    const readings = shortWindow
      ? await readWindowReadings(userId, type, since, timeZone)
      : list;
    for (const r of readings) out.push({ type, ...r });
  }
  return out.sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
}
