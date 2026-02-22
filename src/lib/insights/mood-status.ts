import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { getNoKeyMoodStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  pearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";

const MOOD_STATUS_MODEL = "gpt-4o-mini";
const MOOD_STATUS_POINTS = 30;

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
  records: Array<{ date: string; score: number }>,
) {
  const byDay = new Map<string, { sum: number; count: number }>();

  for (const record of records) {
    const dayKey = record.date;
    const current = byDay.get(dayKey) ?? { sum: 0, count: 0 };
    current.sum += record.score;
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

function aggregateMeasurementDailySeries(
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
    }));
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
      "Focus strictly on mood trends and well-being stability.",
      "Use only the provided snapshot with the latest 30 daily points.",
      "Prioritize the newest measurement day in your interpretation.",
      "Weight findings by importance: clear mood shifts and sustained periods of poor mood should be emphasized more strongly.",
      "If fewer than 5 data points exist, state that insufficient data is available for a qualified assessment. If data is sparse over a long period, still derive rough trends but note limited reliability. If the newest measurement is more than 7 days old, mention the data may not be current.",
      "If cross-metric context (weight, blood pressure, pulse) is provided and shows a notable correlation with mood, briefly mention it in 1-2 sentences. Do not force cross-metric references if no clear pattern exists.",
      "If mood tags are available, consider whether specific tags correlate with mood levels.",
      "Do not include warnings, disclaimers, or references to AI/model limitations.",
      'Return valid JSON only: {"summary":"..."}',
    ].join(" ");
  }

  return [
    "Du bist ein Gesundheits-Trendanalyst für ein privates Projekt.",
    "Schreibe einen kompakten Fließtext mit ungefähr 7 Sätzen auf Deutsch.",
    "Fokussiere strikt auf den Stimmungsverlauf und die Stabilität des Wohlbefindens.",
    "Nutze ausschließlich den bereitgestellten Snapshot mit den letzten 30 Tagesmesspunkten.",
    "Priorisiere in der Interpretation den neuesten Messpunkt-Tag.",
    "Gewichte Aussagen nach Wichtigkeit: klare Stimmungswechsel und anhaltende Phasen schlechter Stimmung sollen stärker betont werden.",
    "Wenn weniger als 5 Messpunkte vorliegen, sage dass noch nicht genügend Daten für eine fundierte Aussage vorhanden sind. Bei spärlichen Daten über einen langen Zeitraum leite trotzdem grobe Trends ab, weise aber auf eingeschränkte Belastbarkeit hin. Wenn die neueste Messung älter als 7 Tage ist, erwähne dass die Daten möglicherweise nicht aktuell sind.",
    "Falls Kontext zu anderen Gesundheitsmetriken (Gewicht, Blutdruck, Puls) vorhanden ist und eine auffällige Korrelation mit der Stimmung zeigt, erwähne dies kurz in 1-2 Sätzen. Erzwinge keine Querverweise, wenn kein klares Muster erkennbar ist.",
    "Falls Stimmungs-Tags vorhanden sind, prüfe ob bestimmte Tags mit Stimmungslevels korrelieren.",
    "Keine Warnhinweise, keine Haftungsausschlüsse, keine Hinweise auf KI oder Modellgrenzen.",
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
      `Use the latest ${MOOD_STATUS_POINTS} daily points as provided.`,
      "If a day contains multiple values, they are already averaged by day.",
      "Write a short mood-focused assessment for the UI section.",
      "Use the newest daily point as strongest anchor.",
      "",
      snapshotJson,
    ].join("\n");
  }

  return [
    `Datum: ${todayKey} (Europe/Berlin)`,
    `Nutze die letzten ${MOOD_STATUS_POINTS} Tagesmesspunkte wie bereitgestellt.`,
    "Mehrere Messungen pro Tag sind bereits zu Tagesmitteln aggregiert.",
    "Erstelle eine kurze stimmungsfokussierte Einschätzung für den UI-Abschnitt.",
    "Nutze den neuesten Tagesmesspunkt als stärksten Anker.",
    "",
    snapshotJson,
  ].join("\n");
}

export async function generateMoodStatusForUser(
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
  const cacheAction = `insights.mood-status.${locale}`;
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
      text: getNoKeyMoodStatusText(locale),
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

  const entries = await prisma.moodEntry.findMany({
    where: {
      userId,
    },
    orderBy: { date: "asc" },
    select: {
      date: true,
      score: true,
      tags: true,
      moodLoggedAt: true,
    },
  });

  const moodSeries = aggregateDailyAverageSeries(
    entries.map((entry) => ({
      date: entry.date,
      score: entry.score,
    })),
  ).slice(-MOOD_STATUS_POINTS);

  const greenMin = 3.5;
  const greenMax = 5;
  const orangeMin = 2;
  const orangeMax = 3.5;

  const inTargetPctLast30DailyPoints =
    moodSeries.length === 0
      ? null
      : round(
          (moodSeries.filter(
            (entry) =>
              entry.value >= greenMin && entry.value <= greenMax,
          ).length /
            moodSeries.length) *
            100,
          1,
        );

  const latestMood = moodSeries.at(-1) ?? null;
  const previousMood =
    moodSeries.length > 1 ? (moodSeries.at(-2) ?? null) : null;

  const oldestEntry = entries.length > 0 ? entries[0].moodLoggedAt : null;
  const newestEntry =
    entries.length > 0
      ? entries[entries.length - 1].moodLoggedAt
      : null;
  const totalSpanDays =
    oldestEntry && newestEntry
      ? Math.round(
          (newestEntry.getTime() - oldestEntry.getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestEntryDaysAgo = newestEntry
    ? Math.round(
        (Date.now() - newestEntry.getTime()) / (24 * 60 * 60 * 1000),
      )
    : null;

  // Fetch cross-metric context for enrichment
  const measurements = await prisma.measurement.findMany({
    where: {
      userId,
      type: { in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "PULSE"] },
    },
    orderBy: { measuredAt: "asc" },
    select: { type: true, value: true, measuredAt: true },
  });

  const weightSeries = aggregateMeasurementDailySeries(
    measurements
      .filter((m) => m.type === "WEIGHT")
      .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
  ).slice(-MOOD_STATUS_POINTS);

  const sysSeries = aggregateMeasurementDailySeries(
    measurements
      .filter((m) => m.type === "BLOOD_PRESSURE_SYS")
      .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
  ).slice(-MOOD_STATUS_POINTS);

  const pulseSeries = aggregateMeasurementDailySeries(
    measurements
      .filter((m) => m.type === "PULSE")
      .map((m) => ({ measuredAt: m.measuredAt, value: m.value })),
  ).slice(-MOOD_STATUS_POINTS);

  // Correlations between mood and other metrics
  const moodVsWeightPairs = pairDailySeries(moodSeries, weightSeries);
  const moodVsWeightCorrelation = pearsonCorrelation(moodVsWeightPairs);

  const moodVsSysPairs = pairDailySeries(moodSeries, sysSeries);
  const moodVsSysCorrelation = pearsonCorrelation(moodVsSysPairs);

  const moodVsPulsePairs = pairDailySeries(moodSeries, pulseSeries);
  const moodVsPulseCorrelation = pearsonCorrelation(moodVsPulsePairs);

  // Extract tag frequencies from recent entries
  const recentEntries = entries.slice(-MOOD_STATUS_POINTS * 3);
  const tagCounts = new Map<string, { count: number; scoreSum: number }>();
  for (const entry of recentEntries) {
    if (entry.tags && Array.isArray(entry.tags)) {
      for (const tag of entry.tags as string[]) {
        const current = tagCounts.get(tag) ?? { count: 0, scoreSum: 0 };
        current.count += 1;
        current.scoreSum += entry.score;
        tagCounts.set(tag, current);
      }
    }
  }
  const tagSummary = Array.from(tagCounts.entries())
    .filter(([, stats]) => stats.count >= 2)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10)
    .map(([tag, stats]) => ({
      tag,
      count: stats.count,
      avgScore: round(stats.scoreSum / stats.count, 2),
    }));

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "mood",
    dataCoverage: {
      totalEntries: entries.length,
      totalSpanDays,
      newestEntryDaysAgo,
    },
    mood: {
      summary: summarizeSeries(moodSeries),
      series: moodSeries,
      latestDayFocus: latestMood
        ? {
            day: latestMood.day,
            value: latestMood.value,
            deltaToPreviousDailyPoint:
              previousMood == null
                ? null
                : round(latestMood.value - previousMood.value, 2),
          }
        : null,
      target: {
        greenMin,
        greenMax,
        orangeMin,
        orangeMax,
        inTargetPctLast30DailyPoints,
      },
      tags: tagSummary.length > 0 ? tagSummary : null,
    },
    crossMetricContext:
      weightSeries.length >= 3 || sysSeries.length >= 3 || pulseSeries.length >= 3
        ? {
            weight:
              weightSeries.length >= 3
                ? {
                    summary: summarizeSeries(weightSeries),
                    correlation: moodVsWeightCorrelation,
                  }
                : null,
            bloodPressureSystolic:
              sysSeries.length >= 3
                ? {
                    summary: summarizeSeries(sysSeries),
                    correlation: moodVsSysCorrelation,
                  }
                : null,
            pulse:
              pulseSeries.length >= 3
                ? {
                    summary: summarizeSeries(pulseSeries),
                    correlation: moodVsPulseCorrelation,
                  }
                : null,
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
        model: MOOD_STATUS_MODEL,
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
      `OpenAI mood-status failed (${openaiResponse.status}): ${body}`,
    );
  }

  const openaiJson = await openaiResponse.json();
  const content = openaiJson.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("OpenAI returned empty content for mood-status");
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
    throw new Error("Mood-status summary was empty after normalization");
  }

  const created = await prisma.auditLog.create({
    data: {
      userId,
      action: cacheAction,
      details: JSON.stringify({
        dateKey: todayKey,
        locale,
        text: summary,
        model: MOOD_STATUS_MODEL,
        pointsPerMetric: MOOD_STATUS_POINTS,
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

export function resolveMoodStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
