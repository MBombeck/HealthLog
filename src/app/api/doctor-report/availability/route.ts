/**
 * v1.4.25 W6c — doctor-report section availability probe.
 *
 * Returns one boolean per toggleable section so the dialog can hide
 * checkboxes for data types that have zero rows in the user-selected
 * date range (Marc's "hide-when-empty" rule). Pure presence check —
 * `count` queries on small indexed tables — so this is cheap enough to
 * run on every date-range change in the dialog without driving cost.
 *
 * Body shape (mirrors `/api/doctor-report`):
 *   { startDate?: ISO, endDate?: ISO, days?: number }
 */
import type { NextRequest } from "next/server";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { apiSuccess, safeJson } from "@/lib/api-response";
import { prisma } from "@/lib/db";
import { normaliseDateRange } from "@/lib/doctor-report-data";

export const dynamic = "force-dynamic";

export interface DoctorReportAvailability {
  /** Section flags — `true` when at least one row exists in the range. */
  bp: boolean;
  weight: boolean;
  pulse: boolean;
  /** BMI requires both a weight reading AND a configured height. */
  bmi: boolean;
  mood: boolean;
  /** Medication compliance — derived from `MedicationIntakeEvent` rows. */
  compliance: boolean;
  sleep: boolean;
}

export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "doctor-report.availability" } });

  const { data: body, error } = await safeJson(request);
  if (error) return error;
  const range = normaliseDateRange(body ?? undefined);
  const { start, end } = range;

  // `count` queries are cheaper than `findMany` for a presence check —
  // we never read the rows themselves. The user has indexes on
  // `(userId, measuredAt)`, `(userId, moodLoggedAt)`, and
  // `(userId, scheduledFor)` so these stay sub-millisecond even with
  // multi-year ranges.
  const [
    bpCount,
    weightCount,
    pulseCount,
    moodCount,
    complianceCount,
    sleepCount,
    profile,
  ] = await Promise.all([
    prisma.measurement.count({
      where: {
        userId: user.id,
        measuredAt: { gte: start, lte: end },
        type: { in: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] },
        // v1.4.41 W-DELETED-2 — hide soft-deleted rows from the
        // section-availability probe so the dialog does not offer a
        // section that would render an empty PDF block.
        deletedAt: null,
      },
    }),
    prisma.measurement.count({
      where: {
        userId: user.id,
        measuredAt: { gte: start, lte: end },
        type: "WEIGHT",
        deletedAt: null,
      },
    }),
    prisma.measurement.count({
      where: {
        userId: user.id,
        measuredAt: { gte: start, lte: end },
        type: "PULSE",
        deletedAt: null,
      },
    }),
    prisma.moodEntry.count({
      // v1.7.0 sync — exclude tombstoned rows from the availability count.
      where: {
        userId: user.id,
        deletedAt: null,
        moodLoggedAt: { gte: start, lte: end },
      },
    }),
    prisma.medicationIntakeEvent.count({
      // v1.7.0 sync — exclude tombstoned rows from the availability count.
      where: {
        userId: user.id,
        deletedAt: null,
        scheduledFor: { gte: start, lte: end },
      },
    }),
    prisma.measurement.count({
      where: {
        userId: user.id,
        measuredAt: { gte: start, lte: end },
        type: "SLEEP_DURATION",
        deletedAt: null,
      },
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { heightCm: true },
    }),
  ]);

  // BMI is derived (latest weight × profile height) so it only shows up
  // when BOTH inputs are available — otherwise the user would tick a
  // box that produces a silently-empty section.
  const bmi = weightCount > 0 && (profile?.heightCm ?? null) !== null;

  const availability: DoctorReportAvailability = {
    bp: bpCount > 0,
    weight: weightCount > 0,
    pulse: pulseCount > 0,
    bmi,
    mood: moodCount > 0,
    compliance: complianceCount > 0,
    sleep: sleepCount > 0,
  };

  annotate({
    meta: {
      report_days: range.days,
      sections_available: Object.values(availability).filter(Boolean).length,
    },
  });

  return apiSuccess(availability);
});
