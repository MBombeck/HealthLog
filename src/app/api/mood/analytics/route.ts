import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";

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

export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId: sessionData.user.id },
    orderBy: { moodLoggedAt: "asc" },
    select: { date: true, score: true, moodLoggedAt: true },
  });

  const entries = aggregateDailyAverages(
    moodEntries.map((e) => ({ date: e.date, score: e.score })),
  );

  // Build DataPoint array for summarize() using moodLoggedAt as the date
  const dataPoints: DataPoint[] = moodEntries.map((e) => ({
    date: e.moodLoggedAt,
    value: e.score,
  }));

  const summary = summarize(dataPoints);

  return apiSuccess({ entries, summary });
}
