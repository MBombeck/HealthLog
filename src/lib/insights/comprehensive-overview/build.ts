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
import { probeProviderPresence } from "@/lib/ai/provider";
import type { DataSummary } from "@/lib/analytics/trends";
import { summarize } from "@/lib/analytics/trends";
import { getBpTargets } from "@/lib/analytics/bp-targets";
import { computeBpInTargetPct } from "@/lib/analytics/bp-in-target";
import {
  classifyBMI,
  classifyBP,
  generateAlerts,
} from "@/lib/analytics/classifications";
import { annotate } from "@/lib/logging/context";
import { buildComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

import { overviewCorrelations } from "./correlations";
import {
  bpMedicationContinuity,
  readMedicationCompliance,
} from "./medication-compliance";
import { readOverviewMoodSeries } from "./mood-series";
import { readRestingPulseDaily } from "./resting-pulse-daily";

/** Who the overview is computed for: the record, with its zone. */
export interface OverviewRecord {
  id: string;
  timezone?: string | null;
}

export type ComprehensiveOverviewBody = Awaited<
  ReturnType<typeof buildComprehensiveResponse>
>;

/** BMI and the 30-day BP classification against the record's profile. */
function classifyProfile(
  summaries: Record<string, DataSummary>,
  dbUser: { heightCm: number | null; dateOfBirth: Date | null } | null,
) {
  let bmi: number | null = null;
  let bmiClassification = null;
  if (dbUser?.heightCm && summaries.WEIGHT?.latest) {
    const heightM = dbUser.heightCm / 100;
    bmi = Math.round((summaries.WEIGHT.latest / (heightM * heightM)) * 10) / 10;
    bmiClassification = classifyBMI(bmi);
  }

  let bpClassification = null;
  const bpTargets = getBpTargets(dbUser?.dateOfBirth ?? null);
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

export async function buildComprehensiveResponse(user: OverviewRecord) {
  const userId = user.id;
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const userTz = user.timezone || DEFAULT_TIMEZONE;

  // Height + DOB drive BMI + BP targets.
  const dbUser = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      heightCm: true,
      dateOfBirth: true,
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
  const { bmi, bmiClassification, bpClassification, bpTargets } =
    classifyProfile(summaries, dbUser);

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
    medications: medCompliance.map((m) => ({
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
    hasProvider: await probeProviderPresence(userId),
    dataSpanDays,
    totalMeasurements: aggregate.totalMeasurements,
  };
}
