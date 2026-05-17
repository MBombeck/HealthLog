import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import { getBmiSystemPrompt, getBmiUserPrompt } from "@/lib/ai/prompts/bmi";
import { classifyBMI } from "@/lib/analytics/classifications";
import { getNoKeyBmiStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import { stripChartTokens } from "@/lib/insights/chart-tokens";
import {
  withTimeout,
  STATUS_PROVIDER_TIMEOUT_MS,
} from "@/lib/insights/with-timeout";
import { annotate } from "@/lib/logging/context";

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

function normalizeSummaryText(value: string): string {
  return stripChartTokens(value).replace(/\s+/g, " ").trim();
}

function normalizeLocale(value: string | null | undefined): SupportedLocale {
  return value === "en" ? "en" : "de";
}

function summarizeSeries(series: Array<{ value: number }>) {
  if (series.length === 0) return null;
  const first = series[0].value;
  const last = series[series.length - 1].value;
  // v1.4.33 — fold sum/min/max into a single walk. The previous
  // `Math.min(...series.map(...))` / `Math.max(...series.map(...))`
  // spread tripped V8's ~125 000-arg ceiling on the bound /api/analytics
  // path and is the same anti-pattern fixed in `summarize()` (see
  // `.planning/round-v1433-analytics-500-report.md` §"Carry-over").
  // These helpers feed off bounded windows today so they did not crash,
  // but the spread allocates a transient args array on every call;
  // folding once is both stack-safe and cheaper.
  let sum = 0;
  let minVal = series[0].value;
  let maxVal = series[0].value;
  for (const entry of series) {
    sum += entry.value;
    if (entry.value < minVal) minVal = entry.value;
    if (entry.value > maxVal) maxVal = entry.value;
  }
  return {
    points: series.length,
    start: round(first, 2),
    end: round(last, 2),
    delta: round(last - first, 2),
    mean: round(sum / series.length, 2),
    min: round(minVal, 2),
    max: round(maxVal, 2),
  };
}

export async function generateBmiStatusForUser(
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
  const cacheAction = `insights.bmi-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const provider = await resolveProvider(userId);
  if (provider.type === "none") {
    return {
      hasProvider: false,
      text: getNoKeyBmiStatusText(locale),
      cached: true,
      updatedAt: null,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
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

  if (!user?.heightCm || user.heightCm <= 0) {
    return {
      hasProvider: true,
      text:
        locale === "de"
          ? "Für die BMI-Einschätzung fehlen aktuell Größenangaben im Profil."
          : "BMI assessment currently requires height data in the profile.",
      cached: true,
      updatedAt: latestCache?.createdAt.toISOString() ?? null,
    };
  }

  // v1.4.28 FB-D2 — cap the snapshot input (weight runs at most once
  // per day for typical users; 365 covers a full year while the
  // downstream payload budget trims further).
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: "WEIGHT",
      },
      orderBy: { measuredAt: "desc" },
      take: 365,
      select: {
        value: true,
        measuredAt: true,
      },
    })
    .then((rows) => rows.reverse());

  const now = new Date();
  const weightSeries = applyPayloadBudget(
    measurements.map((measurement) => ({
      measuredAt: measurement.measuredAt,
      value: measurement.value,
    })),
    { now },
  );

  const heightFactor = (user.heightCm / 100) ** 2;
  const bmiSeries = {
    daily: weightSeries.daily.map((bucket) => ({
      dayOffset: bucket.dayOffset,
      value: round(bucket.value / heightFactor, 2),
      n: bucket.n,
    })),
    monthly: weightSeries.monthly.map((bucket) => ({
      monthOffset: bucket.monthOffset,
      value: round(bucket.value / heightFactor, 2),
      n: bucket.n,
    })),
  };

  // daily[0] = newest bucket (lowest dayOffset).
  const latestBmi = bmiSeries.daily[0] ?? null;
  const previousBmi = bmiSeries.daily[1] ?? null;
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
      summary: summarizeSeries(
        bmiSeries.daily.map((bucket) => ({ value: bucket.value })),
      ),
      series: bmiSeries,
      latestDayFocus: latestBmi
        ? {
            dayOffset: latestBmi.dayOffset,
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

  annotate({
    action: { name: cacheAction },
    meta: { payload_size_bytes: snapshotJson.length },
  });

  const previousContext = await getPreviousInsightContext(
    userId,
    "bmi-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.4.28 FB-D2 — 20 s timeout race; fall back to the no-key text
  // on stall so the InsightStatusCard renders deterministically.
  const raced = await withTimeout(
    () =>
      provider.generateCompletion({
        systemPrompt: getBmiSystemPrompt(locale),
        userPrompt: getBmiUserPrompt(
          snapshotJson,
          todayKey,
          locale,
          previousContextBlock,
        ),
        temperature: 0.3,
        maxTokens: 1000,
      }),
    STATUS_PROVIDER_TIMEOUT_MS,
    null,
  );

  if (raced.timedOut || raced.value === null) {
    // v1.4.37 — persist a sentinel row keyed to today so the next
    // mount short-circuits at the cache lookup above instead of
    // re-racing the same 20 s provider call on every cold visit.
    // Without this, a single stall (provider hiccup, network blip,
    // model warm-up) leaves the user staring at the loading state
    // on every reload until the daily 02:20 pre-warm job runs.
    // The body is the same no-key fallback the caller returned
    // before, so the user-facing UI is identical; only the
    // re-fire frequency drops to zero for the rest of the day.
    // `meta.timeout` is set so the daily pg-boss pre-warm worker
    // (the same job that originally seeded the cache) can
    // recognise and overwrite the stub rather than respect it as
    // a real assessment.
    const stubText = getNoKeyBmiStatusText(locale);
    let stubUpdatedAt: string | null = null;
    try {
      const stub = await prisma.auditLog.create({
        data: {
          userId,
          action: cacheAction,
          details: JSON.stringify({
            dateKey: todayKey,
            locale,
            text: stubText,
            providerType: provider.type,
            model: "timeout-stub",
            tokensUsed: null,
            timeout: true,
          }),
        },
        select: { createdAt: true },
      });
      stubUpdatedAt = stub.createdAt.toISOString();
    } catch {
      // The persist is best-effort — if the row write fails the
      // caller still sees the deterministic fallback text and the
      // next mount falls back to the (still expensive) race. Do
      // not surface the error: the user does not care that the
      // cache write missed, only that the page rendered.
    }
    return {
      hasProvider: true,
      text: stubText,
      cached: true,
      updatedAt: stubUpdatedAt,
    };
  }

  const result = raced.value;
  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("AI returned empty content for bmi-status");
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
        providerType: provider.type,
        model: result.model ?? "unknown",
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

export function resolveBmiStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
