/**
 * The overview's medication block: per-medication compliance over 7 and 30
 * days, and the blood-pressure medication continuity × systolic correlation
 * that pairs the BP medications' intake days with the daily systolic means.
 */
import { prisma } from "@/lib/db";
import {
  buildComplianceMedicationContext,
  COURSES_COMPLIANCE_SELECT,
  calculateCompliance,
  expectsDoses,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { significantPearsonCorrelation } from "@/lib/analytics/correlations";
import { resolveMedicationCategories } from "@/lib/medication-category";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";

import type { DailyValue } from "./daily-series";

interface BpIntakeEvent {
  scheduledFor: Date;
  takenAt: Date | null;
  skipped: boolean;
}

/** Read the tracked scheduled medications with what compliance needs. */
async function readScheduledMedications(userId: string) {
  const medicationRows = await prisma.medication.findMany({
    // As-needed (PRN) medications never surface a compliance rate (no
    // expected doses).
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    include: {
      // Schedules through the shared compliance select so the configured
      // per-dose windows reach this surface like every other.
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // Archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: [{ validFrom: "asc" }, { id: "asc" }] },
      // Pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      // The courses, so a gap between two expects nothing (#1024).
      courses: COURSES_COMPLIANCE_SELECT,
    },
  });
  // A medication with no schedule expects no dose, and `calculateCompliance`
  // answers 100 % for that case. The `asNeeded: false` filter above catches
  // only the PRN arm; the empty schedule is reachable on a scheduled
  // medication and would otherwise report perfect adherence.
  return medicationRows.filter(expectsDoses);
}

/**
 * Per-medication compliance, plus the intake events of the blood-pressure
 * medications for the continuity correlation.
 */
export async function readMedicationCompliance(args: {
  userId: string;
  since: Date;
  timezone: string;
}) {
  const { userId, since, timezone } = args;
  const medications = await readScheduledMedications(userId);

  const resolvedCategories = await resolveMedicationCategories(
    medications.map((m) => m.id),
  );
  const categoryMap = Object.fromEntries(
    Object.entries(resolvedCategories).map(([id, r]) => [id, r.category]),
  );

  const medCompliance = [];
  const bpMedicationEvents: BpIntakeEvent[] = [];
  const bpMedications = medications.filter(
    (med) => (categoryMap[med.id] ?? "OTHER") === "BLOOD_PRESSURE",
  );
  // Single round-trip for all medications instead of N+1: one query keyed
  // on `medicationId IN (...)`, then group in memory.
  const allEvents = medications.length
    ? await prisma.medicationIntakeEvent.findMany({
        where: {
          medicationId: { in: medications.map((m) => m.id) },
          userId,
          // Tombstoned rows are excluded.
          deletedAt: null,
          scheduledFor: { gte: since },
        },
        orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
      })
    : [];

  const eventsByMed = new Map<string, typeof allEvents>();
  for (const ev of allEvents) {
    const list = eventsByMed.get(ev.medicationId);
    if (list) list.push(ev);
    else eventsByMed.set(ev.medicationId, [ev]);
  }

  for (const med of medications) {
    const events = eventsByMed.get(med.id) ?? [];
    const mapped = events.map((e) => ({
      takenAt: e.takenAt,
      skipped: e.skipped,
      scheduledFor: e.scheduledFor,
    }));
    // Engine-routed denominator.
    const medicationContext = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(mapped),
      timezone,
    );
    const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt, {
      medicationContext,
    });
    const c30 = calculateCompliance(mapped, med.schedules, 30, med.createdAt, {
      medicationContext,
    });

    medCompliance.push({
      id: med.id,
      name: med.name,
      dose: med.dose,
      category: categoryMap[med.id] ?? "OTHER",
      // The label of a custom category; null for a built-in (#1041).
      categoryLabel: resolvedCategories[med.id]?.categoryLabel ?? null,
      compliance7: c7.rate,
      compliance30: c30.rate,
      streak: c7.streak,
      taken7: c7.taken,
      skipped7: c7.skipped,
      missed7: c7.missed,
    });

    if ((categoryMap[med.id] ?? "OTHER") === "BLOOD_PRESSURE") {
      bpMedicationEvents.push(
        ...events.map((e) => ({
          scheduledFor: e.scheduledFor,
          takenAt: e.takenAt,
          skipped: e.skipped,
        })),
      );
    }
  }

  return { medications, medCompliance, bpMedications, bpMedicationEvents };
}

/**
 * Correlation: BP medication continuity × systolic BP.
 *
 * Uses the same daily BP_SYS series the aggregator pre-computed — no second
 * round-trip. The intake-side aggregation matches the legacy code:
 * continuity = min(1, taken / expectedPerDay), pairing every day that had a
 * sys reading.
 */
export function bpMedicationContinuity(args: {
  bpMedications: Array<{ schedules: unknown[] }>;
  bpMedicationEvents: BpIntakeEvent[];
  sysDaily: DailyValue[];
}) {
  const { bpMedications, bpMedicationEvents, sysDaily } = args;
  let bpMedicationCorrelation: {
    r: number;
    strength: string;
    n: number;
    medicationCount: number;
  } | null = null;
  const bpMedicationScatterData: Array<{
    continuityPct: number;
    sysBP: number;
  }> = [];

  const expectedBpIntakesPerDay = bpMedications.reduce(
    (sum, med) => sum + med.schedules.length,
    0,
  );

  if (expectedBpIntakesPerDay > 0) {
    // Daily systolic means (already keyed YYYY-MM-DD) from the SQL pass.
    // `sysDaily` (UTC `date_trunc` from the aggregator's `dailyByType`) and
    // `takenByDay` below (intake `scheduledFor` truncated to UTC) both live
    // in the SAME UTC day-key space and are internally consistent with each
    // other, so this join stays UTC. Only the mood pairings moved to a
    // separately derived local-day series (their partner, the mood series,
    // is local-day-keyed). This correlation migrates to local when the
    // measurement-rollup tier buckets per-user tz; re-keying it here without
    // the local-bucketed rollup would mean per-request raw re-aggregation.
    const sysByDay = new Map<string, number>();
    for (const row of sysDaily) {
      sysByDay.set(row.day, row.value);
    }

    const takenByDay = new Map<string, number>();
    // Days that carry an intake record of ANY kind. A logged skip is a real
    // zero and belongs in the series; a day the person never touched is not a
    // zero, it is nothing, and pairing it against that day's systolic reading
    // invented a data point they never produced. Absence is not zero, here as
    // everywhere else in this project, so the unlogged day drops out of both
    // the scatter and the coefficient rather than dragging continuity down.
    const loggedDays = new Set<string>();
    for (const event of bpMedicationEvents) {
      // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: pairs intake days with the DAY rollup buckets in sysByDay, which are UTC days
      const dayKey = event.scheduledFor.toISOString().slice(0, 10);
      loggedDays.add(dayKey);
      if (event.skipped || !event.takenAt) continue;
      takenByDay.set(dayKey, (takenByDay.get(dayKey) ?? 0) + 1);
    }

    const pairs: Array<{ a: number; b: number; date: Date }> = [];
    for (const [dayKey, avgSys] of sysByDay.entries()) {
      if (!loggedDays.has(dayKey)) continue;
      const taken = takenByDay.get(dayKey) ?? 0;
      const continuity = Math.min(1, taken / expectedBpIntakesPerDay);
      pairs.push({
        a: continuity,
        b: avgSys,
        date: dayKeyAsUtcMidnight(dayKey),
      });
      bpMedicationScatterData.push({
        continuityPct: Math.round(continuity * 100),
        sysBP: Math.round(avgSys * 10) / 10,
      });
    }

    const corr = significantPearsonCorrelation(pairs);
    if (corr) {
      bpMedicationCorrelation = {
        ...corr,
        medicationCount: bpMedications.length,
      };
    }
  }

  return { bpMedicationCorrelation, bpMedicationScatterData };
}
