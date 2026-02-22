import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  classifyBMI,
  classifyBP,
  classifySleepDuration,
  classifyBodyFat,
  classifySteps,
  getWeightRange,
  getSleepDurationRange,
  getStepsRange,
  getBpTargetsByAge,
} from "@/lib/analytics/classifications";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { pairByTimestamp } from "@/lib/analytics/correlations";
import {
  classifyPulseByTarget,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import type { MeasurementType } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

function getAge(dateOfBirth: Date): number {
  const today = new Date();
  let age = today.getFullYear() - dateOfBirth.getFullYear();
  const monthDiff = today.getMonth() - dateOfBirth.getMonth();
  if (
    monthDiff < 0 ||
    (monthDiff === 0 && today.getDate() < dateOfBirth.getDate())
  ) {
    age--;
  }
  return age;
}

interface TargetItem {
  type: string;
  label: string;
  current: number | null;
  average30: number | null;
  trend: "up" | "down" | "stable" | null;
  unit: string;
  range: { min: number; max: number } | null;
  classification: { category: string; color: string } | null;
  source: string;
  details?: {
    medications?: Array<{
      name: string;
      compliance7: number;
      compliance30: number;
    }>;
  };
}

export async function GET() {
  const sessionData = await getSession();
  if (!sessionData) return apiError("Nicht angemeldet", 401);

  const userId = sessionData.user.id;

  // Fetch user profile
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
      gender: true,
    },
  });

  const age = user?.dateOfBirth ? getAge(new Date(user.dateOfBirth)) : null;
  const gender = (user?.gender as "MALE" | "FEMALE" | null) ?? null;
  const heightCm = user?.heightCm ?? null;

  // Fetch latest measurements for each type
  const types: MeasurementType[] = [
    "WEIGHT",
    "BLOOD_PRESSURE_SYS",
    "BLOOD_PRESSURE_DIA",
    "PULSE",
    "SLEEP_DURATION",
    "BODY_FAT",
    "ACTIVITY_STEPS",
  ];

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // Fetch all measurements in the last 30 days + the latest for each type
  const recentMeasurements = await prisma.measurement.findMany({
    where: {
      userId,
      type: { in: types },
      measuredAt: { gte: thirtyDaysAgo },
    },
    orderBy: { measuredAt: "desc" },
    select: { type: true, value: true, measuredAt: true },
  });

  // Also get the absolute latest measurement per type (even if older than 30 days)
  const latestByType: Record<string, number | null> = {};
  const avg30ByType: Record<string, number | null> = {};

  for (const t of types) {
    // Latest value
    const latest = await prisma.measurement.findFirst({
      where: { userId, type: t },
      orderBy: { measuredAt: "desc" },
      select: { value: true },
    });
    latestByType[t] = latest?.value ?? null;

    // 30-day average
    const recentOfType = recentMeasurements.filter((m) => m.type === t);
    if (recentOfType.length > 0) {
      const sum = recentOfType.reduce((acc, m) => acc + m.value, 0);
      avg30ByType[t] = Math.round((sum / recentOfType.length) * 10) / 10;
    } else {
      avg30ByType[t] = null;
    }
  }

  // Compute trend (compare first half of 30-day data to second half)
  function computeTrend(
    type: MeasurementType,
  ): "up" | "down" | "stable" | null {
    const data = recentMeasurements
      .filter((m) => m.type === type)
      .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
    if (data.length < 4) return null;

    const mid = Math.floor(data.length / 2);
    const firstHalf = data.slice(0, mid);
    const secondHalf = data.slice(mid);

    const avgFirst =
      firstHalf.reduce((s, m) => s + m.value, 0) / firstHalf.length;
    const avgSecond =
      secondHalf.reduce((s, m) => s + m.value, 0) / secondHalf.length;

    const diff = avgSecond - avgFirst;
    const threshold = avgFirst * 0.02; // 2% change threshold

    if (diff > threshold) return "up";
    if (diff < -threshold) return "down";
    return "stable";
  }

  // Build target items
  const targets: TargetItem[] = [];

  // 1. Weight
  const weightRange = heightCm ? getWeightRange(heightCm) : null;
  let weightClassification: { category: string; color: string } | null = null;
  if (latestByType.WEIGHT != null && heightCm) {
    const heightM = heightCm / 100;
    const bmi = latestByType.WEIGHT / (heightM * heightM);
    const cls = classifyBMI(bmi);
    weightClassification = { category: cls.category, color: cls.color };
  }
  targets.push({
    type: "WEIGHT",
    label: "Gewicht",
    current: latestByType.WEIGHT ?? null,
    average30: avg30ByType.WEIGHT ?? null,
    trend: computeTrend("WEIGHT"),
    unit: "kg",
    range: weightRange,
    classification: weightClassification,
    source: "WHO BMI",
  });

  // 2. Blood Pressure (sys/dia combined)
  const bpRange = age != null ? getBpTargetsByAge(age, gender) : null;
  let bpClassification: { category: string; color: string } | null = null;
  if (
    latestByType.BLOOD_PRESSURE_SYS != null &&
    latestByType.BLOOD_PRESSURE_DIA != null
  ) {
    const cls = classifyBP(
      latestByType.BLOOD_PRESSURE_SYS,
      latestByType.BLOOD_PRESSURE_DIA,
    );
    bpClassification = { category: cls.category, color: cls.color };
  }
  targets.push({
    type: "BLOOD_PRESSURE",
    label: "Blutdruck",
    current: latestByType.BLOOD_PRESSURE_SYS ?? null,
    average30: avg30ByType.BLOOD_PRESSURE_SYS ?? null,
    trend: computeTrend("BLOOD_PRESSURE_SYS"),
    unit: "mmHg",
    range: bpRange ? { min: bpRange.sysLow, max: bpRange.sysHigh } : null,
    classification: bpClassification,
    source: "ESC/ESH 2018",
    // Extra fields for diastolic
  } as TargetItem);

  // 2b. Blood pressure target-hit rate over 30 days
  if (bpRange) {
    const sysPoints = recentMeasurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_SYS")
      .map((measurement) => ({
        date: measurement.measuredAt,
        value: measurement.value,
      }));
    const diaPoints = recentMeasurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_DIA")
      .map((measurement) => ({
        date: measurement.measuredAt,
        value: measurement.value,
      }));

    const bpPairs = pairByTimestamp(sysPoints, diaPoints, 5 * 60 * 1000);
    const bpInTargetCount = bpPairs.filter(
      (pair) =>
        pair.a >= bpRange.sysLow &&
        pair.a <= bpRange.sysHigh &&
        pair.b >= bpRange.diaLow &&
        pair.b <= bpRange.diaHigh,
    ).length;
    const bpInTargetRate =
      bpPairs.length > 0
        ? Math.round((bpInTargetCount / bpPairs.length) * 100 * 10) / 10
        : null;

    targets.push({
      type: "BLOOD_PRESSURE_IN_TARGET",
      label: "Blutdruck im Zielbereich",
      current: bpInTargetRate,
      average30: bpInTargetRate,
      trend: null,
      unit: "%",
      range: { min: 70, max: 100 },
      classification:
        bpInTargetRate != null
          ? bpInTargetRate >= 70
            ? { category: "Gut", color: "#50fa7b" }
            : bpInTargetRate >= 40
              ? { category: "Moderat", color: "#f1fa8c" }
              : { category: "Niedrig", color: "#ff5555" }
          : null,
      source: "ESC/ESH 2018",
    });
  }

  // 3. Pulse
  const pulseTarget = getPersonalizedPulseTarget(age, gender);
  let pulseClassification: { category: string; color: string } | null = null;
  if (latestByType.PULSE != null) {
    const cls = classifyPulseByTarget(latestByType.PULSE, pulseTarget);
    pulseClassification = { category: cls.category, color: cls.color };
  }
  targets.push({
    type: "PULSE",
    label: "Ruhepuls",
    current: latestByType.PULSE ?? null,
    average30: avg30ByType.PULSE ?? null,
    trend: computeTrend("PULSE"),
    unit: "bpm",
    range: { min: pulseTarget.greenMin, max: pulseTarget.greenMax },
    classification: pulseClassification,
    source: pulseTarget.source,
  });

  // 4. Sleep Duration
  const sleepRange = getSleepDurationRange();
  let sleepClassification: { category: string; color: string } | null = null;
  if (latestByType.SLEEP_DURATION != null) {
    const cls = classifySleepDuration(latestByType.SLEEP_DURATION);
    sleepClassification = { category: cls.category, color: cls.color };
  }
  targets.push({
    type: "SLEEP_DURATION",
    label: "Schlafdauer",
    current: latestByType.SLEEP_DURATION ?? null,
    average30: avg30ByType.SLEEP_DURATION ?? null,
    trend: computeTrend("SLEEP_DURATION"),
    unit: "h",
    range: sleepRange,
    classification: sleepClassification,
    source: "AASM/SRS",
  });

  // 5. BMI (derived from weight + height)
  if (heightCm) {
    const heightM = heightCm / 100;
    const heightSq = heightM * heightM;
    const latestWeight = latestByType.WEIGHT ?? null;
    const currentBmi =
      latestWeight != null
        ? Math.round((latestWeight / heightSq) * 10) / 10
        : null;

    // Compute 30-day average BMI from average weight
    const avgWeight = avg30ByType.WEIGHT ?? null;
    const avgBmi =
      avgWeight != null ? Math.round((avgWeight / heightSq) * 10) / 10 : null;

    let bmiClassification: { category: string; color: string } | null = null;
    if (currentBmi != null) {
      const cls = classifyBMI(currentBmi);
      bmiClassification = { category: cls.category, color: cls.color };
    }

    targets.push({
      type: "BMI",
      label: "BMI",
      current: currentBmi,
      average30: avgBmi,
      trend: computeTrend("WEIGHT"), // BMI trend follows weight trend
      unit: "kg/m²",
      range: { min: 18.5, max: 24.9 },
      classification: bmiClassification,
      source: "WHO",
    });
  }

  // 6. Body Fat
  let bodyFatClassification: { category: string; color: string } | null = null;
  if (latestByType.BODY_FAT != null && age != null) {
    const cls = classifyBodyFat(latestByType.BODY_FAT, gender, age);
    bodyFatClassification = { category: cls.category, color: cls.color };
  }
  // Body fat ranges depend on gender/age; provide simplified ranges
  let bodyFatRange: { min: number; max: number } | null = null;
  if (gender === "MALE") {
    bodyFatRange = { min: 14, max: 24 };
  } else if (gender === "FEMALE") {
    bodyFatRange = { min: 21, max: 31 };
  } else if (age != null) {
    // Average of male/female fitness+average ranges
    bodyFatRange = { min: 17.5, max: 27.5 };
  }
  targets.push({
    type: "BODY_FAT",
    label: "Körperfett",
    current: latestByType.BODY_FAT ?? null,
    average30: avg30ByType.BODY_FAT ?? null,
    trend: computeTrend("BODY_FAT"),
    unit: "%",
    range: bodyFatRange,
    classification: bodyFatClassification,
    source: "ACE",
  });

  // 7. Activity Steps
  const stepsRange = getStepsRange();
  let stepsClassification: { category: string; color: string } | null = null;
  if (avg30ByType.ACTIVITY_STEPS != null) {
    const cls = classifySteps(avg30ByType.ACTIVITY_STEPS);
    stepsClassification = { category: cls.category, color: cls.color };
  }
  targets.push({
    type: "ACTIVITY_STEPS",
    label: "Schritte/Tag",
    current: latestByType.ACTIVITY_STEPS ?? null,
    average30: avg30ByType.ACTIVITY_STEPS ?? null,
    trend: computeTrend("ACTIVITY_STEPS"),
    unit: "Schritte",
    range: stepsRange,
    classification: stepsClassification,
    source: "WHO",
  });

  // 8. Medication Compliance (average across active medications)
  const activeMedications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
    orderBy: { name: "asc" },
  });

  if (activeMedications.length > 0) {
    const thirtyDaysAgoIntake = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const intakeEvents = await prisma.medicationIntakeEvent.findMany({
      where: {
        userId,
        medicationId: { in: activeMedications.map((medication) => medication.id) },
        scheduledFor: { gte: thirtyDaysAgoIntake },
      },
      orderBy: { scheduledFor: "desc" },
      select: { medicationId: true, takenAt: true, skipped: true, scheduledFor: true },
    });

    const medicationStats = activeMedications.map((medication) => {
      const medicationEvents = intakeEvents.filter(
        (event) => event.medicationId === medication.id,
      );
      const compliance7 = calculateCompliance(
        medicationEvents,
        medication.schedules,
        7,
        medication.createdAt,
      );
      const compliance30 = calculateCompliance(
        medicationEvents,
        medication.schedules,
        30,
        medication.createdAt,
      );

      return {
        name: medication.name,
        compliance7: compliance7.rate,
        compliance30: compliance30.rate,
        totalExpected7: compliance7.totalExpected,
        taken7: compliance7.taken,
        totalExpected30: compliance30.totalExpected,
        taken30: compliance30.taken,
      };
    });

    const totalExpected7 = medicationStats.reduce(
      (sum, medication) => sum + medication.totalExpected7,
      0,
    );
    const totalTaken7 = medicationStats.reduce(
      (sum, medication) => sum + medication.taken7,
      0,
    );
    const totalExpected30 = medicationStats.reduce(
      (sum, medication) => sum + medication.totalExpected30,
      0,
    );
    const totalTaken30 = medicationStats.reduce(
      (sum, medication) => sum + medication.taken30,
      0,
    );

    const complianceRate7 =
      totalExpected7 > 0
        ? Math.round((Math.min(1, totalTaken7 / totalExpected7) * 100 + Number.EPSILON) * 10) /
          10
        : null;
    const complianceRate30 =
      totalExpected30 > 0
        ? Math.round(
            (Math.min(1, totalTaken30 / totalExpected30) * 100 + Number.EPSILON) *
              10,
          ) / 10
        : complianceRate7;

    targets.push({
      type: "MEDICATION_COMPLIANCE",
      label: "Einnahmetreue",
      current: complianceRate7,
      average30: complianceRate30,
      trend: null,
      unit: "%",
      range: { min: 90, max: 100 },
      classification:
        complianceRate7 != null
          ? complianceRate7 >= 90
            ? { category: "Sehr gut", color: "#50fa7b" }
            : complianceRate7 >= 70
              ? { category: "Gut", color: "#f1fa8c" }
              : { category: "Niedrig", color: "#ff5555" }
          : null,
      source: "7-Tage",
      details: {
        medications: medicationStats.map((medication) => ({
          name: medication.name,
          compliance7: medication.compliance7,
          compliance30: medication.compliance30,
        })),
      },
    });
  }

  // 9. Mood targets (if mood data exists)
  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId },
    orderBy: { moodLoggedAt: "desc" },
    select: { score: true, moodLoggedAt: true },
  });

  if (moodEntries.length >= 3) {
    const thirtyDaysAgoMood = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const recentMood = moodEntries.filter(
      (entry) => entry.moodLoggedAt >= thirtyDaysAgoMood,
    );
    const latestMoodScore = moodEntries[0]?.score ?? null;

    const moodAvg30 =
      recentMood.length > 0
        ? Math.round(
            (recentMood.reduce((sum, e) => sum + e.score, 0) /
              recentMood.length) *
              10,
          ) / 10
        : null;

    // Mood trend: compare first half to second half of last 30 days
    let moodTrend: "up" | "down" | "stable" | null = null;
    if (recentMood.length >= 4) {
      const sorted = [...recentMood].sort(
        (a, b) => a.moodLoggedAt.getTime() - b.moodLoggedAt.getTime(),
      );
      const mid = Math.floor(sorted.length / 2);
      const firstHalf = sorted.slice(0, mid);
      const secondHalf = sorted.slice(mid);
      const avgFirst =
        firstHalf.reduce((s, e) => s + e.score, 0) / firstHalf.length;
      const avgSecond =
        secondHalf.reduce((s, e) => s + e.score, 0) / secondHalf.length;
      const diff = avgSecond - avgFirst;
      if (diff > 0.2) moodTrend = "up";
      else if (diff < -0.2) moodTrend = "down";
      else moodTrend = "stable";
    }

    const moodClassification =
      latestMoodScore != null
        ? latestMoodScore >= 3.5
          ? { category: "Gut", color: "#50fa7b" }
          : latestMoodScore >= 2
            ? { category: "Moderat", color: "#f1fa8c" }
            : { category: "Niedrig", color: "#ff5555" }
        : null;

    targets.push({
      type: "MOOD_SCORE",
      label: "Stimmung",
      current: latestMoodScore,
      average30: moodAvg30,
      trend: moodTrend,
      unit: "/ 5",
      range: { min: 3.5, max: 5 },
      classification: moodClassification,
      source: "moodLog",
    });

    // Mood stability: standard deviation of recent scores (lower = more stable)
    if (recentMood.length >= 5) {
      const mean = moodAvg30 ?? latestMoodScore ?? 3;
      const variance =
        recentMood.reduce((sum, e) => sum + (e.score - mean) ** 2, 0) /
        recentMood.length;
      const stdDev = Math.round(Math.sqrt(variance) * 100) / 100;

      const stabilityClassification =
        stdDev <= 0.5
          ? { category: "Sehr stabil", color: "#50fa7b" }
          : stdDev <= 1.0
            ? { category: "Stabil", color: "#f1fa8c" }
            : { category: "Schwankend", color: "#ff5555" };

      targets.push({
        type: "MOOD_STABILITY",
        label: "Stimmungsstabilität",
        current: stdDev,
        average30: stdDev,
        trend: null,
        unit: "σ",
        range: { min: 0, max: 0.5 },
        classification: stabilityClassification,
        source: "moodLog",
      });
    }
  }

  return apiSuccess({
    targets,
    // Extra diastolic data for BP display
    bpDiastolic: {
      current: latestByType.BLOOD_PRESSURE_DIA ?? null,
      average30: avg30ByType.BLOOD_PRESSURE_DIA ?? null,
      range: bpRange ? { min: bpRange.diaLow, max: bpRange.diaHigh } : null,
    },
    profile: {
      heightCm,
      age,
      gender,
    },
  });
}
