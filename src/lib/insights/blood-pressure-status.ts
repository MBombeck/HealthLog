import { prisma } from "@/lib/db";
import {
  getBloodPressureSystemPrompt,
  getBloodPressureUserPrompt,
} from "@/lib/ai/prompts/blood-pressure";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import {
  pearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  lastNonSkippedTakenAt,
} from "@/lib/analytics/compliance";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import { getMedicationCategories } from "@/lib/medication-category";
import { sanitizeForPrompt } from "@/lib/insights/sanitize";
import { getNoKeyBloodPressureStatusText } from "@/lib/insights/no-key-fallbacks";
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
 * Cap on the embedded correlation / paired-daily arrays. The Pearson
 * coefficients stay computed over the full overlap; only the row-by-row
 * lists the prompt carries are trimmed to their most recent entries.
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
      // UTC midnight of the Berlin day — formatting this Date with
      // `toBerlinDayKey()` is guaranteed DST-safe because the y-m-d
      // fields below are the Berlin calendar day fields by construction.
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

export async function generateBloodPressureStatusForUser(
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
  const cacheAction = `insights.blood-pressure-status.${locale}`;
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
      metric: "blood-pressure",
      locale,
    });
    if (outcome === "no-provider") {
      return {
        hasProvider: false,
        text: getNoKeyBloodPressureStatusText(locale),
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

  // v1.4.28 FB-D2 — cap the snapshot input. The downstream
  // `applyPayloadBudget` trims further; this `take` keeps the read
  // bounded for Apple-Health-rich accounts. BP captures three types
  // per reading day so 1095 = 365 d × 3 channels.
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        type: {
          in: ["WEIGHT", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
        },
      },
      orderBy: { measuredAt: "desc" },
      take: 1095,
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

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);
  const pairedBloodPressure = pairDailyBuckets(
    sysSeries.daily,
    diaSeries.daily,
    now,
  ).map((entry) => ({
    day: entry.dayKey,
    sys: entry.a,
    dia: entry.b,
    inTarget:
      bpTargets == null
        ? null
        : // v1.4.16 A2 — one-sided "at or below ceiling" semantics with a
          // clinical hypotension floor. See lib/analytics/bp-in-target.ts.
          isBpReadingInTarget(entry.a, entry.b, bpTargets),
  }));

  const bpInTargetPctLast30DailyPoints =
    bpTargets == null || pairedBloodPressure.length === 0
      ? null
      : round(
          (pairedBloodPressure.filter((entry) => entry.inTarget === true)
            .length /
            pairedBloodPressure.length) *
            100,
          1,
        );

  const weightVsSystolicPairs = pairDailyBuckets(
    weightSeries.daily,
    sysSeries.daily,
    now,
  );
  const weightVsSystolicCorrelation = pearsonCorrelation(weightVsSystolicPairs);

  const activeMedications = await prisma.medication.findMany({
    where: { userId, active: true },
    include: { schedules: true },
  });

  const categoryMap = await getMedicationCategories(
    activeMedications.map((medication) => medication.id),
  );

  const bpMedications = activeMedications.filter(
    (medication) =>
      (categoryMap[medication.id] ?? "OTHER") === "BLOOD_PRESSURE",
  );

  const bpMedicationEvents =
    bpMedications.length === 0
      ? []
      : await prisma.medicationIntakeEvent.findMany({
          where: {
            userId,
            // v1.7.0 sync — exclude tombstoned rows.
            deletedAt: null,
            medicationId: {
              in: bpMedications.map((medication) => medication.id),
            },
          },
          orderBy: { scheduledFor: "asc" },
          select: {
            medicationId: true,
            scheduledFor: true,
            takenAt: true,
            skipped: true,
          },
        });

  // v1.7.0 SB-SCHED-2 — resolve the user timezone once so the BP-status
  // compliance gate routes its denominator through the canonical engine.
  const userTz = await resolveUserTimezone(userId);

  const medicationCompliance = bpMedications.map((medication) => {
    const eventsForMedication = bpMedicationEvents
      .filter((event) => event.medicationId === medication.id)
      .map((event) => ({
        scheduledFor: event.scheduledFor,
        takenAt: event.takenAt,
        skipped: event.skipped,
      }));

    const medicationContext = buildComplianceMedicationContext(
      medication,
      lastNonSkippedTakenAt(eventsForMedication),
      userTz,
    );
    const compliance7 = calculateCompliance(
      eventsForMedication,
      medication.schedules,
      7,
      medication.createdAt,
      { medicationContext },
    );
    const compliance30 = calculateCompliance(
      eventsForMedication,
      medication.schedules,
      30,
      medication.createdAt,
      { medicationContext },
    );

    return {
      name: sanitizeForPrompt(medication.name),
      dose: sanitizeForPrompt(medication.dose, 50),
      schedulesPerDay: medication.schedules.length,
      compliance7: compliance7.rate,
      compliance30: compliance30.rate,
    };
  });

  const expectedBpIntakesPerDay = bpMedications.reduce(
    (sum, medication) => sum + medication.schedules.length,
    0,
  );
  const takenByDay = new Map<string, number>();
  for (const event of bpMedicationEvents) {
    if (event.skipped || !event.takenAt) continue;
    const dayKey = toBerlinDayKey(event.scheduledFor);
    takenByDay.set(dayKey, (takenByDay.get(dayKey) ?? 0) + 1);
  }

  const continuityVsSystolicSeries = sysSeries.daily.map((point) => {
    // DST-safe: dayOffsetToBerlinDayKey computes calendar days, not 24h ticks.
    const dayKey = dayOffsetToBerlinDayKey(now, point.dayOffset);
    const taken = takenByDay.get(dayKey) ?? 0;
    const continuityPct =
      expectedBpIntakesPerDay > 0
        ? round(Math.min(1, taken / expectedBpIntakesPerDay) * 100, 1)
        : null;
    return {
      day: dayKey,
      dayOffset: point.dayOffset,
      sys: point.value,
      continuityPct,
    };
  });

  // Fetch mood context (optional — for enrichment only). v1.4.28
  // FB-D2 — cap at 90 entries (~3 months) so power users don't pull
  // unbounded rows before the bucket-series budget runs.
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
  // above stay for the correlation pairing + in-target gate; only the
  // graded shape is embedded so the full daily arrays never ship.
  const gradedFromDaily = (buckets: DailyBucket[]) =>
    buildGradedSeriesFromPoints(
      buckets.map((b) => ({
        measuredAt: new Date(dayOffsetToBerlinDayKey(now, b.dayOffset)),
        value: b.value,
      })),
      now,
    );
  // The two BP channels source their recent / weekly slices from a
  // bounded raw read and their monthly / yearly tail from the MONTH /
  // YEAR rollup tier (full-history in-memory fallback on a cold-tier
  // coverage miss). Mood has no rollup tier, so it stays an in-memory fold.
  const [sysGraded, diaGraded] = await Promise.all([
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_SYS", now),
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_DIA", now),
  ]);
  const moodGraded = gradedFromDaily(moodSeries.daily);

  const continuityVsSystolicPairs: PairedPoint[] = continuityVsSystolicSeries
    .map((entry) => {
      if (entry.continuityPct == null) return null;
      const [y, m, d] = entry.day.split("-").map(Number);
      return {
        a: entry.continuityPct,
        b: entry.sys,
        // UTC midnight of the Berlin day — DST-safe (see pairDailyBuckets).
        date: new Date(Date.UTC(y, m - 1, d)),
      };
    })
    .filter((entry): entry is PairedPoint => entry !== null);
  const continuityVsSystolicCorrelation = pearsonCorrelation(
    continuityVsSystolicPairs,
  );

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
    focus: "blood_pressure",
    dataCoverage: {
      totalMeasurements: measurements.length,
      totalSpanDays,
      newestMeasurementDaysAgo,
    },
    bloodPressure: {
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
      paired: {
        summary: summarizeSeries(
          pairedBloodPressure.map((entry) => ({
            value: (entry.sys + entry.dia) / 2,
          })),
        ),
        series: pairedBloodPressure.slice(-CORRELATION_PAIR_CAP),
      },
      targets: bpTargets
        ? {
            systolic: { min: bpTargets.sysLow, max: bpTargets.sysHigh },
            diastolic: { min: bpTargets.diaLow, max: bpTargets.diaHigh },
            inTargetPctLast30DailyPoints: bpInTargetPctLast30DailyPoints,
          }
        : null,
    },
    weightVsSystolic: {
      correlation: weightVsSystolicCorrelation,
      pairs: weightVsSystolicPairs.slice(-CORRELATION_PAIR_CAP).map((entry) => ({
        day: entry.dayKey,
        weight: round(entry.a, 2),
        systolic: round(entry.b, 2),
      })),
    },
    bpMedicationContinuityVsSystolic: {
      expectedIntakesPerDay: expectedBpIntakesPerDay,
      medicationCount: bpMedications.length,
      correlation: continuityVsSystolicCorrelation,
      series: continuityVsSystolicSeries.slice(-CORRELATION_PAIR_CAP),
    },
    bpMedications: medicationCompliance,
    moodContext:
      moodSeries.daily.length >= 3
        ? {
            points: moodSeries.daily.length,
            mean: moodMean,
            latest: moodSeries.daily[0]?.value ?? null,
            series: moodGraded,
            moodVsSystolicCorrelation: (() => {
              const moodVsSysPairs = pairDailyBuckets(
                moodSeries.daily,
                sysSeries.daily,
                now,
              );
              return pearsonCorrelation(moodVsSysPairs);
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
    "blood-pressure-status",
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
    systemPrompt: getBloodPressureSystemPrompt(locale),
    userPrompt: getBloodPressureUserPrompt(
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
      text: getNoKeyBloodPressureStatusText(locale),
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
      stubText: getNoKeyBloodPressureStatusText(locale),
    });
  }

  const summary = normalizeSummaryText(parseSummaryFromContent(outcome.content));
  if (!summary) {
    throw new Error(
      "Blood-pressure-status summary was empty after normalization",
    );
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

export function resolveBloodPressureStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
