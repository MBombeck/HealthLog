/**
 * v1.10.0 — the FLAGSHIP shared baseline engine (catalogue metric #1:
 * personal typical-range / vitals baseline).
 *
 * `computeVitalsBaseline(userId, profile, opts)` is the one real metric
 * Wave 1 ships end-to-end. It returns the band of values that is "normal
 * for you" for a single vital, computed as a rolling personal baseline:
 *
 *   - **center** = median of the per-day means over the window. The DAY
 *     means come from the rollup tier (`readBestGranularityRollups` at
 *     DAY granularity — `mean` composes linearly across DAY buckets, the
 *     `measurement-read-wmy.ts:29-39` contract) with a per-type bounded
 *     live-SQL fallback on a coverage miss.
 *   - **spread** = median ± k·MAD (median absolute deviation, k≈3), an
 *     outlier-robust ≈3σ-equivalent band. MAD is computed from the same
 *     DAY-native per-day series — NEVER from a recomposed WEEK/MONTH `sd`.
 *     This is the hard invariant: `sd`/`slope`/`r2` do not compose, so
 *     the spread is derived at native (DAY) granularity only.
 *
 * Method/standard: robust-statistics anomaly detection — Median Absolute
 * Deviation (Hampel 1974, JASA 69(346):383–393; Leys et al. 2013, J. Exp.
 * Soc. Psychol. 49(4):764–766: "do not use standard deviation around the
 * mean, use the median absolute deviation around the median"). Framing:
 * Apple Health "Vitals" typical-range — establish the band after ≥7 days,
 * then today's reading is "in range" or "outside".
 *
 * Server-only — reads the rollup tier + raw rows via Prisma. The pure
 * statistics helpers below are exported so the unit test can assert the
 * composed-bucket baseline matches the raw-DAY baseline within tolerance.
 */
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import { getAgeFromDateOfBirth } from "@/lib/analytics/pulse-targets";
import { toProfileSex } from "@/lib/profile/sex";
import {
  clampDerivedLowerBound,
  isPlausibleMetricValue,
  plausibleMetricRange,
} from "@/lib/measurements/value-domain";
import type { ProfileSex } from "@/lib/profile/sex";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import {
  SPARKLINE_MAX_POINTS,
  type Derived,
  type DerivedProvenanceSource,
} from "./types";
import { dateOnlyKey } from "@/lib/tz/date-only";

/** k for the median ± k·MAD band — ≈3σ-equivalent for normal data. */
const DEFAULT_MAD_K = 3;
/** 1.4826 makes MAD a consistent estimator of σ under normality. */
const MAD_SIGMA_SCALE = 1.4826;
/** Default trailing window (days). Apple establishes the band after ≥7. */
const DEFAULT_WINDOW_DAYS = 30;

/** The successful `value` payload for a vitals baseline. */
export interface VitalsBaselineValue {
  /** The vital this band describes. */
  type: MeasurementType;
  /** Robust center (median of the per-day means). */
  center: number;
  /**
   * Band lower edge (center − k·MAD·scale), floored at 0 for a metric whose
   * plausibility domain forbids negative values. `spread` below stays the
   * unclamped dispersion, so a deviation-in-σ calculation is unaffected.
   */
  low: number;
  /** Band upper edge (center + k·MAD·scale). */
  high: number;
  /** The MAD-derived σ-equivalent spread (k applied; same units as the metric). */
  spread: number;
  /** Distinct days that contributed to the baseline. */
  sampleDays: number;
  /** k used for the band (echoed for transparency). */
  k: number;
  /**
   * Trailing per-day mean series (oldest → newest), capped to the last
   * `SPARKLINE_MAX_POINTS`. Drives the tile sparkline; reuses the rows the
   * band is already computed from (no extra read).
   */
  series: number[];
}

/** Caller-supplied profile (read once per request, never re-fetched here). */
export interface BaselineProfile {
  ageYears: number | null;
  /**
   * Sex as stored, `OTHER` included. The sex-split reference tables have
   * no `OTHER` row, so `resolveSexRows` falls through to the sex-agnostic
   * band or reports none — an honest omission. Narrowing the value away
   * HERE instead would hand every consumer a `null` it cannot tell apart
   * from "no answer".
   */
  sex: ProfileSex;
  /**
   * Height in cm from `User.heightCm`, when set. Consumed by the BMI
   * metric (weight ÷ height²); `null` when the profile has no height.
   */
  heightCm?: number | null;
}

/**
 * Build the `BaselineProfile` the baseline engine + readiness blend need from
 * the `User` row. This is the one loader the persisting score engines and the
 * live `/api/insights/derived` route share — previously each inlined a
 * byte-identical `findUnique` + gender-narrow + `getAgeFromDateOfBirth`. The
 * `prisma` arg is the caller's client (the nightly worker passes its shared
 * connection; the route passes the request client) so both reads hit one
 * pool. `now` is unused here but accepted so a future age-as-of-date refinement
 * is a one-line change in this single place.
 */
export async function loadBaselineProfile(
  prisma: PrismaClient,
  userId: string,
): Promise<BaselineProfile> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { dateOfBirth: true, gender: true, heightCm: true },
  });
  const sex = toProfileSex(user?.gender);
  return {
    ageYears: getAgeFromDateOfBirth(user?.dateOfBirth ?? null),
    sex,
    heightCm: user?.heightCm ?? null,
  };
}

export interface VitalsBaselineOpts {
  /** Which vital to baseline. */
  type: MeasurementType;
  /** Trailing window in days. Defaults to 30. */
  windowDays?: number;
  /** k for the MAD band. Defaults to 3. */
  k?: number;
  /** Compute time (injected for deterministic tests). */
  now?: Date;
  /**
   * Pre-probed coverage map (one probe per request, shared across
   * metrics — the pool-contention mitigation). When omitted the engine
   * probes itself.
   */
  coverage?: RollupCoverageMap;
}

/** A per-day mean point used to build the baseline. */
export interface DayMeanPoint {
  day: string;
  mean: number;
}

// ── pure statistics (exported for the parity test) ───────────────────

/** Median of a numeric array (does not mutate the input). */
export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Median absolute deviation about the median (raw, unscaled). */
export function medianAbsoluteDeviation(values: number[]): number {
  if (values.length === 0) return NaN;
  const center = median(values);
  const deviations = values.map((v) => Math.abs(v - center));
  return median(deviations);
}

/**
 * Build the median ± k·MAD band from a per-day mean series. Pure — the
 * caller supplies the already-resolved DAY-native series so this can be
 * unit-tested against both a raw-DAY series and a rollup-composed series
 * (they must agree: DAY rollup `mean` equals the per-day raw mean).
 *
 * `type` names the metric the series belongs to and is REQUIRED, not
 * optional: `center − spread` is arithmetic, and arithmetic does not know
 * that a step, a flight, or a kilocalorie cannot be owed. On a metric with a
 * wide relative spread the lower edge crosses zero and the strip underneath
 * the chart reads "your usual range is −5,595.6–13,387.6 steps". The floor
 * comes from `clampDerivedLowerBound`, which reads the metric's declared
 * plausibility domain — the same fact the chart's y-axis clamps against, now
 * answered in one place instead of two. Pass `null` only for a series with no
 * metric identity; the band then keeps the raw arithmetic edge.
 */
export function buildBaselineBand(
  dayMeans: number[],
  type: MeasurementType | null,
  k: number = DEFAULT_MAD_K,
): Omit<VitalsBaselineValue, "type" | "series"> | null {
  if (dayMeans.length === 0) return null;
  const center = median(dayMeans);
  const mad = medianAbsoluteDeviation(dayMeans);
  // Scale MAD to a σ-equivalent so the band reads like a robust ±kσ.
  const spread = k * mad * MAD_SIGMA_SCALE;
  return {
    center,
    low: clampDerivedLowerBound(type, center - spread),
    high: center + spread,
    spread,
    sampleDays: dayMeans.length,
    k,
  };
}

// ── reads ────────────────────────────────────────────────────────────

/**
 * Resolve the per-day mean series for `(userId, type)` over the window.
 * Rollup tier first (DAY-native, `mean` composes); per-type bounded
 * live-SQL fallback on a coverage miss. Returns the series plus the
 * provenance source the read resolved against.
 *
 * Days are UTC days, the DAY rollup grain. A caller that compares the days
 * with the user's own calendar (today's key, a record's local day) passes
 * `timeZone`; the series is then folded live on the user's local days.
 */
export async function readDayMeanSeries(
  userId: string,
  type: MeasurementType,
  windowDays: number,
  now: Date,
  coverage: RollupCoverageMap,
  timeZone?: string,
): Promise<{ points: DayMeanPoint[]; source: DerivedProvenanceSource }> {
  const hasBuckets = timeZone === undefined && coverage.get(type) === true;

  if (hasBuckets) {
    // DAY granularity only — the spread invariant forbids composing a
    // band from WEEK/MONTH `sd`, and the center reads the DAY `mean`
    // which composes exactly. `readBestGranularityRollups` with a
    // window < 91 days resolves to DAY by construction.
    const resolved = await readBestGranularityRollups(userId, type, windowDays);
    if (
      resolved &&
      resolved.granularity === "DAY" &&
      resolved.rows.length > 0
    ) {
      // A bucket mean is only as good as the rows it averaged. The rollup
      // writer aggregates whatever is stored, so a reading outside the
      // metric's plausibility domain rides straight through into the bucket
      // and from there into the band. Drop those buckets on the same rule the
      // live read applies to its rows, so the two paths agree about what
      // counts as a measurement.
      const points = resolved.rows
        .filter((row) => isPlausibleMetricValue(type, row.mean))
        .map((row) => ({
          day: dateOnlyKey(row.bucketStart),
          mean: row.mean,
        }));
      if (points.length > 0) return { points, source: "DAY" };
    }
    // Coverage probe said "has buckets" but the window resolved to a
    // coarser tier or zero DAY rows → fall through to the live read so
    // the spread is still DAY-native.
  }

  // Per-type live fallback — per-day means folded in SQL, so the read is
  // one row per day however densely the metric is sampled (#1023). Only
  // values inside the metric's own plausibility domain count: a single
  // stored value the application declares impossible would drag the day's
  // mean with it and the median would carry it into the band. A day whose
  // every reading is implausible produces no point at all. Days are UTC
  // days, matching the DAY rollup path above, unless the caller asked for
  // the user's own days.
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const days = await readDayAggregates({
    userId,
    type,
    since,
    timeZone: timeZone ?? "UTC",
    valueRange: plausibleMetricRange(type),
  });
  // A pulse day is the mean of its local hours' means (`dayMean`, see
  // `day-mean.ts`); every other type's day is the mean of its readings.
  const points = days.map((d) => ({
    day: d.day,
    mean: d.dayMean ?? d.sum / d.n,
  }));
  if (points.length === 0) {
    return { points: [], source: "none" };
  }
  return { points, source: "live" };
}

/**
 * FLAGSHIP — the one real Wave 1 metric. Pure `(userId, profile, opts) =>
 * Promise<Derived<VitalsBaselineValue>>`: rolling personal baseline
 * (median ± k·MAD) for a single vital, reading the rollup tier with a
 * per-type live fallback on a coverage miss. Below the min-history floor
 * it returns `insufficient` with coverage + provenance (never a
 * fabricated band).
 */
export async function computeVitalsBaseline(
  userId: string,
  _profile: BaselineProfile,
  opts: VitalsBaselineOpts,
): Promise<Derived<VitalsBaselineValue>> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const k = opts.k ?? DEFAULT_MAD_K;
  const now = opts.now ?? new Date();
  const type = opts.type;
  const minHistoryDays = 7;

  const coverage = opts.coverage ?? (await probeRollupCoverage(userId));
  const { points, source } = await readDayMeanSeries(
    userId,
    type,
    windowDays,
    now,
    coverage,
  );

  const historyDays = points.length;
  const computedAt = nowProvenanceTimestamp(now);

  // No data at all — insufficient, source "none".
  if (historyDays === 0) {
    const { coverage: cov } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 0,
      historyDays: 0,
      missing: [String(type)],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<VitalsBaselineValue>({
      coverage: cov,
      provenance: {
        inputs: [String(type)],
        source: "none",
        windowDays,
        computedAt,
      },
      reason: "no_readings_in_window",
    });
  }

  // Below the band floor — value exists but not enough history for a
  // robust band. Insufficient, but honest coverage + provenance so the
  // card shows "building your typical range — N of 7 days".
  if (historyDays < minHistoryDays) {
    const { coverage: cov } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 1,
      historyDays,
      missing: [],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<VitalsBaselineValue>({
      coverage: cov,
      provenance: { inputs: [String(type)], source, windowDays, computedAt },
      reason: "insufficient_history_for_band",
    });
  }

  const band = buildBaselineBand(
    points.map((p) => p.mean),
    type,
    k,
  );
  if (!band) {
    const { coverage: cov } = deriveCoverage({
      requiredInputs: 1,
      presentInputs: 1,
      historyDays,
      missing: [],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<VitalsBaselineValue>({
      coverage: cov,
      provenance: { inputs: [String(type)], source, windowDays, computedAt },
      reason: "band_computation_failed",
    });
  }

  const { coverage: cov, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays,
    missing: [],
    fullHistoryDays: windowDays,
  });

  // Trailing per-day mean series for the inline sparkline — the same DAY
  // means the band is built from, capped to the recent window.
  const series = points.slice(-SPARKLINE_MAX_POINTS).map((p) => p.mean);

  return buildOk<VitalsBaselineValue>({
    value: { type, ...band, series },
    coverage: cov,
    confidence,
    provenance: { inputs: [String(type)], source, windowDays, computedAt },
  });
}
