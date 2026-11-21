/**
 * The insight features' medication block: each active scheduled medication
 * with its 7-, 30- and 90-day compliance, from one batched intake read.
 * Undefined when the record has none.
 */
import { prisma } from "@/lib/db";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  COURSES_COMPLIANCE_SELECT,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
import { getMedicationCategories } from "@/lib/medication-category";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import type { AggregatedFeatures } from "@/lib/insights/features";
import { laterDate } from "@/lib/insights/feature-window";

/** Max chars of the free-text medication name / dose that may enter the Coach prompt. */
const MED_NAME_MAX_CHARS = 60;
const MED_DOSE_MAX_CHARS = 40;

export async function readMedicationFeatures(
  userId: string,
  historyFloor: Date | null,
): Promise<AggregatedFeatures["medications"]> {
  const medications = await prisma.medication.findMany({
    // as-needed (PRN) medications never surface a compliance
    // rate (no expected doses), so the insight features exclude them.
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    // schedules through the shared compliance select so the
    // configured per-dose windows reach this surface like every other.
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: [{ validFrom: "asc" }, { id: "asc" }] },
      // pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      // #1024 — the courses, so a gap between two expects nothing.
      courses: COURSES_COMPLIANCE_SELECT,
    },
  });

  if (medications.length === 0) return undefined;
  const categoryMap = await getMedicationCategories(
    medications.map((med) => med.id),
  );

  // Single batched fetch + in-memory grouping replaces the per-medication
  // findMany loop. Same shape as the v1.3.0 fix to /api/insights/comprehensive
  // . 90 days is the longest window
  // calculateCompliance uses below, so we don't need the full intake history.
  const ninetyDaysAgo = laterDate(
    new Date(Date.now() - 90 * 86_400_000),
    historyFloor,
  );
  const allEvents = await prisma.medicationIntakeEvent.findMany({
    where: {
      userId,
      // exclude tombstoned rows.
      deletedAt: null,
      medicationId: { in: medications.map((med) => med.id) },
      scheduledFor: { gte: ninetyDaysAgo },
    },
    orderBy: [{ scheduledFor: "desc" }, { id: "desc" }],
    select: {
      medicationId: true,
      takenAt: true,
      skipped: true,
      scheduledFor: true,
    },
  });

  const eventsByMed = new Map<
    string,
    { takenAt: Date | null; skipped: boolean; scheduledFor: Date }[]
  >();
  for (const e of allEvents) {
    const list = eventsByMed.get(e.medicationId) ?? [];
    list.push({
      takenAt: e.takenAt,
      skipped: e.skipped,
      scheduledFor: e.scheduledFor,
    });
    eventsByMed.set(e.medicationId, list);
  }

  // resolve the user timezone once so every
  // per-med compliance call can route its denominator through the
  // canonical engine (RRULE / rolling / one-shot / PRN / cyclic).
  const userTz = await resolveUserTimezone(userId);

  return medications.map((med) => {
    const mapped = eventsByMed.get(med.id) ?? [];
    const medicationContext = buildComplianceMedicationContext(
      med,
      lastNonSkippedTakenAt(mapped),
      userTz,
    );
    const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt, {
      medicationContext,
    });
    const c30 = calculateCompliance(mapped, med.schedules, 30, med.createdAt, {
      medicationContext,
    });
    const c90 = calculateCompliance(mapped, med.schedules, 90, med.createdAt, {
      medicationContext,
    });

    return {
      // `name` / `dose` are free text and this struct lands in
      // the Coach SNAPSHOT as `medications`. The category is resolved from
      // `med.id` above, so sanitising the label cannot change any
      // classification. Found by the snapshot free-text guard once its file
      // list was derived from the import graph instead of hardcoded.
      name: sanitizeForPrompt(med.name, MED_NAME_MAX_CHARS),
      dose: sanitizeForPrompt(med.dose, MED_DOSE_MAX_CHARS),
      category: categoryMap[med.id] ?? "OTHER",
      compliance7: c7.rate,
      compliance30: c30.rate,
      compliance90: c90.rate,
      streak: c30.streak,
      missedLast7: c7.missed,
    };
  });
}
