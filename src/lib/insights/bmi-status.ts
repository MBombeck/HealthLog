import { prisma } from "@/lib/db";
import { getBmiSystemPrompt, getBmiUserPrompt } from "@/lib/ai/prompts/bmi";
import { classifyBMI } from "@/lib/analytics/classifications";
import { getNoKeyBmiStatusText } from "@/lib/insights/no-key-fallbacks";
import { computeSteadyRun } from "@/lib/insights/assessment-context";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesWithRollups,
  scaleGradedSeries,
} from "@/lib/insights/graded-series";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import { round, summarizeSeries } from "@/lib/insights/status-shared";
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

/**
 * Public entry — unchanged signature. Prepares the card (cache-read,
 * read-only miss, snapshot build, hash gate) then, when the LLM is still
 * needed, runs ONE completion through the shared single-card path. The
 * one-call-per-metric behaviour and the timeout / no-provider fallbacks are
 * byte-for-byte the same as before the prepare split (v1.18.7 HIGH-1).
 */
export async function generateBmiStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<StatusTextResult> {
  const prepared = await prepareBmiStatusForUser(userId, options);
  return (await runPreparedStatusCard(prepared)) as StatusTextResult;
}

/**
 * Everything up to (not including) the provider call, through the shared
 * status pipeline (`status-pipeline.ts`); this card supplies its height
 * check, its input gate and its snapshot.
 */
export function prepareBmiStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<PreparedStatusCard> {
  return prepareStatusCard(BMI_STATUS_CARD, userId, options);
}

/** The BMI snapshot: the weight series scaled by the profile height. */
async function buildBmiSnapshot(
  ctx: StatusCardContext,
): Promise<StatusCardBuild<undefined> | ServedBuild<StatusTextResult>> {
  const { userId, locale, userTz, todayKey } = ctx;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
    },
  });

  if (!user?.heightCm || user.heightCm <= 0) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text:
          locale === "de"
            ? "Für die BMI-Einschätzung fehlen aktuell Größenangaben im Profil."
            : "BMI assessment currently requires height data in the profile.",
        cached: true,
        updatedAt: null,
      },
    };
  }

  // v1.18.11 — input gate for this slow-moving metric. The snapshot
  // derives from WEIGHT rows and the profile heightCm; a cheap probe over
  // both fingerprints the inputs, so a non-forced unchanged week re-stamps
  // the cached assessment and skips the whole build (findMany + BMI series +
  // provider). A forced run never gates but still records a current
  // fingerprint for the next day's gate.
  const inputHash = await computeStatusInputFingerprint({
    userId,
    types: ["WEIGHT"],
    extra: { heightCm: user.heightCm },
  });
  if (!ctx.force) {
    const unchangedInput = await gateUnchangedInputs(ctx, inputHash, ctx.force);
    if (unchangedInput) return { phase: "served", result: unchangedInput };
  }

  // v1.4.28 — cap the snapshot input (weight runs at most once
  // per day for typical users; 365 covers a full year while the
  // downstream payload budget trims further).
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: "WEIGHT",
        // Soft-deleted rows must never reach the prompt snapshot.
        deletedAt: null,
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
  // v1.2.5 — bucket day windows on the user's own calendar so a
  // near-midnight reading lands on the user's day for non-Berlin self-hosters.
  // `userTz` was already resolved above for the cache day-key.
  const heightFactor = (user.heightCm / 100) ** 2;

  const bmiPoints = measurements.map((measurement) => ({
    measuredAt: measurement.measuredAt,
    value: round(measurement.value / heightFactor, 2),
  }));
  // `applyPayloadBudget` daily buckets drive the latest/previous focus;
  // the compact graded series is what reaches the prompt.
  const weightSeries = applyPayloadBudget(bmiPoints, { now, tz: userTz });
  // BMI has no rollup tier of its own — it is weight ÷ height², a linear
  // transform by the per-user height factor. Read the WEIGHT tier (recent
  // / weekly from a bounded raw read, monthly / yearly from MONTH / YEAR)
  // and scale by 1 / heightFactor; the scaled series is exact.
  const weightGraded = await buildGradedSeriesWithRollups(
    userId,
    "WEIGHT",
    now,
    userTz,
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

  const { totalSpanDays, newestDaysAgo: newestMeasurementDaysAgo } =
    coverageSpan(
      measurements.length > 0 ? measurements[0].measuredAt : null,
      measurements.length > 0
        ? measurements[measurements.length - 1].measuredAt
        : null,
    );

  // v1.18.10 — hand the model the finished recent-vs-baseline
  // comparison + normal-swing verdict instead of asking it to derive them.
  // BMI reads against the WHO healthy band; "target-band" framing.
  const bmiSignal = buildMetricSignal({
    metric: locale === "en" ? "your BMI" : "dein BMI",
    direction: "target-band",
    graded: bmiGraded,
    normalRange: { low: 18.5, high: 24.9 },
    newestDaysAgo: newestMeasurementDaysAgo,
  });

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
      ...(bmiSignal ? { signal: bmiSignal } : {}),
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

  return {
    snapshot,
    inputHash,
    finish: () => ({
      // BMI is a per-user height transform of WEIGHT (no discovery channel
      // of its own), so the RELATIONS sub-block stays empty; the variety /
      // data-strength / repetition signals carry the rotation.
      context: {
        repeatCount: computeSteadyRun(bmiGraded.weekly, bmiGraded.monthly),
        points: bmiSeries.daily.length,
        newestDaysAgo: newestMeasurementDaysAgo,
        relationsFor: null,
      },
      fallbackText: getNoKeyBmiStatusText(locale, bmiSignal),
      prompts: (snapshotJson, context) => ({
        systemPrompt: getBmiSystemPrompt(locale),
        userPrompt: getBmiUserPrompt(
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

const BMI_STATUS_CARD: StatusCardPlugin<StatusTextResult, undefined> = {
  scope: "bmi",
  codec: textStatusCodec,
  unavailableText: (locale) => getNoKeyBmiStatusText(locale),
  emptyMessage: "Bmi-status summary was empty after normalization",
  build: buildBmiSnapshot,
};
