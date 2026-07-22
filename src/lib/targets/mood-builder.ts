import { makeRangeClassifier, rollupConsistency } from "./consistency";
import type {
  TargetItem,
  TargetMoodEntry,
  TargetMoodRollup,
  TargetTrend,
} from "./types";

interface MoodTargetInput {
  moodRollups: TargetMoodRollup[];
  recentRawMood: TargetMoodEntry[] | null;
  latestMoodEntry: TargetMoodEntry | null;
  timezone: string;
  now: Date;
}

export function buildMoodTargets({
  moodRollups,
  recentRawMood,
  latestMoodEntry,
  timezone,
  now,
}: MoodTargetInput): TargetItem[] {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  let dailyEvents: Array<{ measuredAt: Date; value: number }>;
  let entryCount: number;
  let sumScores: number;
  let varianceCount: number;
  let sumSquares: number;

  if (moodRollups.length > 0) {
    entryCount = moodRollups.reduce((sum, rollup) => sum + rollup.count, 0);
    dailyEvents = moodRollups
      .filter((rollup) => rollup.bucketStart >= thirtyDaysAgo)
      .map((rollup) => ({
        measuredAt: rollup.bucketStart,
        value: rollup.mean,
      }));
    sumScores = dailyEvents.reduce((sum, event) => sum + event.value, 0);
    varianceCount = dailyEvents.length;
    sumSquares = dailyEvents.reduce(
      (sum, event) => sum + event.value * event.value,
      0,
    );
  } else if (latestMoodEntry !== null) {
    const rawMood = recentRawMood ?? [];
    entryCount = rawMood.length;
    dailyEvents = rawMood.map((entry) => ({
      measuredAt: entry.moodLoggedAt,
      value: entry.score,
    }));
    sumScores = rawMood.reduce((sum, entry) => sum + entry.score, 0);
    varianceCount = rawMood.length;
    sumSquares = rawMood.reduce(
      (sum, entry) => sum + entry.score * entry.score,
      0,
    );
  } else {
    entryCount = 0;
    dailyEvents = [];
    sumScores = 0;
    varianceCount = 0;
    sumSquares = 0;
  }

  if (entryCount < 3) return [];

  const current = latestMoodEntry?.score ?? null;
  const average30 =
    dailyEvents.length > 0
      ? Math.round((sumScores / dailyEvents.length) * 10) / 10
      : null;
  let trend: TargetTrend = null;
  if (dailyEvents.length >= 4) {
    const sorted = [...dailyEvents].sort(
      (a, b) => a.measuredAt.getTime() - b.measuredAt.getTime(),
    );
    const mid = Math.floor(sorted.length / 2);
    const firstHalf = sorted.slice(0, mid);
    const secondHalf = sorted.slice(mid);
    const averageFirst =
      firstHalf.reduce((sum, event) => sum + event.value, 0) / firstHalf.length;
    const averageSecond =
      secondHalf.reduce((sum, event) => sum + event.value, 0) /
      secondHalf.length;
    const difference = averageSecond - averageFirst;
    if (difference > 0.2) trend = "up";
    else if (difference < -0.2) trend = "down";
    else trend = "stable";
  }

  const range = { min: 3.5, max: 5 };
  const consistency = rollupConsistency({
    events: dailyEvents,
    classify: makeRangeClassifier(range, { orangeMin: 2, orangeMax: 5 }),
    timezone,
    now,
  });
  const targets: TargetItem[] = [
    {
      type: "MOOD_SCORE",
      label: "Mood",
      current,
      average30,
      trend,
      unit: "/ 5",
      range,
      classification:
        current != null
          ? current >= 3.5
            ? { category: "Good", color: "var(--success)" }
            : current >= 2
              ? { category: "Moderate", color: "var(--dracula-yellow)" }
              : { category: "Low", color: "var(--destructive)" }
          : null,
      source: "moodLog",
      ...consistency,
    },
  ];

  if (varianceCount >= 5) {
    const mean = sumScores / varianceCount;
    const variance = sumSquares / varianceCount - mean * mean;
    const standardDeviation =
      Math.round(Math.sqrt(Math.max(0, variance)) * 100) / 100;
    targets.push({
      type: "MOOD_STABILITY",
      label: "Mood stability",
      current: standardDeviation,
      average30: standardDeviation,
      trend: null,
      unit: "σ",
      range: { min: 0, max: 0.5 },
      classification:
        standardDeviation <= 0.5
          ? { category: "Very stable", color: "var(--success)" }
          : standardDeviation <= 1
            ? { category: "Stable", color: "var(--dracula-yellow)" }
            : { category: "Fluctuating", color: "var(--destructive)" },
      source: "moodLog",
      ...consistency,
    });
  }

  return targets;
}
