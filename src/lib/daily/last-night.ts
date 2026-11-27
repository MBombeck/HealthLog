/**
 * Last night, read one way by the morning and by the digest.
 *
 * Neutral ground between the two: the morning loader and the digest loader
 * both import this, and neither imports the other (the digest feeds the
 * reaction-line evidence and the daily push, which stay clear of the morning
 * loader; see `morning-model-free-guard.test.ts`). Both read the night
 * through `readLastNight`, by the one rule in `@/lib/sleep/last-night`;
 * neither reads the other's cache cell. Nothing here is model-written.
 */
import { cachedSwr, caches, type ServerCache } from "@/lib/cache/server-cache";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";
import { isSleepExpected } from "@/lib/daily/digest";
import { prisma } from "@/lib/db";
import { reconstructSleepNights } from "@/lib/analytics/sleep-night";
import { annotate } from "@/lib/logging/context";
import { DASHBOARD_REFETCH_INTERVAL_MS } from "@/lib/queries/refetch-interval";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import {
  lastNightOnRecord,
  resolveLastNight,
  type LastNight,
  type NightOnRecord,
} from "@/lib/sleep/last-night";

/** How long a morning cell, and the night cell beside it, serves. */
export const MORNING_CACHE_TTL_MS = DASHBOARD_REFETCH_INTERVAL_MS + 60_000;

/** The prefix of the morning's day cells; a refresh evicts by it. */
export function morningCacheKey(userId: string, dateKey: string): string {
  return `${userId}|daily-morning|${dateKey}`;
}

/** How far back the night read looks: a long night's first rows included. */
const NIGHT_READ_MS = 72 * 3600_000;

/**
 * The latest night on record (`lastNightOnRecord`), read once per user and
 * day and shared by the morning and the digest, so the two never read the
 * night two ways. The cell sits under the morning's prefix, so the refresh
 * that follows a night's arrival evicts it with the morning's.
 */
export function readLastNight(
  userId: string,
  tz: string,
  todayKey: string,
  now: Date,
): Promise<NightOnRecord | null> {
  return cachedSwr(
    caches.analytics as ServerCache<NightOnRecord | null>,
    `${morningCacheKey(userId, todayKey)}|night`,
    async () => {
      const [rows, priorityJson] = await Promise.all([
        prisma.measurement.findMany({
          where: {
            userId,
            type: "SLEEP_DURATION",
            deletedAt: null,
            measuredAt: {
              gte: new Date(now.getTime() - NIGHT_READ_MS),
              lte: now,
            },
          },
          orderBy: { measuredAt: "asc" },
          select: {
            value: true,
            measuredAt: true,
            sleepStage: true,
            source: true,
            deviceType: true,
            timeZone: true,
          },
        }),
        loadUserSourcePriority(userId),
      ]);
      const latest = lastNightOnRecord(
        reconstructSleepNights(rows, tz, priorityJson),
        (n) => n.mainSession !== null,
      );
      return latest
        ? {
            night: latest.night,
            asleepMinutes: Math.round(latest.asleepMinutes),
          }
        : null;
    },
    annotate,
    MORNING_CACHE_TTL_MS,
  );
}

/**
 * Last night as the morning and the digest both read it: whether sleep is
 * expected at all from the snapshot's last-seen slot, its usual length from
 * the snapshot's 30-day mean, and whether last night is in by the one rule
 * (`resolveLastNight`) from the night `readLastNight` read. Pure.
 */
export function lastNightFromSnapshot(args: {
  snapshot: Pick<DashboardSnapshot, "tiles">;
  todayKey: string;
  sleepOn: boolean;
  morningRefreshedToday: boolean;
  night: NightOnRecord | null;
}): { lastNight: LastNight; sleepExpected: boolean } {
  const { snapshot, todayKey, sleepOn } = args;
  const sleepSlot = snapshot.tiles.lastSeenByType["SLEEP_DURATION"];
  const sleepExpected =
    sleepOn && isSleepExpected(sleepSlot ? sleepSlot.daysAgo : null);
  const avg30 = snapshot.tiles.summaries?.SLEEP_DURATION?.avg30;
  const lastNight = resolveLastNight({
    todayKey,
    sleepOn,
    sleepExpected,
    morningRefreshedToday: args.morningRefreshedToday,
    night: args.night,
    usualMinutes:
      avg30 !== null && avg30 !== undefined && avg30 > 0 ? avg30 : null,
  });
  return { lastNight, sleepExpected };
}

/** The key of the morning's day cell for this module state. */
export function morningExtrasCacheKey(
  userId: string,
  todayKey: string,
  modules: { sleep: boolean; recovery: boolean },
): string {
  return `${morningCacheKey(userId, todayKey)}|${modules.sleep ? "s" : "-"}${modules.recovery ? "r" : "-"}`;
}
