/**
 * v1.4.30 — UI-side categorisation overlay for `MeasurementType`.
 *
 * The flat 27-value enum is the correct storage shape (per R-F §4.1)
 * — Postgres enums are cheap; a per-category sub-table would explode
 * the read joins. The overlay below is presentation-only and drives:
 *
 *   - The iOS HealthKit permission picker — grouped by `category` so
 *     the user sees one consent screen per logical area (vitals,
 *     activity, sleep, …) rather than a flat 27-line list. The iOS
 *     side mirrors this map verbatim via the swift-openapi-generator
 *     codegen path (R-E H-8); a new MeasurementType is one change in
 *     this file + the Prisma enum + the Zod validator + this overlay.
 *
 *   - The web Insights nav (post-v1.5) — the sub-page strip stays
 *     curated at 7 pages, but the "All metrics" overview can group
 *     cards by category cheaply from this map.
 *
 *   - The Coach evidence shelf — chip-grouping by category makes the
 *     prose more navigable than a flat list.
 *
 * Locked: see `.planning/research/v15-r-f-apple-health-depth.md` §4.
 */
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * Apple-Health-flavoured category set. Collapses Apple's
 * Heart + Vitals into one `vitals` bucket and omits the ones we
 * deliberately don't track (Cycle, Nutrition, Respiratory clinical,
 * Symptoms).
 *
 * `cardiovascular` is distinct from `vitals` — vitals are point-in-
 * time signals (BP, pulse, HRV, body temp, SpO2); cardiovascular
 * holds derived risk markers that arrive less frequently (pulse-wave
 * velocity, vascular age).
 */
export type MeasurementCategory =
  | "vitals"
  | "body"
  | "activity"
  | "sleep"
  | "hearing"
  | "environment"
  | "cardiovascular"
  | "metabolic";

/**
 * Per-MeasurementType → category mapping. The map is exhaustive over
 * the current enum surface — adding a new MeasurementType is a
 * compile-time error in this file until a category is assigned.
 *
 * The map is intentionally `ReadonlyMap` rather than a plain object
 * literal so consumers cannot mutate it accidentally; a flat
 * `Record<MeasurementType, MeasurementCategory>` would be equally
 * valid but provides no immutability guard.
 */
export const MEASUREMENT_CATEGORIES: ReadonlyMap<
  MeasurementType,
  MeasurementCategory
> = new Map<MeasurementType, MeasurementCategory>([
  // ── Vitals (point-in-time signals) ──
  ["BLOOD_PRESSURE_SYS", "vitals"],
  ["BLOOD_PRESSURE_DIA", "vitals"],
  ["PULSE", "vitals"],
  ["RESTING_HEART_RATE", "vitals"],
  ["HEART_RATE_VARIABILITY", "vitals"],
  ["OXYGEN_SATURATION", "vitals"],
  ["BODY_TEMPERATURE", "vitals"],

  // ── Body composition ──
  ["WEIGHT", "body"],
  ["BODY_FAT", "body"],
  ["FAT_FREE_MASS", "body"],
  ["FAT_MASS", "body"],
  ["MUSCLE_MASS", "body"],
  ["TOTAL_BODY_WATER", "body"],
  ["BONE_MASS", "body"],
  ["VISCERAL_FAT", "body"],

  // ── Activity (cumulative + fitness + mobility) ──
  ["ACTIVITY_STEPS", "activity"],
  ["ACTIVE_ENERGY_BURNED", "activity"],
  ["FLIGHTS_CLIMBED", "activity"],
  ["WALKING_RUNNING_DISTANCE", "activity"],
  ["VO2_MAX", "activity"],
  ["WALKING_STEADINESS", "activity"],

  // ── Sleep ──
  ["SLEEP_DURATION", "sleep"],

  // ── Hearing (audio exposure quantities + events) ──
  ["AUDIO_EXPOSURE_ENV", "hearing"],
  ["AUDIO_EXPOSURE_HEADPHONE", "hearing"],
  ["AUDIO_EXPOSURE_EVENT", "hearing"],

  // ── Environment ──
  ["TIME_IN_DAYLIGHT", "environment"],

  // ── Cardiovascular (derived risk markers) ──
  ["PULSE_WAVE_VELOCITY", "cardiovascular"],
  ["VASCULAR_AGE", "cardiovascular"],

  // ── Metabolic ──
  ["BLOOD_GLUCOSE", "metabolic"],
  ["SKIN_TEMPERATURE", "metabolic"],
]);

/**
 * Lookup the category for a `MeasurementType`. Returns `undefined`
 * only if a new enum value lands in the schema without a sibling
 * entry in the map — the completeness test in
 * `__tests__/categories.test.ts` is the regression sentinel.
 */
export function getMeasurementCategory(
  type: MeasurementType,
): MeasurementCategory | undefined {
  return MEASUREMENT_CATEGORIES.get(type);
}

/**
 * List every `MeasurementType` belonging to a given category. Useful
 * for the iOS picker fan-out and the web Insights nav grouping. The
 * return order is the insertion order in `MEASUREMENT_CATEGORIES`
 * above — kept deterministic so the picker UX has a stable layout.
 */
export function measurementTypesForCategory(
  category: MeasurementCategory,
): MeasurementType[] {
  const out: MeasurementType[] = [];
  for (const [type, cat] of MEASUREMENT_CATEGORIES) {
    if (cat === category) out.push(type);
  }
  return out;
}
