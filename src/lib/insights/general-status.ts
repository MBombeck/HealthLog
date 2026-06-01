import { prisma } from "@/lib/db";
import {
  getGeneralStatusSystemPrompt,
  getGeneralStatusUserPrompt,
} from "@/lib/ai/prompts/general-status";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import { getNoKeyGeneralStatusText } from "@/lib/insights/no-key-fallbacks";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { applyPayloadBudget } from "@/lib/insights/bucket-series";
import {
  buildGradedSeriesFromPoints,
  degradeStatusSnapshotToBudget,
} from "@/lib/insights/graded-series";
import {
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
}> {
  const locale = normalizeLocale(options?.locale);
  const force = options?.force === true;
  const readOnly = options?.readOnly === true;
  const cacheAction = `insights.general-status.${locale}`;
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
      metric: "general",
      locale,
    });
    if (outcome === "no-provider") {
      return {
        hasProvider: false,
        text: getNoKeyGeneralStatusText(locale),
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

      const series = applyPayloadBudget(records, { now });
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

  const intakeEvents = await prisma.medicationIntakeEvent.findMany({
    // v1.7.0 sync — exclude tombstoned rows.
    where: { userId, deletedAt: null },
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
    const dayKey = toBerlinDayKey(event.scheduledFor);
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
  // record list.
  const adherenceRecords = Array.from(adherenceByDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, value]) => ({
      measuredAt: new Date(`${day}T00:00:00.000Z`),
      value: value.total > 0 ? round((value.taken / value.total) * 100, 1) : 0,
    }));
  const adherenceSeries = applyPayloadBudget(adherenceRecords, { now });
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
  const moodSeries = applyPayloadBudget(moodRecords, { now });
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

  const outcome = await runStatusCompletion({
    userId,
    cacheAction,
    systemPrompt: getGeneralStatusSystemPrompt(locale),
    userPrompt: getGeneralStatusUserPrompt(
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
      text: getNoKeyGeneralStatusText(locale),
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
      stubText: getNoKeyGeneralStatusText(locale),
    });
  }

  const summary = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  if (!summary) {
    throw new Error("General-status summary was empty after normalization");
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

