import { prisma } from "@/lib/db";
import { readRecentMoodScores } from "@/lib/mood/recent-scores";
import { readLatestReadingsPerType } from "@/lib/insights/recent-readings";
import {
  getGeneralStatusSystemPrompt,
  getGeneralStatusUserPrompt,
} from "@/lib/ai/prompts/general-status";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import { getNoKeyGeneralStatusText } from "@/lib/insights/no-key-fallbacks";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import { buildGradedSeriesFromPoints } from "@/lib/insights/graded-series";
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
import { userDayKey } from "@/lib/tz/resolver";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";

// Derived from canonical enum so a new measurement type is auto-included
// in the AI general-status fetch (V3 audit: enum drift cousins).
const MEASUREMENT_TYPES = measurementTypeEnum.options;

// The general overview folds its per-type graded series in memory from a
// single bounded read (the latest 365 per type) rather than per-type rollup-tier
// reads: a many-metric account would otherwise fan out ~15 metrics × 3
// rollup round-trips per render. `degradeStatusSnapshotToBudget` already
// caps the multi-metric snapshot, so the bounded in-memory fold is the
// deliberate design here; the rollup tier is wired into the focused
// single-metric cards (weight / pulse / bmi / blood-pressure) instead.

export async function generateGeneralStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<StatusTextResult> {
  const prepared = await prepareGeneralStatusForUser(userId, options);
  return (await runPreparedStatusCard(prepared)) as StatusTextResult;
}

/**
 * Everything up to (not including) the provider call, through the shared
 * status pipeline (`status-pipeline.ts`); this card supplies its snapshot.
 */
export function prepareGeneralStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<PreparedStatusCard> {
  return prepareStatusCard(GENERAL_STATUS_CARD, userId, options);
}

/**
 * The overview snapshot: every measured type as a summary + graded series,
 * medication adherence, the BP targets, and mood context.
 */
async function buildGeneralSnapshot(
  ctx: StatusCardContext,
): Promise<StatusCardBuild<undefined>> {
  const { userId, locale, userTz, todayKey } = ctx;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
    },
  });

  // The latest 365 readings of each type, bounded per type so a dense
  // stream cannot crowd the others out (`readLatestReadingsPerType`).
  const measurements = await readLatestReadingsPerType(userId, [
    ...MEASUREMENT_TYPES,
  ]);

  const now = new Date();

  // v1.2.5 — every day-bucketing pass below keys on the user's own
  // calendar (a near-midnight reading lands on the user's day for
  // non-Berlin self-hosters). `userTz` was already resolved above for the
  // cache day-key.

  // `dailyByType` keeps the `applyPayloadBudget` daily buckets for the
  // downstream BP in-target pairing; the prompt embeds the compact
  // graded series instead of the full daily array. Skip types with no
  // data so a many-metric account can't balloon the snapshot with empty
  // series objects.
  const dailyByType = new Map<
    (typeof MEASUREMENT_TYPES)[number],
    ReturnType<typeof applyPayloadBudget>
  >();
  const measurementSeries = Object.fromEntries(
    MEASUREMENT_TYPES.flatMap((type) => {
      const records = measurements
        .filter((measurement) => measurement.type === type)
        .map((measurement) => ({
          measuredAt: measurement.measuredAt,
          value: measurement.value,
        }));
      if (records.length === 0) return [];

      // `type` makes a pulse day the mean of its hours' means and a pulse
      // window the mean of its days (`day-mean.ts`); other types unchanged.
      const series = applyPayloadBudget(records, { now, tz: userTz, type });
      dailyByType.set(type, series);
      const graded = buildGradedSeriesFromPoints(records, now, userTz, type);

      return [
        [
          type,
          {
            summary: summarizeSeries(
              series.daily.map((bucket) => ({ value: bucket.value })),
            ),
            series: graded,
          },
        ] as const,
      ];
    }),
  );

  const { adherenceSeries, adherenceGraded } = await readAdherenceSeries(
    userId,
    now,
    userTz,
  );

  // Fetch mood context (optional — for enrichment only). v1.4.28
  // Cap at 90 entries.
  const moodEntries = await readRecentMoodScores(userId, 90);

  const moodRecords = moodEntries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  const moodSeries = applyPayloadBudget(moodRecords, { now, tz: userTz });
  const moodGraded = buildGradedSeriesFromPoints(moodRecords, now, userTz);
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );
  const moodMean = moodSummary?.mean ?? null;

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);
  const bpInTargetLast30Days = bpTargets
    ? bpInTargetLast30DailyPoints(dailyByType, bpTargets)
    : null;

  // Compute overall data coverage info
  const { totalSpanDays, newestDaysAgo } = coverageSpan(
    measurements.length > 0 ? measurements[0].measuredAt : null,
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null,
  );

  const snapshot = {
    locale,
    generatedForDay: todayKey,
    interpretationHint:
      "Use trend direction and deltas. Prioritize the newest data if trends conflict. Consider dataCoverage for reliability assessment.",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo: newestDaysAgo,
      avgDaysBetweenMeasurements:
        measurements.length > 1
          ? Math.round((totalSpanDays / (measurements.length - 1)) * 10) / 10
          : null,
    },
    measurementSeries,
    medicationAdherence: {
      summary: summarizeSeries(
        adherenceSeries.daily.map((bucket) => ({ value: bucket.value })),
      ),
      series: adherenceGraded,
    },
    bloodPressureTargets: bpTargets
      ? {
          systolic: { min: bpTargets.sysLow, max: bpTargets.sysHigh },
          diastolic: { min: bpTargets.diaLow, max: bpTargets.diaHigh },
          inTargetPctLast30DailyPoints: bpInTargetLast30Days,
        }
      : null,
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
      // The overview spans many metrics with no single graded mean to band,
      // so the steady-run signal is left to the previous-context comparison
      // (repeatCount 0) and there is no single discovery channel (relations
      // empty); the variety lead + overall data-strength carry the rotation.
      context: {
        repeatCount: 0,
        points: measurements.length,
        newestDaysAgo,
        relationsFor: null,
      },
      fallbackText: getNoKeyGeneralStatusText(locale),
      prompts: (snapshotJson, context) => ({
        systemPrompt: getGeneralStatusSystemPrompt(locale),
        userPrompt: getGeneralStatusUserPrompt(
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
 * Medication adherence as one rate per user-local day, bucketed and graded
 * so the model gets the canonical 360+24 view.
 */
async function readAdherenceSeries(userId: string, now: Date, userTz: string) {
  // v1.12.7 — bound the intake read to the ~365-day window the adherence
  // series renders. Without a `scheduledFor` floor this scanned all intake
  // history; the adherence fold below only consumes the trailing year.
  const intakeWindowStart = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const intakeEvents = await prisma.medicationIntakeEvent.findMany({
    // v1.7.0 sync — exclude tombstoned rows.
    where: {
      userId,
      deletedAt: null,
      scheduledFor: { gte: intakeWindowStart },
      // v1.39.1 (#1033) — adherence counts tracked medications only.
      ...TRACKED_INTAKE_EVENT_WHERE,
    },
    orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
    select: {
      scheduledFor: true,
      takenAt: true,
      skipped: true,
    },
  });

  const adherenceByDay = new Map<
    string,
    { total: number; taken: number; skipped: number }
  >();
  for (const event of intakeEvents) {
    const dayKey = userDayKey(event.scheduledFor, userTz);
    const bucket = adherenceByDay.get(dayKey) ?? {
      total: 0,
      taken: 0,
      skipped: 0,
    };
    bucket.total += 1;
    if (!event.skipped && event.takenAt) {
      bucket.taken += 1;
    } else if (event.skipped) {
      bucket.skipped += 1;
    }
    adherenceByDay.set(dayKey, bucket);
  }

  // Adherence series — bucket the per-day rate so the model gets the
  // canonical 360+24 view. We collapse one rate per day first, then feed
  // it into applyPayloadBudget over a synthesised `{measuredAt, value}`
  // record list. The day keys are user-local (userDayKey above); anchor
  // the synthesised instant at noon UTC so the downstream tz-aware
  // re-bucket re-derives the same user-local calendar day across every
  // realistic self-hoster offset rather than slipping a day at the
  // midnight edge.
  const adherenceRecords = Array.from(adherenceByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({
      measuredAt: new Date(`${day}T12:00:00.000Z`),
      // A map entry is only ever created after `bucket.total += 1`, so
      // `value.total` is always >= 1 here — the former `: 0` guard branch was
      // unreachable. v1.32.20 removed it: a real zero-dose day never reaches
      // this fold, so a synthesised `0` would have been a fabricated rate, not
      // an honest absence (the #582 silent-wrong-absence class).
      value: round((value.taken / value.total) * 100, 1),
    }));
  const adherenceSeries = applyPayloadBudget(adherenceRecords, {
    now,
    tz: userTz,
  });
  const adherenceGraded = buildGradedSeriesFromPoints(
    adherenceRecords,
    now,
    userTz,
  );

  return { adherenceSeries, adherenceGraded };
}

/**
 * The share of the newest 30 paired systolic / diastolic daily buckets that
 * sit in the person's BP targets, or `null` with no paired day.
 */
function bpInTargetLast30DailyPoints(
  dailyByType: ReadonlyMap<string, ReturnType<typeof applyPayloadBudget>>,
  bpTargets: NonNullable<ReturnType<typeof getBpTargets>>,
): number | null {
  const sysDaily = dailyByType.get("BLOOD_PRESSURE_SYS")?.daily ?? [];
  const diaMap = new Map(
    (dailyByType.get("BLOOD_PRESSURE_DIA")?.daily ?? []).map(
      (bucket) => [bucket.dayOffset, bucket.value] as const,
    ),
  );
  const paired = sysDaily
    .map((bucket) => {
      const dia = diaMap.get(bucket.dayOffset);
      if (dia == null) return null;
      return { dayOffset: bucket.dayOffset, sys: bucket.value, dia };
    })
    .filter(
      (entry): entry is { dayOffset: number; sys: number; dia: number } =>
        !!entry,
    )
    // Keep the legacy "last 30 daily points" semantics — newest 30
    // paired daily buckets (dayOffset 0..29).
    .filter((point) => point.dayOffset < 30);

  if (paired.length === 0) return null;
  const inTargetCount = paired.filter((point) =>
    // v1.4.16 — one-sided ceiling semantics with hypotension
    // floor. See lib/analytics/bp-in-target.ts.
    isBpReadingInTarget(point.sys, point.dia, bpTargets),
  ).length;
  return round((inTargetCount / paired.length) * 100, 1);
}

const GENERAL_STATUS_CARD: StatusCardPlugin<StatusTextResult, undefined> = {
  scope: "general",
  codec: textStatusCodec,
  unavailableText: (locale) => getNoKeyGeneralStatusText(locale),
  emptyMessage: "General-status summary was empty after normalization",
  build: buildGeneralSnapshot,
};
