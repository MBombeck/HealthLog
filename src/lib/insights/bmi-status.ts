import { prisma } from "@/lib/db";
import { getBmiSystemPrompt, getBmiUserPrompt } from "@/lib/ai/prompts/bmi";
import { classifyBMI } from "@/lib/analytics/classifications";
import { getNoKeyBmiStatusText } from "@/lib/insights/no-key-fallbacks";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesWithRollups,
  scaleGradedSeries,
  degradeStatusSnapshotToBudget,
} from "@/lib/insights/graded-series";
import {
  type SupportedLocale,
  normalizeLocale,
  normalizeSummaryText,
  parseSummaryFromContent,
  persistStatusInsight,
  round,
  summarizeSeries,
} from "@/lib/insights/status-shared";
import { runStatusCompletion } from "@/lib/insights/status-provider";
import {
  readFreshStatusText,
  resolveReadOnlyStatusMiss,
} from "@/lib/insights/status-cache";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import { annotate } from "@/lib/logging/context";
import { toBerlinDayKey } from "@/lib/tz/resolver";

export async function generateBmiStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = `insights.bmi-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  const cached = await readFreshStatusText({
    userId,
    cacheAction,
    todayKey,
    force,
  });
  if (cached) {
    return {
      hasProvider: true,
      text: cached.text,
      cached: true,
      updatedAt: cached.updatedAt,
    };
  }

  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId,
      metric: "bmi",
      locale,
    });
    if (outcome === "no-provider") {
      return {
        hasProvider: false,
        text: getNoKeyBmiStatusText(locale),
        cached: true,
        updatedAt: null,
      };
    }
    return {
      hasProvider: true,
      text: null,
      cached: false,
      updatedAt: null,
      preparing: true,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
    },
  });

  if (!user?.heightCm || user.heightCm <= 0) {
    return {
      hasProvider: true,
      text:
        locale === "de"
          ? "Für die BMI-Einschätzung fehlen aktuell Größenangaben im Profil."
          : "BMI assessment currently requires height data in the profile.",
      cached: true,
      updatedAt: null,
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
  const heightFactor = (user.heightCm / 100) ** 2;

  const bmiPoints = measurements.map((measurement) => ({
    measuredAt: measurement.measuredAt,
    value: round(measurement.value / heightFactor, 2),
  }));
  // `applyPayloadBudget` daily buckets drive the latest/previous focus;
  // the compact graded series is what reaches the prompt.
  const weightSeries = applyPayloadBudget(bmiPoints, { now });
  // BMI has no rollup tier of its own — it is weight ÷ height², a linear
  // transform by the per-user height factor. Read the WEIGHT tier (recent
  // / weekly from a bounded raw read, monthly / yearly from MONTH / YEAR)
  // and scale by 1 / heightFactor; the scaled series is exact.
  const weightGraded = await buildGradedSeriesWithRollups(
    userId,
    "WEIGHT",
    now,
  );
  const bmiGraded = scaleGradedSeries(weightGraded, 1 / heightFactor, 2);
  const bmiSeries = {
    daily: weightSeries.daily,
    monthly: weightSeries.monthly,
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
      series: bmiGraded,
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

  const shed = degradeStatusSnapshotToBudget(
    snapshot as unknown as Record<string, unknown>,
  );
  const snapshotJson = JSON.stringify(snapshot, null, 2);

  annotate({
    action: { name: cacheAction },
    meta: {
      payload_size_bytes: snapshotJson.length,
      ...(shed.length > 0 ? { snapshot_shed: shed } : {}),
    },
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

  const outcome = await runStatusCompletion({
    userId,
    cacheAction,
    systemPrompt: getBmiSystemPrompt(locale),
    userPrompt: getBmiUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
    ),
    temperature: 0.3,
    maxTokens: 1000,
  });

  if (outcome.kind === "none") {
    return {
      hasProvider: false,
      text: getNoKeyBmiStatusText(locale),
      cached: true,
      updatedAt: null,
    };
  }
  if (outcome.kind === "timeout" || outcome.kind === "error") {
    return returnTimeoutFallback({
      cacheAction,
      reason: outcome.kind,
      userId,
      todayKey,
      stubText: getNoKeyBmiStatusText(locale),
    });
  }

  const summary = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  if (!summary) {
    throw new Error("Bmi-status summary was empty after normalization");
  }

  const updatedAt = await persistStatusInsight({
    userId,
    cacheAction,
    todayKey,
    locale,
    text: summary,
    providerType: outcome.providerType,
    model: outcome.model,
    tokensUsed: outcome.tokensUsed,
  });

  return {
    hasProvider: true,
    text: summary,
    cached: false,
    updatedAt,
  };
}

export function resolveBmiStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
