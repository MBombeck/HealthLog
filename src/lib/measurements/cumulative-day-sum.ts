/**
 * v1.4.36 W4c — Pure day-bucket sum picker for cumulative metrics.
 *
 * SLEEP_DURATION already runs this shape inline in
 * `src/app/api/analytics/route.ts` lines 198-225: pick a single
 * source per day (source-priority + device-type) then sum the
 * day's slices into one datapoint per day. The dashboard tile
 * surfaces the resulting `latest` as "X minutes asleep".
 *
 * Steps / active energy / walking distance / flights climbed /
 * time-in-daylight share the same physical shape — every iOS
 * HealthKit ingest writes minute-level slices that the dashboard
 * tile was rendering as the *latest slice* instead of the *day's
 * total*. The maintainer reported "Steps tile shows last-measurement-not-day-sum".
 *
 * This helper extracts the per-day-sum reduction so the route can
 * call it for every cumulative metric without copy-pasting the
 * SLEEP_DURATION branch. The source-priority pick stays in the
 * caller (it already imports `pickCanonicalSourceRows`); this
 * helper only handles the bucket-and-sum once that picker has
 * narrowed each day to its canonical source.
 */

export interface CumulativeRow {
  measuredAt: Date;
  value: number;
}

export interface DaySumPoint {
  date: Date;
  value: number;
}

/**
 * Bucket `rows` by `dayKey(measuredAt)` and sum each bucket's `value`.
 * The returned points are sorted ascending by date, with each
 * bucket's `date` set to the latest `measuredAt` seen in that
 * bucket (matches the SLEEP_DURATION branch's contract).
 *
 * Empty input returns an empty array.
 */
export function pickCumulativeDaySum<T extends CumulativeRow>(
  rows: readonly T[],
  dayKey: (d: Date) => string,
): DaySumPoint[] {
  if (rows.length === 0) return [];

  const byDay = new Map<string, { total: number; date: Date }>();
  for (const row of rows) {
    const key = dayKey(row.measuredAt);
    const slot = byDay.get(key) ?? { total: 0, date: row.measuredAt };
    slot.total += row.value;
    if (row.measuredAt > slot.date) slot.date = row.measuredAt;
    byDay.set(key, slot);
  }

  const out: DaySumPoint[] = Array.from(byDay.values()).map((s) => ({
    date: s.date,
    value: s.total,
  }));
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

import type { MeasurementType } from "@/generated/prisma/client";
import type { SourcePriorityMetricKey } from "@/lib/validations/source-priority";
import { CUMULATIVE_HK_TYPES } from "./apple-health-mapping";

/**
 * v1.4.36 W4c / v1.4.37 W10 — Canonical list of cumulative metric
 * types whose dashboard tile should read the *day's sum* and not the
 * latest slice.
 *
 * The set lives in `apple-health-mapping.ts` as `CUMULATIVE_HK_TYPES`
 * (used by the measurements route + nightly drain + chart). This
 * array is the same membership in stable alphabetical order so
 * downstream consumers (analytics route, exports) can iterate
 * deterministically. The W10 reconcile pass collapses the previously
 * duplicated literal to a single derivation so adding a sixth type
 * in `apple-health-mapping.ts` automatically flows through every
 * cumulative-day-sum consumer.
 *
 * Note: SLEEP_DURATION is also cumulative but the route handles
 * it inline because the picker is the canonical sleep source ladder
 * ("sleep" metricKey vs "default"). Once Apple-Health passthrough
 * lands and the sleep ladder needs the same shared treatment it can
 * fold into `CUMULATIVE_HK_TYPES`.
 */
export const CUMULATIVE_DAY_SUM_TYPES = Array.from(
  CUMULATIVE_HK_TYPES,
).sort() as readonly MeasurementType[];

export type CumulativeDaySumType = (typeof CUMULATIVE_DAY_SUM_TYPES)[number];

export function isCumulativeDaySumType(
  type: string,
): type is CumulativeDaySumType {
  return (CUMULATIVE_DAY_SUM_TYPES as readonly string[]).includes(type);
}

/**
 * v1.4.36 W4c / v1.4.37 W10 — cumulative MeasurementType →
 * SourcePriorityMetricKey lookup for `pickCanonicalSourceRows`.
 *
 * Returns `null` for types without a dedicated priority ladder
 * (e.g. TIME_IN_DAYLIGHT, which lacks a clinical-grade competitor
 * to Apple Health for daylight minutes today). The picker treats a
 * `null` ladder as the "no priority — pass through every row"
 * branch, so the bucket-and-sum runs over every source.
 *
 * Hoisted out of `src/app/api/analytics/route.ts` so adding a new
 * cumulative metric is a single-line edit here rather than a
 * route-level switch that drifts from the `SourcePriorityMetricKey`
 * enum + `CUMULATIVE_HK_TYPES` set. A parity test pins the contract:
 * every member of `CUMULATIVE_HK_TYPES` either resolves to a real
 * `SourcePriorityMetricKey` or is explicitly mapped to `null`.
 */
export function cumulativeMetricKey(
  type: MeasurementType,
): SourcePriorityMetricKey | null {
  switch (type) {
    case "ACTIVITY_STEPS":
      return "steps";
    case "ACTIVE_ENERGY_BURNED":
      return "activeEnergy";
    case "WALKING_RUNNING_DISTANCE":
      return "walkingRunningDistance";
    case "FLIGHTS_CLIMBED":
      return "flightsClimbed";
    default:
      return null;
  }
}

/**
 * v1.11.1 — full MeasurementType → SourcePriorityMetricKey map for the
 * source-aware rollup collapse. A superset of `cumulativeMetricKey`: it adds
 * the overlapping NON-cumulative vitals (spot / daily readings that two or
 * more sources realistically report for the same day) so the rollup read path
 * can resolve the canonical source through the same ladder the raw-row picker
 * uses. Cumulative types fall through to `cumulativeMetricKey`. Returns null
 * for single-source types (no competing source today → source-blind grouping
 * is already correct) and for types without a ladder — the collapse treats a
 * null key as "no priority, keep one row deterministically".
 */
export function metricKeyForType(
  type: MeasurementType,
): SourcePriorityMetricKey | null {
  switch (type) {
    case "RESTING_HEART_RATE":
      return "restingHeartRate";
    case "HEART_RATE_VARIABILITY":
      return "hrv";
    // v1.42 (#1110) — RMSSD has its own ladder: WHOOP, Oura, Polar and,
    // since iOS 27, Apple Health all write it, so one day can hold it from
    // two sources.
    case "HRV_RMSSD":
      return "hrvRmssd";
    case "RESPIRATORY_RATE":
      return "respiratoryRate";
    case "OXYGEN_SATURATION":
      return "spo2";
    case "BODY_TEMPERATURE":
      return "bodyTemperature";
    case "SKIN_TEMPERATURE":
      return "skinTemperature";
    case "WEIGHT":
      return "weight";
    case "BODY_FAT":
      return "bodyFat";
    case "BLOOD_PRESSURE_SYS":
    case "BLOOD_PRESSURE_DIA":
      return "bloodPressure";
    case "PULSE":
      return "pulse";
    case "VO2_MAX":
      return "vo2Max";
    case "RECOVERY_SCORE":
      return "recovery";
    case "STRESS_SCORE":
      // v1.18.10 I-5 — ladder the COMPUTED-vs-device stress producer so the
      // rollup source collapse is deterministic the instant a second producer
      // (Oura `daily_stress`) is enabled, rather than falling to the
      // alphabetical rank-90 tiebreak in `collapseRollupRowsBySource`.
      return "stress";
    case "SLEEP_DURATION":
      return "sleep";
    default:
      return cumulativeMetricKey(type);
  }
}
