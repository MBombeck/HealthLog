/**
 * The vocabulary of `GET /api/measurements/series`: the camelCase kinds the
 * route serves, the stored type and wire unit behind each, the point shape,
 * and the thresholds that decide when a sample-dense kind is bucketed.
 */
import { z } from "zod/v4";

import type { MeasurementType, SleepStage } from "@/generated/prisma/client";
import { READING_SPREAD, standardDeviation } from "@/lib/stats/spread";

/**
 * Sample-dense kinds read raw rows only up to this window.
 * A CGM account stores ~288 BLOOD_GLUCOSE rows/day (105k+ rows/year) and
 * per-sample PULSE piles up similarly, so the 365 / 3650-day requests
 * walked a six-figure row set into JS, mapped it twice, and serialized
 * everything. Mirrors the sleep precedent above, but instead of silently
 * clamping the window, requests beyond the cap keep their full range and
 * are day-bucketed in SQL (one point per day, mean + min/max band) — the
 * chart still shows the whole requested history, just at daily grain.
 * The short windows users actually browse (7 / 30 / 90 d) stay raw and
 * byte-identical. Sparse kinds (weight, BP, …) are untouched.
 */
export const DENSE_SERIES_RAW_WINDOW_DAYS = 90;
/**
 * The kinds a device can write at sampling rate. Heart-rate variability and
 * blood oxygen joined pulse and glucose once watches and rings began writing
 * them every few minutes overnight: their 3650-day "Alle" range read every
 * raw row, which is the read this rule exists to stop.
 */
export const DENSE_SERIES_KINDS: ReadonlySet<string> = new Set([
  "glucose",
  "pulse",
  "heartRateVariability",
  "oxygenSaturation",
]);

/**
 * #1023 — inside the raw window, a dense-kind series (pulse, glucose, HRV,
 * blood oxygen) with more rows than this is bucketed per local hour in SQL
 * instead of sent raw.
 *
 * A watch that records heart rate once a minute puts 43 000 rows in the
 * default 30-day window and 130 000 in 90 days: a 15 MB response the client
 * could not draw at that resolution anyway, built from as many objects on the
 * server. A CGM reading every five minutes puts 26 000 glucose rows in 90
 * days, the same problem at a smaller scale. Hourly buckets carry the hour's
 * mean (pulse also its low/high band, the shape an hourly-bucket import
 * already has) and cap the answer at 24 points a day; the statistics stay
 * computed over every raw reading. The cap sits far above what sparse sources
 * produce (a cuff, fingerstick glucose, hourly buckets over 90 days, a watch
 * sampling every five minutes over 30 days), so those series stay raw and
 * unchanged.
 */
export const DENSE_SERIES_RAW_ROW_CAP = 10_000;

export const kindEnum = z.enum([
  "weight",
  "bloodPressure",
  "pulse",
  "bodyFat",
  "glucose",
  "sleep",
  "steps",
  "totalBodyWater",
  "boneMass",
  "oxygenSaturation",
  // The iOS app surfaces these as series-capable, but
  // the route used to reject the trend/detail view request with a
  // 422. The underlying MeasurementType enum already carries each
  // value; this list extends the camelCase wire shape so the route
  // matches the data it can serve.
  "restingHeartRate",
  "heartRateVariability",
  "vo2Max",
]);

export type SeriesKind = z.infer<typeof kindEnum>;

export const KIND_TO_TYPE: Record<SeriesKind, MeasurementType> = {
  weight: "WEIGHT",
  bloodPressure: "BLOOD_PRESSURE_SYS",
  pulse: "PULSE",
  bodyFat: "BODY_FAT",
  glucose: "BLOOD_GLUCOSE",
  sleep: "SLEEP_DURATION",
  steps: "ACTIVITY_STEPS",
  totalBodyWater: "TOTAL_BODY_WATER",
  boneMass: "BONE_MASS",
  oxygenSaturation: "OXYGEN_SATURATION",
  restingHeartRate: "RESTING_HEART_RATE",
  heartRateVariability: "HEART_RATE_VARIABILITY",
  vo2Max: "VO2_MAX",
};

/**
 * Explicit per-kind unit token returned at the top level so
 * the client never has to infer the value's unit. `bloodPressure` reuses
 * the systolic type's unit (mmHg, same for both lines). `sleep` is
 * overridden at request time to `"h"` because the route returns per-night
 * TIME-ASLEEP in hours rather than the canonical per-stage minutes.
 *
 * `glucose` is the canonical-stored unit (mg/dL) here; it is
 * overridden at request time to the user's `glucoseUnit` preference and the
 * point values are converted to match, so this wire DTO reads in the SAME
 * unit as the CSV + FHIR exports and the blood-glucose detail page (one
 * number, one engine).
 */
export const SERIES_UNIT: Record<SeriesKind, string> = {
  weight: "kg",
  bloodPressure: "mmHg",
  pulse: "bpm",
  bodyFat: "%",
  glucose: "mg/dL",
  sleep: "h",
  steps: "steps",
  totalBodyWater: "kg",
  boneMass: "kg",
  oxygenSaturation: "%",
  restingHeartRate: "bpm",
  heartRateVariability: "ms",
  vo2Max: "mL/(kg·min)",
};

export interface SeriesPoint {
  id: string;
  at: string;
  value: number;
  secondary: number | null;
  /**
   * Per-stage minutes for a sleep night point. `null` for
   * every non-sleep kind. Lets a sleep detail view render the night's
   * stage breakdown without a second fetch; the headline `value` stays
   * the night's TIME-ASLEEP total.
   */
  sleepStages?: Partial<Record<SleepStage, number>> | null;
  /**
   * (iOS #34 extension) — per-point spread for `kind=pulse`. On an
   * aggregated hourly heart-rate bucket `value` is the hour's AVERAGE bpm
   * and these carry the hour's MIN / MAX. `null` for a per-sample PULSE row
   * (no bucket spread) and absent for every non-pulse kind, so a client can
   * render a low/high band only where the data supports it.
   */
  valueMin?: number | null;
  valueMax?: number | null;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const sd = standardDeviation(values, READING_SPREAD) ?? 0;
  return Math.round(sd * 100) / 100;
}

/** The stat strip, when a reader computes it from the raw rows itself. */
export interface SeriesStats {
  mean: number;
  min: number;
  max: number;
  stdDev: number;
  count: number;
}

/** What one reader hands back: the points, and the unit and stats it fixed. */
export interface SeriesRead {
  points: SeriesPoint[];
  unit?: string;
  statsOverride?: SeriesStats | null;
}
