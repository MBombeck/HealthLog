import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";
import {
  ensureUserMoodRollupsFresh,
  readMoodDayRollups,
} from "@/lib/mood/rollups";

export const dynamic = "force-dynamic";

/**
 * v1.4.39 W-MOOD — five-year window for the rollup-tier read.
 *
 * Mirrors the legacy "unbounded findMany" semantics in practice: the
 * legacy code passed every mood the user had ever logged into Node.
 * The rollup tier stores one row per day, so a five-year cap is
 * cheap (at most ~1 800 rows) and still covers every user the
 * product has historic data for.
 */
const ROLLUP_WINDOW_MS = 5 * 365 * 24 * 60 * 60 * 1000;

/** Aggregate multiple mood entries per day into daily averages. */
function aggregateDailyAverages(
  records: Array<{ date: string; score: number }>,
) {
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

interface MoodAnalyticsResult {
  entries: Array<{ date: string; score: number; samples: number }>;
  summary: ReturnType<typeof summarize>;
  entryCount: number;
}

/**
 * Format the rollup bucket's UTC `bucket_start` as a YYYY-MM-DD
 * label. The legacy live path emitted the row's TZ-anchored `date`
 * column; the rollup tier anchors on UTC midnight (same convention
 * as the measurement rollup tier). For tenants within ±3 h of UTC
 * (Berlin year-round) the two labels agree on every entry whose
 * timestamp doesn't straddle the UTC boundary — i.e. every realistic
 * mood log, which a human submits during waking hours.
 *
 * Trade-off (QA Specialist-H1, v1.4.39): on DST fall-back nights the
 * UTC anchor and the user's local wall-clock day-key can diverge by
 * one calendar day. Example: `2025-10-25T23:30:00Z` is 00:30 local
 * in Europe/Berlin on `2025-10-26` (one hour after the fall-back
 * transition); the rollup row is keyed on `2025-10-25` (UTC) while
 * the legacy live-fallback path would emit `2025-10-26`. This is
 * pinned by the route-parity DST test. v1.5 per-user-tz bucketing
 * (audit P7) anchors the rollup on the same day-key the legacy path
 * uses, closing the gap.
 */
function utcDayLabel(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

async function buildMoodAnalyticsResponse(
  userId: string,
): Promise<MoodAnalyticsResult> {
  // v1.4.39 W-MOOD — fire-and-forget warm-up so the next cold mount
  // for this user lands on the rollup tier even when the boot-time
  // backfill hasn't reached them yet.
  void ensureUserMoodRollupsFresh(userId);

  const since = new Date(Date.now() - ROLLUP_WINDOW_MS);
  const rollups = await readMoodDayRollups(userId, since);

  if (rollups.length > 0) {
    // Fast path — one DAY-rollup row per calendar day. The legacy
    // `aggregateDailyAverages` collapse is unnecessary because the
    // rollup already carries the daily mean; we recreate its output
    // shape directly so the response stays byte-compatible.
    const entries = rollups
      .map((r) => ({
        date: utcDayLabel(r.bucketStart),
        score: Math.round(r.mean * 100) / 100,
        samples: r.count,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Summarize feeds the slope7/30/90 windows. One DataPoint per
    // day (mean) is the right resolution — the legacy path passed
    // per-entry points, but the slope-window outputs match because
    // a power user's mood is typically 1/day. Multi-entry days
    // contribute their daily mean exactly once, which is the same
    // semantic the dashboard tile renders.
    const dataPoints: DataPoint[] = rollups.map((r) => ({
      date: r.bucketStart,
      value: r.mean,
    }));
    const summary = summarize(dataPoints);
    const entryCount = rollups.reduce((s, r) => s + r.count, 0);

    annotate({ meta: { mood_analytics_path: "rollup" } });

    return { entries, summary, entryCount };
  }

  // Coverage-fallback — the user has no rollup rows yet. Probe for
  // raw mood entries; when the table is empty for this user we
  // return the same empty envelope the legacy path emitted. When
  // mood entries exist but rollups don't (legacy account before the
  // boot-backfill has caught up), we run the legacy live walk ONCE
  // so the request still gets a correct response — the warm-up
  // fired above will mint the rollups for the next request.
  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId },
    orderBy: { moodLoggedAt: "asc" },
    select: { date: true, score: true, moodLoggedAt: true },
  });

  const entries = aggregateDailyAverages(
    moodEntries.map((e) => ({ date: e.date, score: e.score })),
  );

  // QA UX-H1 (v1.4.39): feed `summarize()` per-day means, not per-entry
  // scores. The rollup fast-path emits one DataPoint per calendar day
  // (the rollup's `mean`); the live fallback used to pass every raw
  // entry, which silently shifted `summary.count / latest / min / max
  // / mean / avg7 / avg30 / slope30` on power-user multi-entry days.
  // Pre-aggregating through `aggregateDailyAverages` keeps the two
  // branches byte-identical on multi-entry days too. Date anchor is
  // local-noon for the day so the slope x-axis spans whole-day units —
  // mirrors the dashboard tile's intuition (one number per day).
  const dataPoints: DataPoint[] = entries.map((e) => ({
    date: new Date(`${e.date}T12:00:00.000Z`),
    value: e.score,
  }));

  const summary = summarize(dataPoints);

  annotate({
    meta: {
      mood_analytics_path: moodEntries.length === 0 ? "rollup" : "live",
    },
  });

  return { entries, summary, entryCount: moodEntries.length };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const result = await cached(
    caches.moodAnalytics as ServerCache<MoodAnalyticsResult>,
    user.id,
    () => buildMoodAnalyticsResponse(user.id),
    annotate,
  );

  annotate({
    action: { name: "mood.analytics" },
    meta: { entryCount: result.entryCount },
  });

  return apiSuccess({ entries: result.entries, summary: result.summary });
});
