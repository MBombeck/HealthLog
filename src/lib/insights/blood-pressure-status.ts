import { prisma } from "@/lib/db";
import { readRecentMoodScores } from "@/lib/mood/recent-scores";
import {
  getBloodPressureSystemPrompt,
  getBloodPressureUserPrompt,
} from "@/lib/ai/prompts/blood-pressure";
import { computeSteadyRun } from "@/lib/insights/assessment-context";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { isBpReadingInTarget } from "@/lib/analytics/bp-in-target";
import {
  significantPearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import {
  buildComplianceMedicationContext,
  COURSES_COMPLIANCE_SELECT,
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
  dayOffsetToDayKey,
  type DailyBucket,
} from "@/lib/insights/bucket-series";
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
import { userDayKey } from "@/lib/tz/resolver";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { TRACKED_INTAKE_WHERE } from "@/lib/medications/intake-tracking";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";

/**
 * Cap on the embedded correlation / paired-daily arrays. The Pearson
 * coefficients stay computed over the full overlap; only the row-by-row
 * lists the prompt carries are trimmed to their most recent entries.
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
      // UTC midnight of the user's day: an ordering handle only; `dayKey`
      // is the day itself.
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
  options?: StatusCardOptions,
): Promise<StatusTextResult> {
  const prepared = await prepareBloodPressureStatusForUser(userId, options);
  return (await runPreparedStatusCard(prepared)) as StatusTextResult;
}

/**
 * Everything up to (not including) the provider call, through the shared
 * status pipeline (`status-pipeline.ts`); this card supplies its snapshot.
 */
export function prepareBloodPressureStatusForUser(
  userId: string,
  options?: StatusCardOptions,
): Promise<PreparedStatusCard> {
  return prepareStatusCard(BLOOD_PRESSURE_STATUS_CARD, userId, options);
}

/**
 * The blood-pressure snapshot: both channels against the person's targets,
 * weight against systolic, BP-medication adherence against systolic, and
 * mood context.
 */
async function buildBloodPressureSnapshot(
  ctx: StatusCardContext,
): Promise<StatusCardBuild<undefined>> {
  const { userId, locale, userTz, todayKey } = ctx;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      dateOfBirth: true,
    },
  });

  const { measurements, now, weightSeries, sysSeries, diaSeries } =
    await readBpChannels(userId, userTz);

  const bpTargets = getBpTargets(user?.dateOfBirth ?? null);
  const { pairedBloodPressure, bpInTargetPctLast30DailyPoints } =
    pairBloodPressure(sysSeries.daily, diaSeries.daily, bpTargets, now, userTz);

  const weightVsSystolicPairs = pairDailyBuckets(
    weightSeries.daily,
    sysSeries.daily,
    now,
    userTz,
  );
  const weightVsSystolicCorrelation = significantPearsonCorrelation(
    weightVsSystolicPairs,
  );

  const medicationContext = await readBpMedicationContext(
    userId,
    now,
    userTz,
    sysSeries.daily,
  );

  const { moodSeries, moodMean, moodGraded } = await readBpMoodContext(
    userId,
    now,
    userTz,
  );

  // The two BP channels source their recent / weekly slices from a
  // bounded raw read and their monthly / yearly tail from the MONTH /
  // YEAR rollup tier (full-history in-memory fallback on a cold-tier
  // coverage miss). Mood has no rollup tier, so it stays an in-memory fold.
  const [sysGraded, diaGraded] = await Promise.all([
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_SYS", now, userTz),
    buildGradedSeriesWithRollups(userId, "BLOOD_PRESSURE_DIA", now, userTz),
  ]);

  const { totalSpanDays, newestDaysAgo: newestMeasurementDaysAgo } =
    coverageSpan(
      measurements.length > 0 ? measurements[0].measuredAt : null,
      measurements.length > 0
        ? measurements[measurements.length - 1].measuredAt
        : null,
    );

  // v1.18.10 — hand the model the finished recent-vs-baseline
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
      expectedIntakesPerDay: medicationContext.expectedIntakesPerDay,
      medicationCount: medicationContext.medicationCount,
      correlation: medicationContext.continuityVsSystolicCorrelation,
      series:
        medicationContext.continuityVsSystolicSeries.slice(
          -CORRELATION_PAIR_CAP,
        ),
    },
    bpMedications: medicationContext.medicationCompliance,
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

  return {
    snapshot,
    finish: () => ({
      context: {
        repeatCount: computeSteadyRun(sysGraded.weekly, sysGraded.monthly),
        points: sysSeries.daily.length,
        newestDaysAgo: newestMeasurementDaysAgo,
        relationsFor: "BLOOD_PRESSURE_SYS",
      },
      fallbackText: getNoKeyBloodPressureStatusText(locale, sysSignal),
      prompts: (snapshotJson, context) => ({
        systemPrompt: getBloodPressureSystemPrompt(locale),
        userPrompt: getBloodPressureUserPrompt(
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
 * Weight and the two BP channels, read once and bucketed per user-local day.
 */
async function readBpChannels(userId: string, userTz: string) {
  // v1.4.28 — cap the snapshot input. The downstream
  // `applyPayloadBudget` trims further; this `take` keeps the read
  // bounded for Apple-Health-rich accounts. BP captures three types
  // per reading day so 1095 = 365 d × 3 channels.
  const measurements = await prisma.measurement
    .findMany({
      where: {
        userId,
        deletedAt: null,
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

  // v1.7.0 v1.2.5 — BOTH the BP-status compliance gate
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

  return { measurements, now, weightSeries, sysSeries, diaSeries };
}

/**
 * Systolic paired with diastolic per day, each day judged against the
 * person's targets, and the share of paired days in target.
 */
function pairBloodPressure(
  sysDaily: DailyBucket[],
  diaDaily: DailyBucket[],
  bpTargets: ReturnType<typeof getBpTargets>,
  now: Date,
  userTz: string,
) {
  const pairedBloodPressure = pairDailyBuckets(
    sysDaily,
    diaDaily,
    now,
    userTz,
  ).map((entry) => ({
    day: entry.dayKey,
    sys: entry.a,
    dia: entry.b,
    inTarget:
      bpTargets == null
        ? null
        : // v1.4.16 — one-sided "at or below ceiling" semantics with a
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

  return { pairedBloodPressure, bpInTargetPctLast30DailyPoints };
}

/** The mood context: daily buckets, their mean, and the graded series. */
async function readBpMoodContext(userId: string, now: Date, userTz: string) {
  // Fetch mood context (optional — for enrichment only). v1.4.28
  // Cap at 90 entries (~3 months) so power users don't pull
  // unbounded rows before the bucket-series budget runs.
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
  // above stay for the correlation pairing + in-target gate; only the
  // graded shape is embedded so the full daily arrays never ship.
  const gradedFromDaily = (buckets: DailyBucket[]) =>
    buildGradedSeriesFromPoints(
      buckets.map((b) => ({
        measuredAt: canonicalDailyTimestamp(
          dayOffsetToDayKey(now, b.dayOffset, userTz),
          userTz,
        ),
        value: b.value,
      })),
      now,
      userTz,
    );
  const moodGraded = gradedFromDaily(moodSeries.daily);
  return { moodSeries, moodMean, moodGraded };
}

/**
 * The active, scheduled BP medications with their 7- and 30-day compliance,
 * and the per-day intake continuity against the systolic series with its
 * significance-gated correlation.
 */
async function readBpMedicationContext(
  userId: string,
  now: Date,
  userTz: string,
  sysDaily: DailyBucket[],
) {
  const activeMedicationRows = await prisma.medication.findMany({
    // v1.16.11 — as-needed (PRN) medications never feed the BP-status
    // compliance gate (no expected doses, no rate).
    where: { userId, active: true, asNeeded: false, ...TRACKED_INTAKE_WHERE },
    // v1.15.20 — schedules through the shared compliance select so the
    // configured per-dose windows reach this surface like every other.
    include: {
      schedules: { select: SCHEDULE_COMPLIANCE_SELECT },
      // v1.16.3 — archived schedule eras for era-aware compliance.
      scheduleRevisions: { orderBy: [{ validFrom: "asc" }, { id: "asc" }] },
      // v1.25 — pause eras so paused days drop out of the denominator.
      pauseEras: { select: { pausedAt: true, resumedAt: true } },
      // v1.40 (#1024) — the courses, so a gap between two expects nothing.
      courses: COURSES_COMPLIANCE_SELECT,
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
          orderBy: [{ scheduledFor: "asc" }, { id: "asc" }],
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

  const continuityVsSystolicSeries = sysDaily.map((point) => {
    // DST-safe: dayOffsetToDayKey computes calendar days, not 24h ticks.
    const dayKey = dayOffsetToDayKey(now, point.dayOffset, userTz);
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

  return {
    medicationCompliance,
    expectedIntakesPerDay: expectedBpIntakesPerDay,
    medicationCount: bpMedications.length,
    continuityVsSystolicSeries,
    continuityVsSystolicCorrelation,
  };
}

const BLOOD_PRESSURE_STATUS_CARD: StatusCardPlugin<
  StatusTextResult,
  undefined
> = {
  scope: "blood-pressure",
  codec: textStatusCodec,
  unavailableText: (locale) => getNoKeyBloodPressureStatusText(locale),
  emptyMessage: "Blood-pressure-status summary was empty after normalization",
  build: buildBloodPressureSnapshot,
};
