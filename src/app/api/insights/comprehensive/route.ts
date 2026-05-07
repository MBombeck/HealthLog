import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import { apiSuccess } from "@/lib/api-response";
import { summarize, type DataPoint } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  classifyBMI,
  classifyBP,
  generateAlerts,
} from "@/lib/analytics/classifications";
import {
  pairByTimestamp,
  pearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { getMedicationCategories } from "@/lib/medication-category";
import type { MeasurementType } from "@/generated/prisma/client";
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { annotate } from "@/lib/logging/context";
import { measurementTypeEnum } from "@/lib/validations/measurement";

export const dynamic = "force-dynamic";

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();

  const userId = user.id;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // Fetch user profile
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
    },
  });

  // Derived from canonical enum so adding a new measurement type does not
  // require touching this file (V3 audit finding: enum drift cousins).
  const types = [...measurementTypeEnum.options] as MeasurementType[];

  const allMeasurements = await prisma.measurement.findMany({
    where: { userId, type: { in: types }, measuredAt: { gte: ninetyDaysAgo } },
    orderBy: { measuredAt: "asc" },
    select: { type: true, value: true, measuredAt: true },
  });

  // Fetch mood entries (90 days)
  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId, moodLoggedAt: { gte: ninetyDaysAgo } },
    orderBy: { moodLoggedAt: "asc" },
    select: { date: true, score: true, moodLoggedAt: true },
  });

  // Aggregate mood to daily averages
  const moodByDay = new Map<string, { sum: number; count: number }>();
  for (const entry of moodEntries) {
    const current = moodByDay.get(entry.date) ?? { sum: 0, count: 0 };
    current.sum += entry.score;
    current.count += 1;
    moodByDay.set(entry.date, current);
  }
  const dailyMoodEntries = Array.from(moodByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({
      day,
      value: Math.round((stats.sum / stats.count) * 100) / 100,
    }));

  // Build DataPoint array for mood summary
  const moodDataPoints: DataPoint[] = moodEntries.map((e) => ({
    date: e.moodLoggedAt,
    value: e.score,
  }));
  const moodSummary = moodDataPoints.length > 0 ? summarize(moodDataPoints) : null;

  const byType = (t: MeasurementType): DataPoint[] =>
    allMeasurements
      .filter((m) => m.type === t)
      .map((m) => ({ date: m.measuredAt, value: m.value }));

  // Summaries
  const summaries: Record<string, ReturnType<typeof summarize>> = {};
  for (const t of types) {
    const data = byType(t);
    if (data.length > 0) {
      summaries[t] = summarize(data);
    }
  }

  // BMI
  let bmi: number | null = null;
  let bmiClassification = null;
  if (dbUser?.heightCm && summaries.WEIGHT?.latest) {
    const heightM = dbUser.heightCm / 100;
    bmi = Math.round((summaries.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
    bmiClassification = classifyBMI(bmi);
  }

  // BP classification (30-day average)
  let bpClassification = null;
  const bpTargets = getBpTargets(dbUser?.dateOfBirth ?? null);
  if (
    summaries.BLOOD_PRESSURE_SYS?.avg30 &&
    summaries.BLOOD_PRESSURE_DIA?.avg30
  ) {
    bpClassification = classifyBP(
      summaries.BLOOD_PRESSURE_SYS.avg30,
      summaries.BLOOD_PRESSURE_DIA.avg30,
    );
  }

  // BP target adherence
  let bpPctInTarget: number | null = null;
  if (bpTargets) {
    const sysData = byType("BLOOD_PRESSURE_SYS");
    const diaData = byType("BLOOD_PRESSURE_DIA");
    const sysPairs = pairByTimestamp(sysData, diaData, 5 * 60 * 1000);

    if (sysPairs.length > 0) {
      const inTarget = sysPairs.filter(
        (p) =>
          p.a >= bpTargets.sysLow &&
          p.a <= bpTargets.sysHigh &&
          p.b >= bpTargets.diaLow &&
          p.b <= bpTargets.diaHigh,
      ).length;
      bpPctInTarget = Math.round((inTarget / sysPairs.length) * 100);
    }
  }

  // Correlations: Weight vs Sys BP
  const weightData = byType("WEIGHT");
  const sysData = byType("BLOOD_PRESSURE_SYS");
  const weightBpPairs = pairByTimestamp(weightData, sysData);
  const weightBpCorrelation = pearsonCorrelation(weightBpPairs);
  const scatterData = weightBpPairs.map((p) => ({
    weight: p.a,
    sysBP: p.b,
  }));

  // Correlations: Mood vs metrics (using daily averages matched by date)
  function buildMoodMetricPairs(
    dailyMood: Array<{ day: string; value: number }>,
    measurements: Array<{ measuredAt: Date; value: number }>,
  ): PairedPoint[] {
    // Group measurements by day
    const metricByDay = new Map<string, { sum: number; count: number }>();
    for (const m of measurements) {
      const dayKey = m.measuredAt.toISOString().slice(0, 10);
      const current = metricByDay.get(dayKey) ?? { sum: 0, count: 0 };
      current.sum += m.value;
      current.count += 1;
      metricByDay.set(dayKey, current);
    }

    const pairs: PairedPoint[] = [];
    for (const mood of dailyMood) {
      const metric = metricByDay.get(mood.day);
      if (metric) {
        pairs.push({
          a: mood.value,
          b: Math.round((metric.sum / metric.count) * 100) / 100,
          date: new Date(`${mood.day}T12:00:00.000Z`),
        });
      }
    }
    return pairs;
  }

  // Mood vs Systolic BP
  const moodBpPairs = buildMoodMetricPairs(
    dailyMoodEntries,
    allMeasurements.filter((m) => m.type === "BLOOD_PRESSURE_SYS").map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
  );
  const moodBpCorrelation = pearsonCorrelation(moodBpPairs);
  const moodBpScatterData = moodBpPairs.map((p) => ({ mood: p.a, sysBP: p.b }));

  // Mood vs Weight
  const moodWeightPairs = buildMoodMetricPairs(
    dailyMoodEntries,
    allMeasurements.filter((m) => m.type === "WEIGHT").map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
  );
  const moodWeightCorrelation = pearsonCorrelation(moodWeightPairs);
  const moodWeightScatterData = moodWeightPairs.map((p) => ({ mood: p.a, weight: p.b }));

  // Mood vs Pulse
  const moodPulsePairs = buildMoodMetricPairs(
    dailyMoodEntries,
    allMeasurements.filter((m) => m.type === "PULSE").map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
  );
  const moodPulseCorrelation = pearsonCorrelation(moodPulsePairs);
  const moodPulseScatterData = moodPulsePairs.map((p) => ({ mood: p.a, pulse: p.b }));

  // Medication compliance
  const medications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
  });
  const categoryMap = await getMedicationCategories(
    medications.map((m) => m.id),
  );

  const medCompliance = [];
  const bpMedicationEvents: Array<{
    scheduledFor: Date;
    takenAt: Date | null;
    skipped: boolean;
  }> = [];
  const bpMedications = medications.filter(
    (med) => (categoryMap[med.id] ?? "OTHER") === "BLOOD_PRESSURE",
  );
  // Single round-trip for all medications instead of N+1: one query keyed
  // on `medicationId IN (...)`, then group in memory. The previous loop
  // hit Postgres once per medication, which scales poorly for users with
  // many active meds.
  const allEvents = medications.length
    ? await prisma.medicationIntakeEvent.findMany({
        where: {
          medicationId: { in: medications.map((m) => m.id) },
          userId,
          scheduledFor: { gte: ninetyDaysAgo },
        },
        orderBy: { scheduledFor: "desc" },
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
    const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt);
    const c30 = calculateCompliance(mapped, med.schedules, 30, med.createdAt);

    medCompliance.push({
      id: med.id,
      name: med.name,
      dose: med.dose,
      category: categoryMap[med.id] ?? "OTHER",
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

  // Correlation: continuity of BP medications vs systolic BP
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
    const sysByDay = new Map<string, number[]>();
    for (const m of allMeasurements) {
      if (m.type !== "BLOOD_PRESSURE_SYS") continue;
      const dayKey = m.measuredAt.toISOString().slice(0, 10);
      const list = sysByDay.get(dayKey) ?? [];
      list.push(m.value);
      sysByDay.set(dayKey, list);
    }

    const takenByDay = new Map<string, number>();
    for (const event of bpMedicationEvents) {
      if (event.skipped || !event.takenAt) continue;
      const dayKey = event.scheduledFor.toISOString().slice(0, 10);
      takenByDay.set(dayKey, (takenByDay.get(dayKey) ?? 0) + 1);
    }

    const pairs: Array<{ a: number; b: number; date: Date }> = [];
    for (const [dayKey, sysValues] of sysByDay.entries()) {
      const taken = takenByDay.get(dayKey) ?? 0;
      const continuity = Math.min(1, taken / expectedBpIntakesPerDay);
      const avgSys =
        sysValues.reduce((sum, value) => sum + value, 0) / sysValues.length;
      pairs.push({
        a: continuity,
        b: avgSys,
        date: new Date(`${dayKey}T00:00:00.000Z`),
      });
      bpMedicationScatterData.push({
        continuityPct: Math.round(continuity * 100),
        sysBP: Math.round(avgSys * 10) / 10,
      });
    }

    const corr = pearsonCorrelation(pairs);
    if (corr) {
      bpMedicationCorrelation = {
        ...corr,
        medicationCount: bpMedications.length,
      };
    }
  }

  // Generate alerts
  const alerts = generateAlerts({
    bmi,
    bpAvgSys: summaries.BLOOD_PRESSURE_SYS?.avg30 ?? null,
    bpAvgDia: summaries.BLOOD_PRESSURE_DIA?.avg30 ?? null,
    bpPctInTarget,
    weightSlope30: summaries.WEIGHT?.slope30?.slope ?? null,
    pulseAvg30: summaries.PULSE?.avg30 ?? null,
    pulseAnomalyCount: summaries.PULSE?.anomalyCount,
    medications: medCompliance.map((m) => ({
      name: m.name,
      compliance7: m.compliance7,
      compliance30: m.compliance30,
    })),
  });

  // Data span
  const firstMeasurement =
    allMeasurements.length > 0 ? allMeasurements[0].measuredAt : null;
  const dataSpanDays = firstMeasurement
    ? Math.ceil(
        (Date.now() - firstMeasurement.getTime()) / (24 * 60 * 60 * 1000),
      )
    : 0;

  annotate({
    action: { name: "insights.comprehensive" },
    meta: {
      totalMeasurements: allMeasurements.length,
      moodEntries: moodEntries.length,
      medications: medications.length,
    },
  });

  return apiSuccess({
    summaries,
    bmi,
    bmiClassification,
    bpClassification,
    bpPctInTarget,
    bpTargets,
    weightBpCorrelation,
    scatterData,
    bpMedicationCorrelation,
    bpMedicationScatterData,
    moodSummary,
    moodBpCorrelation,
    moodBpScatterData,
    moodWeightCorrelation,
    moodWeightScatterData,
    moodPulseCorrelation,
    moodPulseScatterData,
    medications: medCompliance,
    alerts,
    hasProvider: (await resolveProvider(userId)).type !== "none",
    dataSpanDays,
    totalMeasurements: allMeasurements.length,
  });
});
