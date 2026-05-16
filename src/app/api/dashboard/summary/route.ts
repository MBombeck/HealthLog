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
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { defaultLocale, type Locale } from "@/lib/i18n/config";
import { userDayKey, DEFAULT_TIMEZONE } from "@/lib/tz/resolver";

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
  /**
   * v1.4.33 maintainer-item-1 — total readings the user has ever
   * logged for this metric, irrespective of the 7-day sparkline
   * window. The dashboard tile keeps showing whenever `allTimeCount > 0`
   * so a user with valid historical data isn't surprised by a tile
   * disappearing during a logging gap. Distinct from `sparkline.length`
   * which only carries the trailing-7-day points.
   */
  allTimeCount: number;
  /**
   * v1.4.33 maintainer-item-1 — ISO timestamp of the metric's single
   * most recent reading. When `allTimeCount > 0` but the latest
   * reading is older than 7 days, the iOS tile renders a muted
   * "Letzter Wert vor Xd" caption so the user understands the value
   * isn't stale silently. `null` when the metric has no readings at
   * all.
   */
  lastSeenAt: string | null;
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

function startOfDayInTz(date: Date, tz: string): Date {
  // Compute midnight in the user's tz → UTC ms.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")?.value ?? "1970";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return new Date(`${y}-${m}-${d}T00:00:00.000Z`);
}

interface StreakInfo {
  currentDays: number;
  longest: number;
}

/** Compute the current logging-day streak (days where any measurement or
 *  intake event was recorded, in the user's display timezone) plus the
 *  longest streak in the last `STREAK_WINDOW_DAYS` days.
 *
 *  v1.4.25 W7b — `userTz` parameterises the "today" pivot so a Pacific/
 *  Auckland user gets their Auckland-day streak rather than the Berlin
 *  one. The activity-day Set entries are already produced in the same
 *  zone by the caller (via `userDayKey`), so the cursor walk only needs
 *  the same zone here to align. */
function computeStreak(activityDays: Set<string>, userTz: string): StreakInfo {
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

  // Current streak: walk back from today (user's tz).
  const todayKey = userDayKey(new Date(), userTz);
  let currentDays = 0;
  let cursor = new Date(`${todayKey}T00:00:00.000Z`);
  // Allow yesterday's last day to count if today not yet logged.
  if (!activityDays.has(userDayKey(cursor, userTz))) {
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  while (activityDays.has(userDayKey(cursor, userTz))) {
    currentDays += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }

  return { currentDays, longest };
}

export const GET = apiHandler(async () => {
  const { user } = await requireAuth();
  annotate({ action: { name: "dashboard.summary" } });

  // v1.4.25 W7b — anchor every day-bucket call to the user's display
  // timezone. Falls back to Europe/Berlin when the column is somehow
  // missing (defensive — the schema's NOT NULL default normally pins
  // it).
  const userTz = user.timezone ?? DEFAULT_TIMEZONE;

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - SPARK_DAYS * 86_400_000);
  const streakWindowStart = new Date(
    now.getTime() - STREAK_WINDOW_DAYS * 86_400_000,
  );
  const todayStart = startOfDayInTz(now, userTz);
  const todayEnd = new Date(todayStart.getTime() + 86_400_000);

  // Derived from canonical enum so a new measurement type is auto-included
  // (V3 audit: enum drift cousins). Per-kind display blocks below decide
  // which types render as MetricCards.
  const measurementTypes = [
    ...measurementTypeEnum.options,
  ] as MeasurementType[];

  // v1.4.33 maintainer-item-1 — pull per-type all-time counts + latest
  // timestamps alongside the 7-day sparkline window so the iOS tile
  // can keep rendering when the recent window is empty but the user
  // has logged the metric before. `groupBy` with `_count._all` +
  // `_max(measuredAt)` is a single Postgres aggregate round-trip; no
  // additional row materialisation beyond the aggregate values
  // themselves.
  const [recentMeasurements, allTimeAggregate, todaysIntakes, streakActivity] =
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
      prisma.measurement.groupBy({
        by: ["type"],
        where: { userId: user.id, type: { in: measurementTypes } },
        _count: { _all: true },
        _max: { measuredAt: true },
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

  // Per-type metadata lookup — typed Map so a metric with no readings
  // at all falls through `metaForType` to the `{ allTimeCount: 0,
  // lastSeenAt: null }` default. The aggregate row's `_count._all` is
  // always `number` per Prisma's runtime contract; defending against
  // undefined keeps the helper's narrow signature stable.
  const allTimeByType = new Map<
    MeasurementType,
    { allTimeCount: number; lastSeenAt: Date | null }
  >();
  for (const row of allTimeAggregate) {
    allTimeByType.set(row.type, {
      allTimeCount: row._count?._all ?? 0,
      lastSeenAt: row._max?.measuredAt ?? null,
    });
  }
  function metaForType(type: MeasurementType): {
    allTimeCount: number;
    lastSeenAt: string | null;
  } {
    const slot = allTimeByType.get(type);
    return {
      allTimeCount: slot?.allTimeCount ?? 0,
      lastSeenAt: slot?.lastSeenAt?.toISOString() ?? null,
    };
  }

  const activityDays = new Set<string>();
  for (const m of recentMeasurements)
    activityDays.add(userDayKey(m.measuredAt, userTz));
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
    for (const m of wider) activityDays.add(userDayKey(m.measuredAt, userTz));
  }
  for (const e of streakActivity) {
    activityDays.add(userDayKey(e.takenAt ?? e.scheduledFor, userTz));
  }

  const streak = computeStreak(activityDays, userTz);

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

  // v1.4.33 maintainer-item-1 — every emitted card now carries
  // `allTimeCount` + `lastSeenAt` so the iOS tile renderer can keep
  // a metric visible during a logging gap (gate on `allTimeCount > 0`)
  // and paint a muted "Letzter Wert vor Xd" caption when the most
  // recent reading is older than the 7-day sparkline window.

  // Weight
  {
    const latest = latestOf("WEIGHT");
    const spark = sparkOf("WEIGHT");
    const meta = metaForType("WEIGHT");
    metrics.push({
      id: "weight",
      kind: "weight",
      title: METRIC_TITLES.weight,
      latestValue: latest?.value ?? null,
      secondaryValue: null,
      unit: METRIC_UNITS.weight,
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latest?.at?.toISOString() ?? meta.lastSeenAt,
      allTimeCount: meta.allTimeCount,
      lastSeenAt: meta.lastSeenAt,
    });
  }

  // Blood pressure (paired sys/dia)
  {
    const sysList = byType.get("BLOOD_PRESSURE_SYS") ?? [];
    const diaList = byType.get("BLOOD_PRESSURE_DIA") ?? [];
    const latestSys = sysList[sysList.length - 1] ?? null;
    const latestDia = diaList[diaList.length - 1] ?? null;
    const sysMeta = metaForType("BLOOD_PRESSURE_SYS");
    const diaMeta = metaForType("BLOOD_PRESSURE_DIA");
    // BP is a paired metric — the tile is "alive" whenever either side
    // of the pair has history. Sum the count to reflect total readings
    // and pick the most recent `_max` so the staleness hint follows
    // whichever side is freshest.
    const bpAllTimeCount = sysMeta.allTimeCount + diaMeta.allTimeCount;
    const bpLastSeenAt = ((): string | null => {
      const sysAt = sysMeta.lastSeenAt;
      const diaAt = diaMeta.lastSeenAt;
      if (!sysAt) return diaAt;
      if (!diaAt) return sysAt;
      return sysAt >= diaAt ? sysAt : diaAt;
    })();
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
        latestSys?.at?.toISOString() ??
        latestDia?.at?.toISOString() ??
        bpLastSeenAt,
      allTimeCount: bpAllTimeCount,
      lastSeenAt: bpLastSeenAt,
    });
  }

  // Pulse
  {
    const latest = latestOf("PULSE");
    const spark = sparkOf("PULSE");
    const meta = metaForType("PULSE");
    metrics.push({
      id: "pulse",
      kind: "pulse",
      title: METRIC_TITLES.pulse,
      latestValue: latest?.value ?? null,
      secondaryValue: null,
      unit: METRIC_UNITS.pulse,
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latest?.at?.toISOString() ?? meta.lastSeenAt,
      allTimeCount: meta.allTimeCount,
      lastSeenAt: meta.lastSeenAt,
    });
  }

  // Body fat — v1.4.33 widens the emit gate from `latestOf` (only
  // fires when the 7-day window has a reading) to `allTimeCount > 0`
  // so a tile doesn't disappear during a fortnight without a fresh
  // reading.
  {
    const latest = latestOf("BODY_FAT");
    const spark = sparkOf("BODY_FAT");
    const meta = metaForType("BODY_FAT");
    if (latest || meta.allTimeCount > 0) {
      metrics.push({
        id: "bodyFat",
        kind: "bodyFat",
        title: METRIC_TITLES.bodyFat,
        latestValue: latest?.value ?? null,
        secondaryValue: null,
        unit: METRIC_UNITS.bodyFat,
        trend: trendOf(spark),
        sparkline: spark,
        updatedAt: latest?.at.toISOString() ?? meta.lastSeenAt,
        allTimeCount: meta.allTimeCount,
        lastSeenAt: meta.lastSeenAt,
      });
    }
  }

  // Optional cards — emitted whenever the user has *ever* logged the
  // metric. Up to v1.4.32 the gate was `latestOf(type)` (only fires
  // when the trailing 7-day window has a reading); v1.4.33 widens to
  // the all-time count so a glucose tile that hasn't been touched in
  // 10 days still renders with the historical value visible to the
  // iOS client (paired with the lastSeenAt caption).
  for (const [type, kind] of [
    ["BLOOD_GLUCOSE", "glucose"],
    ["SLEEP_DURATION", "sleep"],
    ["ACTIVITY_STEPS", "steps"],
    ["TOTAL_BODY_WATER", "totalBodyWater"],
    ["BONE_MASS", "boneMass"],
    ["OXYGEN_SATURATION", "oxygenSaturation"],
  ] as const) {
    const latest = latestOf(type);
    const meta = metaForType(type);
    if (!latest && meta.allTimeCount === 0) continue;
    const spark = sparkOf(type);
    metrics.push({
      id: kind,
      kind,
      title: METRIC_TITLES[kind],
      latestValue: latest?.value ?? null,
      secondaryValue: null,
      unit: METRIC_UNITS[kind],
      trend: trendOf(spark),
      sparkline: spark,
      updatedAt: latest?.at.toISOString() ?? meta.lastSeenAt,
      allTimeCount: meta.allTimeCount,
      lastSeenAt: meta.lastSeenAt,
    });
  }

  const scheduledToday = todaysIntakes.length;
  const takenToday = todaysIntakes.filter(
    (e) => e.takenAt !== null && !e.skipped,
  ).length;

  const greetingName = user.displayName ?? user.username;
  const locale: Locale =
    user.locale === "de" || user.locale === "en" ? user.locale : defaultLocale;
  const t = getServerTranslator(locale).t;

  return apiSuccess({
    greeting: {
      salutation: t("dashboard.greetingSalutation", { name: greetingName }),
      date: now.toISOString(),
    },
    streak: {
      currentDays: streak.currentDays,
      longest: streak.longest,
      label: t("dashboard.streakLabel"),
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
