import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  classifyIntakeTiming,
  expectedSlotCountForDay,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import type { DailyComplianceEntry } from "@/lib/analytics/compliance";
import { assertMedicationOwnership } from "@/lib/medications/route-guards";

type RouteParams = { params: Promise<{ id: string }> };

export const GET = apiHandler(
  async (_request: Request, { params }: RouteParams) => {
    const { user } = await requireAuth();

    const { id } = await params;
    // v1.4.25 W21 Fix-N — privacy gate hoisted to the shared helper.
    const guard = await assertMedicationOwnership(id, user.id);
    if (guard) return guard;

    const medication = await prisma.medication.findUnique({
      where: { id },
      include: { schedules: true },
    });

    if (!medication) {
      return apiError("Medication not found", 404);
    }

    const events = await prisma.medicationIntakeEvent.findMany({
      where: { medicationId: id, userId: user.id },
      orderBy: { scheduledFor: "desc" },
    });

    const mapped = events.map((e) => ({
      takenAt: e.takenAt,
      skipped: e.skipped,
      scheduledFor: e.scheduledFor,
    }));

    const createdAt = medication.createdAt;

    // v1.7.0 SB-SCHED-2 — thread the medication context so the
    // denominator routes through the canonical engine (RRULE / rolling /
    // one-shot / PRN / cyclic) instead of the legacy daysOfWeek walker.
    // `lastIntakeAt` is the latest non-skipped takenAt (rolling cadences
    // re-anchor on it); the events list is already ordered scheduledFor
    // desc, so scan for the max takenAt.
    const lastIntakeAt = lastNonSkippedTakenAt(mapped);
    const userTz = user.timezone || "Europe/Berlin";
    const medicationContext = buildComplianceMedicationContext(
      medication,
      lastIntakeAt,
      userTz,
    );

    const compliance7 = calculateCompliance(mapped, medication.schedules, 7, createdAt, {
      medicationContext,
    });
    const compliance30 = calculateCompliance(
      mapped,
      medication.schedules,
      30,
      createdAt,
      { medicationContext },
    );

    // Build daily compliance map for heatmap/line chart (90 days)
    const now = new Date();
    const dailyCompliance: Record<string, DailyComplianceEntry> = {};

    for (let d = 0; d < 90; d++) {
      const dayStart = new Date(now.getTime() - (d + 1) * 24 * 60 * 60 * 1000);
      const dayEnd = new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

      // Skip days before medication was created
      if (dayEnd <= createdAt) continue;

      const dateKey = dayStart.toISOString().slice(0, 10);

      const dayEvents = mapped.filter(
        (e) => e.scheduledFor >= dayStart && e.scheduledFor < dayEnd,
      );

      const takenEvents = dayEvents.filter(
        (e) => e.takenAt !== null && !e.skipped,
      );

      // Classify timing for each taken event against the best-matching schedule
      let onTime = 0;
      let late = 0;
      let veryLate = 0;
      let early = 0;

      for (const evt of takenEvents) {
        if (medication.schedules.length === 0) {
          // No schedule info: treat all taken as on_time
          onTime++;
          continue;
        }

        // Match event to the closest schedule window by scheduledFor time
        const evtHour = evt.scheduledFor.getUTCHours();
        const evtMin = evt.scheduledFor.getUTCMinutes();

        let bestSchedule = medication.schedules[0];
        let bestDist = Infinity;

        for (const sched of medication.schedules) {
          const [sh, sm] = sched.windowStart.split(":").map(Number);
          const dist = Math.abs(evtHour * 60 + evtMin - (sh * 60 + sm));
          if (dist < bestDist) {
            bestDist = dist;
            bestSchedule = sched;
          }
        }

        const timing = classifyIntakeTiming(
          evt.takenAt,
          bestSchedule.windowStart,
          bestSchedule.windowEnd,
          dayStart, // the scheduled date
        );

        // v1.4.34 IW-C — `early` is the new compliant bucket; it counts
        // alongside `onTime` for the heatmap so a proactive logger reads
        // green. The classifier still emits a distinct `"early"` value
        // for downstream consumers that want to differentiate; the
        // separate counter is surfaced on the daily entry below.
        if (timing === "on_time") onTime++;
        else if (timing === "early") early++;
        else if (timing === "late") late++;
        else veryLate++;
      }

      // v1.7.0 item 5 — the per-day expected count is the engine's actual
      // due-slot count for THIS day, not the static schedule count. iOS
      // history paints a "missed" mark only when `due === true`, so
      // off-weeks / non-matching weekdays / PRN days no longer show a
      // false miss. `expected` is kept populated (= expectedCount) for
      // existing web consumers that read it; `due` + `expectedCount` are
      // the explicit additive fields iOS keys off.
      const expectedCount = expectedSlotCountForDay(
        medication.schedules,
        dayStart,
        dayEnd,
        medicationContext,
      );

      dailyCompliance[dateKey] = {
        expected: expectedCount,
        expectedCount,
        due: expectedCount > 0,
        taken: takenEvents.length,
        skipped: dayEvents.filter((e) => e.skipped).length,
        onTime: onTime + early,
        late,
        veryLate,
        early,
      };
    }

    annotate({
      action: {
        name: "medication.compliance",
        entity_type: "medication",
        entity_id: id,
      },
      meta: { compliance7: compliance7.rate, compliance30: compliance30.rate },
    });

    return apiSuccess({ compliance7, compliance30, dailyCompliance });
  },
);
