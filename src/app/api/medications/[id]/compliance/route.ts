import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  calculateCompliance,
  classifyIntakeTiming,
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
    const compliance7 = calculateCompliance(
      mapped,
      medication.schedules,
      7,
      createdAt,
    );
    const compliance30 = calculateCompliance(
      mapped,
      medication.schedules,
      30,
      createdAt,
    );

    // Build daily compliance map for heatmap/line chart (90 days)
    const now = new Date();
    const schedulesPerDay = medication.schedules.length;
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

        if (timing === "on_time") onTime++;
        else if (timing === "late") late++;
        else veryLate++;
      }

      dailyCompliance[dateKey] = {
        expected: schedulesPerDay,
        taken: takenEvents.length,
        skipped: dayEvents.filter((e) => e.skipped).length,
        onTime,
        late,
        veryLate,
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
