/**
 * The overview's 90-day mood series, read from the mood-rollup DAY tier.
 *
 * The two consumers downstream — `dailyMoodEntries` for the mood × metric
 * correlations and the mood summary for the dashboard mood block — read at a
 * per-day resolution, which is precisely the shape the rollup writer emits,
 * so the tier replaces an unbounded `prisma.moodEntry.findMany`.
 *
 * Coverage-fallback: when the user has mood entries but zero rollup rows yet
 * (legacy account before the boot-time backfill has caught up), fall back to
 * a bounded 90-day raw walk once and fire the warm-up so the next request
 * lands on the rollup tier. Same posture as `/api/mood/analytics`.
 *
 * The mood rollup writer mints `bucketStart` from the canonical local
 * `MoodEntry.date` label at UTC midnight, so `.toISOString().slice(0, 10)`
 * recovers the user's LOCAL calendar day — byte-identical to the live
 * fallback's `entry.date`. Both mood paths therefore emit local-day keys, and
 * the mood × metric pairing partners (sys BP, weight, resting pulse) are
 * derived in the user's tz so both join sides share ONE local-day key space.
 * The measurement-rollup tier itself still buckets UTC (`dailyByType`); the
 * two internally-consistent UTC joins (weight × BP, BP-med continuity) are
 * left on it deliberately (see their call sites in `build.ts`).
 */
import { prisma } from "@/lib/db";
import { runDetached } from "@/lib/logging/detached";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import type { DataPoint } from "@/lib/analytics/trends";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";
import {
  foldMoodEntriesToDays,
  type MoodDayRow,
} from "@/lib/rollups/mood-day-fold";
import { dateOnlyKey } from "@/lib/tz/date-only";

import type { DailyValue } from "./daily-series";

export interface OverviewMoodSeries {
  dailyMoodEntries: DailyValue[];
  moodDataPoints: DataPoint[];
  moodEntryCount: number;
}

export async function readOverviewMoodSeries(
  userId: string,
  since: Date,
): Promise<OverviewMoodSeries> {
  trackBackgroundTask(runDetached(() => ensureUserMoodRollupsFresh(userId)));
  const rollupDays = await readMoodDayRollups(userId, since);
  // Coverage-fallback: legacy account with mood entries but no rollup
  // coverage yet. Bounded by the caller's window so the walk is capped even
  // when the rollup miss happens, and folded into the rows the tier would
  // hold so both paths feed `summarize()` the same points.
  const days: ReadonlyArray<MoodDayRow> =
    rollupDays.length > 0
      ? rollupDays
      : foldMoodEntriesToDays(
          await prisma.moodEntry.findMany({
            // Tombstoned rows are excluded.
            where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
            orderBy: { moodLoggedAt: "asc" },
            select: { date: true, score: true },
          }),
        );
  return {
    dailyMoodEntries: days.map((r) => ({
      day: dateOnlyKey(r.bucketStart),
      value: Math.round(r.mean * 100) / 100,
    })),
    moodDataPoints: days.map((r) => ({
      date: r.bucketStart,
      value: r.mean,
    })),
    moodEntryCount: days.reduce((s, r) => s + r.count, 0),
  };
}
