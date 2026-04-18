import { prisma } from "@/lib/db";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp, safeJson } from "@/lib/api-response";
import { checkRateLimit } from "@/lib/rate-limit";
import { NextRequest } from "next/server";
import {
  getEffectiveRange,
  type ThresholdOverridesJson,
} from "@/lib/analytics/effective-range";
import { resolveGlucoseUnit, thresholdMetricForContext } from "@/lib/glucose";
import type { GlucoseContext } from "@/generated/prisma/client";

/**
 * Collect data for doctor report PDF generation (client-side).
 * Returns aggregated health data for the specified time range.
 */
export const POST = apiHandler(async (request: NextRequest) => {
  const { user } = await requireAuth();
  annotate({ action: { name: "doctor-report.generate" } });

  const rl = await checkRateLimit(`doctor-report:${user.id}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return apiError("Maximum 10 reports per hour", 429);
  }

  const { data: body, error: jsonError } = await safeJson(request);

  if (jsonError) return jsonError;
  const rawDays = (body as Record<string, unknown>)?.days;
  const days =
    typeof rawDays === "number" && Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 365
      ? rawDays
      : 90;
  const since = new Date();
  since.setDate(since.getDate() - days);

  const userId = user.id;

  const [measurements, medications, intakeEvents, moodEntries, userProfile] =
    await Promise.all([
      prisma.measurement.findMany({
        where: { userId, measuredAt: { gte: since } },
        orderBy: { measuredAt: "asc" },
      }),
      prisma.medication.findMany({
        where: { userId, active: true },
        include: { schedules: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: { userId, scheduledFor: { gte: since } },
        include: { medication: { select: { name: true } } },
        orderBy: { scheduledFor: "asc" },
      }),
      prisma.moodEntry.findMany({
        where: { userId, moodLoggedAt: { gte: since } },
        orderBy: { moodLoggedAt: "asc" },
      }),
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          username: true,
          dateOfBirth: true,
          gender: true,
          heightCm: true,
          glucoseUnit: true,
          thresholdsJson: true,
        },
      }),
    ]);

  // Group measurements by type
  const byType: Record<
    string,
    Array<{ value: number; measuredAt: string }>
  > = {};
  for (const m of measurements) {
    if (!byType[m.type]) byType[m.type] = [];
    byType[m.type].push({
      value: m.value,
      measuredAt: m.measuredAt.toISOString(),
    });
  }

  // Calculate stats per type
  const stats: Record<
    string,
    { avg: number; min: number; max: number; count: number; latest: number }
  > = {};
  for (const [type, entries] of Object.entries(byType)) {
    const values = entries.map((e) => e.value);
    stats[type] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      latest: values[values.length - 1],
    };
  }

  // Medication compliance
  const complianceByMed: Record<
    string,
    { total: number; taken: number; skipped: number; missed: number }
  > = {};
  for (const event of intakeEvents) {
    const name = event.medication.name;
    if (!complianceByMed[name]) {
      complianceByMed[name] = { total: 0, taken: 0, skipped: 0, missed: 0 };
    }
    complianceByMed[name].total++;
    if (event.takenAt) {
      complianceByMed[name].taken++;
    } else if (event.skipped) {
      complianceByMed[name].skipped++;
    } else {
      complianceByMed[name].missed++;
    }
  }

  // Mood summary
  const moodScores = moodEntries.map((e) => e.score);
  const moodSummary =
    moodScores.length > 0
      ? {
          avg: moodScores.reduce((a, b) => a + b, 0) / moodScores.length,
          min: Math.min(...moodScores),
          max: Math.max(...moodScores),
          count: moodScores.length,
          distribution: {
            1: moodScores.filter((s) => s === 1).length,
            2: moodScores.filter((s) => s === 2).length,
            3: moodScores.filter((s) => s === 3).length,
            4: moodScores.filter((s) => s === 4).length,
            5: moodScores.filter((s) => s === 5).length,
          },
        }
      : null;

  // BMI
  const weightStats = stats.WEIGHT;
  const bmi =
    weightStats && userProfile?.heightCm
      ? weightStats.latest / (userProfile.heightCm / 100) ** 2
      : null;

  await auditLog("doctor-report.generate", {
    userId,
    ipAddress: getClientIp(request),
    details: { days },
  });

  annotate({ meta: { report_days: days } });

  // Per-context glucose stats (canonical mg/dL) and effective ranges.
  const glucoseContexts: GlucoseContext[] = [
    "FASTING",
    "POSTPRANDIAL",
    "RANDOM",
    "BEDTIME",
  ];
  const glucoseStats: Record<
    string,
    { avg: number; min: number; max: number; count: number; latest: number }
  > = {};
  const glucoseRanges: Record<string, { min: number; max: number }> = {};
  const glucoseRows = measurements.filter((m) => m.type === "BLOOD_GLUCOSE");
  const overrides = (userProfile?.thresholdsJson ?? null) as ThresholdOverridesJson | null;
  const profileForRange = {
    heightCm: userProfile?.heightCm ?? null,
    dateOfBirth: userProfile?.dateOfBirth ?? null,
    gender: userProfile?.gender ?? null,
  };
  for (const ctx of glucoseContexts) {
    const rows = glucoseRows.filter((m) => m.glucoseContext === ctx);
    if (rows.length === 0) continue;
    const values = rows.map((r) => r.value);
    glucoseStats[ctx] = {
      avg: values.reduce((a, b) => a + b, 0) / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
      latest: values[values.length - 1],
    };
    const eff = getEffectiveRange(
      thresholdMetricForContext(ctx),
      profileForRange,
      overrides,
    );
    if (eff.range) {
      glucoseRanges[ctx] = { min: eff.range.greenMin, max: eff.range.greenMax };
    }
  }

  return apiSuccess({
    period: { days, since: since.toISOString() },
    patient: {
      username: userProfile?.username ?? null,
      dateOfBirth: userProfile?.dateOfBirth ?? null,
      gender: userProfile?.gender ?? null,
      heightCm: userProfile?.heightCm ?? null,
    },
    measurements: byType,
    stats,
    glucoseStats,
    glucoseRanges,
    glucoseUnit: resolveGlucoseUnit(userProfile?.glucoseUnit ?? null),
    bmi: bmi ? Math.round(bmi * 10) / 10 : null,
    compliance: complianceByMed,
    medications: medications.map((m) => ({
      name: m.name,
      dose: m.dose,
      schedules: m.schedules.map((s) => ({
        windowStart: s.windowStart,
        windowEnd: s.windowEnd,
        label: s.label,
      })),
    })),
    mood: moodSummary,
  });
});
