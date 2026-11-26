/**
 * Last night, read one way by the morning and by the digest.
 *
 * Neutral ground between the two: the morning loader and the digest loader
 * both import this, and neither imports the other (the digest feeds the
 * reaction-line evidence and the daily push, which stay clear of the morning
 * loader; see `morning-model-free-guard.test.ts`). Nothing here is
 * model-written: a sleep row's wake day and the sleep score's night.
 */
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import type { DashboardSnapshot } from "@/lib/dashboard/snapshot";
import { isSleepExpected } from "@/lib/daily/digest";
import {
  resolveLastNight,
  type LastNight,
  type MorningSleepScore,
} from "@/lib/daily/morning";
import { userDayKey } from "@/lib/tz/format";

/** The prefix of the morning's day cells; a refresh evicts by it. */
export function morningCacheKey(userId: string, dateKey: string): string {
  return `${userId}|daily-morning|${dateKey}`;
}

/**
 * Last night as the morning and the digest both read it: whether sleep is
 * expected at all from the snapshot's last-seen slot, and whether last night
 * is in by one rule (`resolveLastNight`), from the sleep score's night when
 * there is one, else the latest sleep row's wake day. Pure.
 */
export function lastNightFromSnapshot(args: {
  snapshot: Pick<DashboardSnapshot, "tiles">;
  tz: string;
  todayKey: string;
  sleepOn: boolean;
  morningRefreshedToday: boolean;
  sleepScore: MorningSleepScore | null;
}): { lastNight: LastNight; sleepExpected: boolean } {
  const { snapshot, tz, todayKey, sleepOn, sleepScore } = args;
  const sleepSlot = snapshot.tiles.lastSeenByType["SLEEP_DURATION"];
  const sleepLastSeenDaysAgo = sleepSlot ? sleepSlot.daysAgo : null;
  const sleepExpected = sleepOn && isSleepExpected(sleepLastSeenDaysAgo);
  const sleepSummary = snapshot.tiles.summaries?.SLEEP_DURATION;
  const lastNight = resolveLastNight({
    todayKey,
    sleepOn,
    sleepExpected,
    morningRefreshedToday: args.morningRefreshedToday,
    sleepScore: sleepScore
      ? {
          night: sleepScore.night,
          asleepMinutes:
            sleepScore.asleepMinutes ??
            (sleepSlot &&
            userDayKey(new Date(sleepSlot.lastSeenAt), tz) === sleepScore.night
              ? (sleepSummary?.latest ?? 0)
              : 0),
        }
      : null,
    latestSleep: sleepSlot
      ? {
          wakeDay: userDayKey(new Date(sleepSlot.lastSeenAt), tz),
          minutes: sleepSummary?.latest ?? null,
        }
      : null,
    usualMinutes:
      sleepSummary?.avg30 !== null &&
      sleepSummary?.avg30 !== undefined &&
      sleepSummary.avg30 > 0
        ? sleepSummary.avg30
        : null,
  });
  return { lastNight, sleepExpected };
}

/**
 * The sleep score the morning holds for today, without computing one: the
 * morning's own cell, fresh or stale, exactly what the morning would serve on
 * its next read. Null when the morning has not been read today. The digest
 * reads last night through this so the two agree without the digest paying
 * the morning's reads.
 */
export function peekMorningSleepScore(
  userId: string,
  todayKey: string,
  modules: { sleep: boolean; recovery: boolean },
): MorningSleepScore | null {
  if (!modules.sleep) return null;
  const hit = (
    caches.analytics as ServerCache<{ sleepScore: MorningSleepScore | null }>
  ).getAllowStale(morningExtrasCacheKey(userId, todayKey, modules));
  return hit?.value.sleepScore ?? null;
}

/** The key of the morning's day cell for this module state. */
export function morningExtrasCacheKey(
  userId: string,
  todayKey: string,
  modules: { sleep: boolean; recovery: boolean },
): string {
  return `${morningCacheKey(userId, todayKey)}|${modules.sleep ? "s" : "-"}${modules.recovery ? "r" : "-"}`;
}
