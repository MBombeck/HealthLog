import { prisma } from "@/lib/db";
import {
  getGeneralStatusSystemPrompt,
  getGeneralStatusUserPrompt,
} from "@/lib/ai/prompts/general-status";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import type { Locale } from "@/lib/i18n/config";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import { getNoKeyGeneralStatusText } from "@/lib/insights/no-key-fallbacks";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import {
  buildAssessmentContextBlock,
  pickVarietyLead,
} from "@/lib/insights/assessment-context";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesFromPoints,
  degradeStatusSnapshotToBudget,
} from "@/lib/insights/graded-series";
import {
  normalizeLocale,
  finalizeStatusSummary,
  persistStatusInsight,
  round,
  summarizeSeries,
} from "@/lib/insights/status-shared";
import {
  readFreshStatusText,
  refreshUnchangedStatusInsight,
  resolveReadOnlyStatusMiss,
  statusCacheAction,
} from "@/lib/insights/status-cache";
import { hashInsightSnapshot } from "@/lib/insights/snapshot-hash";
import { returnTimeoutFallback } from "@/lib/insights/timeout-fallback";
import {
  runPreparedStatusCard,
  type PreparedStatusCard,
  type StatusCardResult,
} from "@/lib/insights/status-card-generation";
import { annotate } from "@/lib/logging/context";
import { resolveUserTimezone, userDayKey } from "@/lib/tz/resolver";
import { TRACKED_INTAKE_EVENT_WHERE } from "@/lib/medications/intake-tracking";

// Derived from canonical enum so a new measurement type is auto-included
// in the AI general-status fetch (V3 audit: enum drift cousins).
const MEASUREMENT_TYPES = measurementTypeEnum.options;

// The general overview folds its per-type graded series in memory from a
// single bounded read (take 5000, desc) rather than per-type rollup-tier
// reads: a many-metric account would otherwise fan out ~15 metrics × 3
// rollup round-trips per render. `degradeStatusSnapshotToBudget` already
// caps the multi-metric snapshot, so the bounded in-memory fold is the
// deliberate design here; the rollup tier is wired into the focused
// single-metric cards (weight / pulse / bmi / blood-pressure) instead.

export async function generateGeneralStatusForUser(
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
  /** v1.9.0 — last-good text served while a refresh is in flight; keep polling. */
  revalidating?: boolean;
}> {
  const prepared = await prepareGeneralStatusForUser(userId, options);
  const result = await runPreparedStatusCard(prepared);
  return result as {
    hasProvider: boolean;
    text: string | null;
    cached: boolean;
    updatedAt: string | null;
    preparing?: boolean;
    revalidating?: boolean;
  };
}

export async function prepareGeneralStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    /** v1.8.3 — read-only navigation path; see weight-status for the rationale. */
    readOnly?: boolean;
  },
): Promise<PreparedStatusCard> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = statusCacheAction("general", locale);
  // v1.30.3 (QA F5) — resolve the user's own tz BEFORE the day-key so the
  // cache rolls over at the user's local midnight, not Berlin's. Has to
  // happen ahead of the cache read below (the earliest possible return
  // path), not just the later day-bucketing reads.
  const userTz = await resolveUserTimezone(userId);
  const todayKey = userDayKey(new Date(), userTz);

  const cached = await readFreshStatusText({
    userId,
    cacheAction,
    todayKey,
    force,
  });
  if (cached) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: cached.text,
        cached: true,
        updatedAt: cached.updatedAt,
      },
    };
  }

  if (readOnly) {
    const outcome = await resolveReadOnlyStatusMiss({
      userId,
      metric: "general",
      locale,
    });
    // Unavailable for any reason serves the deterministic line and enqueues
    // nothing. `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        phase: "served",
        result: {
          hasProvider: outcome.hasProvider,
          text: getNoKeyGeneralStatusText(locale),
          cached: true,
          updatedAt: null,
        },
      };
    }
    // v1.8.7 — stale-while-revalidate: serve the last good assessment
    // (if any) instantly while the worker re-warms; only fall to the empty
    // preparing skeleton when none was ever produced.
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: outcome.lastGood?.text ?? null,
        cached: outcome.lastGood !== null,
        updatedAt: outcome.lastGood?.updatedAt ?? null,
        preparing: outcome.lastGood === null,
        revalidating: outcome.revalidating,
      },
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
    },
  });

  // v1.4.28 FB-D2 — cap the snapshot input. General-status pulls
  // every supported measurement type; without a cap the read scales
  // linearly with account density.
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: {
          in: [...MEASUREMENT_TYPES],
        },
        // Soft-deleted rows must never reach the prompt snapshot.
        deletedAt: null,
      },
      orderBy: { measuredAt: "desc" },
      take: 5000,
      select: {
        type: true,
        value: true,
        measuredAt: true,
      },
    })
    .then((rows) => rows.reverse());

  const now = new Date();

  // v1.2.5 (M-TZ3) — every day-bucketing pass below keys on the user's own
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

      const series = applyPayloadBudget(records, { now, tz: userTz });
      dailyByType.set(type, series);
      const graded = buildGradedSeriesFromPoints(records, now);

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
    orderBy: { scheduledFor: "asc" },
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
  const adherenceGraded = buildGradedSeriesFromPoints(adherenceRecords, now);

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

  const moodRecords = moodEntries.map((entry) => ({
    measuredAt: entry.moodLoggedAt,
    value: entry.score,
  }));
  const moodSeries = applyPayloadBudget(moodRecords, { now, tz: userTz });
  const moodGraded = buildGradedSeriesFromPoints(moodRecords, now);
  const moodSummary = summarizeSeries(
    moodSeries.daily.map((bucket) => ({ value: bucket.value })),
  );
  const moodMean = moodSummary?.mean ?? null;

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);
  let bpInTargetLast30Days: number | null = null;
  if (bpTargets) {
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

    if (paired.length > 0) {
      const inTargetCount = paired.filter((point) =>
        // v1.4.16 A2 — one-sided ceiling semantics with hypotension
        // floor. See lib/analytics/bp-in-target.ts.
        isBpReadingInTarget(point.sys, point.dia, bpTargets),
      ).length;
      bpInTargetLast30Days = round((inTargetCount / paired.length) * 100, 1);
    }
  }

  // Compute overall data coverage info
  const oldestDay = measurements.length > 0 ? measurements[0].measuredAt : null;
  const newestDay =
    measurements.length > 0
      ? measurements[measurements.length - 1].measuredAt
      : null;
  const totalSpanDays =
    oldestDay && newestDay
      ? Math.round(
          (newestDay.getTime() - oldestDay.getTime()) / (24 * 60 * 60 * 1000),
        )
      : 0;
  const newestDaysAgo = newestDay
    ? Math.round((Date.now() - newestDay.getTime()) / (24 * 60 * 60 * 1000))
    : null;

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

  // Content-hash gate (v1.16.8): when the snapshot is unchanged since the
  // last real assessment, refresh the cache timestamp and skip the LLM.
  const snapshotHash = hashInsightSnapshot(snapshot);
  const unchanged = await refreshUnchangedStatusInsight({
    userId,
    cacheAction,
    todayKey,
    snapshotHash,
  });
  if (unchanged) {
    return {
      phase: "served",
      result: {
        hasProvider: true,
        text: unchanged.text,
        cached: true,
        updatedAt: unchanged.updatedAt,
      },
    };
  }

  // v1.4: pull the previous cached general-status into the prompt so
  // the model can compare to the user's last analysis. Falls back
  // gracefully when there's no history (first-run users).
  const previousContext = await getPreviousInsightContext(
    userId,
    "general-status",
    locale,
    12,
  );
  const previousContextBlock = formatPreviousContextForPrompt(
    previousContext,
    locale,
  );

  // v1.12.7 — diversity / anti-repetition block (see blood-pressure-status).
  // The overview spans many metrics with no single graded mean to band, so
  // the steady-run signal is left to the previous-context comparison
  // (repeatCount 0) and there is no single discovery channel (relations
  // empty); the variety lead + overall data-strength carry the rotation.
  const varietyLead = pickVarietyLead(userId, "general", todayKey);
  const assessmentContextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: measurements.length,
        newestDaysAgo,
      },
      repeatCount: 0,
      relations: [],
    },
    locale,
  );

  // The provider call is deferred to the caller — the single-card path runs
  // ONE completion, the batch path folds this prompt into one shared call.
  // A timeout / error is a transient miss (fallback served, no assessment
  // persisted); `none` (no provider / no consent) serves the no-key text.
  return {
    phase: "pending",
    metric: "general",
    userId,
    cacheAction,
    systemPrompt: getGeneralStatusSystemPrompt(locale),
    userPrompt: getGeneralStatusUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      assessmentContextBlock,
      // v1.28.40 — rotating opener hint, per (user, metric, day).
      openerArchetypeHint(`${userId}:general:${todayKey}`, locale as Locale),
    ),
    snapshotHash,
    // v1.12.7 — match the archetype cards' 0.45.
    temperature: 0.45,
    noProvider: {
      hasProvider: false,
      text: getNoKeyGeneralStatusText(locale),
      cached: true,
      updatedAt: null,
    },
    timeout: (reason): StatusCardResult =>
      returnTimeoutFallback({
        cacheAction,
        reason,
        userId,
        todayKey,
        stubText: getNoKeyGeneralStatusText(locale),
      }),
    finalize: async (outcome): Promise<StatusCardResult> => {
      // Outbound safety screen. The only transform here used to be
      // whitespace-normalisation, so a dose-change imperative or a fabricated
      // clinical risk score persisted as the day's cached assessment. Policy
      // for a background-generated card is WITHHOLD: serve the deterministic
      // stub and persist no model text (see `finalizeStatusSummary`).
      const screened = finalizeStatusSummary(outcome.content, locale);
      if (!screened.ok) {
        annotate({
          action: { name: "insights.status.outbound_blocked" },
          meta: { cacheAction, reason: screened.reason },
        });
        return returnTimeoutFallback({
          cacheAction,
          reason: "screened",
          userId: userId,
          todayKey: todayKey,
          stubText: getNoKeyGeneralStatusText(locale),
        });
      }
      const summary = screened.text;
      if (!summary) {
        throw new Error("General-status summary was empty after normalization");
      }
      const updatedAt = await persistStatusInsight({
        userId,
        cacheAction,
        todayKey,
        text: summary,
        snapshotHash,
      });
      return {
        hasProvider: true,
        text: summary,
        cached: false,
        updatedAt,
      };
    },
  };
}
