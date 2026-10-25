/**
 * v1.17.1 — single mood daily-series engine.
 *
 * Before this module the dashboard snapshot (`buildMoodBlock` in
 * `src/lib/dashboard/snapshot.ts`) and the `/api/mood/analytics` route
 * (`buildMoodAnalyticsResponse`) each carried a hand-copied rollup read +
 * coverage fallback + `summarize()` of the same numbers. Two engines for
 * one metric is the classic seam where the dashboard and the insights
 * surface can read mood differently. This module is the one canonical
 * read; both callers delegate to it so the same number reads identically
 * on the dashboard, the insights mood sparkline, and the iOS client.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { runDetached } from "@/lib/logging/detached";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/rollups/mood-rollups";

/**
 * Five-year window for the rollup-tier read. The rollup tier stores one
 * row per day, so a five-year cap is cheap (at most ~1 800 rows) and
 * still covers every user the product has historic data for. The legacy
 * route + snapshot both used this same window.
 */
export const MOOD_SERIES_WINDOW_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** One daily mood point: the day's average score + how many entries fed it. */
export interface MoodDailyEntry {
  date: string;
  score: number;
  samples: number;
}

export interface MoodDailySeries {
  entries: MoodDailyEntry[];
  summary: ReturnType<typeof summarize>;
  /** Total raw mood entries behind the series (sum of `samples`). */
  entryCount: number;
  /** Which tier answered — for wide-event annotation by the caller. */
  source: "rollup" | "live";
}

/**
 * Format a rollup `bucketStart` as a YYYY-MM-DD label from its UTC
 * calendar parts. Since v1.32.12 the mood rollup writer stores
 * `bucketStart` as the UTC-midnight encoding of the canonical per-row
 * `MoodEntry.date` label, so reading the UTC parts back yields exactly
 * that label — byte-identical to the live `entry.date` fallback below,
 * across every timezone and DST boundary. (Before v1.32.12 the writer
 * UTC-truncated `mood_logged_at`, which shifted the day for any local
 * mood straddling the UTC boundary; that gap is now closed.)
 */
function utcDayLabel(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Aggregate multiple raw mood entries per day into daily averages. */
function aggregateDailyAverages(
  records: Array<{ date: string; score: number }>,
): MoodDailyEntry[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const record of records) {
    const current = byDay.get(record.date) ?? { sum: 0, count: 0 };
    current.sum += record.score;
    current.count += 1;
    byDay.set(record.date, current);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({
      date: day,
      score: Math.round((stats.sum / stats.count) * 100) / 100,
      samples: stats.count,
    }));
}

/**
 * Canonical mood daily series for a user. Rollup fast-path first; a single
 * live walk only on coverage miss (and the warm-up below mints the rollups
 * for the next read). Feeds `summarize()` per-day means in both branches so
 * the slope/latest/min/max windows are byte-identical on multi-entry days.
 *
 * `client` lets the snapshot builder pass its own Prisma handle; defaults to
 * the shared singleton for the route caller.
 */
export async function buildMoodDailySeries(
  userId: string,
  client: PrismaClient = prisma,
): Promise<MoodDailySeries> {
  // Fire-and-forget warm-up so the next cold mount for this user lands on
  // the rollup tier even when the boot-time backfill hasn't reached them.
  // Registered so a caller that must know when the request's work is over
  // (the suite's settle hook, the statement counter) can await it.
  trackBackgroundTask(runDetached(() => ensureUserMoodRollupsFresh(userId)));

  const since = new Date(Date.now() - MOOD_SERIES_WINDOW_MS);
  const rollups = await readMoodDayRollups(userId, since);

  if (rollups.length > 0) {
    const entries = rollups
      .map((r) => ({
        date: utcDayLabel(r.bucketStart),
        score: Math.round(r.mean * 100) / 100,
        samples: r.count,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const dataPoints: DataPoint[] = rollups.map((r) => ({
      date: r.bucketStart,
      value: r.mean,
    }));
    const summary = summarize(dataPoints);
    const entryCount = rollups.reduce((s, r) => s + r.count, 0);
    return { entries, summary, entryCount, source: "rollup" };
  }

  // Coverage fallback — no rollup rows yet. Run the live walk ONCE over the
  // same window the rollup read covers; the warm-up above mints the rollups
  // for the next request.
  const moodEntries = await client.moodEntry.findMany({
    // v1.7.0 sync — exclude tombstoned rows from the fallback.
    where: { userId, deletedAt: null, moodLoggedAt: { gte: since } },
    orderBy: { moodLoggedAt: "asc" },
    select: { date: true, score: true },
  });

  const entries = aggregateDailyAverages(
    moodEntries.map((e: { date: string; score: number }) => ({
      date: e.date,
      score: e.score,
    })),
  );

  // Date anchor is local-noon for the day so the slope x-axis spans
  // whole-day units — mirrors the dashboard tile's one-number-per-day.
  const dataPoints: DataPoint[] = entries.map((e) => ({
    date: new Date(`${e.date}T12:00:00.000Z`),
    value: e.score,
  }));
  const summary = summarize(dataPoints);

  // An empty table reads as "rollup" (nothing to walk) for annotation
  // parity with the historic route; a non-empty live walk reads "live".
  return {
    entries,
    summary,
    entryCount: moodEntries.length,
    source: moodEntries.length === 0 ? "rollup" : "live",
  };
}
