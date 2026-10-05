/**
 * v1.10.0 — public barrel for the derived-metrics layer.
 *
 * Carries the cross-cutting surface: the registry (which metrics exist and
 * how they are archetyped), the route dispatcher, the baseline profile
 * loader, and the handful of per-metric compute engines and value shapes
 * that consumers outside this directory actually reach for.
 *
 * It is deliberately NOT a mirror of every export under `./`. The per-metric
 * scoring helpers, their `*Opts` / `*Band` types and the sub-score weights are
 * imported from their concrete module (`./sleep-score`, `./trajectory`, …) by
 * the code and tests that use them; re-exporting them here only produced lines
 * nothing imported. Add a line below when an outside consumer appears, not in
 * anticipation of one.
 *
 * A `"use client"` component must value-import only from `./types`,
 * `./coverage` and `./registry` — those are server-import-free. The route and
 * server consumers may import the engines below.
 */

// ── client-safe contract ─────────────────────────────────────────────
export { isDerivedOk } from "./types";

export {
  DERIVED_METRIC_IDS,
  TRAJECTORY_TYPES,
  isDerivedMetricId,
} from "./registry";
export type { DerivedMetricId } from "./registry";

// ── server-only compute engines (do NOT value-import from a client component) ──
export { loadBaselineProfile } from "./baseline";
export type { BaselineProfile } from "./baseline";

export { computeDerivedMetric } from "./dispatch";

export type { SleepScoreValue } from "./sleep-score";

export { computeReadiness } from "./readiness";
export type { ReadinessValue, ReadinessComponentKey } from "./readiness";

export { computeCoincidentDeviation } from "./coincident-deviation";

export type { WellnessScoreValue } from "./wellness-scores";

export {
  computeTrajectory,
  TRAJECTORY_DEFAULT_WINDOW_DAYS,
} from "./trajectory";
export type { TrajectoryValue } from "./trajectory";
