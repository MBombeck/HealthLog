/**
 * The deterministic evidence block behind the per-workout Activity Insight.
 *
 * Everything the model is ever told about a session is built here, and the
 * shape of this module is the security boundary of the whole feature: it is a
 * NUMBERS-ONLY projection over closed fields.
 *
 * What is excluded, and why each one matters:
 *
 *   - `metadata` — a JSON blob of device bundle ids, HKWorkoutEvent markers and
 *     per-vendor extras. Never passed in at all; the only thing taken from it
 *     anywhere on this path is the numeric WHOOP zone-duration array, and that
 *     goes through `parseWhoopZoneDurations` before it gets near here.
 *   - `externalId` — a vendor-supplied opaque string. Never selected.
 *   - route geometry — consumed to derive ONE number (metres climbed) and then
 *     dropped. It is location history, not a figure, and it may not ride a
 *     prompt.
 *   - `sportType` — a TEXT column. The API write path constrains it to
 *     `workoutSportTypeEnum`, but the BACKUP RESTORE path accepts
 *     `z.string().min(1)`, so a restored row can carry arbitrary
 *     attacker-chosen text. It is therefore re-asserted against the enum HERE,
 *     at projection time, and anything unrecognised folds to `"other"`. The
 *     enum is imported from the schema module rather than copied, because a
 *     hand-copied vocabulary drifts.
 *
 * And the claim is enforced by `assertNumericLeaves`, not by this comment: the
 * projection is walked before it is returned and ANY non-numeric leaf at any
 * depth throws. A future field that quietly admits a string fails loudly at the
 * seam instead of arriving in a prompt.
 *
 * Determinism is the second contract. The same session always projects to the
 * same numbers, which is what makes the input hash a real no-op gate: a WHOOP
 * re-sync or an iOS `stats:` overwrite that changes nothing the paragraph
 * narrates hashes identically and never reaches a provider.
 */
import { userDayKey } from "@/lib/tz/format";
import { workoutSportTypeEnum } from "@/lib/validations/workout";
import type { WorkoutHrSeries } from "./hr-series";
import type { WorkoutZones } from "./zones";
import { median, roundTo } from "@/lib/stats/central";

/** Lookback for the own-history comparison, in days. */
export const OWN_HISTORY_LOOKBACK_DAYS = 90;

/** Cap on the history rows the median reads — bounded work on a heavy account. */
export const OWN_HISTORY_MAX_ROWS = 400;

/**
 * The shape of the session's heart rate, reduced to four figures.
 *
 * Derived from the SAME series the detail route renders (`buildWorkoutHrSeries`),
 * deliberately not from `loadIntradayPulse`: that read is day-scoped, so it
 * would answer a question about the day rather than about the session, and the
 * workout-window series is the richer of the two anyway.
 */
export interface WorkoutHrShape {
  bucketSec: number;
  buckets: number;
  /** Mean bpm across the first half of the session's buckets. */
  firstHalfMeanBpm: number;
  /** Mean bpm across the second half. */
  secondHalfMeanBpm: number;
  /** secondHalf − firstHalf. Positive = drifting up as the session went on. */
  driftBpm: number;
  /** Buckets that stand out as a local high point (see `countPeaks`). */
  peaks: number;
  /**
   * Median seconds from a peak back down to the session's mean. Null when no
   * peak ever came back down inside the session.
   */
  medianSettleSec: number | null;
}

/** The user's own recent baseline for this sport. Medians, never means. */
export interface WorkoutOwnHistory {
  lookbackDays: number;
  /** Comparable sessions found, excluding this one. */
  sampleSize: number;
  medianDurationSec: number;
  medianAvgHr: number | null;
  medianDistanceM: number | null;
  medianEnergyKcal: number | null;
}

export interface WorkoutInsightEvidence {
  /** Narrowed against the closed enum — never the raw column. */
  sportType: string;
  /** User-profile-timezone day the session started. */
  localDate: string;
  durationSec: number;
  distanceM: number | null;
  /** Metres climbed, from route altitudes when present, else the column. */
  climbM: number | null;
  activeEnergyKcal: number | null;
  avgHr: number | null;
  maxHr: number | null;
  minHr: number | null;
  /** Seconds in each %HRmax (or device) zone, ascending by zone. */
  zoneSeconds: { zone: number; seconds: number }[] | null;
  hr: WorkoutHrShape | null;
  history: WorkoutOwnHistory | null;
}

/**
 * Narrow the stored sport string to the closed vocabulary.
 *
 * The DB column is free text by design (a new sport is one Zod refinement
 * away), so this is the whitelist that keeps an unreviewed value out of the
 * prompt. Anything unrecognised projects as `"other"` — the same bucket the
 * ingest validator uses.
 */
export function narrowSportType(raw: string): string {
  const parsed = workoutSportTypeEnum.safeParse(raw);
  return parsed.success ? parsed.data : "other";
}

/**
 * How far above the session's own mean a bucket must sit to count as an effort.
 *
 * A percentile alone is not enough, and the reason is worth keeping: on a flat
 * ride the 90th percentile sits a beat or two above the mean, so ordinary
 * sampling noise clears it and a steady session reports several "peaks" that
 * the rider did not do. Five bpm is the smallest rise that is a change in
 * effort rather than a change in measurement.
 */
const MIN_PEAK_PROMINENCE_BPM = 5;

/**
 * Count the session's peaks.
 *
 * A peak is a bucket that is a strict local maximum against its neighbours AND
 * clears both thresholds: the 90th percentile of the session's bucket means
 * (relative — it stands out for THIS session) and the prominence floor above
 * the session mean (absolute — it is a real rise, not noise). Requiring all
 * three is what keeps a steady ride from reporting efforts it did not contain
 * while an interval session still reports each of its own.
 */
function countPeaks(means: number[], threshold: number): number[] {
  const indices: number[] = [];
  for (let i = 1; i < means.length - 1; i++) {
    if (
      means[i] >= threshold &&
      means[i] > means[i - 1] &&
      means[i] >= means[i + 1]
    ) {
      indices.push(i);
    }
  }
  return indices;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * p)),
  );
  return sorted[idx];
}

/**
 * Reduce the HR curve to the four figures the paragraph can honestly use.
 *
 * Returns null below three buckets: two points cannot carry a front/back-half
 * comparison, and inventing one from them is exactly the overclaiming the copy
 * contract forbids.
 */
export function summariseHrShape(
  series: WorkoutHrSeries | null,
): WorkoutHrShape | null {
  if (!series || series.points.length < 3) return null;

  const means = series.points.map((p) => p.mean);
  const half = Math.floor(means.length / 2);
  const avg = (xs: number[]) =>
    Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;

  const firstHalfMeanBpm = avg(means.slice(0, half));
  const secondHalfMeanBpm = avg(means.slice(means.length - half));
  const sessionMean = avg(means);

  const sorted = [...means].sort((a, b) => a - b);
  const peakIndices = countPeaks(
    means,
    Math.max(percentile(sorted, 0.9), sessionMean + MIN_PEAK_PROMINENCE_BPM),
  );

  // Settle time: from each peak, how long until the curve first comes back to
  // the session's own mean. A peak that never settles inside the session
  // contributes nothing rather than a censored figure pretending to be one.
  const settles: number[] = [];
  for (const idx of peakIndices) {
    for (let j = idx + 1; j < means.length; j++) {
      if (means[j] <= sessionMean) {
        settles.push((j - idx) * series.bucketSec);
        break;
      }
    }
  }

  return {
    // `series.source` ("workout_series" | "pulse_window") is deliberately not
    // carried: it is provenance for the chart, it is a string, and the
    // paragraph has nothing to say about it. Dropping it keeps the projection
    // numeric without an allowlist exception.
    bucketSec: series.bucketSec,
    buckets: series.points.length,
    firstHalfMeanBpm,
    secondHalfMeanBpm,
    driftBpm: Math.round((secondHalfMeanBpm - firstHalfMeanBpm) * 10) / 10,
    peaks: peakIndices.length,
    medianSettleSec: median1(settles),
  };
}

/** Slim row shape the own-history median reads. */
export interface OwnHistoryRow {
  durationSec: number;
  avgHeartRate: number | null;
  totalDistanceM: number | null;
  totalEnergyKcal: number | null;
}

/**
 * The user's own median for this sport over the lookback window.
 *
 * Medians rather than means because a single six-hour outing would drag a mean
 * far enough that the paragraph's comparison would be wrong in the ordinary
 * case. Returns null below three comparable sessions: two sessions do not make
 * a baseline, and the copy contract says so plainly instead.
 *
 * CONVERGENCE NOTE — read before editing.
 *
 * `src/lib/workouts/sport-context.ts` computes an own-history comparison for
 * the SAME sport, for the workout-detail card and the coach's evidence block.
 * The two are not interchangeable today and the differences are deliberate on
 * this side, but they should become one function:
 *
 *   | this                        | sport-context.ts            |
 *   |-----------------------------|-----------------------------|
 *   | 90-day lookback             | 180-day lookback            |
 *   | medians                     | means                       |
 *   | null below 3 sessions       | any non-empty result        |
 *
 * Medians and the three-session floor are the ones worth keeping: a paragraph
 * that says "right at your usual" must not be moved by one outlier or built on
 * a single prior session. The lookback is arbitrary on both sides.
 *
 * The caller MUST collapse cross-source twins through `pickCanonicalWorkoutRows`
 * before calling this, exactly as `sport-context.ts` does — a session recorded
 * by two paired watches is one session, and counting it twice inflates the
 * sample size and biases every median.
 */
/** Median of the finite values, to one decimal; null when there are none. */
function median1(values: readonly number[]): number | null {
  const m = median(values.filter((v) => Number.isFinite(v)));
  return m === null ? null : roundTo(m, 1);
}

export function summariseOwnHistory(
  rows: readonly OwnHistoryRow[],
): WorkoutOwnHistory | null {
  if (rows.length < 3) return null;
  const durations = rows.map((r) => r.durationSec);
  const medianDurationSec = median(durations);
  if (medianDurationSec === null) return null;

  const numeric = (pick: (r: OwnHistoryRow) => number | null): number[] =>
    rows
      .map(pick)
      .filter((v): v is number => typeof v === "number" && Number.isFinite(v));

  return {
    lookbackDays: OWN_HISTORY_LOOKBACK_DAYS,
    sampleSize: rows.length,
    medianDurationSec: Math.round(medianDurationSec),
    medianAvgHr: median1(numeric((r) => r.avgHeartRate)),
    medianDistanceM: median1(numeric((r) => r.totalDistanceM)),
    medianEnergyKcal: median1(numeric((r) => r.totalEnergyKcal)),
  };
}

/** The already-loaded workout row the projection reads. */
export interface WorkoutEvidenceRow {
  sportType: string;
  startedAt: Date;
  durationSec: number;
  totalDistanceM: number | null;
  totalEnergyKcal: number | null;
  avgHeartRate: number | null;
  maxHeartRate: number | null;
  minHeartRate: number | null;
  elevationM: number | null;
}

export interface BuildEvidenceInput {
  row: WorkoutEvidenceRow;
  tz: string;
  /** The detail route's HR curve for this workout, or null. */
  hrSeries: WorkoutHrSeries | null;
  /** Zones as the detail route computes them, or null. */
  zones: WorkoutZones | null;
  /** Same-sport sessions inside the lookback, excluding this workout. */
  history: readonly OwnHistoryRow[];
}

/**
 * The only two string-valued leaves the projection is allowed to carry, each
 * with the shape that makes it safe.
 *
 * `sportType` is a member of the closed enum; `localDate` is a derived day key.
 * Neither can carry attacker text once these hold. Everything else must be a
 * number, a boolean, or null.
 */
const ALLOWED_STRING_LEAVES: Record<string, RegExp> = {
  sportType: new RegExp(`^(?:${workoutSportTypeEnum.options.join("|")})$`),
  localDate: /^\d{4}-\d{2}-\d{2}$/,
};

/**
 * Walk the finished projection and throw on anything that is not a number.
 *
 * This is the enforcement behind the module's headline claim. A comment saying
 * "numbers only" is worth nothing the day someone adds a field: it stays true
 * in the docblock and false in the payload. Walking every leaf means the claim
 * fails at the seam, in the worker, before a provider is resolved — and the
 * worker treats a throw as a transient fault, so the paragraph is simply not
 * written rather than written from unvetted input.
 *
 * `hrSource` is deliberately NOT on the allowlist: the HR shape's `source` is a
 * two-value internal literal, and it is dropped from the projection entirely
 * rather than argued about.
 */
export function assertNumericLeaves(value: unknown, path = "evidence"): void {
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`workout evidence: non-finite number at ${path}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, i) => assertNumericLeaves(entry, `${path}[${i}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, leaf] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const allowed = ALLOWED_STRING_LEAVES[key];
      if (allowed) {
        if (typeof leaf !== "string" || !allowed.test(leaf)) {
          throw new Error(
            `workout evidence: ${path}.${key} is not a permitted ${key} value`,
          );
        }
        continue;
      }
      assertNumericLeaves(leaf, `${path}.${key}`);
    }
    return;
  }
  throw new Error(
    `workout evidence: non-numeric leaf at ${path} (${typeof value})`,
  );
}

/**
 * Compose the evidence block. Pure — every read has already happened.
 */
export function buildWorkoutInsightEvidence(
  input: BuildEvidenceInput,
): WorkoutInsightEvidence {
  const { row } = input;
  const evidence: WorkoutInsightEvidence = {
    sportType: narrowSportType(row.sportType),
    localDate: userDayKey(row.startedAt, input.tz),
    durationSec: row.durationSec,
    distanceM: row.totalDistanceM,
    // The stored column only. A kept GPS track already filled it at write
    // time (`route-climb.ts`); the track itself never reaches this builder.
    climbM: row.elevationM,
    activeEnergyKcal: row.totalEnergyKcal,
    avgHr: row.avgHeartRate,
    maxHr: row.maxHeartRate,
    minHr: row.minHeartRate,
    zoneSeconds:
      input.zones?.zones.map((z) => ({ zone: z.zone, seconds: z.seconds })) ??
      null,
    hr: summariseHrShape(input.hrSeries),
    history: summariseOwnHistory(input.history),
  };
  assertNumericLeaves(evidence);
  return evidence;
}
