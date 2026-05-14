import { describe, expect, it } from "vitest";
import {
  APPLE_HEALTH_SLEEP_STAGE_MAP,
  APPLE_HEALTH_TYPE_MAP,
  HK_QUANTITY_TYPE_DEFERRED,
  mapAppleHealthEntry,
} from "../apple-health-mapping";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import type { MeasurementType } from "@/generated/prisma/client";

/**
 * MeasurementType values that Apple HealthKit has no native counterpart
 * for. Listing them here means the exhaustiveness check below is a tight
 * fence — additions to the canonical enum that genuinely don't have an HK
 * twin (e.g. Withings-only metrics) stay out of the mapping table without
 * silently failing the assertion.
 */
const MEASUREMENT_TYPES_WITHOUT_HK_COUNTERPART = new Set<MeasurementType>([
  // Withings-only metrics (no HK identifier ships any of these as a
  // first-class quantity — Apple delegates body-composition tail to
  // third-party devices via the BodyMass/BodyFat pair).
  "TOTAL_BODY_WATER",
  "BONE_MASS",
  "FAT_FREE_MASS",
  "FAT_MASS",
  "MUSCLE_MASS",
  "SKIN_TEMPERATURE",
  "PULSE_WAVE_VELOCITY",
  "VASCULAR_AGE",
  "VISCERAL_FAT",
]);

describe("APPLE_HEALTH_TYPE_MAP", () => {
  it("only references measurement types that exist in the canonical enum", () => {
    const enumValues = new Set<string>(measurementTypeEnum.options);
    for (const mapping of Object.values(APPLE_HEALTH_TYPE_MAP)) {
      expect(
        enumValues.has(mapping.measurementType),
        `${mapping.hkIdentifier} → unknown MeasurementType ${mapping.measurementType}`,
      ).toBe(true);
    }
  });

  it("uses each mapping key as the canonical hkIdentifier", () => {
    for (const [key, mapping] of Object.entries(APPLE_HEALTH_TYPE_MAP)) {
      expect(mapping.hkIdentifier).toBe(key);
    }
  });

  it("flags the explicit-consent metrics as privacy sensitive", () => {
    const sensitive = Object.values(APPLE_HEALTH_TYPE_MAP)
      .filter((m) => m.isPrivacySensitive)
      .map((m) => m.hkIdentifier)
      .sort();
    expect(sensitive).toEqual(
      [
        "HKCategoryTypeIdentifierSleepAnalysis",
        "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
        "HKQuantityTypeIdentifierVO2Max",
      ].sort(),
    );
    // Audio exposure + time-in-daylight are environment / lifestyle
    // metrics — Apple does not gate them behind an explicit consent
    // screen beyond the bulk "Health share" prompt, so the mapping
    // entries stay non-sensitive.
    const newEntries = [
      "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
      "HKQuantityTypeIdentifierHeadphoneAudioExposure",
      "HKQuantityTypeIdentifierTimeInDaylight",
    ];
    for (const id of newEntries) {
      expect(APPLE_HEALTH_TYPE_MAP[id]?.isPrivacySensitive).toBeUndefined();
    }
  });

  it("covers every MeasurementType that has a HealthKit counterpart", () => {
    const mappedTypes = new Set(
      Object.values(APPLE_HEALTH_TYPE_MAP).map((m) => m.measurementType),
    );
    const expectedTypes = measurementTypeEnum.options.filter(
      (t) => !MEASUREMENT_TYPES_WITHOUT_HK_COUNTERPART.has(t),
    );
    for (const type of expectedTypes) {
      expect(
        mappedTypes.has(type),
        `MeasurementType ${type} has no HealthKit mapping entry`,
      ).toBe(true);
    }
  });

  it("does not double-book a deferred identifier as a mapped one", () => {
    for (const deferred of HK_QUANTITY_TYPE_DEFERRED) {
      expect(
        APPLE_HEALTH_TYPE_MAP[deferred],
        `${deferred} is both deferred and mapped — pick one`,
      ).toBeUndefined();
    }
  });

  it("emits an identity-conversion entry for the three v1.4.25 W8d additions", () => {
    for (const id of [
      "HKQuantityTypeIdentifierEnvironmentalAudioExposure",
      "HKQuantityTypeIdentifierHeadphoneAudioExposure",
      "HKQuantityTypeIdentifierTimeInDaylight",
    ]) {
      const mapping = APPLE_HEALTH_TYPE_MAP[id];
      expect(mapping, `${id} mapping missing`).toBeDefined();
      expect(mapping!.convertToDbUnit(42)).toBe(42);
    }
  });
});

describe("HK_QUANTITY_TYPE_DEFERRED", () => {
  it("contains only valid HealthKit identifier strings", () => {
    for (const id of HK_QUANTITY_TYPE_DEFERRED) {
      expect(id).toMatch(
        /^HK(Quantity|Category|Clinical|Series|Data|Scored|Electrocardiogram)/,
      );
    }
  });

  // v1.4.25 W16a — explicit coverage gate for the iOS-17 + iOS-18
  // long-tail. The brief flagged these as "the iOS app may emit them
  // when the user has the relevant HealthKit category enabled"; the
  // deferred set means the batch endpoint treats them as
  // skipped-but-known rather than unknown-and-dropped.
  it("covers the iOS-17 + iOS-18 long-tail identifiers", () => {
    const expectedLongTail = [
      // Cardiovascular / clinical
      "HKQuantityTypeIdentifierAtrialFibrillationBurden",
      "HKQuantityTypeIdentifierPeripheralPerfusionIndex",
      // Mobility
      "HKQuantityTypeIdentifierAppleWalkingSteadiness",
      "HKQuantityTypeIdentifierNumberOfTimesFallen",
      "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
      // Respiratory / pulmonary
      "HKQuantityTypeIdentifierForcedExpiratoryVolume1",
      "HKQuantityTypeIdentifierForcedVitalCapacity",
      "HKQuantityTypeIdentifierPeakExpiratoryFlowRate",
      "HKQuantityTypeIdentifierInhalerUsage",
      // Other quantity identifiers
      "HKQuantityTypeIdentifierInsulinDelivery",
      "HKQuantityTypeIdentifierUVExposure",
      "HKQuantityTypeIdentifierElectrodermalActivity",
      "HKQuantityTypeIdentifierBloodAlcoholContent",
      "HKQuantityTypeIdentifierNikeFuel",
      // Heart-rhythm event flags
      "HKCategoryTypeIdentifierLowHeartRateEvent",
      "HKCategoryTypeIdentifierHighHeartRateEvent",
      "HKCategoryTypeIdentifierIrregularHeartRhythmEvent",
      "HKCategoryTypeIdentifierLowCardioFitnessEvent",
      // Audio-exposure events
      "HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent",
      "HKCategoryTypeIdentifierHeadphoneAudioExposureEvent",
      "HKCategoryTypeIdentifierEnvironmentalSoundReduction",
      // Behavioural / habit
      "HKCategoryTypeIdentifierHandwashingEvent",
      "HKCategoryTypeIdentifierToothbrushingEvent",
      // Reproductive / fertility / pregnancy
      "HKCategoryTypeIdentifierContraceptive",
      "HKCategoryTypeIdentifierLactation",
      "HKCategoryTypeIdentifierPregnancy",
      "HKCategoryTypeIdentifierPregnancyTestResult",
      "HKCategoryTypeIdentifierProgesteroneTestResult",
      "HKCategoryTypeIdentifierSexualActivity",
      "HKCategoryTypeIdentifierSleepChanges",
      "HKCategoryTypeIdentifierPersistentIntermenstrualBleeding",
      "HKCategoryTypeIdentifierProlongedMenstrualPeriods",
      "HKCategoryTypeIdentifierIrregularMenstrualCycles",
      "HKCategoryTypeIdentifierInfrequentMenstrualCycles",
    ];
    for (const id of expectedLongTail) {
      expect(
        HK_QUANTITY_TYPE_DEFERRED.has(id),
        `${id} should be in the deferred set`,
      ).toBe(true);
    }
  });

  it("does not duplicate any deferred identifier", () => {
    const ids = Array.from(HK_QUANTITY_TYPE_DEFERRED);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("converts oxygen saturation from 0..1 fraction to 0..100 percent", () => {
    const mapping =
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierOxygenSaturation;
    expect(mapping.convertToDbUnit(0.97)).toBeCloseTo(97);
  });

  it("converts body fat percentage from 0..1 fraction to 0..100 percent", () => {
    const mapping =
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierBodyFatPercentage;
    expect(mapping.convertToDbUnit(0.245)).toBeCloseTo(24.5);
  });

  it("uses identity conversion for the SI-aligned identifiers", () => {
    for (const id of [
      "HKQuantityTypeIdentifierBodyMass",
      "HKQuantityTypeIdentifierBloodPressureSystolic",
      "HKQuantityTypeIdentifierBloodPressureDiastolic",
      "HKQuantityTypeIdentifierHeartRate",
      "HKQuantityTypeIdentifierRestingHeartRate",
      "HKQuantityTypeIdentifierHeartRateVariabilitySDNN",
      "HKQuantityTypeIdentifierStepCount",
      "HKQuantityTypeIdentifierActiveEnergyBurned",
      "HKQuantityTypeIdentifierFlightsClimbed",
      "HKQuantityTypeIdentifierDistanceWalkingRunning",
      "HKQuantityTypeIdentifierVO2Max",
      "HKQuantityTypeIdentifierBloodGlucose",
      "HKQuantityTypeIdentifierBodyTemperature",
    ]) {
      const mapping = APPLE_HEALTH_TYPE_MAP[id];
      expect(mapping.convertToDbUnit(42)).toBe(42);
    }
  });
});

describe("APPLE_HEALTH_SLEEP_STAGE_MAP", () => {
  it("maps the iOS 16+ stage codepoints to DB enum values", () => {
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[0]).toBe("IN_BED");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[1]).toBe("ASLEEP");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[2]).toBe("AWAKE");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[3]).toBe("CORE");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[4]).toBe("DEEP");
    expect(APPLE_HEALTH_SLEEP_STAGE_MAP[5]).toBe("REM");
  });

  it("does not double-claim a codepoint for two stages", () => {
    const codepoints = Object.keys(APPLE_HEALTH_SLEEP_STAGE_MAP);
    expect(new Set(codepoints).size).toBe(codepoints.length);
  });
});

describe("mapAppleHealthEntry", () => {
  const ts = "2026-05-10T07:30:00.000Z";

  it("returns null for an unknown identifier", () => {
    expect(
      mapAppleHealthEntry({
        hkIdentifier: "HKQuantityTypeIdentifierHallucinated",
        value: 1,
        unit: "kg",
        startDate: ts,
        endDate: ts,
      }),
    ).toBeNull();
  });

  it("returns null for an invalid endDate", () => {
    expect(
      mapAppleHealthEntry({
        hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
        value: 80,
        unit: "kg",
        startDate: ts,
        endDate: "not-a-date",
      }),
    ).toBeNull();
  });

  it("anchors `takenAt` on the sample's endDate", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value: 81.5,
      unit: "kg",
      startDate: "2026-05-10T07:00:00.000Z",
      endDate: ts,
    });
    expect(out).not.toBeNull();
    expect(out!.takenAt.toISOString()).toBe(ts);
  });

  it("applies the unit conversion for fraction-shaped quantities", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierOxygenSaturation",
      value: 0.97,
      unit: "fraction",
      startDate: ts,
      endDate: ts,
    });
    expect(out).not.toBeNull();
    expect(out!.type).toBe("OXYGEN_SATURATION");
    expect(out!.unit).toBe("%");
    expect(out!.value).toBeCloseTo(97);
    expect(out!.sleepStage).toBeUndefined();
  });

  it("yields a body weight row for a HKQuantityTypeIdentifierBodyMass sample", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value: 81.5,
      unit: "kg",
      startDate: ts,
      endDate: ts,
    });
    expect(out).toEqual({
      type: "WEIGHT",
      value: 81.5,
      unit: "kg",
      takenAt: new Date(ts),
    });
  });

  it("yields a per-stage sleep row for a sleepAnalysis sample", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 95, // minutes spent in this stage
      unit: "min",
      startDate: "2026-05-10T01:00:00.000Z",
      endDate: "2026-05-10T02:35:00.000Z",
      sleepStage: 4, // DEEP
    });
    expect(out).toEqual({
      type: "SLEEP_DURATION",
      value: 95,
      unit: "minutes",
      takenAt: new Date("2026-05-10T02:35:00.000Z"),
      sleepStage: "DEEP",
    });
  });

  it("returns null for a sleepAnalysis sample without a stage codepoint", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 60,
      unit: "min",
      startDate: ts,
      endDate: ts,
    });
    expect(out).toBeNull();
  });

  it("returns null for a sleepAnalysis sample with an unknown stage codepoint", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierSleepAnalysis",
      value: 60,
      unit: "min",
      startDate: ts,
      endDate: ts,
      sleepStage: 99,
    });
    expect(out).toBeNull();
  });
});
