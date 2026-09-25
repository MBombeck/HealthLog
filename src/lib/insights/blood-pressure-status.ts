import { prisma } from "@/lib/db";
import {
  getBloodPressureSystemPrompt,
  getBloodPressureUserPrompt,
} from "@/lib/ai/prompts/blood-pressure";
import { openerArchetypeHint } from "@/lib/ai/prompts/opener-archetype";
import type { Locale } from "@/lib/i18n/config";
import {
  formatPreviousContextForPrompt,
  getPreviousInsightContext,
} from "@/lib/insights/memory";
import {
  buildAssessmentContextBlock,
  computeSteadyRun,
  pickVarietyLead,
} from "@/lib/insights/assessment-context";
import { getRelevantCorrelationsForMetric } from "@/lib/insights/metric-correlation-context";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import {
  significantPearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import {
  buildComplianceMedicationContext,
  calculateCompliance,
  expectsDoses,
  lastNonSkippedTakenAt,
  SCHEDULE_COMPLIANCE_SELECT,
} from "@/lib/analytics/compliance";
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
import { buildMetricSignal } from "@/lib/insights/metric-signal";
import {
  type SupportedLocale,
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
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";

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
  tz: string = DEFAULT_TIMEZONE,
): Array<PairedPoint & { dayKey: string }> {
  const mapB = new Map(seriesB.map((entry) => [entry.dayOffset, entry.value]));

  return seriesA
    .map((entry) => {
      const b = mapB.get(entry.dayOffset);
      if (b == null) return null;
      const dayKey = dayOffsetToBerlinDayKey(now, entry.dayOffset, tz);
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

/**
 * Public entry — unchanged signature. Prepares the card then, when the LLM
 * is still needed, runs ONE completion through the shared single-card path
 * (v1.18.7 HIGH-1). One-call-per-metric behaviour and the fallbacks are
 * preserved.
 */
export async function generateBloodPressureStatusForUser(
  userId: string,
  options?: {
    locale?: string | null;
    force?: boolean;
    readOnly?: boolean;
  },
): Promise<{
  hasProvider: boolean;
  text: string | null;
  cached: boolean;
  updatedAt: string | null;
  preparing?: boolean;
  revalidating?: boolean;
}> {
  const prepared = await prepareBloodPressureStatusForUser(userId, options);
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

/**
 * v1.18.7 (HIGH-1) — everything up to (not including) the provider call.
 * See `status-card-generation.ts` for the prepare/run/finalize contract.
 */
export async function prepareBloodPressureStatusForUser(
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
  const cacheAction = statusCacheAction("blood-pressure", locale);
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
      metric: "blood-pressure",
      locale,
    });
    // Unavailable for any reason serves the deterministic line and enqueues
    // nothing. `hasProvider` is provider presence only.
    if (outcome.kind === "unavailable") {
      return {
        phase: "served",
        result: {
          hasProvider: outcome.hasProvider,
          text: getNoKeyBloodPressureStatusText(locale),
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

  // v1.7.0 SB-SCHED-2 / v1.2.5 (M-TZ3) — BOTH the BP-status compliance gate
  // AND every day-bucketing pass below (applyPayloadBudget, pairDailyBuckets,
  // the continuity series) key on the user's own calendar day, not Berlin's.
  // `userTz` was already resolved above for the cache day-key.

  const weightSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "WEIGHT")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now, tz: userTz },
  );

  const sysSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_SYS")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now, tz: userTz },
  );

  const diaSeries = applyPayloadBudget(
    measurements
      .filter((measurement) => measurement.type === "BLOOD_PRESSURE_DIA")
      .map((measurement) => ({
        measuredAt: measurement.measuredAt,
        value: measurement.value,
      })),
    { now, tz: userTz },
  );

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);
  const pairedBloodPressure = pairDailyBuckets(
    sysSeries.daily,
    diaSeries.daily,
    now,
    userTz,
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
    userTz,
  );
  const weightVsSystolicCorrelation = significantPearsonCorrelation(
    weightVsSystolicPairs,
  );

  const activeMedicationRows = await prisma.medication.findMany({
    // v1.16.11 — as-needed (PRN) medications never feed the BP-status
    // compliance gate (no expected doses, no rate).
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    // v1.15.20 — schedules through the shared compliance select so the
    // configured per-dose windows reach this surface like every other.
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: { validFrom: "asc" } },
      // v1.25 H-MED1 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
    },
  });

  // A medication with no schedule expects no dose, and `calculateCompliance`
  // answers 100 % for that case. The `asNeeded: false` filter above catches
  // only the PRN arm; the empty schedule is reachable on a scheduled
  // medication and would otherwise report perfect adherence.
  const activeMedications = activeMedicationRows.filter(expectsDoses);

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
            // v1.12.7 — bound to the ~365-day window the continuity series
            // and the 7/30-day compliance gate consume; this read was
            // otherwise unbounded over all intake history.
            scheduledFor: {
              gte: new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000),
            },
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
    // Key on the user's own calendar day so the continuity tally aligns
    // with the user-tz day keys the systolic series is bucketed under.
    const dayKey = userDayKey(event.scheduledFor, userTz);
    takenByDay.set(dayKey, (takenByDay.get(dayKey) ?? 0) + 1);
  }

  const continuityVsSystolicSeries = sysSeries.daily.map((point) => {
    // DST-safe: dayOffsetToBerlinDayKey computes calendar days, not 24h ticks.
    const dayKey = dayOffsetToBerlinDayKey(now, point.dayOffset, userTz);
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
    { now, tz: userTz },
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
        measuredAt: new Date(dayOffsetToBerlinDayKey(now, b.dayOffset, userTz)),
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
  const continuityVsSystolicCorrelation = significantPearsonCorrelation(
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

  // v1.18.10 (HIGH-4) — hand the model the finished recent-vs-baseline
  // comparison + normal-swing verdict per channel instead of asking it to
  // derive them. BP needs two signals; the user's own targets are the coarse
  // band anchor when present.
  const sysSignal = buildMetricSignal({
    metric: locale === "en" ? "your systolic" : "deine Systole",
    unit: "mmHg",
    direction: "lower-better",
    graded: sysGraded,
    normalRange: bpTargets
      ? { low: bpTargets.sysLow, high: bpTargets.sysHigh }
      : null,
    newestDaysAgo: newestMeasurementDaysAgo,
  });
  const diaSignal = buildMetricSignal({
    metric: locale === "en" ? "your diastolic" : "deine Diastole",
    unit: "mmHg",
    direction: "lower-better",
    graded: diaGraded,
    normalRange: bpTargets
      ? { low: bpTargets.diaLow, high: bpTargets.diaHigh }
      : null,
    newestDaysAgo: newestMeasurementDaysAgo,
  });

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
        ...(sysSignal ? { signal: sysSignal } : {}),
        summary: summarizeSeries(
          sysSeries.daily.map((bucket) => ({ value: bucket.value })),
        ),
        series: sysGraded,
      },
      diastolic: {
        ...(diaSignal ? { signal: diaSignal } : {}),
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
      pairs: weightVsSystolicPairs
        .slice(-CORRELATION_PAIR_CAP)
        .map((entry) => ({
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
                userTz,
              );
              return significantPearsonCorrelation(moodVsSysPairs);
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

  // v1.12.7 — same diversity / anti-repetition block the archetype cards
  // carry, now threaded into this headline card. Pure formatting of
  // already-computed data; the correlation fetch is best-effort and resolves
  // to no block on failure, never a generation failure.
  const varietyLead = pickVarietyLead(userId, "blood-pressure", todayKey);
  const steadyRun = computeSteadyRun(sysGraded.weekly, sysGraded.monthly);
  const relations = await getRelevantCorrelationsForMetric(
    userId,
    "BLOOD_PRESSURE_SYS",
    locale,
  );
  const assessmentContextBlock = buildAssessmentContextBlock(
    {
      varietyLead,
      dataStrength: {
        points: sysSeries.daily.length,
        newestDaysAgo: newestMeasurementDaysAgo,
      },
      repeatCount: steadyRun,
      relations,
    },
    locale,
  );

  // The provider call is deferred to the caller — single-card path runs ONE
  // completion; the batch path folds this prompt into one shared call.
  return {
    phase: "pending",
    metric: "blood-pressure",
    userId,
    cacheAction,
    systemPrompt: getBloodPressureSystemPrompt(locale),
    userPrompt: getBloodPressureUserPrompt(
      snapshotJson,
      todayKey,
      locale,
      previousContextBlock,
      assessmentContextBlock,
      // v1.28.40 — rotating opener hint, per (user, metric, day); activates the
      // base prompt's verdict-first opener branch on the per-metric card.
      openerArchetypeHint(
        `${userId}:blood-pressure:${todayKey}`,
        locale as Locale,
      ),
    ),
    snapshotHash,
    // v1.12.7 — match the archetype cards' 0.45: more cadence entropy while
    // FACTS stay pinned by the snapshot + the forbidden-phrase guards.
    temperature: 0.45,
    noProvider: {
      hasProvider: false,
      text: getNoKeyBloodPressureStatusText(locale, sysSignal),
      cached: true,
      updatedAt: null,
    },
    timeout: (reason): StatusCardResult =>
      returnTimeoutFallback({
        cacheAction,
        reason,
        userId,
        todayKey,
        stubText: getNoKeyBloodPressureStatusText(locale, sysSignal),
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
          stubText: getNoKeyBloodPressureStatusText(locale, sysSignal),
        });
      }
      const summary = screened.text;
      if (!summary) {
        throw new Error(
          "Blood-pressure-status summary was empty after normalization",
        );
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

export function resolveBloodPressureStatusLocale(
  locale: string | null | undefined,
): SupportedLocale {
  return normalizeLocale(locale);
}
