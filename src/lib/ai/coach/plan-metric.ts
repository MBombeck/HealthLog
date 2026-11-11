/**
 * A Coach plan's `metric` is a short key the model writes (`WEIGHT`, `SLEEP`,
 * `BLOOD_PRESSURE`, …), not a closed enum. This maps the keys HealthLog can
 * read to a measurement series, the English label the Coach's memory block
 * uses, and the message key a screen shows. Pure, so the plans page can use
 * it as well as the server.
 */
import type { MeasurementType } from "@/generated/prisma/client";

export interface ResolvedPlanMetric {
  type: MeasurementType;
  /** Short English label for the Coach's memory block. */
  label: string;
  /** The measurement's name in the reader's language. */
  labelKey: string;
}

/**
 * The series behind a plan's metric, or `null` for a metric HealthLog does not
 * read (a screen then shows the key as written).
 */
export function resolvePlanMetric(metric: string): ResolvedPlanMetric | null {
  const m = metric
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  switch (m) {
    case "WEIGHT":
      return {
        type: "WEIGHT",
        label: "weight",
        labelKey: "measurements.typeWeight",
      };
    case "SLEEP":
    case "SLEEP_DURATION":
      return {
        type: "SLEEP_DURATION",
        label: "sleep",
        labelKey: "measurements.typeSleep",
      };
    case "BLOOD_PRESSURE":
    case "BLOOD_PRESSURE_SYS":
    case "SYSTOLIC":
      return {
        type: "BLOOD_PRESSURE_SYS",
        label: "systolic",
        labelKey: "measurements.typeBloodPressure",
      };
    case "STEPS":
    case "ACTIVITY_STEPS":
      return {
        type: "ACTIVITY_STEPS",
        label: "steps",
        labelKey: "measurements.typeSteps",
      };
    case "GLUCOSE":
    case "BLOOD_GLUCOSE":
      return {
        type: "BLOOD_GLUCOSE",
        label: "glucose",
        labelKey: "measurements.typeBloodGlucose",
      };
    case "PULSE":
    case "RESTING_HEART_RATE":
      return {
        type: "RESTING_HEART_RATE",
        label: "resting heart rate",
        labelKey: "measurements.typeRestingHeartRate",
      };
    case "HRV":
    case "HEART_RATE_VARIABILITY":
      return {
        type: "HEART_RATE_VARIABILITY",
        label: "HRV",
        labelKey: "measurements.typeHeartRateVariability",
      };
    default:
      return null;
  }
}

/**
 * A plan's or reminder's metric in the reader's language; a key HealthLog
 * does not read shows as written.
 */
export function planMetricLabel(
  metric: string,
  t: (key: string) => string,
): string {
  const resolved = resolvePlanMetric(metric);
  return resolved ? t(resolved.labelKey) : metric;
}
