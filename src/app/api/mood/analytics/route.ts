import { prisma } from "@/lib/db";
import { apiSuccess } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { cached, caches, type ServerCache } from "@/lib/cache/server-cache";

export const dynamic = "force-dynamic";

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

async function buildMoodAnalyticsResponse(
  userId: string,
): Promise<MoodAnalyticsResult> {
  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId },
    orderBy: { moodLoggedAt: "asc" },
    select: { date: true, score: true, moodLoggedAt: true },
  });

  const entries = aggregateDailyAverages(
    moodEntries.map((e) => ({ date: e.date, score: e.score })),
  );

  const dataPoints: DataPoint[] = moodEntries.map((e) => ({
    date: e.moodLoggedAt,
    value: e.score,
  }));

  const summary = summarize(dataPoints);

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
