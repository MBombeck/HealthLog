/**
 * Feature extraction for OpenAI insights.
 * Extracts aggregated health metrics from the database.
 * No raw timestamps or exact values are sent in aggregated mode.
 */
import { prisma } from "@/lib/db";
import { summarize } from "@/lib/analytics/trends";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { getBpTargets } from "@/lib/analytics/bp-targets";

interface DataCoverage {
  count: number;
  spanDays: number;
  avgDaysBetween: number | null;
  oldestDaysAgo: number;
  newestDaysAgo: number;
}

export interface AggregatedFeatures {
  weight?: {
    latest: number;
    avg7: number | null;
    avg30: number | null;
    slope30: number | null;
    outlierCount: number;
    bmi: number | null;
    coverage: DataCoverage;
  };
  bloodPressure?: {
    avgSys30: number | null;
    avgDia30: number | null;
    slopeSys30: number | null;
    slopeDia30: number | null;
    pctInTarget: number | null;
    coverage: DataCoverage;
  };
  pulse?: {
    avg30: number | null;
    slope30: number | null;
    anomalyCount: number;
    coverage: DataCoverage;
  };
  bodyFat?: {
    latest: number | null;
    avg30: number | null;
    slope30: number | null;
    coverage: DataCoverage;
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
    oldestMeasurementDaysAgo: number | null;
    newestMeasurementDaysAgo: number | null;
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

function computeCoverage(
  records: Array<{ measuredAt: Date }>,
  now: number,
): DataCoverage {
  if (records.length === 0) {
    return { count: 0, spanDays: 0, avgDaysBetween: null, oldestDaysAgo: 0, newestDaysAgo: 0 };
  }
  const oldest = records[0].measuredAt.getTime();
  const newest = records[records.length - 1].measuredAt.getTime();
  const spanDays = Math.round((newest - oldest) / (24 * 60 * 60 * 1000));
  const avgDaysBetween = records.length > 1 ? Math.round(spanDays / (records.length - 1) * 10) / 10 : null;
  return {
    count: records.length,
    spanDays,
    avgDaysBetween,
    oldestDaysAgo: Math.round((now - oldest) / (24 * 60 * 60 * 1000)),
    newestDaysAgo: Math.round((now - newest) / (24 * 60 * 60 * 1000)),
  };
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

  const now = Date.now();

  // Fetch ALL measurements (not just 30 days) for full temporal context
  const measurements = await prisma.measurement.findMany({
    where: { userId },
    orderBy: { measuredAt: "asc" },
  });

  const byType = (type: string) => measurements.filter((m) => m.type === type);

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);

  // Compute overall data span
  const oldestMeasurement = measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestMeasurement = measurements.length > 0 ? measurements[measurements.length - 1].measuredAt : null;
  const overallSpanDays = oldestMeasurement && newestMeasurement
    ? Math.round((newestMeasurement.getTime() - oldestMeasurement.getTime()) / (24 * 60 * 60 * 1000))
    : 0;

  const features: AggregatedFeatures = {
    context: {
      heightCm: user?.heightCm ?? null,
      hasBpTargets: !!bpTargets,
      totalMeasurements: measurements.length,
      dataSpanDays: overallSpanDays,
      oldestMeasurementDaysAgo: oldestMeasurement
        ? Math.round((now - oldestMeasurement.getTime()) / (24 * 60 * 60 * 1000))
        : null,
      newestMeasurementDaysAgo: newestMeasurement
        ? Math.round((now - newestMeasurement.getTime()) / (24 * 60 * 60 * 1000))
        : null,
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
      coverage: computeCoverage(weightData, now),
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
      coverage: computeCoverage([...sysData, ...diaData].sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime()), now),
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
      coverage: computeCoverage(pulseData, now),
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
      coverage: computeCoverage(fatData, now),
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
