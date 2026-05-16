import { describe, expect, it } from "vitest";

import { measurementTypeEnum } from "@/lib/validations/measurement";

import {
  MEASUREMENT_CATEGORIES,
  getMeasurementCategory,
  measurementTypesForCategory,
} from "../categories";

describe("MEASUREMENT_CATEGORIES — completeness wall", () => {
  it("assigns a category to every MeasurementType in the canonical enum", () => {
    const enumValues = measurementTypeEnum.options;
    for (const type of enumValues) {
      expect(
        MEASUREMENT_CATEGORIES.has(type),
        `MeasurementType ${type} has no category assignment`,
      ).toBe(true);
    }
  });

  it("does not assign a category to a type the canonical enum does not know", () => {
    const enumValues = new Set<string>(measurementTypeEnum.options);
    for (const type of MEASUREMENT_CATEGORIES.keys()) {
      expect(
        enumValues.has(type),
        `MeasurementType ${type} is mapped but not in the canonical enum`,
      ).toBe(true);
    }
  });

  it("groups blood-pressure systolic and diastolic into the same category", () => {
    expect(MEASUREMENT_CATEGORIES.get("BLOOD_PRESSURE_SYS")).toBe(
      MEASUREMENT_CATEGORIES.get("BLOOD_PRESSURE_DIA"),
    );
  });
});

describe("getMeasurementCategory", () => {
  it("returns the category for a known type", () => {
    expect(getMeasurementCategory("WEIGHT")).toBe("body");
    expect(getMeasurementCategory("BLOOD_GLUCOSE")).toBe("metabolic");
    expect(getMeasurementCategory("ACTIVITY_STEPS")).toBe("activity");
    expect(getMeasurementCategory("AUDIO_EXPOSURE_HEADPHONE")).toBe("hearing");
  });
});

describe("measurementTypesForCategory", () => {
  it("lists every type assigned to a category", () => {
    expect(measurementTypesForCategory("hearing").sort()).toEqual([
      "AUDIO_EXPOSURE_ENV",
      "AUDIO_EXPOSURE_EVENT",
      "AUDIO_EXPOSURE_HEADPHONE",
    ]);
  });

  it("returns an empty list for a category with no members today", () => {
    // None of the current 27 enum values surface a mood-specific
    // MeasurementType — mood lives in MoodEntry — so the category
    // can be queried without surprise (mostly a sanity wall for the
    // R-F §4.4 synthetic-token decision).
    const allCategories: ReadonlyArray<string> = Array.from(
      new Set(Array.from(MEASUREMENT_CATEGORIES.values())),
    );
    for (const cat of allCategories) {
      const members = measurementTypesForCategory(cat as never);
      expect(members.length, `${cat} should not be empty`).toBeGreaterThan(0);
    }
  });

  it("includes the v1.4.25 W8d hearing + environment additions", () => {
    // Regression sentinel — v1.4.25 W8d added AUDIO_EXPOSURE_ENV /
    // AUDIO_EXPOSURE_HEADPHONE / TIME_IN_DAYLIGHT. The categorisation
    // overlay must pick them up so the iOS picker surfaces them under
    // Hearing + Environment rather than dropping them into the flat
    // 27-line view that the overlay exists to avoid.
    expect(measurementTypesForCategory("hearing")).toContain(
      "AUDIO_EXPOSURE_ENV",
    );
    expect(measurementTypesForCategory("environment")).toContain(
      "TIME_IN_DAYLIGHT",
    );
  });
});
