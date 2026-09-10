/**
 * v1.26.0 SEAM-N3 — the ONE schedule-anchored, cadence-aware daily
 * compliance computation.
 *
 * Extracted verbatim from the `GET /api/medications/intake?scope=compliance`
 * dashboard-tile handler so every surface that surfaces a "taken of expected"
 * adherence number reads through the SAME engine instead of the raw coverage
 * rollup (`readMedicationCompliance`), whose `scheduled` counts LOGGED intake
 * slots — a denominator that collapses to ~100% for a user who logs only the
 * doses they took and never mints `takenAt:null` reminder rows for the ones
 * they missed. See the adherence storyline (`adherence-storyline.ts`) and the
 * dashboard tile: both now consume this.
 *
 * `scheduled` is the canonical recurrence engine's expected-dose count for the
 * day, summed across the user's active medications and MINUS the doses the
 * user deliberately skipped, so days the schedule expected a dose that the
 * user missed pull the rate down — and the 7/30/90 windows genuinely diverge
 * with partial adherence. `taken` stays the count of taken (non-skipped,
 * non-auto-missed) doses that day, capped at the day's expected count so a
 * duplicate log can't push a day above 100%.
 *
 * The skip exclusion is what keeps this engine and the ledger tally
 * (`tallyComplianceFromLedger`, the source of the rate on the medication card,
 * the dose history and the doctor report) reporting ONE number: both treat a
 * skip as a deliberate pause outside the denominator, never as a miss.
 *
 * Pure-ish over a single pinned `now` so a cached row is internally
 * consistent. Bounded: one active-medications query + one window-events query,
 * then per-medication-per-day engine expansion over the trailing window.
 */
import { prisma } from "@/lib/db";
import {
  buildComplianceMedicationContext,
  expectedSlotCountForDay,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { getUserTodayBounds } from "@/lib/tz/local-day";
import { userDayKey } from "@/lib/tz/resolver";

export interface ScheduleAnchoredComplianceBucket {
  /** YYYY-MM-DD in the user's tz. */
  date: string;
  scheduled: number;
  taken: number;
}

export async function buildScheduleAnchoredComplianceBuckets(
  userId: string,
  days: number,
  userTz: string,
  now: Date = new Date(),
): Promise<ScheduleAnchoredComplianceBucket[]> {
  const nowMs = now.getTime();
  const start = new Date(nowMs - days * 86_400_000);

  const medications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: {
      // v1.15.20 — the shared compliance select so a future engine column
      // reaches this surface the moment it joins SCHEDULE_COMPLIANCE_SELECT.
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // v1.16.3 — archived schedule eras for era-aware expected counts.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
  });

  const events = await prisma.medicationIntakeEvent.findMany({
    // v1.7.0 sync — exclude tombstoned rows from the compliance buckets.
    where: { userId, deletedAt: null, scheduledFor: { gte: start } },
    select: {
      medicationId: true,
      scheduledFor: true,
      takenAt: true,
      skipped: true,
      autoMissed: true,
    },
  });

  // Pre-compute each local day's [start, end) bounds + key, oldest → newest.
  // Each day's representative instant anchors on the user's LOCAL NOON of
  // the current day and steps back in 24-hour increments: noon stays inside
  // the intended local day across DST shifts (23/25-hour days), and —
  // unlike the previous `now − 12 h` anchor — it cannot slip into
  // yesterday when the user's local time is before noon, which silently
  // dropped TODAY from the buckets for every pre-noon read.
  const { start: todayStart } = getUserTodayBounds(now, userTz);
  const todayNoonMs = todayStart.getTime() + 12 * 60 * 60 * 1000;
  const dayKeys: string[] = [];
  const dayBounds = new Map<string, { start: Date; end: Date }>();
  for (let i = days - 1; i >= 0; i--) {
    const representative = new Date(todayNoonMs - i * 86_400_000);
    const { start: dayStart, end: dayEndInclusive } = getUserTodayBounds(
      representative,
      userTz,
    );
    const key = userDayKey(dayStart, userTz);
    if (dayBounds.has(key)) continue;
    dayKeys.push(key);
    dayBounds.set(key, {
      start: dayStart,
      end: new Date(dayEndInclusive.getTime() + 1), // half-open [start, end)
    });
  }

  const totals = new Map<string, { scheduled: number; taken: number }>();
  for (const key of dayKeys) totals.set(key, { scheduled: 0, taken: 0 });

  // Group events by medication so each med's engine context is built once.
  const eventsByMed = new Map<
    string,
    {
      scheduledFor: Date;
      takenAt: Date | null;
      skipped: boolean;
      autoMissed: boolean;
    }[]
  >();
  for (const e of events) {
    const list = eventsByMed.get(e.medicationId) ?? [];
    list.push({
      scheduledFor: e.scheduledFor,
      takenAt: e.takenAt,
      skipped: e.skipped,
      autoMissed: e.autoMissed,
    });
    eventsByMed.set(e.medicationId, list);
  }

  for (const med of medications) {
    if (med.schedules.length === 0) continue;
    const medEvents = eventsByMed.get(med.id) ?? [];
    const ctx = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(medEvents),
      userTz,
    );

    for (const key of dayKeys) {
      const bounds = dayBounds.get(key)!;
      // Skip days before the medication existed so a young med doesn't paint
      // missed-denominator days it could not have been dosed on.
      if (bounds.end <= med.createdAt) continue;

      const scheduled = expectedSlotCountForDay(
        med.schedules,
        bounds.start,
        bounds.end,
        ctx,
        medEvents,
      );
      if (scheduled === 0) continue;

      const inDay = (at: Date) => at >= bounds.start && at < bounds.end;

      // A deliberate skip is a pause, not a miss (the semantics the ledger
      // tally has carried since v1.15.9 and the only reading the "consistent
      // skip handling" contract admits). The skipped slot leaves the
      // denominator entirely instead of being counted as expected-and-missed
      // — otherwise the dashboard tile reported a lower rate than the card,
      // the history view and the doctor report for the very same day. The
      // count is capped at the expected slots so a stray skip row outside
      // the minted grid cannot drive the denominator negative; a day whose
      // every expected dose was skipped drops out of the buckets, exactly as
      // it drops out of the ledger denominator.
      //
      // `skipped` outranks `autoMissed` here for the same reason it does in
      // `reconstructDoseHistory`: the cron marks a forgotten dose
      // `autoMissed`, so a row still carrying `skipped` is a real user
      // decision.
      const skippedThisDay = Math.min(
        medEvents.filter((e) => e.skipped && inDay(e.scheduledFor)).length,
        scheduled,
      );
      const expected = scheduled - skippedThisDay;
      if (expected === 0) continue;

      // Taken doses that landed in this day's window (non-skipped, non-auto-
      // missed), capped at the expected count so a duplicate log can't push a
      // single day above 100%.
      const takenThisDay = medEvents.filter(
        (e) =>
          e.takenAt !== null &&
          !e.skipped &&
          !e.autoMissed &&
          inDay(e.scheduledFor),
      ).length;

      const bucket = totals.get(key)!;
      bucket.scheduled += expected;
      bucket.taken += Math.min(takenThisDay, expected);
    }
  }

  return dayKeys
    .map((date) => {
      const v = totals.get(date)!;
      return { date, scheduled: v.scheduled, taken: v.taken };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
