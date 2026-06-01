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
import { getUserTodayBounds } from "@/lib/timezone";
import { userDayKey } from "@/lib/tz/format";

type RouteParams = { params: Promise<{ id: string }> };

/** A single effective dose slot with its derived punctuality window. */
interface SlotWindow {
  /** Minute-of-day of the slot's start time (used for nearest-slot match). */
  startMinutes: number;
  /** "HH:mm" slot start — fed to `classifyIntakeTiming` as `windowStart`. */
  windowStart: string;
  /** "HH:mm" slot end = slot start + the schedule's window span. */
  windowEnd: string;
}

const MINUTES_PER_DAY = 24 * 60;

/** Parse "HH:mm" into minute-of-day. */
function hhmmToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/** Format a minute-of-day (wrapped into 0..1439) back to "HH:mm". */
function minutesToHHmm(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * v1.8.1 B15 follow-on — expand every schedule into its effective dose
 * slots so timing classification matches against the right time-of-day.
 *
 * Candidate slot times for a schedule are its `timesOfDay` when non-empty,
 * else `[windowStart]` (so single-time schedules collapse to one slot at
 * `windowStart` and stay byte-identical to the pre-fix matcher). Each
 * slot's punctuality window is anchored at the slot time and spans the
 * schedule's `windowEnd − windowStart` duration; overnight windows
 * (`windowEnd ≤ windowStart`) add a day to the span before deriving the
 * per-slot end. Multi-schedule meds union their slots — the matcher then
 * picks the single closest slot across all of them.
 */
function buildSlotCandidates(
  schedules: { windowStart: string; windowEnd: string; timesOfDay: string[] }[],
): SlotWindow[] {
  const slots: SlotWindow[] = [];
  for (const sched of schedules) {
    const startMin = hhmmToMinutes(sched.windowStart);
    let endMin = hhmmToMinutes(sched.windowEnd);
    // Overnight window: the end is on the following day.
    if (endMin <= startMin) endMin += MINUTES_PER_DAY;
    const spanMinutes = endMin - startMin;

    const times =
      sched.timesOfDay.length > 0 ? sched.timesOfDay : [sched.windowStart];

    for (const time of times) {
      const slotStartMin = hhmmToMinutes(time);
      slots.push({
        startMinutes: slotStartMin,
        windowStart: minutesToHHmm(slotStartMin),
        // `classifyIntakeTiming` re-detects the overnight wrap from the
        // HH:mm pair, so a wrapped end formats back into 0..1439 cleanly.
        windowEnd: minutesToHHmm(slotStartMin + spanMinutes),
      });
    }
  }
  return slots;
}

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
      // v1.7.0 sync — exclude tombstoned rows from the compliance read.
      where: { medicationId: id, userId: user.id, deletedAt: null },
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
      // v1.7.0 code-correctness M1 — anchor each day's [start,end) on the
      // user-tz local-day boundary, not a UTC-midnight slice. The engine
      // applies `timesOfDay` in the user timezone, so for tz-distant users
      // a UTC slice could attach `due` / `expectedCount` to the adjacent
      // calendar cell. Anchor on a noon-local representative instant
      // (dodges the DST midnight-ambiguity edge) and key off the user-tz
      // day so the heatmap cell, the engine frame, and `dateKey` agree.
      const representative = new Date(
        now.getTime() - d * 24 * 60 * 60 * 1000 - 12 * 60 * 60 * 1000,
      );
      const { start: dayStart, end: dayEndInclusive } = getUserTodayBounds(
        representative,
        userTz,
      );
      // `getUserTodayBounds` returns an inclusive end (local 23:59:59.999);
      // the slicing loops below use a half-open `[dayStart, dayEnd)`.
      const dayEnd = new Date(dayEndInclusive.getTime() + 1);

      // Skip days before medication was created
      if (dayEnd <= createdAt) continue;

      const dateKey = userDayKey(dayStart, userTz);

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

      // v1.8.1 B15 follow-on — match each taken event to the closest
      // effective time-of-day SLOT, not merely `windowStart`. A single
      // schedule row carrying `timesOfDay = ["07:00","19:00"]` is two
      // distinct dose slots; matching the evening dose against the lone
      // `windowStart` "07:00" mis-classified it as `very_late` (~12h late)
      // and painted the heatmap cell orange even when both doses were
      // taken on time. Candidate slots for a schedule are its `timesOfDay`
      // when non-empty, else `[windowStart]` — so single-time schedules
      // collapse to exactly one candidate at `windowStart` and stay
      // byte-identical to the pre-fix behaviour. The per-slot window
      // mirrors the projector / cadence anchor: effective windowStart is
      // the slot time, effective windowEnd is the slot time plus the
      // schedule's `windowEnd − windowStart` span (overnight spans where
      // `windowEnd ≤ windowStart` add a day).
      const slotCandidates = buildSlotCandidates(medication.schedules);

      for (const evt of takenEvents) {
        if (slotCandidates.length === 0) {
          // No schedule info: treat all taken as on_time
          onTime++;
          continue;
        }

        // Match event to the closest slot window by scheduledFor time.
        const evtHour = evt.scheduledFor.getUTCHours();
        const evtMin = evt.scheduledFor.getUTCMinutes();
        const evtMinutes = evtHour * 60 + evtMin;

        let bestSlot = slotCandidates[0];
        let bestDist = Infinity;

        for (const slot of slotCandidates) {
          const dist = Math.abs(evtMinutes - slot.startMinutes);
          if (dist < bestDist) {
            bestDist = dist;
            bestSlot = slot;
          }
        }

        const timing = classifyIntakeTiming(
          evt.takenAt,
          bestSlot.windowStart,
          bestSlot.windowEnd,
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
