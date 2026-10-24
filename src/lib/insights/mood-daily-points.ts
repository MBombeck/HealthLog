/**
 * The per-day mood points the Coach's mood block is built from: the rollup
 * DAY tier when it holds rows, a walk over the raw entries otherwise.
 * Split out of `features.ts`, which builds the block from them.
 */
import { prisma } from "@/lib/db";
import { runDetached } from "@/lib/logging/detached";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";
import { dateOnlyKey } from "@/lib/tz/date-only";

export interface MoodDayPoint {
  measuredAt: Date;
  /** The entry's own calendar day label (`MoodEntry.date`). */
  dayKey: string;
  value: number;
  count: number;
}

/**
 * The rollup tier first, never an unbounded read of the entries. The mood
 * block downstream consumes the 7- and 30-day means, the 30-day trend (first
 * half against second half), the newest entry's score (one bounded row), the
 * entry count (the sum of the DAY rows' counts), the oldest and newest day,
 * and one per-day mean point for the cross-metric correlations.
 *
 * When raw entries exist but the tier is still empty (an account the boot
 * backfill has not reached), the points come from a walk over the same
 * window, and the refresh is fired so the next read lands on the tier. Same
 * posture as `/api/mood/analytics`.
 */
export async function readMoodDailyPoints(
  userId: string,
  /** The Coach's lookback floor, or null. */
  historyFloor: Date | null,
): Promise<{
  points: MoodDayPoint[];
  totalEntries: number;
  latestScore: number | null;
}> {
  trackBackgroundTask(runDetached(() => ensureUserMoodRollupsFresh(userId)));
  // Five-year window mirrors the mood-rollup writer default; covers
  // every realistic user history span without an unbounded scan.
  const fiveYearsAgo = new Date(Date.now() - 5 * 365 * 24 * 60 * 60 * 1000);
  const moodSince =
    historyFloor && historyFloor > fiveYearsAgo ? historyFloor : fiveYearsAgo;
  const moodRollupDayRows = await readMoodDayRollups(userId, moodSince);

  let moodDailyPoints: MoodDayPoint[] = [];
  let moodLatestScore: number | null = null;
  let moodTotalEntries = 0;

  if (moodRollupDayRows.length > 0) {
    moodDailyPoints = moodRollupDayRows.map((r) => ({
      measuredAt: r.bucketStart,
      // The rollup encodes the day label as that label's UTC midnight.
      dayKey: dateOnlyKey(r.bucketStart),
      value: r.mean,
      count: r.count,
    }));
    moodTotalEntries = moodRollupDayRows.reduce((s, r) => s + r.count, 0);
    // Latest score = newest individual entry (one bounded row).
    const latestEntry = await prisma.moodEntry.findFirst({
      // Tombstoned rows are not entries.
      where: {
        userId,
        deletedAt: null,
        ...(historyFloor ? { moodLoggedAt: { gte: historyFloor } } : {}),
      },
      orderBy: { moodLoggedAt: "desc" },
      select: { score: true },
    });
    moodLatestScore = latestEntry?.score ?? null;
  } else {
    // Coverage-fallback over the same window the rollup read covers
    // (`moodSince`, five years). A one-year fallback answered the same
    // question with a different history while the tier was warming up;
    // mood entries are a few a day, so five years stays a bounded read.
    const moodEntriesRaw = await prisma.moodEntry.findMany({
      // Tombstoned rows are not entries.
      where: { userId, deletedAt: null, moodLoggedAt: { gte: moodSince } },
      orderBy: { moodLoggedAt: "asc" },
      select: { score: true, moodLoggedAt: true, date: true },
    });
    if (moodEntriesRaw.length > 0) {
      // Bucket per `date` (TZ-anchored YYYY-MM-DD label, same key the
      // rollup tier would emit for Berlin-anchored single-entry days)
      // so the fallback shape matches the rollup-tier shape.
      const byDay = new Map<
        string,
        { dayKey: string; sum: number; count: number; ts: Date }
      >();
      for (const e of moodEntriesRaw) {
        const k = e.date;
        const cur = byDay.get(k) ?? {
          dayKey: k,
          sum: 0,
          count: 0,
          ts: e.moodLoggedAt,
        };
        cur.sum += e.score;
        cur.count += 1;
        // Pin the bucket's measuredAt to the latest entry's timestamp
        // — close enough for the trailing-window filters below.
        if (e.moodLoggedAt > cur.ts) cur.ts = e.moodLoggedAt;
        byDay.set(k, cur);
      }
      moodDailyPoints = Array.from(byDay.values())
        .map((b) => ({
          measuredAt: b.ts,
          dayKey: b.dayKey,
          value: b.sum / b.count,
          count: b.count,
        }))
        .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
      moodTotalEntries = moodEntriesRaw.length;
      moodLatestScore = moodEntriesRaw[moodEntriesRaw.length - 1].score;
    }
  }

  return {
    points: moodDailyPoints,
    totalEntries: moodTotalEntries,
    latestScore: moodLatestScore,
  };
}
