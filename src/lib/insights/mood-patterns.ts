/**
 * Distribution / rhythm calculators for the mood surface: in-target
 * share, discrete-level distribution, weekday averages, the tz-aware
 * time-of-day pattern, and the day-to-day stability score.
 *
 * Extracted verbatim from `mood-aggregates.ts`, which re-exports this
 * module so every existing call site keeps importing from the hub.
 * Everything here is a pure function over already-bucketed daily points
 * or raw mood rows; the DB read + orchestration stay in the hub's
 * `fetchMoodAggregates`.
 */

import { dayOffsetToDayKey } from "@/lib/insights/bucket-series";
import { MOOD_GREEN_MAX, MOOD_GREEN_MIN } from "@/lib/insights/mood-bands";
import type {
  DailyPoint,
  MoodAggregateEntry,
} from "@/lib/insights/mood-aggregates";
import { round } from "@/lib/insights/status-shared";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";
import { wallClockInTz } from "@/lib/tz/wall-clock";
import { READING_SPREAD, standardDeviation } from "@/lib/stats/spread";

// --- In-target % over the last 30 daily points (lifted from mood-status) ---

/**
 * Share (0..100) of the newest 30 daily mood buckets that land in the
 * green band (>= 3.5). Returns null when there is no recent data.
 */
export function computeInTargetPct(daily: DailyPoint[]): number | null {
  const recent = daily.filter((bucket) => bucket.dayOffset < 30);
  if (recent.length === 0) return null;
  const inTarget = recent.filter(
    (entry) => entry.value >= MOOD_GREEN_MIN && entry.value <= MOOD_GREEN_MAX,
  ).length;
  return round((inTarget / recent.length) * 100, 1);
}

// --- Mood distribution (share per discrete level) ---

export interface DistributionRow {
  /** Rounded mood level 1..5. */
  score: number;
  count: number;
}

/**
 * Distribution of daily-mean mood across the five discrete levels.
 *
 * Open product question #2 (design §7) resolves to the daily-mean
 * convention used everywhere else on the surface: each day contributes
 * one observation, its mean rounded to the nearest level. This keeps
 * multi-entry days from over-weighting the histogram and matches the
 * heatmap (one cell per day).
 */
export function computeDistribution(daily: DailyPoint[]): DistributionRow[] {
  const counts = new Map<number, number>();
  for (const bucket of daily) {
    const level = Math.min(5, Math.max(1, Math.round(bucket.value)));
    counts.set(level, (counts.get(level) ?? 0) + 1);
  }
  const rows: DistributionRow[] = [];
  for (let score = 1; score <= 5; score++) {
    rows.push({ score, count: counts.get(score) ?? 0 });
  }
  return rows;
}

// --- Average mood by weekday ---

export interface WeekdayRow {
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  avgScore: number | null;
  count: number;
}

/**
 * Average daily-mean mood grouped by weekday (Monday = 0). The weekday
 * is read off the day-key in UTC so it matches the heatmap's UTC-anchored
 * Monday alignment (`compliance-heatmap` reads `getUTCDay`).
 */
export function computeWeekdayAverages(
  daily: DailyPoint[],
  now: Date,
  tz: string = DEFAULT_TIMEZONE,
): WeekdayRow[] {
  const sums = new Map<number, { sum: number; count: number }>();
  for (const bucket of daily) {
    const dayKey = dayOffsetToDayKey(now, bucket.dayOffset, tz);
    const d = new Date(dayKey + "T00:00:00Z");
    const weekday = (d.getUTCDay() + 6) % 7; // Monday = 0
    const cur = sums.get(weekday) ?? { sum: 0, count: 0 };
    cur.sum += bucket.value;
    cur.count += 1;
    sums.set(weekday, cur);
  }
  const rows: WeekdayRow[] = [];
  for (let weekday = 0; weekday < 7; weekday++) {
    const agg = sums.get(weekday);
    rows.push({
      weekday,
      avgScore: agg ? round(agg.sum / agg.count, 2) : null,
      count: agg?.count ?? 0,
    });
  }
  return rows;
}

// --- Time-of-day pattern (tz-aware part-of-day buckets) ---

/** Part-of-day bucket key. Order is morning → night for stable rendering. */
export type TimeOfDayBucket = "morning" | "afternoon" | "evening" | "night";

/** Ordered bucket list — drives both the chart x-axis and the iteration. */
export const TIME_OF_DAY_BUCKETS: readonly TimeOfDayBucket[] = [
  "morning",
  "afternoon",
  "evening",
  "night",
] as const;

/**
 * Minimum entries a single bucket must hold before it counts toward the
 * pattern. A lone log in a bucket is noise, not a daypart preference.
 */
export const TIME_OF_DAY_MIN_BUCKET_SAMPLES = 3;

/**
 * Minimum distinct populated buckets (each at or above the per-bucket
 * sample floor) before the pattern surfaces at all. The guard against the
 * once-a-day logger: a nightly Telegram check-in clusters in a single
 * bucket, which can never clear a two-bucket spread, so the "you feel
 * best in the morning" takeaway never fires misleadingly.
 */
export const TIME_OF_DAY_MIN_SPREAD = 2;

/**
 * Map a local hour-of-day (0..23) to its part-of-day bucket.
 *
 * morning 05:00–11:59, afternoon 12:00–16:59, evening 17:00–20:59,
 * night 21:00–04:59. The boundaries follow the common Daylio / consumer
 * convention; night wraps midnight so a 02:00 log lands in `night`.
 */
export function bucketForHour(hour: number): TimeOfDayBucket {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

export interface TimeOfDayRow {
  bucket: TimeOfDayBucket;
  avgScore: number | null;
  count: number;
}

export interface TimeOfDayPattern {
  /** All four buckets, in canonical order; unpopulated buckets carry null. */
  buckets: TimeOfDayRow[];
  /**
   * Whether the spread + sample floors are cleared — i.e. the pattern is
   * trustworthy enough to surface a chart and a takeaway. False for the
   * once-a-day logger (everything in one bucket) or a sparse history.
   */
  reliable: boolean;
  /** Best / worst bucket keys when `reliable`; null otherwise. */
  best: TimeOfDayBucket | null;
  worst: TimeOfDayBucket | null;
}

/**
 * Average mood per part of day, bucketed in each entry's own timezone.
 *
 * `moodLoggedAt` carries the exact instant; `tz` (per-row IANA) anchors
 * the local hour. Legacy rows without a `tz` fall back to UTC — the same
 * convention the rollup tier uses for `tz IS NULL` mood rows. Every entry
 * (not the daily mean) feeds its bucket, because the question is "what
 * time of day do I feel best", which a daily collapse would erase.
 *
 * The `reliable` flag is the once-a-day-logger guard: it only trips when
 * at least `TIME_OF_DAY_MIN_SPREAD` buckets each carry
 * `TIME_OF_DAY_MIN_BUCKET_SAMPLES` entries. `best`/`worst` are computed
 * over the populated-and-sufficient buckets only.
 */
export function computeTimeOfDayAverages(
  entries: MoodAggregateEntry[],
): TimeOfDayPattern {
  const sums = new Map<TimeOfDayBucket, { sum: number; count: number }>();
  for (const entry of entries) {
    const tz = entry.tz ?? "UTC";
    const { hour } = wallClockInTz(entry.moodLoggedAt, tz);
    const bucket = bucketForHour(hour);
    const cur = sums.get(bucket) ?? { sum: 0, count: 0 };
    cur.sum += entry.score;
    cur.count += 1;
    sums.set(bucket, cur);
  }

  const buckets: TimeOfDayRow[] = TIME_OF_DAY_BUCKETS.map((bucket) => {
    const agg = sums.get(bucket);
    return {
      bucket,
      avgScore: agg ? round(agg.sum / agg.count, 2) : null,
      count: agg?.count ?? 0,
    };
  });

  const sufficient = buckets.filter(
    (row): row is TimeOfDayRow & { avgScore: number } =>
      row.avgScore != null && row.count >= TIME_OF_DAY_MIN_BUCKET_SAMPLES,
  );
  const reliable = sufficient.length >= TIME_OF_DAY_MIN_SPREAD;

  let best: TimeOfDayBucket | null = null;
  let worst: TimeOfDayBucket | null = null;
  if (reliable) {
    let bestRow = sufficient[0];
    let worstRow = sufficient[0];
    for (const row of sufficient) {
      if (row.avgScore > bestRow.avgScore) bestRow = row;
      if (row.avgScore < worstRow.avgScore) worstRow = row;
    }
    best = bestRow.bucket;
    worst = worstRow.bucket;
  }

  return { buckets, reliable, best, worst };
}

// --- Mood stability score (variance of daily means → 0..100) ---

/**
 * Minimum distinct daily points before a stability score is computed. A
 * handful of days has no meaningful variance signal, so a sparse logger
 * gets `null` (no tile, no sentence) rather than a noisy number.
 */
export const STABILITY_MIN_DAYS = 7;

/**
 * The full-scale standard deviation that maps to a 0 stability score. The
 * mood scale spans 1..5, so the widest day-to-day swing is 4 points; a
 * population SD at or above this is treated as maximally unstable. Below
 * it, the score scales linearly toward 100 (perfectly steady).
 */
export const STABILITY_SD_FULL_SCALE = 1.5;

export type StabilityBand =
  "verySteady" | "steady" | "variable" | "veryVariable";

export interface MoodStability {
  /** 0..100; higher = steadier (lower day-to-day variance). */
  score: number;
  /** Population standard deviation of the daily means (raw, for tests). */
  stdDev: number;
  /** Descriptive, non-judgemental band. */
  band: StabilityBand;
  /** Daily points the score was computed over. */
  days: number;
}

/**
 * Map a 0..100 stability score to a four-band descriptive label.
 * Descriptive, not judgemental — some variation is healthy (Oura framing),
 * so the bands read "steady" / "variable", never "good" / "bad".
 */
function stabilityBand(score: number): StabilityBand {
  if (score >= 80) return "verySteady";
  if (score >= 60) return "steady";
  if (score >= 40) return "variable";
  return "veryVariable";
}

/**
 * Mood-stability score from the population standard deviation of the
 * daily means.
 *
 * Formula:
 *   sd    = sqrt( mean( (x_i - mean(x))^2 ) )         // population SD
 *   score = round( 100 * (1 - min(sd, FULL) / FULL) ) // clamped 0..100
 *
 * A flat mood (sd = 0) scores 100; an sd at or beyond
 * `STABILITY_SD_FULL_SCALE` scores 0. Returns `null` below
 * `STABILITY_MIN_DAYS` distinct daily points so a sparse logger never
 * gets a meaningless score.
 */
export function computeMoodStability(
  daily: DailyPoint[],
): MoodStability | null {
  if (daily.length < STABILITY_MIN_DAYS) return null;

  const stdDev =
    standardDeviation(
      daily.map((bucket) => bucket.value),
      READING_SPREAD,
    ) ?? 0;

  const normalised =
    Math.min(stdDev, STABILITY_SD_FULL_SCALE) / STABILITY_SD_FULL_SCALE;
  const score = Math.round(100 * (1 - normalised));

  return {
    score,
    stdDev: round(stdDev, 3),
    band: stabilityBand(score),
    days: daily.length,
  };
}
