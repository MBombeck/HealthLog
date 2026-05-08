/**
 * Feature extraction for OpenAI insights.
 * Extracts aggregated health metrics from the database.
 * No raw timestamps or exact values are sent in aggregated mode.
 */
import { prisma } from "@/lib/db";
import { summarize } from "@/lib/analytics/trends";
import type { DataPoint } from "@/lib/analytics/trends";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  pairByTimestamp,
  pearsonCorrelation,
  type CorrelationResult,
} from "@/lib/analytics/correlations";
import { getMedicationCategories } from "@/lib/medication-category";

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
    avg90: number | null;
    allTimeAvg: number | null;
    allTimeMin: number | null;
    allTimeMax: number | null;
    slope30: number | null;
    outlierCount: number;
    bmi: number | null;
    coverage: DataCoverage;
  };
  bloodPressure?: {
    avgSys30: number | null;
    avgDia30: number | null;
    avgSys90: number | null;
    avgDia90: number | null;
    allTimeAvgSys: number | null;
    allTimeAvgDia: number | null;
    allTimeMinSys: number | null;
    allTimeMaxSys: number | null;
    allTimeMinDia: number | null;
    allTimeMaxDia: number | null;
    slopeSys30: number | null;
    slopeDia30: number | null;
    sdSys30: number | null;
    sdDia30: number | null;
    pulsePressure30: number | null;
    pctInTarget: number | null;
    coverage: DataCoverage;
  };
  pulse?: {
    avg7: number | null;
    avg30: number | null;
    avg90: number | null;
    allTimeAvg: number | null;
    allTimeMin: number | null;
    allTimeMax: number | null;
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
  mood?: {
    scale: string;
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    trend30: "improving" | "declining" | "stable" | null;
    totalEntries: number;
    coverage: DataCoverage;
  };
  sleep?: {
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    coverage: DataCoverage;
  };
  activity?: {
    avg7: number | null;
    avg30: number | null;
    latest: number | null;
    coverage: DataCoverage;
  };
  ratePressureProduct?: {
    rpp7: number | null;
    rpp30: number | null;
    risk: "normal" | "elevated" | null;
  };
  bodyCompositionDivergence?: {
    weightStable: boolean;
    bodyFatRising: boolean;
    flag: boolean;
  };
  moodAdherenceRisk?: boolean;
  seasonalVariation?: {
    winterAvgSys: number | null;
    summerAvgSys: number | null;
    delta: number | null;
    significance: "normal" | "elevated" | null;
  };
  correlations?: {
    weightVsSystolic: CorrelationResult | null;
    weightVsDiastolic: CorrelationResult | null;
    pulseVsSystolic: CorrelationResult | null;
    moodVsPulse: CorrelationResult | null;
    moodVsSystolic: CorrelationResult | null;
    moodVsWeight: CorrelationResult | null;
    sleepVsPulse: CorrelationResult | null;
    sleepVsSystolic: CorrelationResult | null;
  };
  historicalComparison?: {
    weight?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    systolic?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    diastolic?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
    pulse?: {
      current7dAvg: number | null;
      previous30dAvg: number | null;
      change: number | null;
    };
  };
  medications?: Array<{
    name: string;
    dose: string;
    category: string;
    compliance7: number;
    compliance30: number;
    compliance90: number;
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
    ageYears: number | null;
    gender: string | null;
  };
}

export interface RawFeatures extends AggregatedFeatures {
  rawMeasurements: Array<{
    type: string;
    value: number;
    dayOffset: number; // days ago (anonymized — no exact date)
  }>;
}

function stdDev(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance =
    values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.round(Math.sqrt(variance) * 10) / 10;
}

function toDataPoints(
  records: Array<{ value: number; measuredAt: Date }>,
): DataPoint[] {
  return records.map((r) => ({ date: r.measuredAt, value: r.value }));
}

function computeCoverage(
  records: Array<{ measuredAt: Date }>,
  now: number,
): DataCoverage {
  if (records.length === 0) {
    return {
      count: 0,
      spanDays: 0,
      avgDaysBetween: null,
      oldestDaysAgo: 0,
      newestDaysAgo: 0,
    };
  }
  const oldest = records[0].measuredAt.getTime();
  const newest = records[records.length - 1].measuredAt.getTime();
  const spanDays = Math.round((newest - oldest) / (24 * 60 * 60 * 1000));
  const avgDaysBetween =
    records.length > 1
      ? Math.round((spanDays / (records.length - 1)) * 10) / 10
      : null;
  return {
    count: records.length,
    spanDays,
    avgDaysBetween,
    oldestDaysAgo: Math.round((now - oldest) / (24 * 60 * 60 * 1000)),
    newestDaysAgo: Math.round((now - newest) / (24 * 60 * 60 * 1000)),
  };
}

/** Compute average of values within a time window (days ago from now). */
function avgInWindow(
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
  fromDaysAgo: number,
  toDaysAgo: number = 0,
): number | null {
  const fromMs = now - fromDaysAgo * 24 * 60 * 60 * 1000;
  const toMs = now - toDaysAgo * 24 * 60 * 60 * 1000;
  const filtered = records.filter((r) => {
    const t = r.measuredAt.getTime();
    return t >= fromMs && t <= toMs;
  });
  if (filtered.length === 0) return null;
  const sum = filtered.reduce((s, r) => s + r.value, 0);
  return Math.round((sum / filtered.length) * 100) / 100;
}

/** Compute historical comparison: current 7d avg vs previous 30d avg (days 7-37). */
function computeHistoricalComparison(
  records: Array<{ value: number; measuredAt: Date }>,
  now: number,
): {
  current7dAvg: number | null;
  previous30dAvg: number | null;
  change: number | null;
} {
  const current7dAvg = avgInWindow(records, now, 7, 0);
  const previous30dAvg = avgInWindow(records, now, 37, 7);
  const change =
    current7dAvg !== null && previous30dAvg !== null
      ? Math.round((current7dAvg - previous30dAvg) * 100) / 100
      : null;
  return { current7dAvg, previous30dAvg, change };
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
      gender: true,
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
  const oldestMeasurement =
    measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestMeasurement =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const overallSpanDays =
    oldestMeasurement && newestMeasurement
      ? Math.round(
          (newestMeasurement.getTime() - oldestMeasurement.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;

  // Compute age
  let ageYears: number | null = null;
  if (user?.dateOfBirth) {
    const dob = user.dateOfBirth;
    const today = new Date();
    ageYears = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      ageYears--;
    }
  }

  const features: AggregatedFeatures = {
    context: {
      heightCm: user?.heightCm ?? null,
      hasBpTargets: !!bpTargets,
      totalMeasurements: measurements.length,
      dataSpanDays: overallSpanDays,
      oldestMeasurementDaysAgo: oldestMeasurement
        ? Math.round(
            (now - oldestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
          )
        : null,
      newestMeasurementDaysAgo: newestMeasurement
        ? Math.round(
            (now - newestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
          )
        : null,
      ageYears,
      gender: user?.gender ?? null,
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
      avg90: avgInWindow(weightData, now, 90),
      allTimeAvg: summary.count > 0 ? summary.mean : null,
      allTimeMin: summary.count > 0 ? summary.min : null,
      allTimeMax: summary.count > 0 ? summary.max : null,
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
      const sysByTime = new Map(
        sysData.map((m) => [m.measuredAt.getTime(), m.value]),
      );
      let inTargetCount = 0;
      let pairedCount = 0;
      for (const dia of diaData) {
        const sysVal = sysByTime.get(dia.measuredAt.getTime());
        if (sysVal === undefined) continue;
        pairedCount++;
        if (
          sysVal >= bpTargets.sysLow &&
          sysVal <= bpTargets.sysHigh &&
          dia.value >= bpTargets.diaLow &&
          dia.value <= bpTargets.diaHigh
        ) {
          inTargetCount++;
        }
      }
      pctInTarget =
        pairedCount > 0
          ? Math.round((inTargetCount / pairedCount) * 100)
          : null;
    }

    features.bloodPressure = {
      avgSys30: sysSummary?.avg30 ?? null,
      avgDia30: diaSummary?.avg30 ?? null,
      avgSys90: sysData.length > 0 ? avgInWindow(sysData, now, 90) : null,
      avgDia90: diaData.length > 0 ? avgInWindow(diaData, now, 90) : null,
      allTimeAvgSys: sysSummary?.count ? sysSummary.mean : null,
      allTimeAvgDia: diaSummary?.count ? diaSummary.mean : null,
      allTimeMinSys: sysSummary?.count ? sysSummary.min : null,
      allTimeMaxSys: sysSummary?.count ? sysSummary.max : null,
      allTimeMinDia: diaSummary?.count ? diaSummary.min : null,
      allTimeMaxDia: diaSummary?.count ? diaSummary.max : null,
      slopeSys30: sysSummary?.slope30?.slope ?? null,
      slopeDia30: diaSummary?.slope30?.slope ?? null,
      sdSys30: (() => {
        const fromMs = now - 30 * 24 * 60 * 60 * 1000;
        const vals = sysData
          .filter((m) => m.measuredAt.getTime() >= fromMs)
          .map((m) => m.value);
        return stdDev(vals);
      })(),
      sdDia30: (() => {
        const fromMs = now - 30 * 24 * 60 * 60 * 1000;
        const vals = diaData
          .filter((m) => m.measuredAt.getTime() >= fromMs)
          .map((m) => m.value);
        return stdDev(vals);
      })(),
      pulsePressure30: (() => {
        const avgSys = sysSummary?.avg30 ?? null;
        const avgDia = diaSummary?.avg30 ?? null;
        if (avgSys === null || avgDia === null) return null;
        return Math.round((avgSys - avgDia) * 10) / 10;
      })(),
      pctInTarget,
      coverage: computeCoverage(
        [...sysData, ...diaData].sort(
          (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime(),
        ),
        now,
      ),
    };
  }

  // Pulse
  const pulseData = byType("PULSE");
  if (pulseData.length > 0) {
    const summary = summarize(toDataPoints(pulseData));
    features.pulse = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      avg90: avgInWindow(pulseData, now, 90),
      allTimeAvg: summary.count > 0 ? summary.mean : null,
      allTimeMin: summary.count > 0 ? summary.min : null,
      allTimeMax: summary.count > 0 ? summary.max : null,
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

  // Sleep Duration
  const sleepData = byType("SLEEP_DURATION");
  if (sleepData.length > 0) {
    const summary = summarize(toDataPoints(sleepData));
    features.sleep = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      latest: summary.latest,
      coverage: computeCoverage(sleepData, now),
    };
  }

  // Activity Steps
  const activityData = byType("ACTIVITY_STEPS");
  if (activityData.length > 0) {
    const summary = summarize(toDataPoints(activityData));
    features.activity = {
      avg7: summary.avg7,
      avg30: summary.avg30,
      latest: summary.latest,
      coverage: computeCoverage(activityData, now),
    };
  }

  // Mood
  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId },
    orderBy: { moodLoggedAt: "asc" },
  });

  if (moodEntries.length > 0) {
    const moodNow = Date.now();
    const last7 = moodEntries.filter(
      (e) => moodNow - e.moodLoggedAt.getTime() < 7 * 24 * 60 * 60 * 1000,
    );
    const last30 = moodEntries.filter(
      (e) => moodNow - e.moodLoggedAt.getTime() < 30 * 24 * 60 * 60 * 1000,
    );

    const avg = (entries: typeof moodEntries) =>
      entries.length > 0
        ? Math.round(
            (entries.reduce((s, e) => s + e.score, 0) / entries.length) * 100,
          ) / 100
        : null;

    // Compute 30-day trend: compare first half vs second half of last 30 days
    let trend30: "improving" | "declining" | "stable" | null = null;
    if (last30.length >= 4) {
      const firstHalf = last30.filter(
        (e) => moodNow - e.moodLoggedAt.getTime() >= 15 * 24 * 60 * 60 * 1000,
      );
      const secondHalf = last30.filter(
        (e) => moodNow - e.moodLoggedAt.getTime() < 15 * 24 * 60 * 60 * 1000,
      );
      if (firstHalf.length >= 2 && secondHalf.length >= 2) {
        const avgFirst = avg(firstHalf)!;
        const avgSecond = avg(secondHalf)!;
        const diff = avgSecond - avgFirst;
        if (diff > 0.3) trend30 = "improving";
        else if (diff < -0.3) trend30 = "declining";
        else trend30 = "stable";
      }
    }

    const oldest = moodEntries[0].moodLoggedAt;
    const newest = moodEntries[moodEntries.length - 1].moodLoggedAt;
    const spanDays = Math.round(
      (newest.getTime() - oldest.getTime()) / (24 * 60 * 60 * 1000),
    );
    const avgDaysBetween =
      moodEntries.length > 1
        ? Math.round((spanDays / (moodEntries.length - 1)) * 10) / 10
        : null;

    features.mood = {
      scale: "1=LAUSIG, 2=SCHLECHT, 3=OKAY, 4=GUT, 5=SUPER_GUT",
      avg7: avg(last7),
      avg30: avg(last30),
      latest: moodEntries[moodEntries.length - 1].score,
      trend30,
      totalEntries: moodEntries.length,
      coverage: {
        count: moodEntries.length,
        spanDays,
        avgDaysBetween,
        oldestDaysAgo: Math.round(
          (moodNow - oldest.getTime()) / (24 * 60 * 60 * 1000),
        ),
        newestDaysAgo: Math.round(
          (moodNow - newest.getTime()) / (24 * 60 * 60 * 1000),
        ),
      },
    };
  }

  // Cross-metric correlations
  const weightPoints = toDataPoints(weightData);
  const sysPoints = toDataPoints(sysData);
  const diaPoints = toDataPoints(diaData);
  const pulsePoints = toDataPoints(pulseData);
  const moodPoints: DataPoint[] = moodEntries.map((e) => ({
    date: e.moodLoggedAt,
    value: e.score,
  }));

  const computeCorr = (a: DataPoint[], b: DataPoint[]) =>
    pearsonCorrelation(pairByTimestamp(a, b));

  const sleepPoints = toDataPoints(sleepData);

  features.correlations = {
    weightVsSystolic: computeCorr(weightPoints, sysPoints),
    weightVsDiastolic: computeCorr(weightPoints, diaPoints),
    pulseVsSystolic: computeCorr(pulsePoints, sysPoints),
    moodVsPulse: computeCorr(moodPoints, pulsePoints),
    moodVsSystolic: computeCorr(moodPoints, sysPoints),
    moodVsWeight: computeCorr(moodPoints, weightPoints),
    sleepVsPulse:
      sleepData.length > 0 ? computeCorr(sleepPoints, pulsePoints) : null,
    sleepVsSystolic:
      sleepData.length > 0 ? computeCorr(sleepPoints, sysPoints) : null,
  };

  // Rate-Pressure Product (RPP) — myocardial oxygen demand indicator
  if (features.pulse && features.bloodPressure) {
    const rpp7 =
      features.pulse.avg7 !== null && features.bloodPressure.avgSys30 !== null
        ? Math.round(
            features.pulse.avg7 *
              (avgInWindow(sysData, now, 7) ?? features.bloodPressure.avgSys30),
          )
        : null;
    const rpp30 =
      features.pulse.avg30 !== null && features.bloodPressure.avgSys30 !== null
        ? Math.round(features.pulse.avg30 * features.bloodPressure.avgSys30)
        : null;
    const rppRef = rpp30 ?? rpp7;
    features.ratePressureProduct = {
      rpp7,
      rpp30,
      risk: rppRef !== null ? (rppRef > 12000 ? "elevated" : "normal") : null,
    };
  }

  // Body Composition Divergence
  if (features.weight && features.bodyFat) {
    const weightStable =
      features.weight.slope30 !== null &&
      Math.abs(features.weight.slope30) < 0.01;
    const bodyFatRising =
      features.bodyFat.slope30 !== null && features.bodyFat.slope30 > 0;
    features.bodyCompositionDivergence = {
      weightStable,
      bodyFatRising,
      flag: weightStable && bodyFatRising,
    };
  }

  // Mood-Adherence Risk Flag
  if (
    features.mood &&
    features.medications &&
    features.medications.length > 0
  ) {
    features.moodAdherenceRisk =
      features.mood.avg7 !== null &&
      features.mood.avg7 <= 2.5 &&
      features.mood.trend30 === "declining";
  }

  // Seasonal BP Variation (only if > 180 days of data)
  if (features.context.dataSpanDays > 180 && sysData.length > 0) {
    const winterMonths = [11, 0, 1]; // Dec, Jan, Feb (0-indexed)
    const summerMonths = [5, 6, 7]; // Jun, Jul, Aug
    const winterVals = sysData
      .filter((m) => winterMonths.includes(m.measuredAt.getMonth()))
      .map((m) => m.value);
    const summerVals = sysData
      .filter((m) => summerMonths.includes(m.measuredAt.getMonth()))
      .map((m) => m.value);
    const winterAvg =
      winterVals.length > 0
        ? Math.round(
            (winterVals.reduce((s, v) => s + v, 0) / winterVals.length) * 10,
          ) / 10
        : null;
    const summerAvg =
      summerVals.length > 0
        ? Math.round(
            (summerVals.reduce((s, v) => s + v, 0) / summerVals.length) * 10,
          ) / 10
        : null;
    const delta =
      winterAvg !== null && summerAvg !== null
        ? Math.round((winterAvg - summerAvg) * 10) / 10
        : null;
    features.seasonalVariation = {
      winterAvgSys: winterAvg,
      summerAvgSys: summerAvg,
      delta,
      significance:
        delta !== null ? (Math.abs(delta) > 5 ? "elevated" : "normal") : null,
    };
  }

  // Historical comparison: current 7d avg vs previous 30d avg (days 7-37)
  features.historicalComparison = {};
  if (weightData.length > 0) {
    features.historicalComparison.weight = computeHistoricalComparison(
      weightData,
      now,
    );
  }
  if (sysData.length > 0) {
    features.historicalComparison.systolic = computeHistoricalComparison(
      sysData,
      now,
    );
  }
  if (diaData.length > 0) {
    features.historicalComparison.diastolic = computeHistoricalComparison(
      diaData,
      now,
    );
  }
  if (pulseData.length > 0) {
    features.historicalComparison.pulse = computeHistoricalComparison(
      pulseData,
      now,
    );
  }

  // Medications
  const medications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
  });

  if (medications.length > 0) {
    const categoryMap = await getMedicationCategories(
      medications.map((med) => med.id),
    );

    // Single batched fetch + in-memory grouping replaces the per-medication
    // findMany loop. Same shape as the v1.3.0 fix to /api/insights/comprehensive
    // (the previous N+1 the v3 audit closed). 90 days is the longest window
    // calculateCompliance uses below, so we don't need the full intake history.
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000);
    const allEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        medicationId: { in: medications.map((med) => med.id) },
        scheduledFor: { gte: ninetyDaysAgo },
      },
      orderBy: { scheduledFor: "desc" },
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

    features.medications = medications.map((med) => {
      const mapped = eventsByMed.get(med.id) ?? [];
      const c7 = calculateCompliance(mapped, med.schedules, 7, med.createdAt);
      const c30 = calculateCompliance(mapped, med.schedules, 30, med.createdAt);
      const c90 = calculateCompliance(mapped, med.schedules, 90, med.createdAt);

      return {
        name: med.name,
        dose: med.dose,
        category: categoryMap[med.id] ?? "OTHER",
        compliance7: c7.rate,
        compliance30: c30.rate,
        compliance90: c90.rate,
        streak: c30.streak,
        missedLast7: c7.missed,
      };
    });
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
