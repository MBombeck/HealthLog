import { prisma } from "@/lib/db";
import { readRecentMoodScores } from "@/lib/mood/recent-scores";
import {
  getWeightSystemPrompt,
  getWeightUserPrompt,
} from "@/lib/ai/prompts/weight";
import {
  significantPearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import { getNoKeyWeightStatusText } from "@/lib/insights/no-key-fallbacks";
import { resolveWeightTargetOverride } from "@/lib/analytics/effective-range";
import { buildWeightTargetFeature } from "@/lib/targets/weight-trend";
import { computeSteadyRun } from "@/lib/insights/assessment-context";
import {
  applyPayloadBudget,
  dayOffsetToDayKey,
  type DailyBucket,
} from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesFromPoints,
  buildGradedSeriesWithRollups,
  convertGradedSeries,
  type GradedSeries,
} from "@/lib/insights/graded-series";
import {
  applyDisplayTransform,
  applyDisplayTransformDelta,
  getReadingTransform,
  resolveUnitPreferences,
  transformRescales,
  type DisplayTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import {
  round,
  summarizeSeries,
  type SupportedLocale,
} from "@/lib/insights/status-shared";
import { computeStatusInputFingerprint } from "@/lib/insights/status-cache";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
} from "@/lib/insights/status-card-generation";
import {
  coverageSpan,
  gateUnchangedInputs,
  prepareStatusCard,
  textStatusCodec,
  type ServedBuild,
  type StatusCardBuild,
  type StatusCardContext,
  type StatusCardOptions,
  type StatusCardPlugin,
  type StatusTextResult,
} from "@/lib/insights/status-pipeline";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";

/**
 * Cap on the embedded correlation pair arrays. The Pearson coefficient
 * is still computed over the full overlap; only the row-by-row pair
 * list the prompt carries is trimmed to its most recent entries.
 */
const CORRELATION_PAIR_CAP = 30;

/**
 * Pair two daily-bucket series on `dayOffset`. The synthesised `date`
 * field is anchored at the UTC midnight of the Berlin calendar day —
 * `dayOffsetToDayKey()` is the source of truth so DST boundaries
 * don't slip the day-key by one. Each pair also carries `dayKey`
 * directly so callers can label points without re-formatting.
 */
function pairDailyBuckets(
  seriesA: DailyBucket[],
  seriesB: DailyBucket[],
  now: Date,
  tz: string = DEFAULT_TIMEZONE,
): Array<PairedPoint & { dayKey: string }> {
  const mapB = new Map(seriesB.map((entry) => [entry.dayOffset, entry.value]));

  return seriesA
    .map((entry) => {
      const b = mapB.get(entry.dayOffset);
      if (b == null) return null;
      const dayKey = dayOffsetToDayKey(now, entry.dayOffset, tz);
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

/**
 * Public entry — unchanged signature. Prepares the card (cache-read,
 * read-only miss, snapshot build, hash gate) then, when the LLM is still
 * needed, runs ONE completion through the shared single-card path. The
 * one-call-per-metric behaviour and the timeout / no-provider fallbacks are
 * byte-for-byte the same as before the prepare split (v1.18.7 HIGH-1).
 */
export async function generateWeightStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<StatusTextResult> {
  const prepared = await prepareWeightStatusForUser(userId, options);
  return (await runPreparedStatusCard(prepared)) as StatusTextResult;
}

/**
 * Everything up to (not including) the provider call, through the shared
 * status pipeline (`status-pipeline.ts`); this card supplies its input gate
 * and its snapshot.
 */
export function prepareWeightStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<PreparedStatusCard> {
  return prepareStatusCard(WEIGHT_STATUS_CARD, userId, options);
}

interface WeightInputs {
  weightTarget: ReturnType<typeof resolveWeightTargetOverride>;
  units: UnitPreferences;
  mass: DisplayTransform;
  inputHash: string;
}

/**
 * Input gate for this slow-moving metric. A cheap grouped probe over the
 * salient inputs (weight + BP channels + mood) fingerprints what the snapshot
 * would read. On a non-forced run with an unchanged fingerprint the cached
 * assessment is re-stamped under today's key and the whole heavy build
 * (bounded findMany + per-series rollup reads + correlation math + the
 * provider call) is skipped. A forced run never gates — but still computes
 * the fingerprint so the persisted row carries a current one for the next
 * day's gate.
 */
async function readWeightInputs(
  ctx: StatusCardContext,
): Promise<WeightInputs | ServedBuild<StatusTextResult>> {
  const { userId } = ctx;
  // v1.39 (#1006) — the person's own weight target decides which way is
  // progress. Folded into the input fingerprint so editing the target flips
  // the gate even when no weight row moved.
  const userRow = await prisma.user.findUnique({
    where: { id: userId },
    select: { thresholdsJson: true, unitPreference: true },
  });
  const weightTarget = resolveWeightTargetOverride(userRow?.thresholdsJson);
  // The note is written in the reader's mass unit. Every weight figure the
  // snapshot carries is converted once, after the canonical arithmetic; the
  // correlations are scale-free and stay as computed.
  const units = resolveUnitPreferences({
    unitPreference: userRow?.unitPreference,
  });
  const mass = getReadingTransform("WEIGHT", units);
  const inputHash = await computeStatusInputFingerprint({
    userId,
    types: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
    extra: {
      weightTargetMin: weightTarget?.min ?? null,
      weightTargetMax: weightTarget?.max ?? null,
      // A unit switch changes every figure the note quotes.
      unitPreference: units.system,
    },
    includeMood: true,
    // v1.18.11 — WEIGHT is an FDR discovery OUTCOME channel and
    // the prompt folds `getRelevantCorrelationsForMetric(userId, "WEIGHT")`, so
    // a relation surfacing off a behaviour channel (e.g. more daylight →
    // next-day weight) must flip the gate even when no weight row moved. Fold
    // the discovery channels + the prior-analysis anchor into the fingerprint.
    includeCorrelationChannels: true,
  });
  if (!ctx.force) {
    const unchangedInput = await gateUnchangedInputs(ctx, inputHash, ctx.force);
    if (unchangedInput) return { phase: "served", result: unchangedInput };
  }
  return { weightTarget, units, mass, inputHash };
}

/**
 * The weight snapshot: the weight series in the reader's mass unit, the two
 * BP channels as context, the weight-vs-BP correlations, and mood context.
 */
async function buildWeightSnapshot(
  ctx: StatusCardContext,
): Promise<StatusCardBuild<undefined> | ServedBuild<StatusTextResult>> {
  const { userId, locale, userTz, todayKey } = ctx;
  const inputs = await readWeightInputs(ctx);
  if ("phase" in inputs) return inputs;
  const { weightTarget, units, mass, inputHash } = inputs;
  const toMass = (kg: number) => applyDisplayTransform(kg, mass);

  const {
    now,
    measurements,
    weightSeries,
    sysSeries,
    diaSeries,
    moodSeries,
    moodMean,
    canonicalWeightGraded,
    weightGraded,
    sysGraded,
    diaGraded,
    moodGraded,
  } = await readWeightSeries(userId, mass, userTz);

  const pairs = pairWeightWithBloodPressure(
    weightSeries.daily,
    sysSeries.daily,
    diaSeries.daily,
    now,
    userTz,
  );

  // daily[0] = newest bucket (lowest dayOffset).
  const latestWeight = weightSeries.daily[0] ?? null;
  const previousWeight = weightSeries.daily[1] ?? null;
  const latestWeightDay = latestWeight
    ? dayOffsetToDayKey(now, latestWeight.dayOffset, userTz)
    : null;
  const sameDayBp = latestWeightDay
    ? (pairs.systolicDiastolic.find((entry) => entry.day === latestWeightDay) ??
      null)
    : null;

  const { totalSpanDays, newestDaysAgo: newestMeasurementDaysAgo } =
    coverageSpan(
      measurements.length > 0 ? measurements[0].measuredAt : null,
      measurements.length > 0
        ? measurements[measurements.length - 1].measuredAt
        : null,
    );

  const { weightTargetFeature, weightSignal } = weightTargetAndSignal({
    weightDaily: weightSeries.daily,
    latestWeight,
    weightTarget,
    units,
    mass,
    weightGraded,
    newestDaysAgo: newestMeasurementDaysAgo,
    locale: ctx.locale,
  });

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
      unit: mass.displayUnit,
      ...(weightSignal ? { signal: weightSignal } : {}),
      ...(weightTargetFeature ? { target: weightTargetFeature } : {}),
      summary: summarizeSeries(
        weightSeries.daily.map((bucket) => ({ value: toMass(bucket.value) })),
      ),
      series: weightGraded,
      latestDayFocus: latestWeight
        ? {
            day: latestWeightDay,
            dayOffset: latestWeight.dayOffset,
            value: toMass(latestWeight.value),
            deltaToPreviousDailyPoint:
              previousWeight == null
                ? null
                : applyDisplayTransformDelta(
                    round(latestWeight.value - previousWeight.value, 2),
                    mass,
                  ),
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
      pairedDaily: pairs.systolicDiastolic.slice(-CORRELATION_PAIR_CAP),
    },
    weightVsSystolic: {
      correlation: pairs.weightVsSystolicCorrelation,
      pairs: pairs.weightVsSystolic
        .slice(-CORRELATION_PAIR_CAP)
        .map((entry) => ({
          day: entry.dayKey,
          weight: toMass(round(entry.a, 2)),
          systolic: round(entry.b, 2),
        })),
    },
    weightVsMeanBloodPressure: {
      correlation: pairs.weightVsMeanBpCorrelation,
      pairs: pairs.weightVsMeanBp.slice(-CORRELATION_PAIR_CAP).map((entry) => ({
        day: entry.dayKey,
        weight: toMass(round(entry.a, 2)),
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
                userTz,
              );
              return significantPearsonCorrelation(moodVsWeightPairs);
            })(),
          }
        : null,
  };

  return {
    snapshot,
    inputHash,
    finish: () => ({
      context: {
        repeatCount: computeSteadyRun(
          canonicalWeightGraded.weekly,
          canonicalWeightGraded.monthly,
        ),
        points: weightSeries.daily.length,
        newestDaysAgo: newestMeasurementDaysAgo,
        relationsFor: "WEIGHT",
      },
      fallbackText: getNoKeyWeightStatusText(locale, weightSignal),
      prompts: (snapshotJson, context) => ({
        systemPrompt: getWeightSystemPrompt(locale, units.system),
        userPrompt: getWeightUserPrompt(
          snapshotJson,
          todayKey,
          locale,
          context.previousContextBlock,
          context.assessmentContextBlock,
          context.openerHint,
        ),
      }),
      detail: undefined,
    }),
  };
}

/**
 * The weight target feature and the finished recent-vs-baseline signal.
 */
function weightTargetAndSignal(args: {
  weightDaily: DailyBucket[];
  latestWeight: DailyBucket | null;
  weightTarget: WeightInputs["weightTarget"];
  units: UnitPreferences;
  mass: DisplayTransform;
  weightGraded: GradedSeries;
  newestDaysAgo: number | null;
  locale: SupportedLocale;
}) {
  const { weightTarget, units, mass, weightGraded, locale } = args;
  const newestMeasurementDaysAgo = args.newestDaysAgo;
  const latestWeight = args.latestWeight;
  // v1.18.10 — hand the model the finished recent-vs-baseline
  // comparison + normal-swing verdict instead of asking it to derive them.
  // Weight has no universal favourable direction or population band, so
  // without a stored target the signal carries the neutral "target-band"
  // framing and no normalRange. v1.39 (#1006) — with one, the direction is
  // the person's own: below the band a rise is favourable, above it a fall.
  const recentWeights = args.weightDaily
    .filter((bucket) => bucket.dayOffset < 7)
    .map((bucket) => bucket.value);
  const weightTargetFeature = buildWeightTargetFeature(
    weightTarget,
    {
      avg7:
        recentWeights.length > 0
          ? recentWeights.reduce((sum, value) => sum + value, 0) /
            recentWeights.length
          : null,
      latest: latestWeight?.value ?? null,
    },
    units.system,
  );
  const weightSignal = buildMetricSignal({
    metric: locale === "en" ? "your weight" : "dein Gewicht",
    unit: mass.displayUnit,
    direction:
      weightTargetFeature?.position === "below"
        ? "higher-better"
        : weightTargetFeature?.position === "above"
          ? "lower-better"
          : "target-band",
    graded: weightGraded,
    newestDaysAgo: newestMeasurementDaysAgo,
  });

  return { weightTargetFeature, weightSignal };
}

/**
 * The weight snapshot's reads: weight and the two BP channels as daily
 * buckets and graded series, and the mood context.
 */
async function readWeightSeries(
  userId: string,
  mass: DisplayTransform,
  userTz: string,
) {
  // v1.4.28 — cap the snapshot input. BP captures three types
  // per day so 1095 = 365 d × 3 channels. Order desc + reverse so we
  // keep the most recent year of rows.
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: {
          in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
        },
        // Soft-deleted rows must never reach the prompt snapshot.
        deletedAt: null,
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

  // v1.2.5 — every day-bucketing pass below keys on the user's own
  // calendar day. `userTz` was already resolved above for the cache day-key.
  const dailyOf = (type: string) =>
    applyPayloadBudget(
      measurements
        .filter((measurement) => measurement.type === type)
        .map((measurement) => ({
          measuredAt: measurement.measuredAt,
          value: measurement.value,
        })),
      { now, tz: userTz },
    );
  const weightSeries = dailyOf("WEIGHT");
  const sysSeries = dailyOf("BLOOD_PRESSURE_SYS");
  const diaSeries = dailyOf("BLOOD_PRESSURE_DIA");

  // Fetch mood context (optional — for enrichment only). v1.4.28
  // Cap at 90 entries.
  const moodEntries = await readRecentMoodScores(userId, 90);

  const moodSeries = applyPayloadBudget(
    moodEntries.map((entry) => ({
      measuredAt: entry.moodLoggedAt,
      value: entry.score,
    })),
    { now, tz: userTz },
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
  const [canonicalWeightGraded, sysGraded, diaGraded] = await Promise.all([
    buildGradedSeriesWithRollups(userId, "WEIGHT", now, userTz),
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_SYS", now, userTz),
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_DIA", now, userTz),
  ]);
  const weightGraded = transformRescales(mass)
    ? convertGradedSeries(canonicalWeightGraded, mass, mass.decimals)
    : canonicalWeightGraded;
  const moodGraded = buildGradedSeriesFromPoints(
    moodSeries.daily.map((b) => ({
      measuredAt: canonicalDailyTimestamp(
        dayOffsetToDayKey(now, b.dayOffset, userTz),
        userTz,
      ),
      value: b.value,
    })),
    now,
    userTz,
  );

  return {
    now,
    measurements,
    weightSeries,
    sysSeries,
    diaSeries,
    moodSeries,
    moodMean,
    canonicalWeightGraded,
    weightGraded,
    sysGraded,
    diaGraded,
    moodGraded,
  };
}

/**
 * Weight against the two BP channels: the paired systolic / diastolic days,
 * weight against systolic, and weight against the daily BP mean, each with
 * its significance-gated correlation.
 */
function pairWeightWithBloodPressure(
  weightDaily: DailyBucket[],
  sysDaily: DailyBucket[],
  diaDaily: DailyBucket[],
  now: Date,
  userTz: string,
) {
  const weightVsSystolic = pairDailyBuckets(weightDaily, sysDaily, now, userTz);
  const weightVsSystolicCorrelation =
    significantPearsonCorrelation(weightVsSystolic);

  const systolicDiastolic = pairDailyBuckets(
    sysDaily,
    diaDaily,
    now,
    userTz,
  ).map((entry) => ({
    day: entry.dayKey,
    sys: entry.a,
    dia: entry.b,
    mean: round((entry.a + entry.b) / 2, 2),
  }));

  // Synthesise a daily-bucket-shaped BP-mean series so we can reuse
  // pairDailyBuckets — derive dayOffset from the offsets in sysSeries.
  const sysOffsetByDay = new Map(
    sysDaily.map((bucket) => {
      const dayKey = dayOffsetToDayKey(now, bucket.dayOffset, userTz);
      return [dayKey, bucket.dayOffset];
    }),
  );
  const bpMeanDaily: DailyBucket[] = systolicDiastolic
    .map((entry) => {
      const dayOffset = sysOffsetByDay.get(entry.day);
      if (dayOffset == null) return null;
      return { dayOffset, value: entry.mean, n: 1 };
    })
    .filter((entry): entry is DailyBucket => entry !== null);

  const weightVsMeanBp = pairDailyBuckets(
    weightDaily,
    bpMeanDaily,
    now,
    userTz,
  );
  const weightVsMeanBpCorrelation =
    significantPearsonCorrelation(weightVsMeanBp);

  return {
    weightVsSystolic,
    weightVsSystolicCorrelation,
    systolicDiastolic,
    weightVsMeanBp,
    weightVsMeanBpCorrelation,
  };
}

const WEIGHT_STATUS_CARD: StatusCardPlugin<StatusTextResult, undefined> = {
  scope: "weight",
  codec: textStatusCodec,
  unavailableText: (locale) => getNoKeyWeightStatusText(locale),
  emptyMessage: "Weight-status summary was empty after normalization",
  build: buildWeightSnapshot,
};
