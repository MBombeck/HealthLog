/**
 * v1.4.25 W19e — GLP-1 cadence + compliance read endpoint.
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
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import {
  apiError,
  apiSuccess,
  returnAllZodIssues,
} from "@/lib/api-response";
import {
  buildCadenceTimeline,
  computeNextDose,
} from "@/lib/medications/scheduling/cadence";
import { complianceChips } from "@/lib/medications/scheduling/compliance";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";
import { resolveUserTimezone } from "@/lib/tz/resolver";

type RouteParams = { params: Promise<{ id: string }> };

const querySchema = z.object({
  days: z.coerce.number().int().min(1).max(180).optional(),
});

export const GET = apiHandler(
  async (request: NextRequest, { params }: RouteParams) => {
    const { user } = await requireAuth();
    const { id } = await params;

    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const med = await prisma.medication.findUnique({
      where: { id },
      include: { schedules: true },
    });
    if (!med) {
      return apiError("Medication not found", 404);
    }

    const url = new URL(request.url);
    const parsed = querySchema.safeParse({
      days: url.searchParams.get("days") ?? undefined,
    });
    if (!parsed.success) {
      // v1.4.43 W6 — multi-issue 422.
      return returnAllZodIssues(parsed.error, 422);
    }
    const windowDays = parsed.data.days ?? 30;
    const asOf = new Date();

    // Pull intake events covering the window + a small buffer so a dose
    // logged at the edge can still pair with its slot.
    const bufferMs = 24 * 60 * 60 * 1000;
    const from = new Date(asOf.getTime() - windowDays * 24 * 60 * 60 * 1000 - bufferMs);
    const events = await prisma.medicationIntakeEvent.findMany({
      where: {
        medicationId: id,
        userId: user.id,
        scheduledFor: { gte: from },
      },
      select: { scheduledFor: true, takenAt: true, skipped: true },
      orderBy: { scheduledFor: "asc" },
    });

    // The cadence-anchor is the medication's createdAt for stable
    // intervalWeeks=N phasing. Falling back to `from` would re-anchor
    // every window-size change, which would make a 30-day vs 90-day
    // chart disagree on the bi-weekly grid.
    const anchor = med.createdAt;

    // v1.4.25 W21 Fix-O — resolve the user's IANA zone so the cadence
    // helpers compute every local-day boundary, window-time application,
    // and streak day-key in the user's clock instead of the host's
    // system time. A Tokyo user reading the same medication gets the
    // same chip values as a Berlin user — the host-relative day flip
    // was a sneaky bug at the 08:00-Berlin / 16:00-Tokyo intersection.
    const userTz = await resolveUserTimezone(user.id);

    const timeline = buildCadenceTimeline(
      med.schedules,
      events,
      asOf,
      windowDays,
      anchor,
      userTz,
    );
    const chips = complianceChips(
      med.schedules,
      events,
      asOf,
      windowDays,
      anchor,
      userTz,
    );
    const next = computeNextDose(med.schedules, asOf, 14, anchor, userTz);

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
