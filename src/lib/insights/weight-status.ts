import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import {
  pearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import { getNoKeyWeightStatusText } from "@/lib/insights/no-key-fallbacks";

const WEIGHT_STATUS_MODEL = "gpt-4o-mini";
const WEIGHT_STATUS_POINTS = 30;

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

function getSystemPrompt(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "You are a health trend analyst for a private personal project.",
      "Write one compact paragraph with about 7 sentences in English.",
      "Focus strictly on weight trends and the relation to blood pressure.",
      "Use only the provided snapshot with the latest 30 daily points.",
      "Prioritize the newest measurement day in your interpretation.",
      "Weight findings by importance: clear trend changes, strong correlations, and major latest-point deviations should be emphasized much more than weak signals.",
      "If fewer than 5 data points exist, state that insufficient data is available for a qualified assessment. If data is sparse over a long period, still derive rough trends but note limited reliability. If the newest measurement is more than 7 days old, mention the data may not be current.",
      "Do not include warnings, disclaimers, or references to AI/model limitations.",
      "If mood data is available and shows a notable correlation or pattern, briefly mention it. Do not force mood into the assessment if nothing stands out.",
      'Return valid JSON only: {"summary":"..."}',
    ].join(" ");
  }

  return [
    "Du bist ein Gesundheits-Trendanalyst für ein privates Projekt.",
    "Schreibe einen kompakten Fließtext mit ungefähr 7 Sätzen auf Deutsch.",
    "Fokussiere strikt auf Gewichtstrend und die Beziehung zum Blutdruck.",
    "Nutze ausschließlich den bereitgestellten Snapshot mit den letzten 30 Tagesmesspunkten.",
    "Priorisiere in der Interpretation den neuesten Messpunkt-Tag.",
    "Gewichte Aussagen nach Wichtigkeit: klare Trendwechsel, starke Korrelationen und große Abweichungen am neuesten Messpunkt sollen deutlich stärker betont werden als schwache Signale.",
    "Wenn weniger als 5 Messpunkte vorliegen, sage dass noch nicht genügend Daten für eine fundierte Aussage vorhanden sind. Bei spärlichen Daten über einen langen Zeitraum leite trotzdem grobe Trends ab, weise aber auf eingeschränkte Belastbarkeit hin. Wenn die neueste Messung älter als 7 Tage ist, erwähne dass die Daten möglicherweise nicht aktuell sind.",
    "Keine Warnhinweise, keine Haftungsausschlüsse, keine Hinweise auf KI oder Modellgrenzen.",
    "Falls Stimmungsdaten vorhanden sind und einen bemerkenswerten Zusammenhang zeigen, erwähne dies kurz. Erzwinge keine Stimmungsaussage, wenn nichts auffällt.",
    'Gib nur valides JSON zurück: {"summary":"..."}',
  ].join(" ");
}

function getUserPrompt(
  locale: SupportedLocale,
  snapshotJson: string,
  todayKey: string,
): string {
  if (locale === "en") {
    return [
      `Date: ${todayKey} (Europe/Berlin)`,
      `Use the latest ${WEIGHT_STATUS_POINTS} daily points as provided.`,
      "If a day contains multiple values, they are already averaged by day.",
      "Evaluate the weight chart and the weight-vs-blood-pressure chart.",
      "Use the newest daily point as strongest anchor for the short assessment.",
      "",
      snapshotJson,
    ].join("\n");
  }

  return [
    `Datum: ${todayKey} (Europe/Berlin)`,
    `Nutze die letzten ${WEIGHT_STATUS_POINTS} Tagesmesspunkte wie bereitgestellt.`,
    "Mehrere Messungen pro Tag sind bereits zu Tagesmitteln aggregiert.",
    "Werte den Gewichts-Chart und den Chart Gewicht versus Blutdruck aus.",
    "Nutze den neuesten Tagesmesspunkt als stärksten Anker für die kurze Einschätzung.",
    "",
    snapshotJson,
  ].join("\n");
}

export async function generateWeightStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
  },
): Promise<{
  hasKey: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const cacheAction = `insights.weight-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      openaiKeyEncrypted: true,
    },
  });

  if (!user?.openaiKeyEncrypted) {
    return {
      hasKey: false,
      text: getNoKeyWeightStatusText(locale),
      cached: true,
      updatedAt: null,
    };
  }

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
          hasKey: true,
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
  ).slice(-WEIGHT_STATUS_POINTS);

  const sysSeries = aggregateDailyAverageSeries(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_SYS")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
  ).slice(-WEIGHT_STATUS_POINTS);

  const diaSeries = aggregateDailyAverageSeries(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_DIA")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
  ).slice(-WEIGHT_STATUS_POINTS);

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

  const weightVsSystolicPairs = pairDailySeries(weightSeries, sysSeries);
  const weightVsSystolicCorrelation = pearsonCorrelation(weightVsSystolicPairs);

  const pairedSystolicDiastolic = pairDailySeries(sysSeries, diaSeries).map(
    (entry) => ({
      day: toBerlinDayKey(entry.date),
      sys: entry.a,
      dia: entry.b,
      mean: round((entry.a + entry.b) / 2, 2),
    }),
  );

  const bpMeanSeries = pairedSystolicDiastolic.map((entry) => ({
    day: entry.day,
    value: entry.mean,
  }));

  const weightVsMeanBpPairs = pairDailySeries(weightSeries, bpMeanSeries);
  const weightVsMeanBpCorrelation = pearsonCorrelation(weightVsMeanBpPairs);

  const latestWeight = weightSeries.at(-1) ?? null;
  const previousWeight =
    weightSeries.length > 1 ? (weightSeries.at(-2) ?? null) : null;
  const latestWeightDay = latestWeight?.day ?? null;
  const sameDayBp = latestWeightDay
    ? (pairedSystolicDiastolic.find((entry) => entry.day === latestWeightDay) ??
      null)
    : null;

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
    focus: "weight",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    weight: {
      summary: summarizeSeries(weightSeries),
      series: weightSeries,
      latestDayFocus: latestWeight
        ? {
            day: latestWeight.day,
            value: latestWeight.value,
            deltaToPreviousDailyPoint:
              previousWeight == null
                ? null
                : round(latestWeight.value - previousWeight.value, 2),
            sameDayBloodPressure: sameDayBp,
          }
        : null,
    },
    bloodPressureContext: {
      systolic: {
        summary: summarizeSeries(sysSeries),
        series: sysSeries,
      },
      diastolic: {
        summary: summarizeSeries(diaSeries),
        series: diaSeries,
      },
      pairedDaily: pairedSystolicDiastolic,
    },
    weightVsSystolic: {
      correlation: weightVsSystolicCorrelation,
      pairs: weightVsSystolicPairs.map((entry) => ({
        day: toBerlinDayKey(entry.date),
        weight: round(entry.a, 2),
        systolic: round(entry.b, 2),
      })),
    },
    weightVsMeanBloodPressure: {
      correlation: weightVsMeanBpCorrelation,
      pairs: weightVsMeanBpPairs.map((entry) => ({
        day: toBerlinDayKey(entry.date),
        weight: round(entry.a, 2),
        meanBloodPressure: round(entry.b, 2),
      })),
    },
    moodContext:
      dailyMoodSeries.length >= 3
        ? {
            points: dailyMoodSeries.length,
            mean: moodMean,
            latest: dailyMoodSeries.at(-1)?.value ?? null,
            series: dailyMoodSeries.slice(-10),
            moodVsWeightCorrelation: (() => {
              const moodVsWeightPairs = pairDailySeries(dailyMoodSeries, weightSeries);
              return pearsonCorrelation(moodVsWeightPairs);
            })(),
          }
        : null,
  };

  const snapshotJson = JSON.stringify(snapshot, null, 2);
  const apiKey = decrypt(user.openaiKeyEncrypted);

  const openaiResponse = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: WEIGHT_STATUS_MODEL,
        messages: [
          { role: "system", content: getSystemPrompt(locale) },
          {
            role: "user",
            content: getUserPrompt(locale, snapshotJson, todayKey),
          },
        ],
        temperature: 0.3,
        max_tokens: 550,
        response_format: { type: "json_object" },
      }),
    },
  );

  if (!openaiResponse.ok) {
    const body = await openaiResponse.text();
    throw new Error(
      `OpenAI weight-status failed (${openaiResponse.status}): ${body}`,
    );
  }

  const openaiJson = await openaiResponse.json();
  const content = openaiJson.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("OpenAI returned empty content for weight-status");
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
    throw new Error("Weight-status summary was empty after normalization");
  }

  const created = await prisma.auditLog.create({
    data: {
      userId,
      action: cacheAction,
      details: JSON.stringify({
        dateKey: todayKey,
        locale,
        text: summary,
        model: WEIGHT_STATUS_MODEL,
        pointsPerMetric: WEIGHT_STATUS_POINTS,
        tokensUsed: openaiJson.usage?.total_tokens ?? null,
      }),
    },
    select: { createdAt: true },
  });

  return {
    hasKey: true,
    text: summary,
    cached: false,
    updatedAt: created.createdAt.toISOString(),
  };
}

export function resolveWeightStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
