import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import {
  getBloodPressureSystemPrompt,
  getBloodPressureUserPrompt,
} from "@/lib/ai/prompts/blood-pressure";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import {
  pearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import { calculateCompliance } from "@/lib/analytics/compliance";
import { getMedicationCategories } from "@/lib/medication-category";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { getNoKeyBloodPressureStatusText } from "@/lib/insights/no-key-fallbacks";

const BLOOD_PRESSURE_STATUS_POINTS = 30;

const BERLIN_DAY_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

type SupportedLocale = "de" | "en";

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
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizeSummaryText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeLocale(value: string | null | undefined): SupportedLocale {
  return value === "en" ? "en" : "de";
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

function pairDailySeries(
  seriesA: Array<{ day: string; value: number }>,
  seriesB: Array<{ day: string; value: number }>,
): PairedPoint[] {
  const mapB = new Map(seriesB.map((entry) => [entry.day, entry.value]));

  return seriesA
    .map((entry) => {
      const b = mapB.get(entry.day);
      if (b == null) return null;
      return {
        a: entry.value,
        b,
        date: new Date(`${entry.day}T00:00:00.000Z`),
      };
    })
    .filter((entry): entry is PairedPoint => entry !== null);
}

export async function generateBloodPressureStatusForUser(
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
  const cacheAction = `insights.blood-pressure-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const provider = await resolveProvider(userId);
  if (provider.type === "none") {
    return {
      hasProvider: false,
      text: getNoKeyBloodPressureStatusText(locale),
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
        in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
      },
    },
    orderBy: { measuredAt: "asc" },
    select: {
      type: true,
      value: true,
      measuredAt: true,
    },
  });

  const weightSeries = aggregateDailyAverageSeries(
    measurements
      .filter((measurement) => measurement.type === "WEIGHT")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
  ).slice(-BLOOD_PRESSURE_STATUS_POINTS);

  const sysSeries = aggregateDailyAverageSeries(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_SYS")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
  ).slice(-BLOOD_PRESSURE_STATUS_POINTS);

  const diaSeries = aggregateDailyAverageSeries(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_DIA")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
  ).slice(-BLOOD_PRESSURE_STATUS_POINTS);

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);
  const pairedBloodPressure = pairDailySeries(sysSeries, diaSeries).map(
    (entry) => ({
      day: toBerlinDayKey(entry.date),
      sys: entry.a,
      dia: entry.b,
      inTarget:
        bpTargets == null
          ? null
          : entry.a >= bpTargets.sysLow &&
            entry.a <= bpTargets.sysHigh &&
            entry.b >= bpTargets.diaLow &&
            entry.b <= bpTargets.diaHigh,
    }),
  );

  const bpInTargetPctLast30DailyPoints =
    bpTargets == null || pairedBloodPressure.length === 0
      ? null
      : round(
          (pairedBloodPressure.filter((entry) => entry.inTarget === true)
            .length /
            pairedBloodPressure.length) *
            100,
          1,
        );

  const weightVsSystolicPairs = pairDailySeries(weightSeries, sysSeries);
  const weightVsSystolicCorrelation = pearsonCorrelation(weightVsSystolicPairs);

  const activeMedications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
  });

  const categoryMap = await getMedicationCategories(
    activeMedications.map((medication) => medication.id),
  );

  const bpMedications = activeMedications.filter(
    (medication) =>
      (categoryMap[medication.id] ?? "OTHER") === "BLOOD_PRESSURE",
  );

  const bpMedicationEvents =
    bpMedications.length === 0
      ? []
      : await prisma.medicationIntakeEvent.findMany({
          where: {
            userId,
            medicationId: {
              in: bpMedications.map((medication) => medication.id),
            },
          },
          orderBy: { scheduledFor: "asc" },
          select: {
            medicationId: true,
            scheduledFor: true,
            takenAt: true,
            skipped: true,
          },
        });

  const medicationCompliance = bpMedications.map((medication) => {
    const eventsForMedication = bpMedicationEvents
      .filter((event) => event.medicationId === medication.id)
      .map((event) => ({
        scheduledFor: event.scheduledFor,
        takenAt: event.takenAt,
        skipped: event.skipped,
      }));

    const compliance7 = calculateCompliance(
      eventsForMedication,
      medication.schedules,
      7,
      medication.createdAt,
    );
    const compliance30 = calculateCompliance(
      eventsForMedication,
      medication.schedules,
      30,
      medication.createdAt,
    );

    return {
      name: sanitizeForPrompt(medication.name),
      dose: sanitizeForPrompt(medication.dose, 50),
      schedulesPerDay: medication.schedules.length,
      compliance7: compliance7.rate,
      compliance30: compliance30.rate,
    };
  });

  const expectedBpIntakesPerDay = bpMedications.reduce(
    (sum, medication) => sum + medication.schedules.length,
    0,
  );
  const takenByDay = new Map<string, number>();
  for (const event of bpMedicationEvents) {
    if (event.skipped || !event.takenAt) continue;
    const dayKey = toBerlinDayKey(event.scheduledFor);
    takenByDay.set(dayKey, (takenByDay.get(dayKey) ?? 0) + 1);
  }

  const continuityVsSystolicSeries = sysSeries.map((point) => {
    const taken = takenByDay.get(point.day) ?? 0;
    const continuityPct =
      expectedBpIntakesPerDay > 0
        ? round(Math.min(1, taken / expectedBpIntakesPerDay) * 100, 1)
        : null;
    return {
      day: point.day,
      sys: point.value,
      continuityPct,
    };
  });

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

  const continuityVsSystolicPairs: PairedPoint[] = continuityVsSystolicSeries
    .map((entry) => {
      if (entry.continuityPct == null) return null;
      return {
        a: entry.continuityPct,
        b: entry.sys,
        date: new Date(`${entry.day}T00:00:00.000Z`),
      };
    })
    .filter((entry): entry is PairedPoint => entry !== null);
  const continuityVsSystolicCorrelation = pearsonCorrelation(
    continuityVsSystolicPairs,
  );

  const oldestMeasurement =
    measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestMeasurement =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldestMeasurement && newestMeasurement
      ? Math.round(
          (newestMeasurement.getTime() - oldestMeasurement.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestMeasurementDaysAgo = newestMeasurement
    ? Math.round(
        (Date.now() - newestMeasurement.getTime()) / (24 * 60 * 60 * 1000),
      )
    : null;

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "blood_pressure",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    bloodPressure: {
      systolic: {
        summary: summarizeSeries(sysSeries),
        series: sysSeries,
      },
      diastolic: {
        summary: summarizeSeries(diaSeries),
        series: diaSeries,
      },
      paired: {
        summary: summarizeSeries(
          pairedBloodPressure.map((entry) => ({
            value: (entry.sys + entry.dia) / 2,
          })),
        ),
        series: pairedBloodPressure,
      },
      targets: bpTargets
        ? {
            systolic: { min: bpTargets.sysLow, max: bpTargets.sysHigh },
            diastolic: { min: bpTargets.diaLow, max: bpTargets.diaHigh },
            inTargetPctLast30DailyPoints: bpInTargetPctLast30DailyPoints,
          }
        : null,
    },
    weightVsSystolic: {
      correlation: weightVsSystolicCorrelation,
      pairs: weightVsSystolicPairs.map((entry) => ({
        day: toBerlinDayKey(entry.date),
        weight: round(entry.a, 2),
        systolic: round(entry.b, 2),
      })),
    },
    bpMedicationContinuityVsSystolic: {
      expectedIntakesPerDay: expectedBpIntakesPerDay,
      medicationCount: bpMedications.length,
      correlation: continuityVsSystolicCorrelation,
      series: continuityVsSystolicSeries,
    },
    bpMedications: medicationCompliance,
    moodContext:
      dailyMoodSeries.length >= 3
        ? {
            points: dailyMoodSeries.length,
            mean: moodMean,
            latest: dailyMoodSeries.at(-1)?.value ?? null,
            series: dailyMoodSeries.slice(-10),
            moodVsSystolicCorrelation: (() => {
              const moodVsSysPairs = pairDailySeries(
                dailyMoodSeries,
                sysSeries,
              );
              return pearsonCorrelation(moodVsSysPairs);
            })(),
          }
        : null,
  };

  const snapshotJson = JSON.stringify(snapshot, null, 2);

  const previousContext = await getPreviousInsightContext(
    userId,
    "blood-pressure-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  const result = await provider.generateCompletion({
    systemPrompt: getBloodPressureSystemPrompt(locale),
    userPrompt: getBloodPressureUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
    ),
    temperature: 0.3,
    maxTokens: 1000,
  });

  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("AI returned empty content for blood-pressure-status");
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
    throw new Error(
      "Blood-pressure-status summary was empty after normalization",
    );
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
        pointsPerMetric: BLOOD_PRESSURE_STATUS_POINTS,
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

export function resolveBloodPressureStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
