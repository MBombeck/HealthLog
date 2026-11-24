/**
 * v1.25 — breathing-disturbance screening read.
 *
 *   GET /api/insights/breathing-screening
 *
 * Reads the last ~30 days of per-night sleep-breathing-disturbance index
 * (`BREATHING_DISTURBANCES`) and device-flagged breathing-disturbance / apnea
 * events (`BREATHING_DISTURBANCE_EVENT`) and summarises them into a calm
 * awareness read (nights, recent mean, trend, event count, the device's own
 * classification). SCREENING SIGNAL ONLY — never a HealthLog diagnosis; the
 * card states this explicitly.
 *
 * Mirrors `/api/insights/derived`: `apiHandler`, `requireAuth`, the `sleep`
 * module gate, the shared analytics-read budget. `userId` is narrowed from the
 * session.
 */
import { apiError, apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { checkAnalyticsReadRateLimit } from "@/lib/rate-limit";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { summariseBreathing } from "@/lib/insights/breathing-screening";

export const dynamic = "force-dynamic";

const WINDOW_DAYS = 30;

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");

  // The screening belongs to sleep: with the sleep module off it hides like
  // every other sleep surface. Not an AI read, so the `insights` module (the
  // AI analysis opt-out) does not gate it.
  const m = await requireModuleEnabled(user.id, "sleep");
  if (!m.enabled) return m.response;

  const rl = await checkAnalyticsReadRateLimit(user.id);
  if (!rl.allowed) {
    return apiError("Too many analytics requests. Please retry later.", 429);
  }

  const now = new Date();
  const since = new Date(now.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const rows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      deletedAt: null,
      type: { in: ["BREATHING_DISTURBANCES", "BREATHING_DISTURBANCE_EVENT"] },
      measuredAt: { gte: since },
    },
    select: { type: true, value: true, measuredAt: true },
    orderBy: { measuredAt: "asc" },
  });

  const indexRows = rows
    .filter((r) => r.type === "BREATHING_DISTURBANCES")
    .map((r) => ({ value: r.value, measuredAt: r.measuredAt }));
  const eventRows = rows
    .filter((r) => r.type === "BREATHING_DISTURBANCE_EVENT")
    .map((r) => ({ value: r.value, measuredAt: r.measuredAt }));

  const summary = summariseBreathing(indexRows, eventRows);

  annotate({
    action: { name: "insights.breathing-screening.read" },
    meta: {
      present: summary.present,
      nights: summary.nights,
      events: summary.eventCount,
      classified: summary.classification != null,
    },
  });

  return apiSuccess({ ...summary, generatedAt: now.toISOString() });
});
