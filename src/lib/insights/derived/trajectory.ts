/**
 * v1.11.0 (Epic B, Pillar 3) — the `TRAJECTORY` forecasting derived metric.
 *
 * `computeTrajectory(userId, profile, opts)` projects a single metric's
 * recent trend a SHORT horizon forward with an HONEST, widening
 * prediction-interval band. It is the deterministic-compute extension of
 * the existing `trendSlope` (`src/lib/analytics/trends.ts:29`) which
 * already returns `slope` + `direction` + R² (as `confidence`):
 *
 *   - **fit** = ordinary least squares on the DAY-native per-day mean
 *     series (x = days since the window start, y = the per-day mean). The
 *     series is read exactly like the baseline engine
 *     (`readDayMeanSeries`) — rollup DAY buckets (`mean` composes) with a
 *     per-type bounded live-SQL fallback. NEVER from a composed WEEK/MONTH
 *     `sd`/`slope`: the rollup invariant forbids it (`baseline.ts:14-21`),
 *     so the fit + residual spread are computed at DAY granularity only.
 *   - **projection** = the fitted line evaluated at the next
 *     `horizonDays` day-offsets past the last observation.
 *   - **band** = the textbook OLS prediction interval
 *     `ŷ ± t·s·sqrt(1 + 1/n + (x−x̄)²/Sxx)`, which VISIBLY WIDENS the
 *     further the horizon strays from the data centre `x̄`. NOT a flat ±.
 *     The fanning band IS the uncertainty communication.
 *
 * Honesty gates (overclaiming a forecast is the top Epic-B risk). A
 * projection is produced ONLY when all hold; otherwise `insufficient`
 * (never a weak line, never extrapolated noise):
 *   - R² ≥ `TRAJECTORY_MIN_R2` (a weak-but-real trend, not noise).
 *   - `sampleDays ≥ TRAJECTORY_MIN_HISTORY_DAYS` (enough fit support).
 *   - the series is not stale: the window is anchored on `now` (like
 *     `trendSlope`) so a series with no recent points yields too few
 *     in-window days and gates out the same way the dashboard tile hides a
 *     stale average.
 *
 * The displayed confidence is server-computed from n + fit + recency
 * (`deriveCoverage`), never the model's self-confidence — the LLM never
 * invents the number; it only narrates a band that is already here.
 *
 * Server-only — reads the rollup tier + raw rows via the baseline reader.
 * The pure OLS + prediction-interval helpers are exported so the unit
 * test asserts the projection on a seeded trend and the band's widening.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import {
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import {
  buildInsufficient,
  buildOk,
  deriveCoverage,
  nowProvenanceTimestamp,
} from "./coverage";
import { readDayMeanSeries, type BaselineProfile } from "./baseline";
import type { Derived, DerivedProvenanceSource } from "./types";
import { daysBetweenDateKeys, shiftDateKey } from "@/lib/tz/format";

/** Trailing window the fit reads (days). Matches the baseline engine. */
const DEFAULT_WINDOW_DAYS = 30;
/** The window `computeTrajectory` reads when called without one. */
export const TRAJECTORY_DEFAULT_WINDOW_DAYS = DEFAULT_WINDOW_DAYS;
/** Default short projection horizon (days). Deliberately conservative. */
const DEFAULT_HORIZON_DAYS = 14;
/** Hard ceiling on the horizon — the literature warns off long horizons. */
const MAX_HORIZON_DAYS = 14;
/** Minimum distinct in-window days before a projection is produced. */
export const TRAJECTORY_MIN_HISTORY_DAYS = 14;
/** Minimum R² (fit quality) before a projection is produced. */
export const TRAJECTORY_MIN_R2 = 0.3;
/**
 * Two-sided t critical value at 95% used for the prediction band. A fixed
 * conservative constant (≈ the large-n z) rather than a per-n t-table
 * lookup: the band is an honesty signal, not an inferential claim, and a
 * constant keeps the math pure + dependency-free. With the ≥14-day floor
 * the true t is within ~5% of this, and erring slightly wide is the safe
 * direction for a forecast band.
 */
const T_CRITICAL_95 = 1.96;

/** One projected day on the forecast fan. */
export interface TrajectoryPoint {
  /** Days past the last observation (1..horizonDays). */
  dayOffset: number;
  /** ISO date (YYYY-MM-DD) the offset lands on. */
  date: string;
  /** Fitted projection ŷ at this offset. */
  projected: number;
  /** Prediction-interval lower edge at this offset. */
  bandLow: number;
  /** Prediction-interval upper edge at this offset. */
  bandHigh: number;
}

/** The successful `value` payload for a trajectory projection. */
export interface TrajectoryValue {
  /** The metric this projection describes. */
  type: MeasurementType;
  /** OLS slope (units per day). */
  slopePerDay: number;
  /** Trend direction, mirroring `trendSlope`. */
  direction: "up" | "down" | "stable";
  /** Horizon the projection covers (days). */
  horizonDays: number;
  /** R² of the fit (0..1) — the confidence the band rides. */
  r2: number;
  /** Residual standard error of the fit (same units as the metric). */
  residualStdError: number;
  /** Distinct in-window days that backed the fit. */
  sampleDays: number;
  /** Last observed per-day mean (the fan's anchor). */
  lastValue: number;
  /** Projected fan (oldest → newest offset), each with a widening band. */
  projection: TrajectoryPoint[];
  /** Method tag — always "ols" for v1. */
  method: "ols";
}

export interface TrajectoryOpts {
  /** Which metric to project. */
  type: MeasurementType;
  /** Trailing fit window in days. Defaults to 30. */
  windowDays?: number;
  /** Projection horizon in days. Clamped to [1, MAX_HORIZON_DAYS]. */
  horizonDays?: number;
  /** Compute time (injected for deterministic tests). */
  now?: Date;
  /** Pre-probed coverage map (one probe per request). */
  coverage?: RollupCoverageMap;
}

// ── pure OLS + prediction interval (exported for the unit test) ───────

/** A fitted OLS line plus the spread terms the band needs. */
export interface OlsFit {
  slope: number;
  intercept: number;
  r2: number;
  /** Number of points. */
  n: number;
  /** Mean of x (the data centre the band widens away from). */
  meanX: number;
  /** Σ(x − x̄)² — the denominator in the prediction-interval term. */
  sxx: number;
  /** Residual standard error s = sqrt(SSres / (n − 2)). */
  residualStdError: number;
}

/**
 * Fit an OLS line `y = intercept + slope·x` and return the spread terms
 * the prediction interval needs. Pure. Returns `null` when the fit is
 * degenerate (< 3 points, or all x identical → Sxx = 0). Three points is
 * the floor for a meaningful residual standard error (n − 2 ≥ 1).
 */
export function fitOls(xs: number[], ys: number[]): OlsFit | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;

  const sumX = xs.reduce((s, x) => s + x, 0);
  const sumY = ys.reduce((s, y) => s + y, 0);
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i] - meanY);
  }
  if (sxx === 0) return null; // all x identical → no slope

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    const fitted = intercept + slope * xs[i];
    ssRes += (ys[i] - fitted) ** 2;
    ssTot += (ys[i] - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  // n − 2 degrees of freedom; n ≥ 3 guarantees a positive denominator.
  const residualStdError = Math.sqrt(ssRes / (n - 2));

  return { slope, intercept, r2, n, meanX, sxx, residualStdError };
}

/**
 * The half-width of the OLS prediction interval at a single x:
 *   t·s·sqrt(1 + 1/n + (x − x̄)²/Sxx)
 * Pure. This is the term that makes the band FAN OUT — the `(x − x̄)²/Sxx`
 * summand grows quadratically as x leaves the data centre, so a point far
 * into the horizon carries a visibly wider band than one near the data.
 */
export function predictionIntervalHalfWidth(fit: OlsFit, x: number): number {
  const { n, meanX, sxx, residualStdError } = fit;
  const leverage = 1 + 1 / n + (x - meanX) ** 2 / sxx;
  return T_CRITICAL_95 * residualStdError * Math.sqrt(leverage);
}

// ── compute ───────────────────────────────────────────────────────────

/**
 * Short-horizon OLS trajectory with a widening prediction band, gated on
 * fit quality + history + staleness. Reads the DAY-native per-day mean
 * series (rollup tier + bounded live fallback) — never a composed
 * WEEK/MONTH slope. Below any gate it returns `insufficient` (never a
 * weak line, never noise extrapolated).
 */
export async function computeTrajectory(
  userId: string,
  _profile: BaselineProfile,
  opts: TrajectoryOpts,
): Promise<Derived<TrajectoryValue>> {
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const horizonDays = Math.max(
    1,
    Math.min(MAX_HORIZON_DAYS, opts.horizonDays ?? DEFAULT_HORIZON_DAYS),
  );
  const now = opts.now ?? new Date();
  const type = opts.type;
  const computedAt = nowProvenanceTimestamp(now);

  const coverage = opts.coverage ?? (await probeRollupCoverage(userId));
  const { points, source } = await readDayMeanSeries(
    userId,
    type,
    windowDays,
    now,
    coverage,
  );

  const sampleDays = points.length;

  const insufficient = (
    reason: string,
    src: DerivedProvenanceSource,
    presentInputs: number,
  ): Derived<TrajectoryValue> => {
    const { coverage: cov } = deriveCoverage({
      requiredInputs: 1,
      presentInputs,
      historyDays: sampleDays,
      missing: presentInputs === 0 ? [String(type)] : [],
      fullHistoryDays: windowDays,
    });
    return buildInsufficient<TrajectoryValue>({
      coverage: cov,
      provenance: {
        inputs: [String(type)],
        source: src,
        windowDays,
        computedAt,
      },
      reason,
    });
  };

  // No data at all — insufficient, source "none".
  if (sampleDays === 0) {
    return insufficient("no_readings_in_window", "none", 0);
  }

  // Too little history for an honest fit. The window is anchored on `now`
  // (via the reader), so a STALE series (no recent points) lands here too
  // — the same staleness gate `trendSlope` enforces.
  if (sampleDays < TRAJECTORY_MIN_HISTORY_DAYS) {
    return insufficient("insufficient_history_for_projection", source, 1);
  }

  // x = days since the FIRST in-window day; y = the per-day mean.
  const xs = points.map((p) => daysBetweenDateKeys(points[0].day, p.day));
  const ys = points.map((p) => p.mean);

  const fit = fitOls(xs, ys);
  if (!fit) {
    return insufficient("fit_computation_failed", source, 1);
  }

  // Gate on fit quality — a weak-but-real trend, never noise.
  if (fit.r2 < TRAJECTORY_MIN_R2) {
    return insufficient("insufficient_fit_for_projection", source, 1);
  }

  // Project from the last observed day-offset forward over the horizon,
  // each point carrying the widening prediction band.
  const lastX = xs[xs.length - 1];
  const lastDay = points[points.length - 1].day;
  const projection: TrajectoryPoint[] = [];
  for (let h = 1; h <= horizonDays; h++) {
    const x = lastX + h;
    const projected = fit.intercept + fit.slope * x;
    const half = predictionIntervalHalfWidth(fit, x);
    projection.push({
      dayOffset: h,
      date: shiftDateKey(lastDay, h),
      projected,
      bandLow: projected - half,
      bandHigh: projected + half,
    });
  }

  const slopePerDay = fit.slope;
  const threshold = 0.01;
  const direction: "up" | "down" | "stable" =
    Math.abs(slopePerDay) < threshold
      ? "stable"
      : slopePerDay > 0
        ? "up"
        : "down";

  const { coverage: cov, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: sampleDays,
    missing: [],
    fullHistoryDays: windowDays,
  });

  return buildOk<TrajectoryValue>({
    value: {
      type,
      slopePerDay,
      direction,
      horizonDays,
      r2: fit.r2,
      residualStdError: fit.residualStdError,
      sampleDays,
      lastValue: ys[ys.length - 1],
      projection,
      method: "ols",
    },
    coverage: cov,
    confidence,
    provenance: { inputs: [String(type)], source, windowDays, computedAt },
  });
}
