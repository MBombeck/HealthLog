import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { CoachScopeSource } from "@/lib/ai/coach/types";
import { requireFloor } from "@/__tests__/helpers/source-files";
import {
  scopeSourceFromMetricKey,
  scopeSourceMetricLabelKey,
} from "../coach-metric-scope";

const PROJECT_ROOT = resolve(import.meta.dirname, "../../../..");
const MESSAGE_BUNDLES = ["en", "de"].map((locale) =>
  JSON.parse(
    readFileSync(join(PROJECT_ROOT, `messages/${locale}.json`), "utf8"),
  ),
);

function translationAt(bundle: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((current, segment) => {
    if (
      current == null ||
      typeof current !== "object" ||
      !(segment in current)
    ) {
      return undefined;
    }
    return (current as Record<string, unknown>)[segment];
  }, bundle);
}

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function genericMetricCardInventory(): Set<string> {
  const insightRouteSources = requireFloor(
    "insight route sources",
    sourceFilesBelow(join(PROJECT_ROOT, "src/app/insights")),
    60,
  ).map((path) => readFileSync(path, "utf8"));
  const recoverySource = readFileSync(
    join(PROJECT_ROOT, "src/components/insights/recovery/recovery-section.tsx"),
    "utf8",
  );

  const statusMetrics = insightRouteSources.flatMap((source) =>
    Array.from(
      source.matchAll(/\bstatusMetric\s*=\s*"([A-Z0-9_]+)"/g),
      (m) => m[1],
    ),
  );
  const directMetrics = insightRouteSources.flatMap((source) =>
    Array.from(
      source.matchAll(
        /<MetricStatusCard\b[\s\S]*?\bmetric\s*=\s*"([A-Z0-9_]+)"[\s\S]*?\/>/g,
      ),
      (m) => m[1],
    ),
  );
  const recoveryMetrics = Array.from(
    recoverySource.matchAll(/\bstatusMetric\s*:\s*"([A-Z0-9_]+)"/g),
    (m) => m[1],
  );

  return new Set([...statusMetrics, ...directMetrics, ...recoveryMetrics]);
}

/**
 * Every generic assessment mount is classified here. A non-null value means
 * the Coach snapshot has a source backed by the exact data on that card;
 * null records that no matching source exists and prevents a tempting but
 * incorrect near-match (for example wrist temperature → skin temperature).
 */
const GENERIC_METRIC_SCOPE_EXPECTATION: Readonly<
  Record<string, CoachScopeSource | null>
> = {
  ACTIVE_ENERGY: "active_energy",
  AUDIO_EXPOSURE_EVENT: "audio_event",
  AUDIO_EXPOSURE_ENV: "audio_env",
  AUDIO_EXPOSURE_HEADPHONE: "audio_headphone",
  BLOOD_GLUCOSE: "glucose",
  BODY_TEMPERATURE: "body_temp",
  BONE_MASS: "bone_mass",
  FAT_FREE_MASS: "fat_free_mass",
  FAT_MASS: "fat_mass",
  FLIGHTS_CLIMBED: "flights",
  HEART_RATE_VARIABILITY: "hrv",
  LEAN_BODY_MASS: "lean_body_mass",
  MUSCLE_MASS: "muscle_mass",
  OXYGEN_SATURATION: "spo2",
  PULSE_WAVE_VELOCITY: "pulse_wave_velocity",
  RESPIRATORY_RATE: "respiratory_rate",
  RESTING_HEART_RATE: "resting_hr",
  SKIN_TEMPERATURE: "skin_temp",
  SLEEP_DURATION: "sleep",
  STEPS: "steps",
  TIME_IN_DAYLIGHT: "daylight",
  TOTAL_BODY_WATER: "total_body_water",
  VASCULAR_AGE: "vascular_age",
  VISCERAL_FAT: "visceral_fat",
  VO2_MAX: "vo2_max",
  WALKING_ASYMMETRY: "walking_asymmetry",
  WALKING_DOUBLE_SUPPORT: "walking_double_support",
  WALKING_HEART_RATE_AVERAGE: "walking_hr",
  WALKING_RUNNING_DISTANCE: "distance",
  WALKING_SPEED: "walking_speed",
  WALKING_STEADINESS: "walking_steadiness",
  WALKING_STEP_LENGTH: "walking_step_length",

  ANS_CHARGE: null,
  AVERAGE_HEART_RATE: null,
  BREATHING_DISTURBANCES: null,
  CARDIO_LOAD: null,
  BODY_BATTERY: null,
  STRESS_LEVEL: null,
  TRAINING_READINESS: null,
  ACUTE_TRAINING_LOAD: null,
  CARDIO_RECOVERY: null,
  DAY_STRAIN: null,
  ENERGY_EXPENDITURE_KJ: null,
  FALL_COUNT: null,
  GRIP_STRENGTH: null,
  MAX_HEART_RATE: null,
  PAIN_NRS: null,
  SIX_MINUTE_WALK_DISTANCE: null,
  STAIR_ASCENT_SPEED: null,
  STAIR_DESCENT_SPEED: null,
  WAIST_CIRCUMFERENCE: null,
  WAIST_TO_HEIGHT: null,
  WORKOUT_STRAIN: null,
  WRIST_TEMPERATURE: null,
};

describe("generic MetricStatusCard Coach scope inventory", () => {
  it("classifies every mounted status metric and scopes every exact Coach source", () => {
    const mountedMetrics = genericMetricCardInventory();
    expect([...mountedMetrics].sort()).toEqual(
      Object.keys(GENERIC_METRIC_SCOPE_EXPECTATION).sort(),
    );

    for (const [metric, expectedSource] of Object.entries(
      GENERIC_METRIC_SCOPE_EXPECTATION,
    )) {
      expect(scopeSourceFromMetricKey(metric), metric).toBe(expectedSource);
    }
  });

  it("uses an existing localized measurement label for every scoped mount", () => {
    const supportedSources = new Set(
      Object.values(GENERIC_METRIC_SCOPE_EXPECTATION).filter(
        (source): source is CoachScopeSource => source !== null,
      ),
    );

    for (const source of supportedSources) {
      const labelKey = scopeSourceMetricLabelKey(source);
      expect(labelKey, source).not.toBeNull();
      for (const messages of MESSAGE_BUNDLES) {
        expect(
          translationAt(messages, labelKey!),
          `${source}: ${labelKey}`,
        ).toEqual(expect.any(String));
      }
    }
  });
});
