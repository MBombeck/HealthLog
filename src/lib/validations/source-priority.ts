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
 *
 * v1.4.25 W8c — two-axis extension. The original (W5e) shape carried a
 * per-metric ladder at the top level (e.g. `weight: ["WITHINGS", …]`).
 * W8c adds two optional containers ON TOP of that:
 *   - `metricPriority`     — the per-metric ladder, identical in shape
 *                            to the top-level keys but nested. The
 *                            nested form is canonical going forward;
 *                            the flat form is kept as a backward-compat
 *                            shim (no migration / no UI for it).
 *   - `deviceTypePriority` — within a source, which device wins. Keyed
 *                            by metric type with an optional `default`
 *                            ladder that covers metrics where the user
 *                            hasn't set a per-metric override.
 *
 * Both new keys are optional; existing rows with the flat shape keep
 * working unchanged. `parseSourcePriority()` merges everything onto
 * `DEFAULT_SOURCE_PRIORITY` plus an empty two-axis state so the call
 * site never has to think about which keys exist.
 */
import { z } from "zod/v4";

import {
  measurementSourceEnum,
  measurementTypeEnum,
} from "@/lib/validations/measurement";

// v1.4.25 Fix-G — `annotate` from `@/lib/logging/context` was the
// canonical breadcrumb for a parse failure, but the helper pulls
// `node:async_hooks` via `AsyncLocalStorage`. Any client component that
// reaches for a type-only export here (e.g.
// `src/components/settings/sources-section.tsx` importing
// `DEFAULT_SOURCE_PRIORITY`) used to drag `node:async_hooks` into the
// browser bundle and break the Turbopack build. The parser stays in the
// shared module — splitting it out would ripple through every callsite —
// so the breadcrumb path now goes through a runtime-resolved callback.
// The server logging module registers the real `annotate` on first import
// (via `registerSourcePriorityParseObserver`); the browser leaves it as
// the no-op default and never traces `node:async_hooks`.
type ParseFailureObserver = (entry: {
  meta: Record<string, unknown>;
}) => void;
let parseFailureObserver: ParseFailureObserver = () => {};

/**
 * Server-side opt-in for the parse-failure breadcrumb. Called once from
 * `@/lib/logging/context` so a buggy schema-tightening that silently
 * wipes a saved ladder still surfaces in ops dashboards. The client
 * bundle never imports the logging module, so the observer stays the
 * no-op default in the browser.
 */
export function registerSourcePriorityParseObserver(
  observer: ParseFailureObserver,
): void {
  parseFailureObserver = observer;
}

/**
 * Device-type tag attached to a `Measurement` row. Mirrors
 * open-wearables (`watch | band | ring | phone | scale | other`) plus
 * an explicit `unknown` slot for legacy rows where the iOS app or
 * Withings webhook never told us which device produced the sample.
 *
 * Stored on `Measurement.deviceType` (nullable). NULL is treated as
 * `unknown` by `pickCanonicalSource()` — it falls through to the
 * source-only axis when no device-type override applies.
 */
export const deviceTypeEnum = z.enum([
  "watch",
  "band",
  "ring",
  "phone",
  "scale",
  "other",
  "unknown",
]);

export type DeviceType = z.infer<typeof deviceTypeEnum>;

/**
 * Per-metric source ladder. Same shape as the v1.4.25 W5e top-level
 * keys; lifted into a nested object so the schema has room for the new
 * `deviceTypePriority` sibling without clobbering the metric keys.
 *
 * The 8-entry cap is a sanity bound (we have 4 sources today, the cap
 * leaves headroom without inviting a megabyte-blob payload).
 */
const metricSourceLadder = z.array(measurementSourceEnum).max(8);

const metricPriorityObjectSchema = z
  .object({
    // ── Cumulative metrics — sum-per-day; pick ONE source per day. ──
    steps: metricSourceLadder,
    activeEnergy: metricSourceLadder,
    walkingRunningDistance: metricSourceLadder,
    flightsClimbed: metricSourceLadder,
    // ── Sleep — pick best-resolution source per night. ──
    sleep: metricSourceLadder,
    // ── Point measurements — all sources kept; this controls
    //    "display preference" when multiple sources happen to capture
    //    the same metric on the same day.
    weight: metricSourceLadder,
    bloodPressure: metricSourceLadder,
    pulse: metricSourceLadder,
    bodyFat: metricSourceLadder,
    bodyTemperature: metricSourceLadder,
    spo2: metricSourceLadder,
    hrv: metricSourceLadder,
    restingHeartRate: metricSourceLadder,
    vo2Max: metricSourceLadder,
  })
  .partial();

/**
 * v1.4.25 W8c — device-type ladder per metric class. Walked by
 * `pickCanonicalSource()` AFTER the source axis has narrowed the
 * candidate row down to the winning source.
 *
 * Two-level lookup:
 *   - `deviceTypePriority[metric]` — per-metric override (wins).
 *   - `deviceTypePriority.default` — global fallback (used when the
 *                                    metric has no per-key entry).
 *
 * Cap mirrors the source ladder (8 entries) and is generous; the enum
 * itself has 7 slots.
 */
const deviceTypeLadder = z.array(deviceTypeEnum).max(8);

const deviceTypePrioritySchema = z
  .object({
    // Global fallback applied when no per-metric override exists.
    default: deviceTypeLadder,
    // Per-metric overrides — keyed by MeasurementType enum value so
    // iOS-emitted device-type tags survive a future per-metric tweak
    // without schema churn.
  })
  .catchall(deviceTypeLadder)
  // `partial()` so callers can supply only `default`, only an override,
  // or omit the key entirely.
  .partial();

/**
 * Top-level schema. Flat metric keys (W5e shape) sit alongside the new
 * `metricPriority` + `deviceTypePriority` containers. The flat shape is
 * a backward-compat alias — when both exist, `metricPriority` wins.
 */
export const sourcePrioritySchema = z
  .object({
    // ── v1.4.25 W5e flat shape (backward-compat) ──
    steps: metricSourceLadder,
    activeEnergy: metricSourceLadder,
    walkingRunningDistance: metricSourceLadder,
    flightsClimbed: metricSourceLadder,
    sleep: metricSourceLadder,
    weight: metricSourceLadder,
    bloodPressure: metricSourceLadder,
    pulse: metricSourceLadder,
    bodyFat: metricSourceLadder,
    bodyTemperature: metricSourceLadder,
    spo2: metricSourceLadder,
    hrv: metricSourceLadder,
    restingHeartRate: metricSourceLadder,
    vo2Max: metricSourceLadder,
    // ── v1.4.25 W8c additions ──
    metricPriority: metricPriorityObjectSchema,
    deviceTypePriority: deviceTypePrioritySchema,
  })
  .partial();

export type SourcePriority = z.infer<typeof sourcePrioritySchema>;
export type MetricPriority = z.infer<typeof metricPriorityObjectSchema>;
export type DeviceTypePriority = z.infer<typeof deviceTypePrioritySchema>;

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

export type SourcePriorityMetricKey =
  (typeof SOURCE_PRIORITY_METRIC_KEYS)[number];

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
export const DEFAULT_SOURCE_PRIORITY: Required<MetricPriority> = {
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
 * v1.4.25 W8c — default device-type ladder. Open-wearables' research
 * recommendation: watch first (highest fidelity for cumulative + HR
 * metrics), then ring/band (wrist-adjacent), then phone (fallback
 * cumulative when wearables are off-wrist), then scale (only writes
 * weight/body comp anyway), then catch-all `other` / `unknown`.
 *
 * Note: the picker treats a row with `deviceType = null` as `unknown`
 * — legacy Withings rows (pre-v1.4.25 W8c) fall to the bottom of the
 * ladder but never get filtered out, because the source-axis pick
 * already narrowed to one source.
 */
export const DEFAULT_DEVICE_TYPE_PRIORITY: readonly DeviceType[] = [
  "watch",
  "ring",
  "band",
  "phone",
  "scale",
  "other",
  "unknown",
];

/**
 * Fully-resolved shape returned by `parseSourcePriority`. The flat
 * per-metric ladder is always populated (defaulted); the two-axis
 * containers default to empty objects so call sites can read
 * `resolved.metricPriority.weight` etc. without an `undefined` guard.
 */
export interface ResolvedSourcePriority extends Required<MetricPriority> {
  /**
   * Canonical per-metric ladder. Merged from `metricPriority` (W8c
   * nested shape) over the flat top-level keys (W5e shape) over
   * `DEFAULT_SOURCE_PRIORITY`. Always populated for every metric.
   */
  metricPriority: Required<MetricPriority>;
  /**
   * Per-metric device-type override + a global fallback ladder. Both
   * keys default to the empty state (no overrides) so the picker uses
   * `DEFAULT_DEVICE_TYPE_PRIORITY` as the implicit fallback.
   */
  deviceTypePriority: DeviceTypePriority;
}

/**
 * Resolve the persisted Json blob into a fully-defaulted priority map.
 * Missing keys fall back to `DEFAULT_SOURCE_PRIORITY` — the UI never
 * has to think about which keys exist, and a future schema addition
 * (a new metric class) carries its default automatically until the
 * user edits the field.
 *
 * Merge order (high → low):
 *   1. `raw.metricPriority` (W8c nested shape; canonical going forward)
 *   2. `raw` top-level flat keys (W5e backward-compat)
 *   3. `DEFAULT_SOURCE_PRIORITY`
 */
export function parseSourcePriority(raw: unknown): ResolvedSourcePriority {
  if (raw == null) return buildResolved({}, {}, {});

  const parsed = sourcePrioritySchema.safeParse(raw);
  if (!parsed.success) {
    // v1.4.25 W10 reconcile (Sr-M2) — emit a wide-event tag so a future
    // schema-tightening regression that silently nukes a user's saved
    // ladder surfaces in ops dashboards rather than as a "why did my
    // priorities reset?" user report. `annotate()` is a no-op outside a
    // request context, so the static settings-page render and tests
    // remain side-effect-free.
    parseFailureObserver({
      meta: {
        sourcePriority: {
          parse: "failed",
          issueCount: parsed.error.issues.length,
          firstIssuePath: parsed.error.issues[0]?.path.join(".") ?? null,
        },
      },
    });
    return buildResolved({}, {}, {});
  }

  // Pull the W5e flat per-metric ladder off the top level. Drop the
  // two W8c container keys so the rest of the object is just the flat
  // metric ladder we can spread without TS complaining.
  const {
    metricPriority: nested,
    deviceTypePriority,
    ...flatMetricLadder
  } = parsed.data;
  return buildResolved(flatMetricLadder, nested ?? {}, deviceTypePriority ?? {});
}

function buildResolved(
  flat: Partial<MetricPriority>,
  nested: Partial<MetricPriority>,
  deviceTypePriority: DeviceTypePriority,
): ResolvedSourcePriority {
  // Merge: defaults < flat (W5e) < nested (W8c).
  const merged: Required<MetricPriority> = {
    ...DEFAULT_SOURCE_PRIORITY,
    ...flat,
    ...nested,
  };
  const resolved: ResolvedSourcePriority = {
    ...merged,
    metricPriority: merged,
    deviceTypePriority,
  };
  // v1.4.25 W10 reconcile (Code-M1) — deep-freeze the resolved blob so
  // a caller who mutates `resolved.metricPriority.weight = …` after
  // parseSourcePriority() returns trips at runtime instead of silently
  // desyncing the two views (the top-level flat keys share their
  // backing object with `metricPriority` via the spread above, but
  // anything written through the alias post-freeze raises in strict
  // mode and surfaces in dev). Freezing the leaves keeps the contract
  // immutable end-to-end without copying the source ladders.
  for (const ladder of Object.values(merged)) {
    Object.freeze(ladder);
  }
  for (const ladder of Object.values(deviceTypePriority)) {
    if (ladder) Object.freeze(ladder);
  }
  Object.freeze(merged);
  Object.freeze(deviceTypePriority);
  Object.freeze(resolved);
  return resolved;
}

/**
 * v1.4.25 W8c — runtime device-type checker for ingest paths. Returns
 * a `DeviceType` for any input the iOS app or Withings webhook might
 * supply; falls back to `"unknown"` when the value isn't part of the
 * canonical enum. Keeps the picker on the happy path even when a
 * legacy row has `deviceType = null` or a typoed value.
 */
export function normalizeDeviceType(raw: unknown): DeviceType {
  const parsed = deviceTypeEnum.safeParse(raw);
  return parsed.success ? parsed.data : "unknown";
}

/**
 * Convenience: walk the metric-key list and return the source ladder
 * for one metric. Centralised so the picker, the UI, and tests share
 * one path; future axis additions slot in here.
 */
export function getSourceLadder(
  resolved: ResolvedSourcePriority,
  metricKey: SourcePriorityMetricKey,
): readonly z.infer<typeof measurementSourceEnum>[] {
  return resolved.metricPriority[metricKey];
}

/**
 * v1.4.25 W8c — resolve the device-type ladder for a given metric.
 * Lookup order:
 *   1. `deviceTypePriority[metricType]` — per-metric override.
 *   2. `deviceTypePriority.default`     — global fallback the user set.
 *   3. `DEFAULT_DEVICE_TYPE_PRIORITY`   — the constant ladder.
 *
 * The metric key is a `MeasurementType` enum value (e.g. `"WEIGHT"`),
 * not the `SourcePriorityMetricKey` (e.g. `"weight"`), because the
 * iOS-emitted `deviceType` field on `Measurement` is tagged per
 * `MeasurementType` row, not per `SourcePriorityMetricKey` aggregation
 * bucket. The Settings UI translates between the two.
 */
export function getDeviceTypeLadder(
  resolved: ResolvedSourcePriority,
  metricType: z.infer<typeof measurementTypeEnum> | string,
): readonly DeviceType[] {
  const override = resolved.deviceTypePriority[metricType];
  if (override && override.length > 0) return override;
  const fallback = resolved.deviceTypePriority.default;
  if (fallback && fallback.length > 0) return fallback;
  return DEFAULT_DEVICE_TYPE_PRIORITY;
}
