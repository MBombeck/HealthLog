/**
 * v1.10.0 — device-flagged event awareness route (categorical events,
 * WX-B).
 *
 * `GET /api/insights/rhythm-events` returns the authenticated user's
 * timeline of device-flagged EVENT rows — irregular-rhythm /
 * high-HR / low-HR / walking-steadiness / breathing-disturbance
 * notifications the user's wearable (Apple Watch / Withings ScanWatch)
 * already produced and synced.
 *
 * Regulatory framing (load-bearing): this surface is AWARENESS / SCREENING
 * of the DEVICE's own decision. HealthLog stores and reflects ONLY the
 * classification RESULT the device's FDA-cleared / CE-marked on-device
 * algorithm emitted. It never ingests a raw ECG waveform, never
 * re-classifies, and never produces a HealthLog diagnosis. The verdict the
 * client renders (`rhythmClassification`) is the device's, verbatim.
 *
 * Data-availability-gated by construction: an account with no event rows
 * gets `{ events: [], hasEvents: false }`, and the client un-mounts the
 * whole surface rather than painting an empty / alarming card.
 *
 * Follows the `metric-status` / `derived` route precedent: `apiHandler`
 * wrapper, cookie OR Bearer auth, `userId` narrowed from the session
 * (never a query field), the `insightStatus` assistant-surface gate (no AI
 * provider call — this is a pure DB read).
 */
import { apiSuccess } from "@/lib/api-response";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { requireModuleEnabled } from "@/lib/modules/gate";
import { prisma } from "@/lib/db";
import { EVENT_MEASUREMENT_TYPES } from "@/lib/validations/measurement";
import type { MeasurementType } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

// Cap the returned timeline. A healthy account produces a handful of
// these a year; the cap is a defensive bound, not an expected ceiling.
const MAX_EVENTS = 200;

const EVENT_TYPE_LIST = Array.from(
  EVENT_MEASUREMENT_TYPES,
) as MeasurementType[];

export const GET = apiHandler(async () => {
  // v1.37.0 — MANAGE-level read: computed over the whole record, with no
  // provider anywhere on the path.
  const { user } = await requireRecordAuth("manage", "record");
  const m = await requireModuleEnabled(user.id, "insights");
  if (!m.enabled) return m.response;
  // A pure read of the device's own verdicts, so no assistant-surface gate.

  const rows = await prisma.measurement.findMany({
    where: {
      userId: user.id,
      type: { in: EVENT_TYPE_LIST },
      deletedAt: null,
    },
    select: {
      id: true,
      type: true,
      rhythmClassification: true,
      measuredAt: true,
      source: true,
      deviceType: true,
    },
    orderBy: { measuredAt: "desc" },
    take: MAX_EVENTS,
  });

  const events = rows.map((r) => ({
    id: r.id,
    type: r.type,
    classification: r.rhythmClassification,
    occurredAt: r.measuredAt.toISOString(),
    source: r.source,
    deviceType: r.deviceType,
  }));

  annotate({
    action: { name: "insights.rhythm-events" },
    meta: { count: events.length },
  });

  return apiSuccess({
    events,
    hasEvents: events.length > 0,
  });
});
