import {
  classifySleepDuration,
  getSleepDurationRange,
} from "@/lib/analytics/classifications";
import { reconstructSleepNights } from "@/lib/analytics/sleep-night";
import { makeRangeClassifier, rollupConsistency } from "./consistency";
import type { TargetItem, TargetSleepStageRow, TargetTrend } from "./types";

interface SleepTargetInput {
  sleepStageRows: TargetSleepStageRow[];
  timezone: string;
  sourcePriorityJson: unknown;
  now: Date;
}

export function buildSleepTarget({
  sleepStageRows,
  timezone,
  sourcePriorityJson,
  now,
}: SleepTargetInput): TargetItem {
  const sleepRange = getSleepDurationRange();
  const nights = reconstructSleepNights(
    sleepStageRows,
    timezone,
    sourcePriorityJson,
  )
    .filter((night) => night.asleepMinutes > 0)
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
  const roundHours = (value: number) => Math.round(value * 100) / 100;
  const sleepEvents = nights.map((night) => ({
    measuredAt: night.measuredAt,
    value: roundHours(night.asleepMinutes / 60),
  }));
  const latestNight = nights.length > 0 ? nights[nights.length - 1] : null;
  const current = latestNight
    ? roundHours(latestNight.asleepMinutes / 60)
    : null;
  const average30 =
    sleepEvents.length > 0
      ? roundHours(
          sleepEvents.reduce((sum, event) => sum + event.value, 0) /
            sleepEvents.length,
        )
      : null;

  let classification: TargetItem["classification"] = null;
  if (current != null) {
    const classified = classifySleepDuration(current);
    classification = {
      category: classified.category,
      color: classified.color,
    };
  }

  let trend: TargetTrend = null;
  if (sleepEvents.length >= 4) {
    const mid = Math.floor(sleepEvents.length / 2);
    const firstHalf = sleepEvents.slice(0, mid);
    const secondHalf = sleepEvents.slice(mid);
    const averageFirst =
      firstHalf.reduce((sum, event) => sum + event.value, 0) / firstHalf.length;
    const averageSecond =
      secondHalf.reduce((sum, event) => sum + event.value, 0) /
      secondHalf.length;
    const difference = averageSecond - averageFirst;
    const threshold = averageFirst * 0.02;
    if (difference > threshold) trend = "up";
    else if (difference < -threshold) trend = "down";
    else trend = "stable";
  }

  return {
    type: "SLEEP_DURATION",
    label: "Sleep duration",
    current,
    average30,
    trend,
    unit: "h",
    range: sleepRange,
    classification,
    source: "AASM/SRS",
    ...rollupConsistency({
      events: sleepEvents,
      classify: makeRangeClassifier(sleepRange),
      timezone,
      now,
    }),
  };
}
