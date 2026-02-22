import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { auditLog } from "@/lib/auth/audit";
import { apiSuccess, apiError, getClientIp } from "@/lib/api-response";
import { NextRequest } from "next/server";

/**
 * Collect data for doctor report PDF generation (client-side).
 * Returns aggregated health data for the specified time range.
 */
export async function POST(request: NextRequest) {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  try {
    const body = await request.json();
    const days = body.days ?? 90;
    const since = new Date();
    since.setDate(since.getDate() - days);

    const userId = sessionData.user.id;

    const [measurements, medications, intakeEvents, moodEntries, user] =
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
      weightStats && user?.heightCm
        ? weightStats.latest / (user.heightCm / 100) ** 2
        : null;

    await auditLog("doctor-report.generate", {
      userId,
      ipAddress: getClientIp(request),
      details: { days },
    });

    return apiSuccess({
      period: { days, since: since.toISOString() },
      patient: {
        username: user?.username ?? null,
        dateOfBirth: user?.dateOfBirth ?? null,
        gender: user?.gender ?? null,
        heightCm: user?.heightCm ?? null,
      },
      measurements: byType,
      stats,
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
  } catch (err) {
    console.error("Doctor report error:", err);
    return apiError("Arztreport konnte nicht erstellt werden", 500);
  }
}
