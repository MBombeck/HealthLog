/**
 * Medication-compliance block for the Coach snapshot.
 *
 * Medication compliance lives outside the structured features — the
 * legacy Coach surface labelled it as "general" provenance only.
 * v1.4.20.1 shipped a per-day adherence row; v1.16.9 derives it from
 * the band-engine LEDGER (the same expansion the compliance % and the
 * dose-history view consume): a slot counts against the rate only once
 * it is genuinely missed, a pending/upcoming slot never reads as "not
 * taken", deliberate skips and ad-hoc takes stay out of the
 * denominator, and cross-source duplicate rows collapse onto one slot.
 *
 * Split out of `snapshot.ts`; the builder passes the medication rows it
 * already read plus the shared accumulators, so the emitted shape and
 * ordering are unchanged.
 */
import {
  buildComplianceLedgerRows,
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
  type ComplianceSchedule,
  type IntakeEvent,
} from "@/lib/analytics/compliance";
import type { DoseHistoryRow } from "@/lib/medications/scheduling/dose-history";
import { annotate } from "@/lib/logging/context";
import { courseStatusOn } from "@/lib/medications/course-window";
import { isoWeekKey, tzDayKey, tzWeekday } from "../snapshot-series";
import type {
  CoachProvenance,
  CoachProvenanceMetric,
  CoachScopeSource,
} from "../types";

/**
 * The medication row shape the block consumes — exactly what the
 * builder's Prisma read selects, expressed through the compliance
 * engine's own parameter types so the two can never drift.
 */
type ComplianceBlockMedication = Parameters<
  typeof buildComplianceMedicationContext
>[0] & {
  schedules: ComplianceSchedule[];
  intakeEvents: IntakeEvent[];
};

interface ComplianceBlockContext {
  complianceMeds: ComplianceBlockMedication[];
  userTz: string;
  cutoff: Date;
  recentCutoff: Date;
  now: Date;
  snapshot: Record<string, unknown>;
  metrics: Set<CoachProvenanceMetric>;
  counts: NonNullable<CoachProvenance["counts"]>;
  registerBlock: (key: string, source: CoachScopeSource) => void;
}

function courseSummary(
  meds: readonly ComplianceBlockMedication[],
  now: Date,
  userTz: string,
): { courses?: { takenInCourses: number; noCourseRunning: number } } {
  const todayKey = tzDayKey(now, userTz);
  const several = meds.filter((m) => (m.courses?.length ?? 0) >= 2);
  if (several.length === 0) return {};
  const idle = several.filter((m) =>
    (m.courses ?? []).every((c) => courseStatusOn(c, todayKey) !== "CURRENT"),
  ).length;
  return {
    courses: { takenInCourses: several.length, noCourseRunning: idle },
  };
}

export function buildComplianceBlock(
  ctx: Readonly<ComplianceBlockContext>,
): void {
  const {
    complianceMeds,
    userTz,
    cutoff,
    recentCutoff,
    now,
    snapshot,
    metrics,
    counts,
    registerBlock,
  } = ctx;
  const ledgerRows: DoseHistoryRow[] = [];
  // v1.17 W1c — the coach's headline adherence figure routes through the
  // SAME `calculateCompliance(...).rate` ledger authority the medication
  // card shows (the ledger path, `medicationContext` supplied), so the
  // coach can never quote a denominator the card doesn't use. Per
  // medication we take the ledger numerator (on-time + late takes) and
  // denominator (taken + missed) and pool them across the user's
  // scheduled medications: for a single medication the headline equals
  // that med's card rate exactly; for several it is the dose-weighted
  // overall adherence (the same pooling the cross-med timeline below
  // already uses), never a per-day / per-week denominator of its own.
  let complianceTaken = 0;
  let complianceDenominator = 0;
  const windowDaysForRate = Math.max(
    1,
    Math.round((now.getTime() - cutoff.getTime()) / (24 * 60 * 60 * 1000)),
  );
  for (const med of complianceMeds) {
    if (med.schedules.length === 0) continue;
    const medCtx = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(med.intakeEvents),
      userTz,
    );
    ledgerRows.push(
      ...buildComplianceLedgerRows(
        med.intakeEvents,
        med.schedules,
        medCtx,
        cutoff,
        now,
        now,
      ),
    );
    // The card's rate IS `calculateCompliance(...).rate` over the ledger;
    // aggregate the same taken / (taken + missed) counts here so the
    // coach's single headline % equals what the card renders.
    const result = calculateCompliance(
      med.intakeEvents,
      med.schedules,
      windowDaysForRate,
      med.createdAt,
      { now, medicationContext: medCtx },
    );
    complianceTaken += result.taken;
    complianceDenominator += result.taken + result.missed;
  }
  // Countable rows: taken (on-time or late) or genuinely missed. The
  // pending / upcoming / skipped / ad-hoc rows carry no adherence signal.
  const countable = ledgerRows.filter(
    (r) =>
      r.status === "taken_on_time" ||
      r.status === "taken_late" ||
      r.status === "missed",
  );
  if (countable.length > 0) {
    const recent = countable.filter((r) => r.at >= recentCutoff);
    const olderRows = countable.filter((r) => r.at < recentCutoff);
    const isTaken = (r: DoseHistoryRow) =>
      r.status === "taken_on_time" || r.status === "taken_late";
    const recentByDay = new Map<
      string,
      { date: Date; total: number; taken: number }
    >();
    for (const r of recent) {
      const key = tzDayKey(r.at, userTz);
      const e = recentByDay.get(key) ?? {
        date: r.at,
        total: 0,
        taken: 0,
      };
      e.total += 1;
      if (isTaken(r)) e.taken += 1;
      recentByDay.set(key, e);
    }
    const recentRows = Array.from(recentByDay.entries())
      .map(([date, info]) => ({
        date,
        weekday: tzWeekday(info.date, userTz),
        rate: Math.round((info.taken / info.total) * 100) / 100,
        taken: info.taken,
        total: info.total,
      }))
      .sort((a, b) => a.date.localeCompare(b.date));
    const olderByWeek = new Map<string, { taken: number; total: number }>();
    for (const r of olderRows) {
      const key = isoWeekKey(r.at, userTz);
      const e = olderByWeek.get(key) ?? { taken: 0, total: 0 };
      e.total += 1;
      if (isTaken(r)) e.taken += 1;
      olderByWeek.set(key, e);
    }
    const weeklyRows = Array.from(olderByWeek.entries())
      .map(([weekISO, v]) => ({
        weekISO,
        rate: v.total > 0 ? Math.round((v.taken / v.total) * 100) / 100 : 0,
        taken: v.taken,
        total: v.total,
      }))
      .sort((a, b) => a.weekISO.localeCompare(b.weekISO));
    snapshot.compliance = {
      // v1.17 W1c — headline adherence % from the SAME ledger authority
      // (`calculateCompliance(...).rate`) the medication card shows: the
      // dose-weighted pool of taken / (taken + missed) across the user's
      // scheduled medications, so the coach quotes the card's figure
      // (single med) or its honest overall adherence (several meds) rather
      // than a per-day / per-week rate built off a different denominator.
      // Integer 0-100 to match the card's rounding; null when no scheduled
      // medication has any countable dose in the window.
      rate:
        complianceDenominator > 0
          ? Math.round((complianceTaken / complianceDenominator) * 100)
          : null,
      timeline: { recent: recentRows, weekly: weeklyRows },
      // v1.40 (#1024) — how many medications are taken in separate courses,
      // and how many of those have no course running today. Their days
      // between courses expect no dose, so a quiet stretch there is not a
      // lapse; the rate above already leaves those days out.
      ...courseSummary(complianceMeds, now, userTz),
    };
    metrics.add("compliance");
    counts.compliance = countable.length;
    registerBlock("compliance", "compliance");
  } else {
    // v1.7.0 — toggled-on cluster with no rows. Annotate so the
    // dashboards can distinguish "user has no medication data" from
    // "medication cluster was off".
    annotate({
      action: { name: "coach.cluster.empty_skipped" },
      meta: { cluster: "medication" },
    });
  }
}
