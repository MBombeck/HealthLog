/**
 * GET /api/dashboard/summary
 *
 * Aggregator endpoint for the iOS DashboardSummary view. Combines
 * greeting, intake-day streaks, today's medication compliance, the
 * highlighted insight, and per-metric latest+sparkline+trend.
 *
 * The shape is fixed for the iOS client and intentionally normalised —
 * `kind` is iOS-friendly (camelCase), unlike the canonical Prisma enum
 * (BLOOD_PRESSURE_SYS etc.).
 */
import { apiHandler, requireAuth } from "@/lib/api-handler";
import { apiSuccess } from "@/lib/api-response";
import { annotate } from "@/lib/logging/context";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import { measurementTypeEnum } from "@/lib/validations/measurement";

const SPARK_DAYS = 7;
const STREAK_WINDOW_DAYS = 365;

type MetricKind =
  | "weight"
  | "bloodPressure"
  | "pulse"
  | "bodyFat"
  | "glucose"
  | "sleep"
  | "steps"
  | "totalBodyWater"
  | "boneMass"
  | "oxygenSaturation";

interface MetricCard {
  id: string;
  kind: MetricKind;
  title: string;
  latestValue: number | null;
  secondaryValue: number | null;
  unit: string;
  trend: "up" | "down" | "flat" | "unknown";
  sparkline: number[];
  updatedAt: string | null;
}

const METRIC_TITLES: Record<MetricKind, string> = {
  weight: "Gewicht",
  bloodPressure: "Blutdruck",
  pulse: "Puls",
  bodyFat: "Körperfett",
  glucose: "Blutzucker",
  sleep: "Schlaf",
  steps: "Schritte",
  totalBodyWater: "Gesamtkörperwasser",
  boneMass: "Knochenmasse",
  oxygenSaturation: "Sauerstoffsättigung",
};

const METRIC_UNITS: Record<MetricKind, string> = {
  weight: "kg",
  bloodPressure: "mmHg",
  pulse: "bpm",
  bodyFat: "%",
  glucose: "mg/dL",
  sleep: "h",
  steps: "Schritte",
  totalBodyWater: "kg",
  boneMass: "kg",
  oxygenSaturation: "%",
};

function trendOf(values: number[]): MetricCard["trend"] {
  if (values.length < 2) return "unknown";
  const first = values[0];
  const last = values[values.length - 1];
  const delta = last - first;
  const epsilon = Math.max(1, Math.abs(first) * 0.01);
  if (Math.abs(delta) < epsilon) return "flat";
  return delta > 0 ? "up" : "down";
}

function startOfDayBerlin(date: Date): Date {
  // Compute midnight in Europe/Berlin → UTC ms.
  const berlin = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = berlin.find((p) => p.type === "year")?.value ?? "1970";
  const m = berlin.find((p) => p.type === "month")?.value ?? "01";
  const d = berlin.find((p) => p.type === "day")?.value ?? "01";
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

function berlinDayKey(date: Date): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
  }).format(date);
}

interface StreakInfo {
  currentDays: number;
  longest: number;
}

/** Compute the current logging-day streak (days where any measurement or
 *  intake event was recorded, in Berlin time) plus the longest streak in
 *  the last `STREAK_WINDOW_DAYS` days. */
function computeStreak(activityDays: Set<string>): StreakInfo {
  if (activityDays.size === 0) return { currentDays: 0, longest: 0 };

  const sorted = [...activityDays].sort();
  let longest = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(`${sorted[i - 1]}T00:00:00.000Z`).getTime();
    const cur = new Date(`${sorted[i]}T00:00:00.000Z`).getTime();
    if (cur - prev === 86_400_000) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 1;
    }
  }

  // Current streak: walk back from today (Berlin).
  const todayKey = berlinDayKey(new Date());
  let currentDays = 0;
  let cursor = new Date(`${todayKey}T00:00:00.000Z`);
  // Allow yesterday's last day to count if today not yet logged.
  if (!activityDays.has(berlinDayKey(cursor))) {
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  while (activityDays.has(berlinDayKey(cursor))) {
    currentDays += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }

  return { currentDays, longest };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "dashboard.summary" } });

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - SPARK_DAYS * 86_400_000);
  const streakWindowStart = new Date(
    now.getTime() - STREAK_WINDOW_DAYS * 86_400_000,
  );
  const todayStart = startOfDayBerlin(now);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);

  // Derived from canonical enum so a new measurement type is auto-included
  // (V3 audit: enum drift cousins). Per-kind display blocks below decide
  // which types render as MetricCards.
  const measurementTypes = [
    ...measurementTypeEnum.options,
  ] as MeasurementType[];

  const [recentMeasurements, todaysIntakes, streakActivity] =
    await Promise.all([
      prisma.measurement.findMany({
        where: {
          userId: user.id,
          type: { in: measurementTypes },
          measuredAt: { gte: sevenDaysAgo },
        },
        orderBy: { measuredAt: "asc" },
        select: { type: true, value: true, measuredAt: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId: user.id,
          scheduledFor: { gte: todayStart, lt: todayEnd },
        },
        select: { id: true, takenAt: true, skipped: true },
      }),
      prisma.medicationIntakeEvent.findMany({
        where: {
          userId: user.id,
          scheduledFor: { gte: streakWindowStart },
          OR: [{ takenAt: { not: null } }, { skipped: true }],
        },
        select: { takenAt: true, scheduledFor: true },
      }),
    ]);

  const activityDays = new Set<string>();
  for (const m of recentMeasurements) activityDays.add(berlinDayKey(m.measuredAt));
  // Pull a wider measurement window for the streak so it isn't capped by
  // SPARK_DAYS — but only if the user has any data at all.
  if (recentMeasurements.length > 0) {
    const wider = await prisma.measurement.findMany({
      where: {
        userId: user.id,
        measuredAt: { gte: streakWindowStart },
      },
      select: { measuredAt: true },
    });
    for (const m of wider) activityDays.add(berlinDayKey(m.measuredAt));
  }
  for (const e of streakActivity) {
    activityDays.add(berlinDayKey(e.takenAt ?? e.scheduledFor));
  }

  const streak = computeStreak(activityDays);

  // Per-type latest + sparkline.
  const byType = new Map<MeasurementType, { value: number; at: Date }[]>();
  for (const m of recentMeasurements) {
    const list = byType.get(m.type) ?? [];
    list.push({ value: m.value, at: m.measuredAt });
    byType.set(m.type, list);
  }

  function latestOf(type: MeasurementType): { value: number; at: Date } | null {
    const list = byType.get(type);
    if (!list || list.length === 0) return null;
    return list[list.length - 1];
  }

  function sparkOf(type: MeasurementType): number[] {
    const list = byType.get(type);
    if (!list) return [];
    return list.map((p) => p.value);
  }

  const metrics: MetricCard[] = [];

  // Weight
  {
    const latest = latestOf("WEIGHT");
    const spark = sparkOf("WEIGHT");
    metrics.push({
      id: "weight",
      kind: "weight",
      title: METRIC_TITLES.weight,
      latestValue: latest?.value ?? null,
      secondaryValue: null,
      unit: METRIC_UNITS.weight,
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latest?.at.toISOString() ?? null,
    });
  }

  // Blood pressure (paired sys/dia)
  {
    const sysList = byType.get("BLOOD_PRESSURE_SYS") ?? [];
    const diaList = byType.get("BLOOD_PRESSURE_DIA") ?? [];
    const latestSys = sysList[sysList.length - 1] ?? null;
    const latestDia = diaList[diaList.length - 1] ?? null;
    metrics.push({
      id: "bp",
      kind: "bloodPressure",
      title: METRIC_TITLES.bloodPressure,
      latestValue: latestSys?.value ?? null,
      secondaryValue: latestDia?.value ?? null,
      unit: METRIC_UNITS.bloodPressure,
      trend: trendOf(sysList.map((p) => p.value)),
      sparkline: sysList.map((p) => p.value),
      updatedAt:
        latestSys?.at.toISOString() ?? latestDia?.at.toISOString() ?? null,
    });
  }

  // Pulse
  {
    const latest = latestOf("PULSE");
    const spark = sparkOf("PULSE");
    metrics.push({
      id: "pulse",
      kind: "pulse",
      title: METRIC_TITLES.pulse,
      latestValue: latest?.value ?? null,
      secondaryValue: null,
      unit: METRIC_UNITS.pulse,
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latest?.at.toISOString() ?? null,
    });
  }

  // Body fat
  {
    const latest = latestOf("BODY_FAT");
    const spark = sparkOf("BODY_FAT");
    if (latest) {
      metrics.push({
        id: "bodyFat",
        kind: "bodyFat",
        title: METRIC_TITLES.bodyFat,
        latestValue: latest.value,
        secondaryValue: null,
        unit: METRIC_UNITS.bodyFat,
        trend: trendOf(spark),
        sparkline: spark,
        updatedAt: latest.at.toISOString(),
      });
    }
  }

  // Optional cards — only emitted if the user has data for that type.
  for (const [type, kind] of [
    ["BLOOD_GLUCOSE", "glucose"],
    ["SLEEP_DURATION", "sleep"],
    ["ACTIVITY_STEPS", "steps"],
    ["TOTAL_BODY_WATER", "totalBodyWater"],
    ["BONE_MASS", "boneMass"],
    ["OXYGEN_SATURATION", "oxygenSaturation"],
  ] as const) {
    const latest = latestOf(type);
    if (!latest) continue;
    const spark = sparkOf(type);
    metrics.push({
      id: kind,
      kind,
      title: METRIC_TITLES[kind],
      latestValue: latest.value,
      secondaryValue: null,
      unit: METRIC_UNITS[kind],
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latest.at.toISOString(),
    });
  }

  const scheduledToday = todaysIntakes.length;
  const takenToday = todaysIntakes.filter(
    (e) => e.takenAt !== null && !e.skipped,
  ).length;

  const greetingName = user.displayName ?? user.username;

  return apiSuccess({
    greeting: {
      salutation: `Hi, ${greetingName}`,
      date: now.toISOString(),
    },
    streak: {
      currentDays: streak.currentDays,
      longest: streak.longest,
      label: "Tage in Folge",
    },
    compliance: {
      scheduledToday,
      takenToday,
    },
    highlightInsight: null,
    metrics,
    lastUpdated: now.toISOString(),
  });
});
