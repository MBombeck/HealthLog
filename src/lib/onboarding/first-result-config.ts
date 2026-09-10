/**
 * v1.39 (C2) — what each first-result task needs to render, as data.
 *
 * The task itself is chosen by the step machine (`chooseFirstResultTask`);
 * this file says what a task's target maps to on the surfaces that already
 * exist: which measurement form and which stored types a Q2 area means,
 * which integration a Q4 source is, and which page carries an area the
 * measurement form cannot log.
 */
import type { OnboardingAreaKey } from "@/lib/modules/registry";

import type { BrowserConnectableSource } from "./wizard-steps";

export interface AreaReadingTarget {
  /** The `defaultType` the measurement form opens on. */
  formType: string;
  /** The stored types the reading lands as, read back for the result tile. */
  storedTypes: readonly string[];
}

/**
 * The areas one reading in the measurement form can answer. Blood pressure
 * is one form mode over two stored rows; the rest are one type each. Mood,
 * cycle, labs and illness have their own surfaces and are linked instead
 * (`AREA_PAGE_HREF`).
 */
export const AREA_READING_TARGETS: Readonly<
  Partial<Record<OnboardingAreaKey, AreaReadingTarget>>
> = Object.freeze({
  "blood-pressure": {
    formType: "BLOOD_PRESSURE",
    storedTypes: ["BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"],
  },
  "weight-body": { formType: "WEIGHT", storedTypes: ["WEIGHT"] },
  glucose: { formType: "BLOOD_GLUCOSE", storedTypes: ["BLOOD_GLUCOSE"] },
  sleep: { formType: "SLEEP_DURATION", storedTypes: ["SLEEP_DURATION"] },
  activity: { formType: "ACTIVITY_STEPS", storedTypes: ["ACTIVITY_STEPS"] },
});

/** Where an area the form cannot log is logged instead. */
export const AREA_PAGE_HREF: Readonly<
  Partial<Record<OnboardingAreaKey, string>>
> = Object.freeze({
  mood: "/mood",
  cycle: "/cycle",
  labs: "/labs",
  illness: "/illness",
});

/**
 * The connections panel's anchor for each connectable source — the `id` of
 * the provider card on Settings → Integrations, and the key its status is
 * published under on `/api/integrations/status`.
 */
export const SOURCE_INTEGRATION: Readonly<
  Record<BrowserConnectableSource, { anchor: string; statusKey: string }>
> = Object.freeze({
  withings: { anchor: "withings", statusKey: "withings" },
  oura: { anchor: "oura", statusKey: "oura" },
  whoop: { anchor: "whoop", statusKey: "whoop" },
  polar: { anchor: "polar", statusKey: "polar" },
  fitbit: { anchor: "fitbit", statusKey: "fitbit" },
  strava: { anchor: "strava", statusKey: "strava" },
  nightscout: { anchor: "nightscout", statusKey: "nightscout" },
});
