import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import { getGeneralStatusSystemPrompt, getGeneralStatusUserPrompt } from "@/lib/ai/prompts/general-status";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { getNoKeyGeneralStatusText } from "@/lib/insights/no-key-fallbacks";

const GENERAL_STATUS_POINTS = 30;

const BERLIN_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type SupportedLocale = "de" | "en";

const MEASUREMENT_TYPES = [
  "WEIGHT",
  "BLOOD_PRESSURE_SYS",
  "BLOOD_PRESSURE_DIA",
  "PULSE",
  "BODY_FAT",
  "SLEEP_DURATION",
  "ACTIVITY_STEPS",
] as const;

function toBerlinDayKey(date: Date): string {
  const parts = BERLIN_DAY_FORMATTER.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  if (!year || !month || !day) {
    throw new Error("Could not derive Berlin day key");
  }

  return `${year}-${month}-${day}`;
}

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function aggregateDailyAverageSeries(
  records: Array<{ measuredAt: Date; value: number }>,
) {
  const byDay = new Map<string, { sum: number; count: number }>();

  for (const record of records) {
    const dayKey = toBerlinDayKey(record.measuredAt);
    const current = byDay.get(dayKey) ?? { sum: 0, count: 0 };
    current.sum += record.value;
    current.count += 1;
    byDay.set(dayKey, current);
  }

  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({
      day,
      value: round(stats.sum / stats.count, 2),
      samples: stats.count,
    }));
}

function summarizeSeries(series: Array<{ value: number }>) {
  if (series.length === 0) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  return {
    points: series.length,
    start: round(first, 2),
    end: round(last, 2),
    delta: round(last - first, 2),
    mean: round(average(series.map((entry) => entry.value)), 2),
    min: round(Math.min(...series.map((entry) => entry.value)), 2),
    max: round(Math.max(...series.map((entry) => entry.value)), 2),
  };
}

function normalizeLocale(value: string | null | undefined): SupportedLocale {
  return value === "en" ? "en" : "de";
}

export async function generateGeneralStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const cacheAction = `insights.general-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const provider = await resolveProvider(userId);
  if (provider.type === "none") {
    return {
      hasProvider: false,
      text: getNoKeyGeneralStatusText(locale),
      cached: true,
      updatedAt: null,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
    },
  });

  const latestCache = await prisma.auditLog.findFirst({
    where: { userId, action: cacheAction },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true, details: true },
  });

  if (!force && latestCache?.details) {
    try {
      const parsed = JSON.parse(latestCache.details) as {
        dateKey?: string;
        text?: string;
      };
      if (
        parsed.dateKey === todayKey &&
        typeof parsed.text === "string" &&
        parsed.text.trim().length > 0
      ) {
        return {
          hasProvider: true,
          text: parsed.text,
          cached: true,
          updatedAt: latestCache.createdAt.toISOString(),
        };
      }
    } catch {
      // ignore invalid cache payload
    }
  }

  const measurements = await prisma.measurement.findMany({
    where: {
      userId,
      type: {
        in: [...MEASUREMENT_TYPES],
      },
    },
    orderBy: { measuredAt: "asc" },
    select: {
      type: true,
      value: true,
      measuredAt: true,
    },
  });

  const measurementSeries = Object.fromEntries(
    MEASUREMENT_TYPES.map((type) => {
      const series = aggregateDailyAverageSeries(
        measurements
          .filter((measurement) => measurement.type === type)
          .map((measurement) => ({
            measuredAt: measurement.measuredAt,
            value: measurement.value,
          })),
      ).slice(-GENERAL_STATUS_POINTS);

      return [
        type,
        {
          summary: summarizeSeries(series),
          series,
        },
      ];
    }),
  );

  const intakeEvents = await prisma.medicationIntakeEvent.findMany({
    where: { userId },
    orderBy: { scheduledFor: "asc" },
    select: {
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });

  const adherenceByDay = new Map<
    string,
    { total: number; taken: number; skipped: number }
  >();
  for (const event of intakeEvents) {
    const dayKey = toBerlinDayKey(event.scheduledFor);
    const bucket = adherenceByDay.get(dayKey) ?? {
      total: 0,
      taken: 0,
      skipped: 0,
    };
    bucket.total += 1;
    if (!event.skipped && event.takenAt) {
      bucket.taken += 1;
    } else if (event.skipped) {
      bucket.skipped += 1;
    }
    adherenceByDay.set(dayKey, bucket);
  }

  const adherenceSeries = Array.from(adherenceByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({
      day,
      rate: value.total > 0 ? round((value.taken / value.total) * 100, 1) : 0,
      taken: value.taken,
      skipped: value.skipped,
      total: value.total,
    }))
    .slice(-GENERAL_STATUS_POINTS);

  // Fetch mood context (optional — for enrichment only)
  const moodEntries = await prisma.moodEntry.findMany({
    where: { userId },
    orderBy: { moodLoggedAt: "asc" },
    select: { date: true, score: true, moodLoggedAt: true },
  });

  const moodByDay = new Map<string, { sum: number; count: number }>();
  for (const entry of moodEntries) {
    const current = moodByDay.get(entry.date) ?? { sum: 0, count: 0 };
    current.sum += entry.score;
    current.count += 1;
    moodByDay.set(entry.date, current);
  }
  const dailyMoodSeries = Array.from(moodByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({
      day,
      value: round(stats.sum / stats.count, 2),
    }))
    .slice(-30);

  const moodMean =
    dailyMoodSeries.length > 0
      ? round(
          dailyMoodSeries.reduce((s, e) => s + e.value, 0) /
            dailyMoodSeries.length,
          2,
        )
      : null;

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);
  let bpInTargetLast30Days: number | null = null;
  if (bpTargets) {
    const sysSeries = (measurementSeries.BLOOD_PRESSURE_SYS?.series ?? []).map(
      (entry) => [entry.day, entry.value] as const,
    );
    const diaMap = new Map(
      (measurementSeries.BLOOD_PRESSURE_DIA?.series ?? []).map((entry) => [
        entry.day,
        entry.value,
      ]),
    );
    const paired = sysSeries
      .map(([day, sys]) => {
        const dia = diaMap.get(day);
        if (dia == null) return null;
        return { day, sys, dia };
      })
      .filter(
        (entry): entry is { day: string; sys: number; dia: number } => !!entry,
      )
      .slice(-GENERAL_STATUS_POINTS);

    if (paired.length > 0) {
      const inTargetCount = paired.filter(
        (point) =>
          point.sys >= bpTargets.sysLow &&
          point.sys <= bpTargets.sysHigh &&
          point.dia >= bpTargets.diaLow &&
          point.dia <= bpTargets.diaHigh,
      ).length;
      bpInTargetLast30Days = round((inTargetCount / paired.length) * 100, 1);
    }
  }

  // Compute overall data coverage info
  const oldestDay = measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestDay =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldestDay && newestDay
      ? Math.round(
          (newestDay.getTime() - oldestDay.getTime()) / (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestDaysAgo = newestDay
    ? Math.round((Date.now() - newestDay.getTime()) / (24 * 60 * 60 * 1000))
    : null;

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    interpretationHint:
      "Use trend direction and deltas. Prioritize the newest data if trends conflict. Consider dataCoverage for reliability assessment.",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo: newestDaysAgo,
      avgDaysBetweenMeasurements:
        measurements.length > 1
          ? Math.round((totalSpanDays / (measurements.length - 1)) * 10) / 10
          : null,
    },
    measurementSeries,
    medicationAdherence: {
      summary: summarizeSeries(
        adherenceSeries.map((entry) => ({ value: entry.rate })),
      ),
      series: adherenceSeries,
    },
    bloodPressureTargets: bpTargets
      ? {
          systolic: { min: bpTargets.sysLow, max: bpTargets.sysHigh },
          diastolic: { min: bpTargets.diaLow, max: bpTargets.diaHigh },
          inTargetPctLast30DailyPoints: bpInTargetLast30Days,
        }
      : null,
    moodContext:
      dailyMoodSeries.length >= 3
        ? {
            points: dailyMoodSeries.length,
            mean: moodMean,
            latest: dailyMoodSeries.at(-1)?.value ?? null,
            series: dailyMoodSeries.slice(-10),
          }
        : null,
  };

  const snapshotJson = JSON.stringify(snapshot, null, 2);

  const result = await provider.generateCompletion({
    systemPrompt: getGeneralStatusSystemPrompt(locale),
    userPrompt: getGeneralStatusUserPrompt(snapshotJson, todayKey, locale),
    temperature: 0.3,
    maxTokens: 1000,
  });

  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("AI returned empty content for general-status");
  }

  let summary = "";
  try {
    const parsed = JSON.parse(content) as { summary?: string };
    if (typeof parsed.summary === "string") {
      summary = parsed.summary;
    } else {
      summary = content;
    }
  } catch {
    summary = content;
  }

  summary = normalizeSummaryText(summary);
  if (!summary) {
    throw new Error("General-status summary was empty after normalization");
  }

  const created = await prisma.auditLog.create({
    data: {
      userId,
      action: cacheAction,
      details: JSON.stringify({
        dateKey: todayKey,
        locale,
        text: summary,
        providerType: provider.type,
        model: result.model ?? "unknown",
        pointsPerMetric: GENERAL_STATUS_POINTS,
        tokensUsed: result.tokensUsed ?? null,
      }),
    },
    select: { createdAt: true },
  });

  return {
    hasProvider: true,
    text: summary,
    cached: false,
    updatedAt: created.createdAt.toISOString(),
  };
}

export function resolveGeneralStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
