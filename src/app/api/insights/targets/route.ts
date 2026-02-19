import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth/session";
import { apiSuccess, apiError } from "@/lib/api-response";
import {
  classifyBMI,
  classifyBP,
  classifyPulse,
  classifySleepDuration,
  classifyBodyFat,
  getWeightRange,
  getPulseRange,
  getSleepDurationRange,
  getBpTargetsByAge,
} from "@/lib/analytics/classifications";
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

  // 3. Pulse
  const pulseRange = getPulseRange();
  let pulseClassification: { category: string; color: string } | null = null;
  if (latestByType.PULSE != null) {
    const cls = classifyPulse(latestByType.PULSE);
    pulseClassification = { category: cls.category, color: cls.color };
  }
  targets.push({
    type: "PULSE",
    label: "Ruhepuls",
    current: latestByType.PULSE ?? null,
    average30: avg30ByType.PULSE ?? null,
    trend: computeTrend("PULSE"),
    unit: "bpm",
    range: pulseRange,
    classification: pulseClassification,
    source: "AHA",
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

  // 5. Body Fat
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
