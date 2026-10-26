import { prisma } from "@/lib/db";
import { readRecentMoodScores } from "@/lib/mood/recent-scores";
import { readRecentReadings } from "@/lib/insights/recent-readings";
import {
  getPulseSystemPrompt,
  getPulseUserPrompt,
} from "@/lib/ai/prompts/pulse";
import { computeSteadyRun } from "@/lib/insights/assessment-context";
import {
  getAgeFromDateOfBirth,
  getPersonalizedPulseTarget,
} from "@/lib/analytics/pulse-targets";
import { resolveRestingPulseSeries } from "@/lib/analytics/resting-pulse";
import { getNoKeyPulseStatusText } from "@/lib/insights/no-key-fallbacks";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesFromPoints,
  buildGradedSeriesWithRollups,
} from "@/lib/insights/graded-series";
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import { round, summarizeSeries } from "@/lib/insights/status-shared";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
} from "@/lib/insights/status-card-generation";
import {
  coverageSpan,
  prepareStatusCard,
  textStatusCodec,
  type StatusCardBuild,
  type StatusCardContext,
  type StatusCardOptions,
  type StatusCardPlugin,
  type StatusTextResult,
} from "@/lib/insights/status-pipeline";
import { binaryReferenceSex } from "@/lib/profile/sex";
import { userDayKey } from "@/lib/tz/resolver";

/**
 * Public entry — unchanged signature. Prepares the card (cache-read,
 * read-only miss, snapshot build, hash gate) then, when the LLM is still
 * needed, runs ONE completion through the shared single-card path. The
 * one-call-per-metric behaviour and the timeout / no-provider fallbacks are
 * byte-for-byte the same as before the prepare split (v1.18.7 HIGH-1).
 */
export async function generatePulseStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<StatusTextResult> {
  const prepared = await preparePulseStatusForUser(userId, options);
  return (await runPreparedStatusCard(prepared)) as StatusTextResult;
}

/**
 * Everything up to (not including) the provider call, through the shared
 * status pipeline (`status-pipeline.ts`); this card supplies its snapshot.
 */
export function preparePulseStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<PreparedStatusCard> {
  return prepareStatusCard(PULSE_STATUS_CARD, userId, options);
}

/**
 * The resting-pulse snapshot: the PULSE stream graded for the prompt, the
 * resting band judged against the RESTING series, and the mood context.
 */
async function buildPulseSnapshot(
  ctx: StatusCardContext,
): Promise<StatusCardBuild<undefined>> {
  const { userId, locale, userTz, todayKey } = ctx;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
      gender: true,
    },
  });

  // v1.15.12 — bucket the resting-pulse proxy on the user's
  // own day boundary so this surface aligns with the targets route, which
  // passes `userDayKey(d, userTz)`. Without it the proxy bucketed on
  // Berlin-day here and on the user's TZ there, drifting the resting
  // estimate for non-Berlin users. `userTz` was already resolved above for
  // the cache day-key.

  // The latest 365 readings, and never less than the last 30 days: a dense
  // pulse stream holds 365 readings in a few hours (`readRecentReadings`).
  const measurements = await readRecentReadings(userId, "PULSE");

  // v1.15.12 — the RESTING band is judged against the RESTING series,
  // not the raw PULSE stream (Apple fills PULSE with workout HR). Pull
  // RESTING_HEART_RATE rows; the resolver falls back to a low-percentile
  // PULSE proxy when the user has none.
  const restingMeasurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: "RESTING_HEART_RATE",
        deletedAt: null,
      },
      orderBy: { measuredAt: "desc" },
      take: 365,
      select: { value: true, measuredAt: true },
    })
    .then((rows) => rows.reverse());

  const now = new Date();

  const pulsePoints = measurements.map((measurement) => ({
    measuredAt: measurement.measuredAt,
    value: measurement.value,
  }));
  // `applyPayloadBudget` daily buckets still drive the derived stats
  // below (latest, in-target %, delta). They are NOT embedded in the
  // prompt — the compact graded series replaces the full daily array.
  // A pulse day is the mean of its hours' means (`day-mean.ts`).
  const pulseSeries = applyPayloadBudget(pulsePoints, {
    now,
    tz: userTz,
    type: "PULSE",
  });
  // Primary metric: recent / weekly fold from the bounded raw read, the
  // monthly / yearly tail comes from the MONTH / YEAR rollup tier (with
  // a full-history in-memory fallback on a cold-tier coverage miss).
  const pulseGraded = await buildGradedSeriesWithRollups(
    userId,
    "PULSE",
    now,
    userTz,
  );
  const pulseSummary = summarizeSeries(
    pulseSeries.daily.map((bucket) => ({ value: bucket.value })),
  );

  // Fetch mood context (optional — for enrichment only). Cap at 90
  // entries (~3 months); the bucket-series budget then summarises
  // further. v1.4.28 FB-D2 — prevent unbounded reads for power users.
  const moodEntries = await readRecentMoodScores(userId, 90);

  const moodPoints = moodEntries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  const moodSeries = applyPayloadBudget(moodPoints, { now, tz: userTz });
  const moodGraded = buildGradedSeriesFromPoints(moodPoints, now, userTz);
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );
  const moodMean = moodSummary?.mean ?? null;

  const pulseAge = getAgeFromDateOfBirth(user?.dateOfBirth ?? null);
  const pulseTarget = getPersonalizedPulseTarget(
    pulseAge,
    binaryReferenceSex(user?.gender),
  );

  const inTargetPctLast30DailyPoints = restingInTargetPct({
    restingMeasurements,
    measurements,
    target: pulseTarget,
    now,
    userTz,
  });

  // Daily buckets are sorted oldest-first by dayOffset (lower = newer).
  const latestPulse = pulseSeries.daily[0] ?? null;
  const previousPulse = pulseSeries.daily[1] ?? null;

  const { totalSpanDays, newestDaysAgo: newestMeasurementDaysAgo } =
    coverageSpan(
      measurements.length > 0 ? measurements[0].measuredAt : null,
      measurements.length > 0
        ? measurements[measurements.length - 1].measuredAt
        : null,
    );

  // v1.18.10 — feed the model the finished recent-vs-baseline
  // comparison + normal-swing verdict instead of asking it to derive them from
  // the raw buckets (the "model computes a number" pattern the mandate bans).
  // Resting pulse reads lower-better; the green band is the coarse anchor.
  const pulseSignal = buildMetricSignal({
    metric: locale === "en" ? "your resting pulse" : "dein Ruhepuls",
    unit: "bpm",
    direction: "lower-better",
    graded: pulseGraded,
    normalRange: { low: pulseTarget.greenMin, high: pulseTarget.greenMax },
    newestDaysAgo: newestMeasurementDaysAgo,
  });

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    focus: "pulse",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    pulse: {
      ...(pulseSignal ? { signal: pulseSignal } : {}),
      summary: pulseSummary,
      series: pulseGraded,
      latestDayFocus: latestPulse
        ? {
            dayOffset: latestPulse.dayOffset,
            value: latestPulse.value,
            deltaToPreviousDailyPoint:
              previousPulse == null
                ? null
                : round(latestPulse.value - previousPulse.value, 2),
          }
        : null,
      target: {
        greenMin: pulseTarget.greenMin,
        greenMax: pulseTarget.greenMax,
        orangeMin: pulseTarget.orangeMin,
        orangeMax: pulseTarget.orangeMax,
        inTargetPctLast30DailyPoints,
      },
    },
    moodContext:
      moodSeries.daily.length >= 3
        ? {
            points: moodSeries.daily.length,
            mean: moodMean,
            latest: moodSeries.daily[0]?.value ?? null,
            series: moodGraded,
          }
        : null,
  };

  return {
    snapshot,
    finish: () => ({
      context: {
        repeatCount: computeSteadyRun(pulseGraded.weekly, pulseGraded.monthly),
        points: pulseSeries.daily.length,
        newestDaysAgo: newestMeasurementDaysAgo,
        relationsFor: "PULSE",
      },
      fallbackText: getNoKeyPulseStatusText(locale, pulseSignal),
      prompts: (snapshotJson, context) => ({
        systemPrompt: getPulseSystemPrompt(locale),
        userPrompt: getPulseUserPrompt(
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
 * Resting-target in-target % over the RESTING series (preferring
 * RESTING_HEART_RATE, else the low-percentile PULSE proxy), NOT the raw PULSE
 * daily buckets which mix in workout HR. Scoring the raw stream against a
 * resting band counted a workout day as "over target" and tanked the %.
 */
function restingInTargetPct(args: {
  restingMeasurements: ReadonlyArray<{ measuredAt: Date; value: number }>;
  measurements: ReadonlyArray<{ measuredAt: Date; value: number }>;
  target: { greenMin: number; greenMax: number };
  now: Date;
  userTz: string;
}): number | null {
  const { target, now, userTz } = args;
  const restingResolved = resolveRestingPulseSeries({
    restingSamples: args.restingMeasurements.map((m) => ({
      measuredAt: m.measuredAt,
      value: m.value,
    })),
    pulseSamples: args.measurements.map((m) => ({
      measuredAt: m.measuredAt,
      value: m.value,
    })),
    dayKeyOf: (d: Date) => userDayKey(d, userTz),
  });
  const thirtyDaysAgoMs = now.getTime() - 30 * 24 * 60 * 60 * 1000;
  const recentResting = restingResolved.series.filter(
    (p) => p.measuredAt.getTime() >= thirtyDaysAgoMs,
  );
  return recentResting.length === 0
    ? null
    : round(
        (recentResting.filter(
          (entry) =>
            entry.value >= target.greenMin && entry.value <= target.greenMax,
        ).length /
          recentResting.length) *
          100,
        1,
      );
}

const PULSE_STATUS_CARD: StatusCardPlugin<StatusTextResult, undefined> = {
  scope: "pulse",
  codec: textStatusCodec,
  unavailableText: (locale) => getNoKeyPulseStatusText(locale),
  emptyMessage: "Pulse-status summary was empty after normalization",
  build: buildPulseSnapshot,
};
