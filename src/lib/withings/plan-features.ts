/**
 * The readings a Withings API-plan refusal can withhold, as the settings card
 * names them. Pure: no database, no network, so the OpenAPI registry and the
 * client bundle can import it.
 */
import type { WithingsApiPlanState } from "./api-plan";
import { ownValue } from "@/lib/own-key";

/** The Withings plans page, linked from the settings card and the docs. */
export const WITHINGS_API_PLANS_URL =
  "https://static.withings.com/content/api/plans/plans.html";

/**
 * The closed set of reading names the Withings card can show for a plan
 * refusal, in display order. Server-resolved so every client renders the same
 * list; each has a label under `settings.integrations.withings.plan.items`.
 */
export const WITHINGS_PLAN_FEATURES = [
  "spo2",
  "vascularAge",
  "pulseWaveVelocity",
  "vo2Max",
  "visceralFat",
  "skinTemperature",
  "ecg",
  "sleepScore",
  "sleepHrv",
  "sleepHeartRate",
  "sleepRespiratoryRate",
  "sleepSpo2",
  "bodyTemperature",
  "bodyFat",
  "fatMass",
  "fatFreeMass",
  "muscleMass",
  "bodyWater",
  "boneMass",
  "heartRate",
  "bloodPressure",
  "weight",
] as const;

export type WithingsPlanFeature = (typeof WITHINGS_PLAN_FEATURES)[number];

const MEASTYPE_FEATURE: Record<number, WithingsPlanFeature> = {
  1: "weight",
  5: "fatFreeMass",
  6: "bodyFat",
  8: "fatMass",
  9: "bloodPressure",
  10: "bloodPressure",
  11: "heartRate",
  12: "bodyTemperature",
  35: "spo2",
  54: "spo2",
  71: "bodyTemperature",
  73: "skinTemperature",
  76: "muscleMass",
  77: "bodyWater",
  88: "boneMass",
  91: "pulseWaveVelocity",
  123: "vo2Max",
  155: "vascularAge",
  170: "visceralFat",
};

const SLEEP_FIELD_FEATURE: Record<string, WithingsPlanFeature> = {
  hr_average: "sleepHeartRate",
  rr_average: "sleepRespiratoryRate",
  sdnn_1: "sleepHrv",
  spo2_average: "sleepSpo2",
  sleep_score: "sleepScore",
};

/**
 * The readings this connection's plan currently withholds, deduplicated and in
 * display order. Empty when nothing is refused.
 */
export function withingsPlanUnavailableFeatures(
  state: WithingsApiPlanState,
): WithingsPlanFeature[] {
  const found = new Set<WithingsPlanFeature>();
  for (const t of state.measures?.unavailable ?? []) {
    const f = MEASTYPE_FEATURE[t];
    if (f) found.add(f);
  }
  for (const field of state.sleepSummary?.unavailable ?? []) {
    const f = ownValue(SLEEP_FIELD_FEATURE, field);
    if (f) found.add(f);
  }
  if ((state.ecg?.unavailable.length ?? 0) > 0) found.add("ecg");
  return WITHINGS_PLAN_FEATURES.filter((f) => found.has(f));
}
