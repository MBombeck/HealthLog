/**
 * Feature extraction for OpenAI insights.
 * Extracts aggregated health metrics from the database.
 * No raw timestamps or exact values are sent in aggregated mode.
 */
import { prisma } from "@/lib/db";
import { summarize } from "@/lib/analytics/trends";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { getBpTargets } from "@/lib/analytics/bp-targets";

export interface AggregatedFeatures {
  weight?: {
    latest: number;
    avg7: number | null;
    avg30: number | null;
    slope30: number | null;
    outlierCount: number;
    bmi: number | null;
  };
  bloodPressure?: {
    avgSys30: number | null;
    avgDia30: number | null;
    slopeSys30: number | null;
    slopeDia30: number | null;
    pctInTarget: number | null;
  };
  pulse?: {
    avg30: number | null;
    slope30: number | null;
    anomalyCount: number;
  };
  bodyFat?: {
    latest: number | null;
    avg30: number | null;
    slope30: number | null;
  };
  medications?: Array<{
    name: string;
    dose: string;
    compliance7: number;
    compliance30: number;
    streak: number;
    missedLast7: number;
  }>;
  context: {
    heightCm: number | null;
    hasBpTargets: boolean;
    totalMeasurements: number;
    dataSpanDays: number;
  };
}

export interface RawFeatures extends AggregatedFeatures {
  rawMeasurements: Array<{
    type: string;
    value: number;
    dayOffset: number; // days ago (anonymized — no exact date)
  }>;
}

function toDataPoints(
  records: Array<{ value: number; measuredAt: Date }>,
): Array<{ date: Date; value: number }> {
  return records.map((r) => ({ date: r.measuredAt, value: r.value }));
}

export async function extractFeatures(
  userId: string,
  includeRaw: boolean,
): Promise<AggregatedFeatures | RawFeatures> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
    },
  });

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Fetch all recent measurements
  const measurements = await prisma.measurement.findMany({
    where: { userId, measuredAt: { gte: thirtyDaysAgo } },
    orderBy: { measuredAt: "asc" },
  });

  const byType = (type: string) => measurements.filter((m) => m.type === type);

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);

  const features: AggregatedFeatures = {
    context: {
      heightCm: user?.heightCm ?? null,
      hasBpTargets: !!bpTargets,
      totalMeasurements: measurements.length,
      dataSpanDays: 30,
    },
  };

  // Weight
  const weightData = byType("WEIGHT");
  if (weightData.length > 0) {
    const summary = summarize(toDataPoints(weightData));
    const bmi =
      user?.heightCm && summary.latest
        ? parseFloat((summary.latest / (user.heightCm / 100) ** 2).toFixed(1))
        : null;

    features.weight = {
      latest: summary.latest!,
      avg7: summary.avg7,
      avg30: summary.avg30,
      slope30: summary.slope30?.slope ?? null,
      outlierCount: summary.anomalyCount,
      bmi,
    };
  }

  // Blood Pressure
  const sysData = byType("BLOOD_PRESSURE_SYS");
  const diaData = byType("BLOOD_PRESSURE_DIA");
  if (sysData.length > 0 || diaData.length > 0) {
    const sysSummary =
      sysData.length > 0 ? summarize(toDataPoints(sysData)) : null;
    const diaSummary =
      diaData.length > 0 ? summarize(toDataPoints(diaData)) : null;

    let pctInTarget: number | null = null;
    if (bpTargets) {
      const sysInRange = sysData.filter(
        (m) => m.value >= bpTargets.sysLow && m.value <= bpTargets.sysHigh,
      ).length;
      const diaInRange = diaData.filter(
        (m) => m.value >= bpTargets.diaLow && m.value <= bpTargets.diaHigh,
      ).length;
      const total = sysData.length + diaData.length;
      if (total > 0) {
        pctInTarget = Math.round(((sysInRange + diaInRange) / total) * 100);
      }
    }

    features.bloodPressure = {
      avgSys30: sysSummary?.avg30 ?? null,
      avgDia30: diaSummary?.avg30 ?? null,
      slopeSys30: sysSummary?.slope30?.slope ?? null,
      slopeDia30: diaSummary?.slope30?.slope ?? null,
      pctInTarget,
    };
  }

  // Pulse
  const pulseData = byType("PULSE");
  if (pulseData.length > 0) {
    const summary = summarize(toDataPoints(pulseData));
    features.pulse = {
      avg30: summary.avg30,
      slope30: summary.slope30?.slope ?? null,
      anomalyCount: summary.anomalyCount,
    };
  }

  // Body Fat
  const fatData = byType("BODY_FAT");
  if (fatData.length > 0) {
    const summary = summarize(toDataPoints(fatData));
    features.bodyFat = {
      latest: summary.latest,
      avg30: summary.avg30,
      slope30: summary.slope30?.slope ?? null,
    };
  }

  // Medications
  const medications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
  });

  if (medications.length > 0) {
    features.medications = [];
    for (const med of medications) {
      const events = await prisma.medicationIntakeEvent.findMany({
        where: { medicationId: med.id, userId },
        orderBy: { scheduledFor: "desc" },
      });
      const mapped = events.map((e) => ({
        takenAt: e.takenAt,
        skipped: e.skipped,
        scheduledFor: e.scheduledFor,
      }));
      const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt);
      const c30 = calculateCompliance(mapped, med.schedules, 30, med.createdAt);

      features.medications.push({
        name: med.name,
        dose: med.dose,
        compliance7: c7.rate,
        compliance30: c30.rate,
        streak: c7.streak,
        missedLast7: c7.missed,
      });
    }
  }

  // Raw mode: add anonymized raw data points
  if (includeRaw) {
    const now = Date.now();
    const rawFeatures: RawFeatures = {
      ...features,
      rawMeasurements: measurements.map((m) => ({
        type: m.type,
        value: m.value,
        dayOffset: Math.round(
          (now - m.measuredAt.getTime()) / (24 * 60 * 60 * 1000),
        ),
      })),
    };
    return rawFeatures;
  }

  return features;
}
