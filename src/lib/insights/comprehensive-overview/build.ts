/**
 * The Insights overview's response body, computed from the record.
 *
 * SQL-side aggregates served by `buildComprehensiveAggregate` replace the
 * 100k-row-in-JS aggregation the route once ran; the medication-compliance
 * block keeps its bounded Prisma reads (medications + intake events). No
 * provider is called anywhere on the path: `hasProvider` is the presence
 * probe only.
 *
 * Every day-bucketing pass (resting-pulse proxy, medication continuity, BP
 * pairing) shares the one per-user tz resolved here.
 */
import { prisma } from "@/lib/db";
import { pregnancyContextActive } from "@/lib/cycle/pregnancy-context";
import { probeProviderPresence } from "@/lib/ai/provider";
import type { DataSummary } from "@/lib/analytics/trends";
import { summarize } from "@/lib/analytics/trends";
import { resolveEffectiveBpTargets } from "@/lib/analytics/effective-range";
import { computeBpInTargetPct } from "@/lib/analytics/bp-in-target";
import {
  bmiOf,
  classifyBMI,
  classifyBP,
  generateAlerts,
} from "@/lib/analytics/classifications";
import { annotate } from "@/lib/logging/context";
import { buildComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { summarizeNights } from "@/lib/analytics/sleep-night";
import { readSleepNights } from "@/lib/measurements/list/sleep-nights";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";

import { overviewCorrelations } from "./correlations";
import {
  bpMedicationContinuity,
  readMedicationCompliance,
} from "./medication-compliance";
import { readOverviewMoodSeries } from "./mood-series";
import { readRestingPulseDaily } from "./resting-pulse-daily";
import { roundTo } from "@/lib/stats/central";

/** Who the overview is computed for: the record, with its zone. */
export interface OverviewRecord {
  id: string;
  timezone?: string | null;
}

export type ComprehensiveOverviewBody = Awaited<
  ReturnType<typeof buildComprehensiveResponse>
>;

/**
 * BMI, the 30-day BP classification, and the BP band: the person's own target
 * where one is set, the age default otherwise.
 */
function classifyProfile(
  summaries: Record<string, DataSummary>,
  dbUser: {
    heightCm: number | null;
    dateOfBirth: Date | null;
    gender: string | null;
    thresholdsJson: unknown;
  } | null,
  pregnancy: boolean,
) {
  let bmi: number | null = null;
  let bmiClassification = null;
  // During a pregnancy or its postpartum weeks weight is data, not a BMI
  // category (`pregnancyContextActive`), and no alert grades it either.
  if (dbUser?.heightCm && summaries.WEIGHT?.latest && !pregnancy) {
    bmi = roundTo(bmiOf(summaries.WEIGHT.latest, dbUser.heightCm), 1);
    bmiClassification = classifyBMI(bmi);
  }

  let bpClassification = null;
  const bpTargets = dbUser
    ? resolveEffectiveBpTargets(dbUser, dbUser.thresholdsJson)
    : null;
  if (
    summaries.BLOOD_PRESSURE_SYS?.avg30 &&
    summaries.BLOOD_PRESSURE_DIA?.avg30
  ) {
    bpClassification = classifyBP(
      summaries.BLOOD_PRESSURE_SYS.avg30,
      summaries.BLOOD_PRESSURE_DIA.avg30,
    );
  }
  return { bmi, bmiClassification, bpClassification, bpTargets };
}

/** No 90-day window holds this many nights; the read is uncapped in practice. */
const WINDOW_NIGHTS = 1000;

/**
 * Sleep over the window, one point per night.
 *
 * `SLEEP_DURATION` is stored one row per stage (and one per segment) of a
 * night, so the aggregator's per-type summary averages stage rows: an awake
 * spell of half a minute is a "reading", `latest` is the last stage, and
 * `avg30` is a few minutes. The night here is the one every other sleep
 * surface reads (`reconstructSleepNights`: the night's sessions, one source
 * per night on the source ladder, time asleep), so the overview's count,
 * latest, range, mean, median, windowed means and slopes are nights.
 */
async function summarizeWindowNights(
  userId: string,
  tz: string,
  since: Date,
  now: Date,
): Promise<DataSummary> {
  const nights = await readSleepNights(
    userId,
    tz,
    await loadUserSourcePriority(userId),
    { from: since, to: now, maxNights: WINDOW_NIGHTS },
  );
  const { summary } = summarizeNights(nights);
  // The 90-day window holds no night from a year ago.
  return { ...summary, avg30LastYear: null };
}

export async function buildComprehensiveResponse(user: OverviewRecord) {
  const userId = user.id;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const userTz = user.timezone || DEFAULT_TIMEZONE;

  // Height drives BMI; the BP band is the own target or the age default.
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
      gender: true,
      thresholdsJson: true,
      timezone: true,
    },
  });

  // SQL-side rollup: per-type DataSummary identical to the JS `summarize()`
  // semantics over the 90-day window, plus the bounded raw rows the BP target
  // adherence pairing needs, plus daily-mean buckets for the correlations.
  const aggregate = await buildComprehensiveAggregate(userId);

  const { dailyMoodEntries, moodDataPoints, moodEntryCount } =
    await readOverviewMoodSeries(userId, ninetyDaysAgo);
  const moodSummary =
    moodDataPoints.length > 0 ? summarize(moodDataPoints) : null;

  const summaries: Record<string, DataSummary> = aggregate.summaries;
  if (summaries.SLEEP_DURATION) {
    summaries.SLEEP_DURATION = await summarizeWindowNights(
      userId,
      userTz,
      ninetyDaysAgo,
      new Date(),
    );
  }
  const { bmi, bmiClassification, bpClassification, bpTargets } =
    classifyProfile(
      summaries,
      dbUser,
      await pregnancyContextActive(prisma, userId, userTz),
    );

  // BP target adherence over the trailing 90 days, through the canonical
  // `computeBpInTargetPct` so this figure shares ONE definition with the
  // dashboard tile, the insight cards, the AI snapshot and the targets
  // endpoint. The helper pairs sys+dia on the 5-minute window with the
  // same-local-day fallback (keyed on the user's OWN tz) and keeps the
  // ESH-2023 band + 90/50 hypotension floor. Window is the aggregator's
  // 90-day raw pull — a "recent control" figure, not the all-time headline.
  let bpPctInTarget: number | null = null;
  if (bpTargets) {
    bpPctInTarget =
      computeBpInTargetPct(
        aggregate.bpRawRows.sys,
        aggregate.bpRawRows.dia,
        bpTargets,
        userTz,
      )?.pct ?? null;
  }

  const restingPulseDaily = await readRestingPulseDaily(
    userId,
    ninetyDaysAgo,
    userTz,
  );
  const sysDaily = aggregate.dailyByType.BLOOD_PRESSURE_SYS ?? [];
  const correlations = overviewCorrelations({
    aggregate,
    dailyMoodEntries,
    restingPulseDaily,
    userTz,
  });

  const { medications, medCompliance, bpMedications, bpMedicationEvents } =
    await readMedicationCompliance({
      userId,
      since: ninetyDaysAgo,
      timezone: user.timezone || DEFAULT_TIMEZONE,
    });
  const { bpMedicationCorrelation, bpMedicationScatterData } =
    bpMedicationContinuity({ bpMedications, bpMedicationEvents, sysDaily });

  const alerts = generateAlerts({
    bmi,
    bpAvgSys: summaries.BLOOD_PRESSURE_SYS?.avg30 ?? null,
    bpAvgDia: summaries.BLOOD_PRESSURE_DIA?.avg30 ?? null,
    bpPctInTarget,
    weightSlope30: summaries.WEIGHT?.slope30?.slope ?? null,
    pulseAvg30: summaries.PULSE?.avg30 ?? null,
    pulseAnomalyCount: summaries.PULSE?.anomalyCount ?? 0,
    // A medication with no dose to score yet gets no adherence alert: "100 %
    // over the last 7 days, keep it up" for a dose never due is a claim
    // without data.
    medications: medCompliance
      .filter((m) => m.taken7 + m.missed7 > 0)
      .map((m) => ({
        name: m.name,
        compliance7: m.compliance7,
        compliance30: m.compliance30,
      })),
  });

  // Data span — derived from the earliest 90-day measurement.
  const dataSpanDays = aggregate.firstMeasurementAt
    ? Math.ceil(
        (Date.now() - aggregate.firstMeasurementAt.getTime()) /
          (24 * 60 * 60 * 1000),
      )
    : 0;

  annotate({
    action: { name: "insights.comprehensive" },
    meta: {
      totalMeasurements: aggregate.totalMeasurements,
      moodEntries: moodEntryCount,
      medications: medications.length,
    },
  });

  return {
    summaries,
    bmi,
    bmiClassification,
    bpClassification,
    bpPctInTarget,
    bpTargets,
    weightBpCorrelation: correlations.weightBpCorrelation,
    scatterData: correlations.scatterData,
    bpMedicationCorrelation,
    bpMedicationScatterData,
    moodSummary,
    moodBpCorrelation: correlations.moodBpCorrelation,
    moodBpScatterData: correlations.moodBpScatterData,
    moodWeightCorrelation: correlations.moodWeightCorrelation,
    moodWeightScatterData: correlations.moodWeightScatterData,
    moodPulseCorrelation: correlations.moodPulseCorrelation,
    moodPulseScatterData: correlations.moodPulseScatterData,
    medications: medCompliance,
    alerts,
    // Presence only: no client is built and no token is refreshed on a read.
    hasProvider: await probeProviderPresence(userId, "text", "briefing"),
    dataSpanDays,
    totalMeasurements: aggregate.totalMeasurements,
  };
}
