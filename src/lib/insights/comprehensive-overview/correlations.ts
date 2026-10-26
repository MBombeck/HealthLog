/**
 * The overview's correlations: weight × systolic, and mood against
 * systolic, weight and resting pulse. Pure: every series is already read.
 */
import {
  significantPearsonCorrelation,
  type PairedPoint,
} from "@/lib/analytics/correlations";
import type { ComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";

import {
  deriveDailyLocalMeans,
  joinDailyByDay,
  pairMoodWithDaily,
  type DailyValue,
} from "./daily-series";

export function overviewCorrelations(args: {
  aggregate: ComprehensiveAggregate;
  dailyMoodEntries: DailyValue[];
  restingPulseDaily: DailyValue[];
  userTz: string;
}) {
  const { aggregate, dailyMoodEntries, restingPulseDaily, userTz } = args;

  // Weight × Sys BP, daily-key pairing. Both sides come from the UTC
  // `dailyByType` series, so they share one UTC day-key space and are
  // internally consistent; re-keying it to local migrates with the rollup
  // tier.
  const weightDaily = aggregate.dailyByType.WEIGHT ?? [];
  const sysDaily = aggregate.dailyByType.BLOOD_PRESSURE_SYS ?? [];
  const weightBpPairs: PairedPoint[] = joinDailyByDay(weightDaily, sysDaily);
  const weightBpCorrelation = significantPearsonCorrelation(weightBpPairs);
  const scatterData = weightBpPairs.map((p) => ({
    weight: p.a,
    sysBP: p.b,
  }));

  // Mood × {sys BP, weight, pulse}. The mood series is LOCAL-day-keyed and
  // `pairMoodWithDaily` joins on an EXACT YYYY-MM-DD key, so the partners
  // are exact local-day means from the raw rows already on the request path
  // (canonical-source deduped in the aggregator), NOT the UTC `dailyByType` —
  // a UTC-day MEAN cannot be relabeled into a local-day mean.
  const sysDailyLocal = deriveDailyLocalMeans(aggregate.bpRawRows.sys, userTz);
  const weightDailyLocal = deriveDailyLocalMeans(
    aggregate.weightRawRows,
    userTz,
  );

  const moodBpPairs = pairMoodWithDaily(dailyMoodEntries, sysDailyLocal);
  const moodBpCorrelation = significantPearsonCorrelation(moodBpPairs);
  const moodBpScatterData = moodBpPairs.map((p) => ({ mood: p.a, sysBP: p.b }));

  const moodWeightPairs = pairMoodWithDaily(dailyMoodEntries, weightDailyLocal);
  const moodWeightCorrelation = significantPearsonCorrelation(moodWeightPairs);
  const moodWeightScatterData = moodWeightPairs.map((p) => ({
    mood: p.a,
    weight: p.b,
  }));

  const moodPulsePairs = pairMoodWithDaily(dailyMoodEntries, restingPulseDaily);
  const moodPulseCorrelation = significantPearsonCorrelation(moodPulsePairs);
  const moodPulseScatterData = moodPulsePairs.map((p) => ({
    mood: p.a,
    pulse: p.b,
  }));

  return {
    weightBpCorrelation,
    scatterData,
    moodBpCorrelation,
    moodBpScatterData,
    moodWeightCorrelation,
    moodWeightScatterData,
    moodPulseCorrelation,
    moodPulseScatterData,
  };
}
