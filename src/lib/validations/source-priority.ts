/**
 * v1.4.25 W5e — per-user, per-metric-class source priority. When more
 * than one ingest source ships the same metric for the same day, the
 * analytics aggregator consults this map to pick ONE canonical source
 * per day (so cumulative metrics like steps don't double-count) or to
 * pick a "display preferred" source (for point measurements like weight
 * or BP — every source's row stays in the DB as an audit trail).
 *
 * Today (v1.4.25) only WITHINGS + MANUAL exist for any of these
 * metrics, so the function effectively no-ops for every user. The
 * shape lands now so v1.5's Apple Health passthrough drops onto a
 * known foundation without extra schema work.
 *
 * Persisted as `User.sourcePriorityJson` (nullable Jsonb). Null = use
 * `DEFAULT_SOURCE_PRIORITY` verbatim.
 */
import { z } from "zod/v4";

import { measurementSourceEnum } from "@/lib/validations/measurement";

/**
 * Per-metric-class priority list. First wins when multiple sources have
 * data for the same day on a cumulative metric. For point measurements
 * the list controls "display preference" but every source's row stays
 * in the DB.
 *
 * The 8-entry cap is a sanity bound (we have 4 sources today, the cap
 * leaves headroom without inviting a megabyte-blob payload).
 */
export const sourcePrioritySchema = z
  .object({
    // ── Cumulative metrics — sum-per-day; pick ONE source per day. ──
    steps: z.array(measurementSourceEnum).max(8),
    activeEnergy: z.array(measurementSourceEnum).max(8),
    walkingRunningDistance: z.array(measurementSourceEnum).max(8),
    flightsClimbed: z.array(measurementSourceEnum).max(8),
    // ── Sleep — pick best-resolution source per night. ──
    sleep: z.array(measurementSourceEnum).max(8),
    // ── Point measurements — all sources kept; this controls
    //    "display preference" when multiple sources happen to capture
    //    the same metric on the same day.
    weight: z.array(measurementSourceEnum).max(8),
    bloodPressure: z.array(measurementSourceEnum).max(8),
    pulse: z.array(measurementSourceEnum).max(8),
    bodyFat: z.array(measurementSourceEnum).max(8),
    bodyTemperature: z.array(measurementSourceEnum).max(8),
    spo2: z.array(measurementSourceEnum).max(8),
    hrv: z.array(measurementSourceEnum).max(8),
    restingHeartRate: z.array(measurementSourceEnum).max(8),
    vo2Max: z.array(measurementSourceEnum).max(8),
  })
  .partial();

export type SourcePriority = z.infer<typeof sourcePrioritySchema>;

/**
 * Metric-class keys carried by `SourcePriority`. Listed once here so
 * the Settings UI, the aggregator helper, and the tests all read from
 * the same place — a future addition (Apple Health workouts in v1.5)
 * shows up everywhere by extending one constant.
 */
export const SOURCE_PRIORITY_METRIC_KEYS = [
  "steps",
  "activeEnergy",
  "walkingRunningDistance",
  "flightsClimbed",
  "sleep",
  "weight",
  "bloodPressure",
  "pulse",
  "bodyFat",
  "bodyTemperature",
  "spo2",
  "hrv",
  "restingHeartRate",
  "vo2Max",
] as const;

export type SourcePriorityMetricKey = (typeof SOURCE_PRIORITY_METRIC_KEYS)[number];

/**
 * Marc-directive 2026-05-14 defaults:
 *   - Cumulative metrics (steps, activeEnergy, walkingRunningDistance,
 *     flightsClimbed): APPLE_HEALTH > WITHINGS > MANUAL. iOS HealthKit
 *     aggregates ScanWatch + iPhone sensors into a single canonical
 *     stream, so when the iOS passthrough lands in v1.5 it's the most
 *     complete source for cumulative metrics.
 *   - Sleep + HRV + RHR: APPLE_HEALTH > WITHINGS. HealthKit has higher
 *     resolution (per-minute samples) than Withings' nightly summary.
 *   - Point measurements (weight, BP, pulse, body-fat, body-temp,
 *     SpO2, VO2 max): WITHINGS > APPLE_HEALTH > MANUAL. Withings
 *     devices are the primary sensor (scale, BPM cuff, ScanWatch
 *     pulse-ox, Thermo). Apple Health is second-hand (HealthKit
 *     receives the same reading via Withings' Health Mate iOS app).
 */
export const DEFAULT_SOURCE_PRIORITY: Required<SourcePriority> = {
  steps: ["APPLE_HEALTH", "WITHINGS", "MANUAL"],
  activeEnergy: ["APPLE_HEALTH", "WITHINGS", "MANUAL"],
  walkingRunningDistance: ["APPLE_HEALTH", "WITHINGS", "MANUAL"],
  flightsClimbed: ["APPLE_HEALTH", "WITHINGS", "MANUAL"],
  sleep: ["APPLE_HEALTH", "WITHINGS"],
  hrv: ["APPLE_HEALTH", "WITHINGS"],
  restingHeartRate: ["APPLE_HEALTH", "WITHINGS"],
  weight: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
  bloodPressure: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
  pulse: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
  bodyFat: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
  bodyTemperature: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
  spo2: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
  vo2Max: ["WITHINGS", "APPLE_HEALTH", "MANUAL"],
};

/**
 * Resolve the persisted Json blob into a fully-defaulted priority map.
 * Missing keys fall back to `DEFAULT_SOURCE_PRIORITY` — the UI never
 * has to think about which keys exist, and a future schema additions
 * (a new metric class) carry their default automatically until the
 * user edits the field.
 */
export function parseSourcePriority(raw: unknown): Required<SourcePriority> {
  if (raw == null) return DEFAULT_SOURCE_PRIORITY;
  const parsed = sourcePrioritySchema.safeParse(raw);
  if (!parsed.success) return DEFAULT_SOURCE_PRIORITY;
  // Merge the parsed partial onto defaults so missing keys read as
  // defaults — same intuition as `Object.assign({}, defaults, parsed)`
  // but typed.
  return {
    ...DEFAULT_SOURCE_PRIORITY,
    ...parsed.data,
  };
}
