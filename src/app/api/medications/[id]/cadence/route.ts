/**
 * v1.4.25 — GLP-1 cadence + compliance read endpoint.
 *
 *   GET /api/medications/[id]/cadence?days=30
 *     - returns the schedule's 30-day (configurable) expected-vs-actual
 *       dose timeline plus the four compliance chip values that drive
 *       the detail-page section.
 *
 * Pure computation — no writes. The route delegates math to the
 * `src/lib/medications/scheduling/{cadence,compliance}` pure modules
 * so the chart, the chips, and the server agree dose-for-dose.
 *
 * Auth: cookie-session via requireAuth(); the medication is verified
 * to belong to the caller before any read.
 */

import { NextRequest } from "next/server";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { apiHandler, requireRecordAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiError, apiSuccess, returnAllZodIssues } from "@/lib/api-response";
import {
  buildCadenceTimeline,
  computeNextDose,
} from "@/lib/medications/scheduling/cadence";
import { complianceChips } from "@/lib/medications/scheduling/compliance";
import {
  buildComplianceMedicationContext,
  COMPLIANCE_LEDGER_WINDOW_DAYS,
  COURSES_COMPLIANCE_SELECT,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { dueSchedules } from "@/lib/medications/intake-tracking";

type RouteParams = { params: Promise<{ id: string }> };

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).optional(),
});

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireRecordAuth("read", "medications");
    const { id } = await params;

    // v1.4.25 — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const med = await prisma.medication.findUnique({
      where: { id },
      // v1.15.20 — schedules through the shared compliance select so the
      // configured per-dose windows reach this surface like every other.
      include: {
        schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
        // v1.16.3 — archived schedule eras for era-aware chips/tallies.
        scheduleRevisions: { orderBy: { validFrom: "asc" } },
        // The pause eras and courses, so the chips tally the ledger the
        // detail page's rate reads: a paused day or a gap between two
        // courses expects nothing.
        pauseEras: { select: { pausedAt: true, resumedAt: true } },
        courses: COURSES_COMPLIANCE_SELECT,
      },
    });
    if (!med) {
      return apiError("Medication not found", 404);
    }

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      days: url.searchParams.get("days") ?? undefined,
    });
    if (!parsed.success) {
      // v1.4.43 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }
    const windowDays = parsed.data.days ?? 30;
    const asOf = new Date();

    // The events the compliance ledger reads (its full trailing year plus a
    // day): the chips tally the same rows as the detail page, and a rolling
    // cadence re-anchors on the latest intake even when it predates the
    // chart's window.
    const from = new Date(
      asOf.getTime() -
        (COMPLIANCE_LEDGER_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000,
    );
    const events = await prisma.medicationIntakeEvent.findMany({
      where: {
        medicationId: id,
        userId: user.id,
        // v1.7.0 sync — exclude tombstoned rows from the cadence read.
        deletedAt: null,
        scheduledFor: { gte: from },
      },
      select: {
        scheduledFor: true,
        takenAt: true,
        skipped: true,
        // A dose the auto-miss job closed counts as missed, as in the rate.
        autoMissed: true,
        // v1.15.20 — pinned takes bind by anchor in the chip tally so the
        // chips agree with the % + the history on a "zugeordnet" dose.
        attributionSource: true,
      },
      orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    });

    // The cadence-anchor is the medication's createdAt for stable
    // intervalWeeks=N phasing. Falling back to `from` would re-anchor
    // every window-size change, which would make a 30-day vs 90-day
    // chart disagree on the bi-weekly grid.
    const anchor = med.createdAt;

    // v1.4.25 — resolve the user's IANA zone so the cadence
    // helpers compute every local-day boundary, window-time application,
    // and streak day-key in the user's clock instead of the host's
    // system time. A Tokyo user reading the same medication gets the
    // same chip values as a Berlin user — the host-relative day flip
    // was a sneaky bug at the 08:00-Berlin / 16:00-Tokyo intersection.
    const userTz = await resolveUserTimezone(user.id);

    // v1.7.0 — route the detail-page compliance through the
    // canonical recurrence engine so RRULE / rolling / cyclic / one-shot /
    // PRN schedules read the same expected-slot grid the dashboard tile +
    // intake path use. Without this the detail page falls back to the
    // legacy weekday walker (e.g. `FREQ=WEEKLY;BYDAY=MO` expands daily,
    // PRN counts as a real cadence) and disagrees with the dashboard.
    // Mirrors `analytics/compliance.ts`'s context construction.
    const engineCtx = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(events),
      userTz,
    );

    // v1.39.1 (#1033) — intake tracking off: no chip, no next dose.
    const liveSchedules = dueSchedules(med);
    const timeline = buildCadenceTimeline(
      liveSchedules,
      events,
      asOf,
      windowDays,
      anchor,
      userTz,
      engineCtx,
    );
    const chips = complianceChips(
      liveSchedules,
      events,
      engineCtx,
      asOf,
      windowDays,
      anchor,
    );
    const next = computeNextDose(
      liveSchedules,
      asOf,
      14,
      anchor,
      userTz,
      engineCtx,
    );

    annotate({
      action: {
        name: "medication.cadence",
        entity_type: "medication",
        entity_id: id,
      },
      meta: {
        window_days: windowDays,
        slots: timeline.length,
        adherence: chips.adherenceRate,
      },
    });

    return apiSuccess({
      windowDays,
      anchorIso: anchor.toISOString(),
      next: next
        ? {
            windowStart: next.windowStart.toISOString(),
            windowEnd: next.windowEnd.toISOString(),
            scheduleIndex: next.scheduleIndex,
          }
        : null,
      chips,
      timeline: timeline.map((p) => ({
        day: p.day.toISOString(),
        windowStart: p.windowStart.toISOString(),
        windowEnd: p.windowEnd.toISOString(),
        scheduleIndex: p.scheduleIndex,
        status: p.status,
      })),
    });
  },
);
