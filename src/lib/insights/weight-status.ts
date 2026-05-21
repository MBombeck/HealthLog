import { prisma } from "@/lib/db";
import { resolveProvider } from "@/lib/ai/provider";
import {
  getWeightSystemPrompt,
  getWeightUserPrompt,
} from "@/lib/ai/prompts/weight";
import {
  pearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import { getNoKeyWeightStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import {
  applyPayloadBudget,
  dayOffsetToBerlinDayKey,
  type DailyBucket,
} from "@/lib/insights/bucket-series";
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
  // path; see `.planning/round-v1433-analytics-500-report.md` §"Carry-
  // over". These helpers are fed bounded windows today so the crash
  // never reached them, but the spread allocates a transient args array
  // on every call — the fold is both stack-safe and cheaper.
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

/**
 * Pair two daily-bucket series on `dayOffset`. The synthesised `date`
 * field is anchored at the UTC midnight of the Berlin calendar day —
 * `dayOffsetToBerlinDayKey()` is the source of truth so DST boundaries
 * don't slip the day-key by one. Each pair also carries `dayKey`
 * directly so callers can label points without re-formatting.
 */
function pairDailyBuckets(
  seriesA: DailyBucket[],
  seriesB: DailyBucket[],
  now: Date,
): Array<PairedPoint & { dayKey: string }> {
  const mapB = new Map(seriesB.map((entry) => [entry.dayOffset, entry.value]));

  return seriesA
    .map((entry) => {
      const b = mapB.get(entry.dayOffset);
      if (b == null) return null;
      const dayKey = dayOffsetToBerlinDayKey(now, entry.dayOffset);
      const [y, m, d] = dayKey.split("-").map(Number);
      return {
        a: entry.value,
        b,
        date: new Date(Date.UTC(y, m - 1, d)),
        dayKey,
      };
    })
    .filter(
      (entry): entry is PairedPoint & { dayKey: string } => entry !== null,
    );
}

export async function generateWeightStatusForUser(
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
  const cacheAction = `insights.weight-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const provider = await resolveProvider(userId);
  if (provider.type === "none") {
    return {
      hasProvider: false,
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

  // v1.4.28 FB-D2 — cap the snapshot input. BP captures three types
  // per day so 1095 = 365 d × 3 channels. Order desc + reverse so we
  // keep the most recent year of rows.
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: {
          in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
        },
      },
      take: 1095,
      orderBy: { measuredAt: "desc" },
      select: {
        type: true,
        value: true,
        measuredAt: true,
      },
    })
    .then((rows) => rows.reverse());

  const now = new Date();

  const weightSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "WEIGHT")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now },
  );

  const sysSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_SYS")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now },
  );

  const diaSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_DIA")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now },
  );

  // Fetch mood context (optional — for enrichment only). v1.4.28
  // FB-D2 — cap at 90 entries.
  const moodEntries = await prisma.moodEntry
    .findMany({
      where: { userId },
      orderBy: { moodLoggedAt: "desc" },
      take: 90,
      select: { date: true, score: true, moodLoggedAt: true },
    })
    .then((rows) => rows.reverse());

  const moodSeries = applyPayloadBudget(
    moodEntries.map((entry) => ({
      measuredAt: entry.moodLoggedAt,
      value: entry.score,
    })),
    { now },
  );
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );
  const moodMean = moodSummary?.mean ?? null;

  const weightVsSystolicPairs = pairDailyBuckets(
    weightSeries.daily,
    sysSeries.daily,
    now,
  );
  const weightVsSystolicCorrelation = pearsonCorrelation(weightVsSystolicPairs);

  const pairedSystolicDiastolic = pairDailyBuckets(
    sysSeries.daily,
    diaSeries.daily,
    now,
  ).map((entry) => ({
    day: entry.dayKey,
    sys: entry.a,
    dia: entry.b,
    mean: round((entry.a + entry.b) / 2, 2),
  }));

  // Synthesise a daily-bucket-shaped BP-mean series so we can reuse
  // pairDailyBuckets — derive dayOffset from the offsets in sysSeries.
  const sysOffsetByDay = new Map(
    sysSeries.daily.map((bucket) => {
      const dayKey = dayOffsetToBerlinDayKey(now, bucket.dayOffset);
      return [dayKey, bucket.dayOffset];
    }),
  );
  const bpMeanDaily: DailyBucket[] = pairedSystolicDiastolic
    .map((entry) => {
      const dayOffset = sysOffsetByDay.get(entry.day);
      if (dayOffset == null) return null;
      return { dayOffset, value: entry.mean, n: 1 };
    })
    .filter((entry): entry is DailyBucket => entry !== null);

  const weightVsMeanBpPairs = pairDailyBuckets(
    weightSeries.daily,
    bpMeanDaily,
    now,
  );
  const weightVsMeanBpCorrelation = pearsonCorrelation(weightVsMeanBpPairs);

  // daily[0] = newest bucket (lowest dayOffset).
  const latestWeight = weightSeries.daily[0] ?? null;
  const previousWeight = weightSeries.daily[1] ?? null;
  const latestWeightDay = latestWeight
    ? dayOffsetToBerlinDayKey(now, latestWeight.dayOffset)
    : null;
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
      summary: summarizeSeries(
        weightSeries.daily.map((bucket) => ({ value: bucket.value })),
      ),
      series: weightSeries,
      latestDayFocus: latestWeight
        ? {
            day: latestWeightDay,
            dayOffset: latestWeight.dayOffset,
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
        summary: summarizeSeries(
          sysSeries.daily.map((bucket) => ({ value: bucket.value })),
        ),
        series: sysSeries,
      },
      diastolic: {
        summary: summarizeSeries(
          diaSeries.daily.map((bucket) => ({ value: bucket.value })),
        ),
        series: diaSeries,
      },
      pairedDaily: pairedSystolicDiastolic,
    },
    weightVsSystolic: {
      correlation: weightVsSystolicCorrelation,
      pairs: weightVsSystolicPairs.map((entry) => ({
        day: entry.dayKey,
        weight: round(entry.a, 2),
        systolic: round(entry.b, 2),
      })),
    },
    weightVsMeanBloodPressure: {
      correlation: weightVsMeanBpCorrelation,
      pairs: weightVsMeanBpPairs.map((entry) => ({
        day: entry.dayKey,
        weight: round(entry.a, 2),
        meanBloodPressure: round(entry.b, 2),
      })),
    },
    moodContext:
      moodSeries.daily.length >= 3
        ? {
            points: moodSeries.daily.length,
            mean: moodMean,
            latest: moodSeries.daily[0]?.value ?? null,
            series: moodSeries,
            moodVsWeightCorrelation: (() => {
              const moodVsWeightPairs = pairDailyBuckets(
                moodSeries.daily,
                weightSeries.daily,
                now,
              );
              return pearsonCorrelation(moodVsWeightPairs);
            })(),
          }
        : null,
  };

  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: { payload_size_bytes: snapshotJson.length },
  });

  const previousContext = await getPreviousInsightContext(
    userId,
    "weight-status",
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
        systemPrompt: getWeightSystemPrompt(locale),
        userPrompt: getWeightUserPrompt(
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
    return {
      hasProvider: true,
      text: getNoKeyWeightStatusText(locale),
      cached: true,
      updatedAt: null,
    };
  }

  const result = raced.value;
  const content = result.content;
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new Error("AI returned empty content for weight-status");
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

export function resolveWeightStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
