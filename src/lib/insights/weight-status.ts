import { prisma } from "@/lib/db";
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
import {
  buildGradedSeriesFromPoints,
  buildGradedSeriesWithRollups,
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

/**
 * Cap on the embedded correlation pair arrays. The Pearson coefficient
 * is still computed over the full overlap; only the row-by-row pair
 * list the prompt carries is trimmed to its most recent entries.
 */
const CORRELATION_PAIR_CAP = 30;

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
    /**
     * v1.8.3 — read-only mode for the navigation path. On a cache miss the
     * generator does NOT run the SQL gather + blocking LLM inline; it
     * enqueues an out-of-band generation and returns a `preparing` shape so
     * the request never awaits the provider. The worker (and the nightly
     * pre-generate cron) call with `readOnly: false` to actually generate.
     */
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
  const cacheAction = `insights.weight-status.${locale}`;
  const todayKey = toBerlinDayKey(new Date());

  // Serve today's real assessment when present. The shared reader
  // rejects timeout stubs, so a single stall no longer pins the
  // fallback for the day.
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

  // v1.8.3 — read-only navigation path: never block on the provider.
  // Enqueue generation out of band and return preparing / no-provider.
  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId,
      metric: "weight",
      locale,
    });
    if (outcome === "no-provider") {
      return {
        hasProvider: false,
        text: getNoKeyWeightStatusText(locale),
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

  // Compact graded series for the prompt. The `*Series.daily` buckets
  // above stay for the correlation pairing + latest-day focus; only the
  // graded shape is embedded so the full daily arrays never ship.
  //
  // Weight + the two BP context channels source their recent / weekly
  // slices from a bounded raw read and their monthly / yearly tail from
  // the MONTH / YEAR rollup tier (with a full-history in-memory fallback
  // on a cold-tier coverage miss). Mood has no rollup tier, so it stays
  // an in-memory fold.
  const [weightGraded, sysGraded, diaGraded] = await Promise.all([
    buildGradedSeriesWithRollups(userId, "WEIGHT", now),
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_SYS", now),
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_DIA", now),
  ]);
  const moodGraded = buildGradedSeriesFromPoints(
    moodSeries.daily.map((b) => ({
      measuredAt: new Date(dayOffsetToBerlinDayKey(now, b.dayOffset)),
      value: b.value,
    })),
    now,
  );

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
      series: weightGraded,
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
        series: sysGraded,
      },
      diastolic: {
        summary: summarizeSeries(
          diaSeries.daily.map((bucket) => ({ value: bucket.value })),
        ),
        series: diaGraded,
      },
      // Keep the correlation coefficients (computed over the full
      // overlap) but cap the embedded pair arrays to the most recent
      // paired days — the raw pair lists were a major payload driver.
      pairedDaily: pairedSystolicDiastolic.slice(-CORRELATION_PAIR_CAP),
    },
    weightVsSystolic: {
      correlation: weightVsSystolicCorrelation,
      pairs: weightVsSystolicPairs.slice(-CORRELATION_PAIR_CAP).map((entry) => ({
        day: entry.dayKey,
        weight: round(entry.a, 2),
        systolic: round(entry.b, 2),
      })),
    },
    weightVsMeanBloodPressure: {
      correlation: weightVsMeanBpCorrelation,
      pairs: weightVsMeanBpPairs.slice(-CORRELATION_PAIR_CAP).map((entry) => ({
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
            series: moodGraded,
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
    "weight-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // Run the provider chain bounded by the aligned 60 s budget. A
  // timeout / error / empty content is a transient miss — serve the
  // fallback for this render without persisting it, so the next mount
  // re-attempts a real generation rather than sticking the fallback.
  const outcome = await runStatusCompletion({
    userId,
    cacheAction,
    systemPrompt: getWeightSystemPrompt(locale),
    userPrompt: getWeightUserPrompt(
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
      text: getNoKeyWeightStatusText(locale),
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
      stubText: getNoKeyWeightStatusText(locale),
    });
  }

  const summary = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  if (!summary) {
    throw new Error("Weight-status summary was empty after normalization");
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

export function resolveWeightStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
