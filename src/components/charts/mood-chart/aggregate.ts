/**
 * The mood chart's aggregation: daily mood entries folded to the range tab's
 * grain, pure so the unit tests can pin the exact mean per bucket.
 */
import {
  bucketTimeSeries,
  type ChartBucketType,
} from "@/lib/charts/bucket-time-series";
import { bucketPeriod, pickRangeBucket } from "@/lib/charts/range-grain";
import type { ChartRangePoints } from "@/lib/dashboard/chart-overlay-prefs";

import { dayKeyToTimestamp } from "../health-chart/series-math";

export interface MoodEntryDay {
  date: string; // "YYYY-MM-DD" Berlin
  score: number;
  /** The entries behind the day's score; one when absent. */
  samples?: number;
}

/**
 * The grain for a window of mood entries: the range tab's, through the same
 * `pickRangeBucket` every chart with the range tabs reads (7 and 30 days
 * daily, 90 days weekly, All by the span). `range` defaults to All, where the
 * span of the entries decides. Pure: no DOM/i18n side-effects.
 */
export function pickMoodBucket(
  entries: MoodEntryDay[],
  range: ChartRangePoints = 0,
): ChartBucketType {
  return pickRangeBucket(
    range,
    entries.map((e) => dayKeyToTimestamp(e.date)),
  );
}

export interface MoodBucketPoint {
  timestamp: number;
  score: number;
  /** First and last day a week or month point covers inside the window. */
  periodStart?: number;
  periodEnd?: number;
  /** The entries a week or month point averages. */
  readings?: number;
}

/**
 * Aggregate daily mood entries into the bucket chosen by `pickMoodBucket`.
 * Returns `{ timestamp, score }` rows so the chart can render them
 * without re-formatting; a week or month row also carries the days it
 * covers and the entries behind it. Days/weeks/months without an
 * observation are skipped, never emitted as 0.
 *
 * Pure & deterministic so the unit test can pin the exact aggregated
 * mean per bucket.
 */
export function aggregateMoodEntries(
  entries: MoodEntryDay[],
  /**
   * The calendar the week / month boundaries are drawn in. Required rather
   * than defaulted for the same reason `bucketTimeSeries` requires it: a
   * default would leave a forgotten caller quietly bucketing someone else's
   * evening into the wrong month.
   */
  timeZone: string,
  {
    range = 0,
    period,
  }: {
    range?: ChartRangePoints;
    /** The window's first and last day; defaults to no clip on either end. */
    period?: { firstDay: number | null; lastDay: number };
  } = {},
): {
  bucket: ChartBucketType;
  points: MoodBucketPoint[];
} {
  const bucket = pickMoodBucket(entries, range);
  if (entries.length === 0) return { bucket, points: [] };

  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  if (bucket === "day") {
    return {
      bucket,
      points: sorted.map((entry) => ({
        timestamp: dayKeyToTimestamp(entry.date),
        score: entry.score,
      })),
    };
  }

  const out = bucketTimeSeries(
    sorted.map((entry) => ({
      timestamp: dayKeyToTimestamp(entry.date),
      values: {
        score: entry.score,
        samples:
          typeof entry.samples === "number" && entry.samples > 0
            ? entry.samples
            : 1,
      },
    })),
    { bucket, timeZone },
  );

  return {
    bucket,
    points: out.points.map((point) => {
      const covered = bucketPeriod(
        point.timestamp,
        bucket,
        period ?? { firstDay: null, lastDay: Number.POSITIVE_INFINITY },
      );
      return {
        timestamp: point.timestamp,
        score: point.values.score,
        periodStart: covered.start,
        periodEnd: covered.end,
        readings: point.sums.samples,
      };
    }),
  };
}
