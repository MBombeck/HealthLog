/**
 * v1.7.0 SB-SCHED-3 — server-computed `nextDueAt`.
 *
 * Stops the iOS client re-implementing the recurrence engine: the
 * server computes the next due instant per medication by asking the
 * canonical engine (`nextOccurrenceAfter`) for each schedule and taking
 * the earliest. Pure / synchronous — the caller fetches `lastIntakeAt`
 * (rolling cadences re-anchor on it) and the user timezone.
 *
 * Returns null when no schedule has an upcoming slot (paused course,
 * one-shot already in the past, `endsOn` crossed, every schedule PRN).
 */
import {
  buildCanonicalSchedule,
  buildRecurrenceContext,
  type WorkerMedicationRow,
  type WorkerScheduleRow,
} from "@/lib/medications/scheduling/worker-helpers";
import { nextOccurrenceAfter } from "@/lib/medications/scheduling/recurrence";

export function computeNextDueAt(input: {
  medication: WorkerMedicationRow;
  schedules: WorkerScheduleRow[];
  now: Date;
  userTz: string;
  lastIntakeAt: Date | null;
}): Date | null {
  const { medication, schedules, now, userTz, lastIntakeAt } = input;
  if (schedules.length === 0) return null;

  const ctx = buildRecurrenceContext({ medication, userTz, lastIntakeAt });
  let earliest: Date | null = null;
  for (const schedule of schedules) {
    const canonical = buildCanonicalSchedule(schedule);
    const next = nextOccurrenceAfter(canonical, now, ctx);
    if (next === null) continue;
    if (earliest === null || next.at.getTime() < earliest.getTime()) {
      earliest = next.at;
    }
  }
  return earliest;
}
