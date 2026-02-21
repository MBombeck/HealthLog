import { prisma } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { classifyBMI } from "@/lib/analytics/classifications";
import { getNoKeyBmiStatusText } from "@/lib/insights/no-key-fallbacks";

const BMI_STATUS_MODEL = "gpt-4o-mini";
const BMI_STATUS_POINTS = 30;

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

function getSystemPrompt(locale: SupportedLocale): string {
  if (locale === "en") {
    return [
      "You are a health trend analyst for a private personal project.",
      "Write one compact paragraph with about 7 sentences in English.",
      "Focus strictly on BMI development and current trend situation.",
      "Use only the provided snapshot with the latest 30 daily points.",
      "Prioritize the newest measurement day in your interpretation.",
      "Weight findings by importance: clear trend shifts and severe BMI-class deviations should be emphasized more strongly.",
      "If fewer than 5 data points exist, state that insufficient data is available for a qualified assessment. If data is sparse over a long period, still derive rough trends but note limited reliability. If the newest measurement is more than 7 days old, mention the data may not be current.",
      "Do not include warnings, disclaimers, or references to AI/model limitations.",
      'Return valid JSON only: {"summary":"..."}',
    ].join(" ");
  }

  return [
    "Du bist ein Gesundheits-Trendanalyst für ein privates Projekt.",
    "Schreibe einen kompakten Fließtext mit ungefähr 7 Sätzen auf Deutsch.",
    "Fokussiere strikt auf die BMI-Entwicklung und die aktuelle Trendsituation.",
    "Nutze ausschließlich den bereitgestellten Snapshot mit den letzten 30 Tagesmesspunkten.",
    "Priorisiere in der Interpretation den neuesten Messpunkt-Tag.",
    "Gewichte Aussagen nach Wichtigkeit: klare Trendwechsel und starke BMI-Abweichungen sollen stärker betont werden.",
    "Wenn weniger als 5 Messpunkte vorliegen, sage dass noch nicht genügend Daten für eine fundierte Aussage vorhanden sind. Bei spärlichen Daten über einen langen Zeitraum leite trotzdem grobe Trends ab, weise aber auf eingeschränkte Belastbarkeit hin. Wenn die neueste Messung älter als 7 Tage ist, erwähne dass die Daten möglicherweise nicht aktuell sind.",
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
      `Use the latest ${BMI_STATUS_POINTS} daily points as provided.`,
      "If a day contains multiple values, they are already averaged by day.",
      "Write a short BMI-focused assessment for the UI section.",
      "Use the newest daily point as strongest anchor.",
      "",
      snapshotJson,
    ].join("\n");
  }

  return [
    `Datum: ${todayKey} (Europe/Berlin)`,
    `Nutze die letzten ${BMI_STATUS_POINTS} Tagesmesspunkte wie bereitgestellt.`,
    "Mehrere Messungen pro Tag sind bereits zu Tagesmitteln aggregiert.",
    "Erstelle eine kurze BMI-fokussierte Einschätzung für den UI-Abschnitt.",
    "Nutze den neuesten Tagesmesspunkt als stärksten Anker.",
    "",
    snapshotJson,
  ].join("\n");
}

export async function generateBmiStatusForUser(
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
  const cacheAction = `insights.bmi-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      openaiKeyEncrypted: true,
      heightCm: true,
    },
  });

  if (!user?.openaiKeyEncrypted) {
    return {
      hasKey: false,
      text: getNoKeyBmiStatusText(locale),
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

  if (!user.heightCm || user.heightCm <= 0) {
    return {
      hasKey: true,
      text:
        locale === "de"
          ? "Für die BMI-Einschätzung fehlen aktuell Größenangaben im Profil."
          : "BMI assessment currently requires height data in the profile.",
      cached: true,
      updatedAt: latestCache?.createdAt.toISOString() ?? null,
    };
  }

  const measurements = await prisma.measurement.findMany({
    where: {
      userId,
      type: "WEIGHT",
    },
    orderBy: { measuredAt: "asc" },
    select: {
      value: true,
      measuredAt: true,
    },
  });

  const weightSeries = aggregateDailyAverageSeries(
    measurements.map((measurement) => ({
      measuredAt: measurement.measuredAt,
      value: measurement.value,
    })),
  ).slice(-BMI_STATUS_POINTS);

  const heightFactor = (user.heightCm / 100) ** 2;
  const bmiSeries = weightSeries.map((entry) => ({
    day: entry.day,
    value: round(entry.value / heightFactor, 2),
  }));

  const latestBmi = bmiSeries.at(-1) ?? null;
  const previousBmi = bmiSeries.length > 1 ? (bmiSeries.at(-2) ?? null) : null;
  const latestClassification = latestBmi ? classifyBMI(latestBmi.value) : null;

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
    focus: "bmi",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    bmi: {
      summary: summarizeSeries(bmiSeries),
      series: bmiSeries,
      latestDayFocus: latestBmi
        ? {
            day: latestBmi.day,
            value: latestBmi.value,
            classification: latestClassification,
            deltaToPreviousDailyPoint:
              previousBmi == null
                ? null
                : round(latestBmi.value - previousBmi.value, 2),
          }
        : null,
      target: {
        greenMin: 18.5,
        greenMax: 24.9,
      },
    },
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
        model: BMI_STATUS_MODEL,
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
      `OpenAI bmi-status failed (${openaiResponse.status}): ${body}`,
    );
  }

  const openaiJson = await openaiResponse.json();
  const content = openaiJson.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("OpenAI returned empty content for bmi-status");
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
    throw new Error("Bmi-status summary was empty after normalization");
  }

  const created = await prisma.auditLog.create({
    data: {
      userId,
      action: cacheAction,
      details: JSON.stringify({
        dateKey: todayKey,
        locale,
        text: summary,
        model: BMI_STATUS_MODEL,
        pointsPerMetric: BMI_STATUS_POINTS,
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

export function resolveBmiStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
