/**
 * GET /api/insights/presence: which Insights pages have something to show.
 *
 * The tab strip on every Insights page gates its pills on this answer alone:
 * the reading count per measurement type, and whether the record has mood
 * entries, a scheduled medication, workouts and ECG recordings. The counts are
 * the summaries slice's cell, after the record's module switches; mood and
 * medication mean what the overview means by them. A flag whose page a
 * switched-off module hides (`src/lib/modules/surface.ts`) is false, and its
 * rows are not read.
 *
 * No AI gate: every field is computed from the record. MANAGE-level read over
 * the whole record, like the overview the strip sits on.
 */
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/db";
import { readSummariesSlice } from "@/lib/analytics/summaries-slice";
import { gateSummariesByModules } from "@/lib/dashboard/widget-modules";
import { resolveModuleMap } from "@/lib/modules/gate";
import { isSurfaceVisible } from "@/lib/modules/surface";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

export const dynamic = "force-dynamic";

/** The overview's mood window: a mood pill needs an entry inside it. */
const MOOD_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const GET = apiHandler(async () => {
  const { user } = await requireRecordAuth("manage", "record");

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const modules = await resolveModuleMap(user.id);
  const shows = (slug: string) =>
    isSurfaceVisible(`insights-page:${slug}`, modules);
  const userId = user.id;
  const [slice, mood, medication, workout, ecg] = await Promise.all([
    readSummariesSlice(userId, { serveStale: true }),
    shows("mood")
      ? prisma.moodEntry.findFirst({
          where: {
            userId,
            deletedAt: null,
            moodLoggedAt: { gte: new Date(Date.now() - MOOD_WINDOW_MS) },
          },
          select: { id: true },
        })
      : null,
    // A medication with no schedule, an as-needed one or one whose intake is
    // not tracked expects no dose, so the overview lists no rate for it.
    shows("medications")
      ? prisma.medication.findFirst({
          where: {
            userId,
            active: true,
            asNeeded: false,
            ...TRACKED_INTAKE_WHERE,
            schedules: { some: {} },
          },
          select: { id: true },
        })
      : null,
    shows("workouts")
      ? prisma.workout.findFirst({ where: { userId }, select: { id: true } })
      : null,
    prisma.ecgRecording.findFirst({ where: { userId }, select: { id: true } }),
  ]);

  const { summaries } = gateSummariesByModules(
    slice.summaries,
    slice.lastSeenByType,
    modules,
  );
  const metrics: Record<string, { count: number }> = {};
  for (const [type, summary] of Object.entries(summaries)) {
    if (summary.count > 0) metrics[type] = { count: summary.count };
  }

  annotate({
    action: { name: "insights.presence.read" },
    meta: { metrics: Object.keys(metrics).length },
  });

  return apiSuccess({
    metrics,
    hasMood: mood !== null,
    hasMedication: medication !== null,
    hasWorkouts: workout !== null,
    hasEcgRecordings: ecg !== null,
  });
});
