/**
 * v1.4.27 F17/F18/F19 — single decision point for "does the user have
 * any observations on this metric?".
 *
 * Three render gates consume this helper:
 *
 *   1. The routed Insights sub-pages (`/insights/{slug}/page.tsx`)
 *      early-return an empty-state with a CTA when the gate is false.
 *   2. The Insights tab strip (`<InsightsTabStrip>`) filters pills so
 *      a metric with zero observations doesn't surface a navigation
 *      target the user can't act on.
 *   3. The dashboard tile registry (`src/app/page.tsx`) — wired in
 *      bucket B1 — applies the same gate per tile.
 *
 * Source signals:
 *
 *   - Sensor metrics (`PULSE`, `WEIGHT`, `BMI`, `BLOOD_PRESSURE_*`,
 *     `SLEEP_DURATION`, `VO2_MAX`, `STEPS`, `ACTIVE_ENERGY`) read
 *     `summaries[METRIC].count` from the analytics endpoint.
 *   - `BMI` is derived from `WEIGHT` so it inherits the weight count.
 *   - Event-driven metrics (`MOOD`, `MEDICATION`) read the boolean
 *     `hasMood` / `hasMedication` flags the caller threads in from
 *     `/api/insights/comprehensive` (mood summary count > 0,
 *     medications array length > 0).
 *
 * Auto-light-up behaviour: once the iOS native client uploads its
 * first Apple-Health measurement, `summaries[METRIC].count` flips
 * from 0 to ≥1 and the next React-Query refetch reveals the matching
 * pill, sub-page, and dashboard tile — no separate feature flag
 * needed. (F18.)
 */
import type { DataSummary } from "@/lib/analytics/trends";

/**
 * Metric keys the gating helper distinguishes. Mirrors the
 * `MeasurementType` enum for sensor metrics and adds synthetic keys
 * for `MOOD`, `MEDICATION`, and `BMI` (derived from `WEIGHT`).
 *
 * Adding a new metric is a one-place change: list it here, decide
 * which branch of `hasMetricData` handles it, and the sub-page /
 * tab strip / dashboard tile gates pick it up automatically.
 */
export type InsightMetric =
  | "BLOOD_PRESSURE_SYS"
  | "BLOOD_PRESSURE_DIA"
  | "PULSE"
  | "WEIGHT"
  | "BMI"
  | "MOOD"
  | "MEDICATION"
  | "SLEEP_DURATION"
  | "VO2_MAX"
  | "STEPS"
  | "ACTIVE_ENERGY";

/**
 * Inputs the gating helper consumes. The `summaries` shape mirrors
 * the `/api/analytics` response (`Record<MeasurementType, DataSummary>`)
 * — undefined means the caller hasn't loaded analytics yet, which
 * the helper treats as "not available" so loading shells aren't
 * accidentally lit up.
 */
export interface InsightInputs {
  summaries: Record<string, DataSummary> | undefined;
  /** Whether the user has logged at least one mood entry. */
  hasMood: boolean;
  /** Whether the user has at least one active medication. */
  hasMedication: boolean;
}

/**
 * Decide whether a metric has enough observations to surface its
 * sub-page, tab pill, or dashboard tile. Returns `false` for any
 * unknown branch so a future metric added to `InsightMetric` without
 * a handler stays hidden until the gate is wired explicitly.
 */
export function hasMetricData(
  metric: InsightMetric,
  inputs: InsightInputs,
): boolean {
  if (metric === "MOOD") return inputs.hasMood;
  if (metric === "MEDICATION") return inputs.hasMedication;
  if (metric === "BMI") {
    // BMI is derived from WEIGHT + the profile height. The chart
    // mounts even at one weight reading; the gate matches.
    return (inputs.summaries?.WEIGHT?.count ?? 0) > 0;
  }
  return (inputs.summaries?.[metric]?.count ?? 0) > 0;
}
