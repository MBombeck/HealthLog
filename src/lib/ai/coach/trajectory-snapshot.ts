/**
 * v1.11.0 (Epic B, Pillar 3) — short-horizon trajectory block for the
 * Coach prompt.
 *
 * Folds the deterministic `computeTrajectory` forecasting engine into the
 * Coach snapshot as COMPACT per-metric projections: direction + slope +
 * the projected END of the horizon with its widening prediction band, the
 * last observed value, and the fit's R² / confidence. The Coach narrates
 * the SAME numbers the engine computed (single source of truth) — it never
 * invents a forecast; the projection is computed off-LLM and the model
 * only describes a band that is already here, and only when present.
 *
 * Every entry reads the one `computeTrajectory` contract — NEVER a
 * recompute. A metric whose projection is `insufficient` (below the
 * R²/history/staleness floor) is OMITTED entirely; the block is omitted
 * when none of the in-scope metrics resolve to `ok`, so the Coach prompt's
 * conditional-projection ground rule has nothing to narrate and (per that
 * rule) does not project.
 *
 * Server-only — calls the trajectory engine, which reads the rollup tier +
 * raw rows via the baseline reader.
 */
import {
  UNBOUNDED_REACH,
  capDays,
  isBounded,
  type CoachHistoryReach,
} from "./history-reach";
import {
  TRAJECTORY_DEFAULT_WINDOW_DAYS,
  computeTrajectory,
  isDerivedOk,
  TRAJECTORY_TYPES,
  type BaselineProfile,
  type TrajectoryValue,
} from "@/lib/insights/derived";

/** One compact projection the Coach can ground a conditional reply in. */
interface TrajectorySnapshotEntry {
  /** Trend direction over the fit window. */
  direction: "up" | "down" | "stable";
  /** OLS slope in metric units per day. */
  slopePerDay: number;
  /** Horizon the projection covers (days). */
  horizonDays: number;
  /** Last observed per-day mean — the fan's anchor. */
  lastValue: number;
  /** The horizon END point: the projected value + its widening band. */
  projectedEnd: {
    value: number;
    bandLow: number;
    bandHigh: number;
  };
  /** R² of the fit (0..1) — the confidence the band rides. */
  r2: number;
  /** Server-computed confidence 0–100 (never the model's self-confidence). */
  confidence: number;
}

/** Round a metric value to one decimal — compact, no false precision. */
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Pull the compact entry off a successful trajectory value. */
function summariseTrajectory(
  value: TrajectoryValue,
  confidence: number,
): TrajectorySnapshotEntry | null {
  const end = value.projection[value.projection.length - 1];
  if (!end) return null;
  return {
    direction: value.direction,
    slopePerDay: round1(value.slopePerDay),
    horizonDays: value.horizonDays,
    lastValue: round1(value.lastValue),
    projectedEnd: {
      value: round1(end.projected),
      bandLow: round1(end.bandLow),
      bandHigh: round1(end.bandHigh),
    },
    r2: Math.round(value.r2 * 100) / 100,
    confidence,
  };
}

/**
 * Build the compact trajectory block, or `null` when no in-scope metric
 * resolved to a projection. Each entry carries direction + slope +
 * projected horizon-end-with-band + R² + confidence — the model never sees
 * the full fan or the raw series. Computes sequentially off the one shared
 * profile (the trajectory engine probes rollup coverage per call).
 */
export async function buildTrajectorySnapshotBlock(
  userId: string,
  profile: BaselineProfile,
  now: Date,
  /** The Coach's lookback limit: the fit reads no further back than it. */
  reach: CoachHistoryReach = UNBOUNDED_REACH,
): Promise<Record<string, TrajectorySnapshotEntry> | null> {
  const windowOpts = isBounded(reach)
    ? { windowDays: capDays(TRAJECTORY_DEFAULT_WINDOW_DAYS, reach) }
    : {};
  const block: Record<string, TrajectorySnapshotEntry> = {};

  for (const type of TRAJECTORY_TYPES) {
    // Per-metric fault isolation: a transient compute failure on one metric
    // must never sink the whole Coach turn — drop it and carry on.
    let derived;
    try {
      derived = await computeTrajectory(userId, profile, {
        type,
        now,
        ...windowOpts,
      });
    } catch {
      continue;
    }
    if (!isDerivedOk(derived)) continue; // omit insufficient — no projection noise
    const summary = summariseTrajectory(
      derived.value,
      derived.confidence.score,
    );
    if (!summary) continue;
    block[type] = summary;
  }

  return Object.keys(block).length > 0 ? block : null;
}
