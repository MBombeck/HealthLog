import { describe, expect, it } from "vitest";
import {
  APPLE_HEALTH_SLEEP_STAGE_MAP,
  APPLE_HEALTH_TYPE_MAP,
  CUMULATIVE_HK_TYPES,
  HIGH_FREQUENCY_MEAN_TYPES,
  HK_QUANTITY_TYPE_DEFERRED,
  dailyStatsExternalId,
  hkIdentifierForType,
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
  // v1.10.0 — computed scores (WX-C). Server-derived wellness scores
  // (Recovery / Stress / Strain) are minted by a nightly engine from the
  // user's already-stored signals; HealthKit ships no identifier for them
  // and they are never ingested, so they have no HK mapping by design.
  "RECOVERY_SCORE",
  "STRESS_SCORE",
  "STRAIN_SCORE",
  // v1.11.0 — WHOOP-native score classes. These ingest server-side from the
  // WHOOP API (source = WHOOP), never from HealthKit; Apple ships no
  // identifier for day/workout strain, the WHOOP sleep-quality indices, sleep
  // need, RMSSD HRV (Apple ships only the SDNN variant), or kJ energy. They
  // have no HK mapping by design.
  "HRV_RMSSD",
  "DAY_STRAIN",
  "WORKOUT_STRAIN",
  "SLEEP_PERFORMANCE",
  "SLEEP_EFFICIENCY",
  "SLEEP_CONSISTENCY",
  "SLEEP_NEED",
  "ENERGY_EXPENDITURE_KJ",
  // v1.12.8 — WHOOP cycle + sleep coverage completion. These ingest
  // server-side from the WHOOP API (source = WHOOP), never from HealthKit:
  // Apple ships no first-class daily-aggregate average / max heart-rate
  // quantity, and the per-night disturbance count is WHOOP-specific (Apple
  // ships sleep stages, not a disturbance tally). No HK mapping by design.
  "AVERAGE_HEART_RATE",
  "MAX_HEART_RATE",
  "SLEEP_DISTURBANCE_COUNT",
  // v1.17.1 — Polar Nightly Recharge + Training Load Pro components. These
  // ingest server-side from the Polar AccessLink API (source = POLAR), never
  // from HealthKit: Apple ships no identifier for Polar's autonomic charge or
  // its device-native cardio-load strain figure. No HK mapping by design.
  "ANS_CHARGE",
  "CARDIO_LOAD",
  // v1.17.1 — Oura coverage completion. The Sleep Score and the body-temperature
  // deviation ingest server-side from the Oura API (source = OURA), never from
  // HealthKit: Apple ships no headline 0–100 sleep score and surfaces only an
  // absolute wrist temperature, not a signed baseline deviation. No HK mapping
  // by design.
  "SLEEP_SCORE",
  "BODY_TEMPERATURE_DEVIATION",
  // v1.19.0 — Oura resilience. The resilience level ingests server-side from
  // the Oura API (source = OURA), never from HealthKit: Apple ships no
  // resilience metric. No HK mapping by design.
  "RESILIENCE",
  // v1.25 — clinical-signals wave. The mental-health screener totals are
  // derived from an in-app questionnaire, and grip strength / pain NRS are
  // manual / instrument readings — none ships a first-class HealthKit quantity
  // we ingest, so they have no HK mapping by design. Waist-to-height is a
  // server-derived ratio (no HK quantity). `WAIST_CIRCUMFERENCE` DOES round-
  // trip via `HKQuantityTypeIdentifierWaistCircumference`, so it is NOT listed
  // here.
  "PHQ9_SCORE",
  "GAD7_SCORE",
  "GRIP_STRENGTH",
  "PAIN_NRS",
  "WAIST_TO_HEIGHT",
  // v1.27.9 — WHO-5 / SCI screening totals: same in-app questionnaire
  // derivation as PHQ-9 / GAD-7. No HK mapping by design.
  "WHO5_SCORE",
  "SCI_SCORE",
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
        // v1.10.0 — overnight wrist temperature + the sleep-breathing
        // index ride behind an explicit Health-share consent, same as
        // HRV / VO2 max / sleep analysis.
        "HKQuantityTypeIdentifierAppleSleepingWristTemperature",
        "HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances",
        // v1.10.0 — the categorical EVENT classes carry health-screening
        // verdicts (rhythm / heart-rate / mobility / breathing) the user
        // explicitly enabled on-device; flagged privacy-sensitive so the
        // server audit trail can distinguish them.
        "HKCategoryTypeIdentifierIrregularHeartRhythmEvent",
        "HKCategoryTypeIdentifierHighHeartRateEvent",
        "HKCategoryTypeIdentifierLowHeartRateEvent",
        "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
        "HKCategoryTypeIdentifierSleepApneaEvent",
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
      // Mobility — `AppleWalkingSteadiness` moved into the mapped set in
      // v1.4.30. In v1.10.0 both remaining identifiers moved in too:
      // `NumberOfTimesFallen` → FALL_COUNT and `AppleWalkingSteadinessEvent`
      // → WALKING_STEADINESS_EVENT, so neither stays deferred.
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
      // Heart-rhythm event flags — `LowHeartRateEvent`,
      // `HighHeartRateEvent` + `IrregularHeartRhythmEvent` moved into the
      // mapped set in v1.10.0 as categorical events. `LowCardioFitnessEvent`
      // stays deferred (no awareness surface yet).
      "HKCategoryTypeIdentifierLowCardioFitnessEvent",
      // Audio-exposure events — environmental + headphone moved into
      // the mapped set in v1.4.30 (AUDIO_EXPOSURE_EVENT). The general
      // sound-reduction flag stays deferred.
      "HKCategoryTypeIdentifierEnvironmentalSoundReduction",
      // Behavioural / habit
      "HKCategoryTypeIdentifierHandwashingEvent",
      "HKCategoryTypeIdentifierToothbrushingEvent",
      // Reproductive / fertility — v1.15.0 promoted MenstrualFlow,
      // IntermenstrualBleeding, CervicalMucusQuality, OvulationTestResult,
      // Contraceptive, PregnancyTestResult, ProgesteroneTestResult,
      // SexualActivity and SleepChanges OUT of the deferred list (they route
      // into CYCLE day-logs via the cycle accumulator). Pregnancy +
      // Lactation STATUS and the four awareness types stay deferred (no
      // v1.15.0 schema destination / server-derived).
      "HKCategoryTypeIdentifierLactation",
      "HKCategoryTypeIdentifierPregnancy",
      "HKCategoryTypeIdentifierBleedingAfterPregnancy",
      "HKCategoryTypeIdentifierBleedingDuringPregnancy",
      "HKCategoryTypeIdentifierPersistentIntermenstrualBleeding",
      "HKCategoryTypeIdentifierProlongedMenstrualPeriods",
      "HKCategoryTypeIdentifierIrregularMenstrualCycles",
      "HKCategoryTypeIdentifierInfrequentMenstrualCycles",
    ];

    // v1.15.0 — these are NO LONGER deferred (promoted into cycle day-logs).
    for (const id of [
      "HKCategoryTypeIdentifierMenstrualFlow",
      "HKCategoryTypeIdentifierIntermenstrualBleeding",
      "HKCategoryTypeIdentifierCervicalMucusQuality",
      "HKCategoryTypeIdentifierOvulationTestResult",
      "HKCategoryTypeIdentifierContraceptive",
      "HKCategoryTypeIdentifierPregnancyTestResult",
      "HKCategoryTypeIdentifierProgesteroneTestResult",
      "HKCategoryTypeIdentifierSexualActivity",
    ]) {
      expect(
        HK_QUANTITY_TYPE_DEFERRED.has(id),
        `${id} should NOT be deferred (promoted to cycle in v1.15.0)`,
      ).toBe(false);
    }
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

  it("round-trips waist circumference from HK metres to canonical cm", () => {
    const mapping =
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierWaistCircumference;
    expect(mapping.measurementType).toBe("WAIST_CIRCUMFERENCE");
    expect(mapping.dbUnit).toBe("cm");
    // 0.84 m → 84 cm.
    expect(mapping.convertToDbUnit(0.84)).toBeCloseTo(84);
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierWaistCircumference",
      value: 0.92,
      unit: "m",
      startDate: "2026-06-28T08:00:00.000Z",
      endDate: "2026-06-28T08:00:00.000Z",
    });
    expect(out).not.toBeNull();
    expect(out!.type).toBe("WAIST_CIRCUMFERENCE");
    expect(out!.value).toBeCloseTo(92);
    expect(out!.unit).toBe("cm");
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

  it("stores a batch reading in the unit the table assumes, whatever `unit` says", () => {
    // issue #944 — the batch route's `unit` is captured for audit and never
    // read. A client that stamps the person's DISPLAY unit into the field
    // must not have its metres multiplied by a thousand: the conversion is
    // opt-in and only the `export.xml` path opts in.
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierDistanceWalkingRunning",
      value: 2484,
      unit: "km",
      startDate: ts,
      endDate: ts,
    });
    expect(out).not.toBeNull();
    expect(out!.value).toBe(2484);
    expect(out!.unit).toBe("m");
  });

  it("converts out of the record's own unit when the caller opts in", () => {
    const out = mapAppleHealthEntry(
      {
        hkIdentifier: "HKQuantityTypeIdentifierDistanceWalkingRunning",
        value: 2.484,
        unit: "km",
        startDate: ts,
        endDate: ts,
      },
      { convertRecordUnit: true },
    );
    expect(out).not.toBeNull();
    expect(out!.value).toBeCloseTo(2484, 9);
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

describe("v1.5.5 iOS-coord additions — six previously-deferred identifiers", () => {
  it("maps every one of the six identifiers", () => {
    const expected: Array<[string, string]> = [
      ["HKQuantityTypeIdentifierRespiratoryRate", "RESPIRATORY_RATE"],
      ["HKQuantityTypeIdentifierBodyMassIndex", "BODY_MASS_INDEX"],
      ["HKQuantityTypeIdentifierLeanBodyMass", "LEAN_BODY_MASS"],
      [
        "HKQuantityTypeIdentifierWalkingHeartRateAverage",
        "WALKING_HEART_RATE_AVERAGE",
      ],
      [
        "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
        "WALKING_ASYMMETRY",
      ],
      [
        "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
        "WALKING_DOUBLE_SUPPORT",
      ],
    ];
    for (const [hkId, type] of expected) {
      const mapping = APPLE_HEALTH_TYPE_MAP[hkId];
      expect(mapping, `${hkId} should be mapped`).toBeDefined();
      expect(mapping.measurementType).toBe(type);
    }
  });

  it("scales the gait percent identifiers ×100 server-side (project convention)", () => {
    const asym =
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierWalkingAsymmetryPercentage;
    const ds =
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierWalkingDoubleSupportPercentage;
    // Apple ships these as 0..1 fractions; HealthLog stores 0..100.
    expect(asym.convertToDbUnit(0.07)).toBeCloseTo(7);
    expect(ds.convertToDbUnit(0.2)).toBeCloseTo(20);
    expect(asym.dbUnit).toBe("%");
    expect(ds.dbUnit).toBe("%");
  });

  it("keeps identity conversion for the non-percent additions", () => {
    expect(
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierRespiratoryRate.convertToDbUnit(
        16,
      ),
    ).toBe(16);
    expect(
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierBodyMassIndex.convertToDbUnit(
        24.5,
      ),
    ).toBe(24.5);
    expect(
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierLeanBodyMass.convertToDbUnit(
        62,
      ),
    ).toBe(62);
    expect(
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierWalkingHeartRateAverage.convertToDbUnit(
        96,
      ),
    ).toBe(96);
  });

  it("removes the six identifiers from the deferred set", () => {
    const previouslyDeferred = [
      "HKQuantityTypeIdentifierRespiratoryRate",
      "HKQuantityTypeIdentifierBodyMassIndex",
      "HKQuantityTypeIdentifierLeanBodyMass",
      "HKQuantityTypeIdentifierWalkingHeartRateAverage",
      "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
      "HKQuantityTypeIdentifierWalkingDoubleSupportPercentage",
    ];
    for (const id of previouslyDeferred) {
      expect(
        HK_QUANTITY_TYPE_DEFERRED.has(id),
        `${id} should no longer be deferred`,
      ).toBe(false);
    }
  });

  it("round-trips a respiratory-rate sample through mapAppleHealthEntry", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierRespiratoryRate",
      value: 16,
      unit: "count/min",
      startDate: "2026-05-28T03:00:00.000Z",
      endDate: "2026-05-28T07:00:00.000Z",
    });
    expect(out).toEqual({
      type: "RESPIRATORY_RATE",
      value: 16,
      unit: "breaths/min",
      takenAt: new Date("2026-05-28T07:00:00.000Z"),
    });
  });

  it("round-trips a walking-asymmetry sample with ×100 scaling", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierWalkingAsymmetryPercentage",
      value: 0.07,
      unit: "%",
      startDate: "2026-05-28T08:00:00.000Z",
      endDate: "2026-05-28T08:00:00.000Z",
    });
    expect(out).not.toBeNull();
    expect(out!.type).toBe("WALKING_ASYMMETRY");
    expect(out!.unit).toBe("%");
    expect(out!.value).toBeCloseTo(7);
  });
});

describe("v1.5.5 iOS-coord follow-up — raw-SI gait pair", () => {
  it("maps walkingStepLength + walkingSpeed to the new MeasurementTypes", () => {
    const sl = APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierWalkingStepLength;
    const sp = APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierWalkingSpeed;
    expect(sl).toBeDefined();
    expect(sp).toBeDefined();
    expect(sl.measurementType).toBe("WALKING_STEP_LENGTH");
    expect(sp.measurementType).toBe("WALKING_SPEED");
    expect(sl.dbUnit).toBe("m");
    expect(sp.dbUnit).toBe("m/s");
  });

  it("passes raw SI values through unchanged (no ×100 scaling)", () => {
    // Crucial convention pin: the percent gait metrics scale ×100
    // server-side because Apple ships 0..1 fractions; step length
    // and speed are already in metres / metres-per-second and MUST
    // round-trip as identity. A future contributor wiring a new
    // gait identifier should add to the right bucket — this test
    // is the regression sentinel for that decision.
    const sl = APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierWalkingStepLength;
    const sp = APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierWalkingSpeed;
    expect(sl.convertToDbUnit(0.72)).toBe(0.72);
    expect(sl.convertToDbUnit(1.5)).toBe(1.5);
    expect(sp.convertToDbUnit(1.3)).toBe(1.3);
    expect(sp.convertToDbUnit(2.1)).toBe(2.1);
  });

  it("removes both identifiers from the deferred set", () => {
    expect(
      HK_QUANTITY_TYPE_DEFERRED.has(
        "HKQuantityTypeIdentifierWalkingStepLength",
      ),
    ).toBe(false);
    expect(
      HK_QUANTITY_TYPE_DEFERRED.has("HKQuantityTypeIdentifierWalkingSpeed"),
    ).toBe(false);
  });

  it("round-trips a walking-step-length sample through mapAppleHealthEntry", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierWalkingStepLength",
      value: 0.72,
      unit: "m",
      startDate: "2026-05-28T09:00:00.000Z",
      endDate: "2026-05-28T09:00:00.000Z",
    });
    expect(out).toEqual({
      type: "WALKING_STEP_LENGTH",
      value: 0.72,
      unit: "m",
      takenAt: new Date("2026-05-28T09:00:00.000Z"),
    });
  });

  it("round-trips a walking-speed sample through mapAppleHealthEntry", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierWalkingSpeed",
      value: 1.34,
      unit: "m/s",
      startDate: "2026-05-28T09:00:00.000Z",
      endDate: "2026-05-28T09:00:00.000Z",
    });
    expect(out).toEqual({
      type: "WALKING_SPEED",
      value: 1.34,
      unit: "m/s",
      takenAt: new Date("2026-05-28T09:00:00.000Z"),
    });
  });
});

describe("v1.4.30 Tier-1 additions (R-F T1.4 + T1.5)", () => {
  it("maps appleWalkingSteadiness to WALKING_STEADINESS with × 100 scaling", () => {
    const mapping =
      APPLE_HEALTH_TYPE_MAP.HKQuantityTypeIdentifierAppleWalkingSteadiness;
    expect(mapping).toBeDefined();
    expect(mapping.measurementType).toBe("WALKING_STEADINESS");
    expect(mapping.convertToDbUnit(0.85)).toBeCloseTo(85);
    expect(mapping.dbUnit).toBe("%");
  });

  it("maps environmental + headphone audio-exposure events to AUDIO_EXPOSURE_EVENT (count 1)", () => {
    const envMapping =
      APPLE_HEALTH_TYPE_MAP.HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent;
    expect(envMapping).toBeDefined();
    expect(envMapping.measurementType).toBe("AUDIO_EXPOSURE_EVENT");
    expect(envMapping.convertToDbUnit(0)).toBe(1);
    expect(envMapping.convertToDbUnit(99)).toBe(1);

    const hpMapping =
      APPLE_HEALTH_TYPE_MAP.HKCategoryTypeIdentifierHeadphoneAudioExposureEvent;
    expect(hpMapping).toBeDefined();
    expect(hpMapping.measurementType).toBe("AUDIO_EXPOSURE_EVENT");
    expect(hpMapping.convertToDbUnit(0)).toBe(1);
  });

  it("does not double-book the new identifiers as deferred AND mapped", () => {
    expect(
      HK_QUANTITY_TYPE_DEFERRED.has(
        "HKQuantityTypeIdentifierAppleWalkingSteadiness",
      ),
    ).toBe(false);
    expect(
      HK_QUANTITY_TYPE_DEFERRED.has(
        "HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent",
      ),
    ).toBe(false);
    expect(
      HK_QUANTITY_TYPE_DEFERRED.has(
        "HKCategoryTypeIdentifierHeadphoneAudioExposureEvent",
      ),
    ).toBe(false);
  });
});

describe("dailyStatsExternalId (v1.4.30 — R-A Option A handoff lock)", () => {
  it("produces the canonical stats:<type>:<date> shape for stepCount", () => {
    expect(
      dailyStatsExternalId("HKQuantityTypeIdentifierStepCount", "2026-05-16"),
    ).toBe("stats:HKQuantityTypeIdentifierStepCount:2026-05-16");
  });

  it("produces the same shape for every cumulative-type identifier", () => {
    const cases: Array<[string, string]> = [
      ["HKQuantityTypeIdentifierStepCount", "2026-01-01"],
      ["HKQuantityTypeIdentifierActiveEnergyBurned", "2026-02-29"],
      ["HKQuantityTypeIdentifierFlightsClimbed", "2025-12-31"],
      ["HKQuantityTypeIdentifierDistanceWalkingRunning", "2024-02-29"],
      ["HKQuantityTypeIdentifierTimeInDaylight", "2026-05-16"],
    ];
    for (const [id, day] of cases) {
      expect(dailyStatsExternalId(id, day)).toBe(`stats:${id}:${day}`);
    }
  });

  it("accepts the date string as-is — iOS owns the format", () => {
    // Per R-A §5, iOS generates the date string from the user's IANA
    // timezone via DateFormatter with the `yyyy-MM-dd` pattern. The
    // server trusts the inbound shape rather than re-validating; the
    // receiving Zod schema already caps `externalId` at 120 chars.
    expect(
      dailyStatsExternalId("HKQuantityTypeIdentifierStepCount", " 2026-05-16 "),
    ).toBe("stats:HKQuantityTypeIdentifierStepCount: 2026-05-16 ");
    expect(dailyStatsExternalId("HKQuantityTypeIdentifierStepCount", "")).toBe(
      "stats:HKQuantityTypeIdentifierStepCount:",
    );
  });

  it("covers every CUMULATIVE_HK_TYPES MeasurementType via a known HK identifier", () => {
    // Sanity wall: every cumulative MeasurementType has a forward-map
    // entry in APPLE_HEALTH_TYPE_MAP so the iOS-side daily-stats
    // service can mint the externalId without a server round-trip.
    const cumulativeIdentifiers = Object.values(APPLE_HEALTH_TYPE_MAP)
      .filter((m) => CUMULATIVE_HK_TYPES.has(m.measurementType))
      .map((m) => m.hkIdentifier);
    expect(cumulativeIdentifiers.sort()).toEqual(
      [
        "HKQuantityTypeIdentifierStepCount",
        "HKQuantityTypeIdentifierActiveEnergyBurned",
        "HKQuantityTypeIdentifierFlightsClimbed",
        "HKQuantityTypeIdentifierDistanceWalkingRunning",
        "HKQuantityTypeIdentifierTimeInDaylight",
        // v1.10.0 — hard-fall detections accumulate across the day.
        "HKQuantityTypeIdentifierNumberOfTimesFallen",
      ].sort(),
    );
  });
});

describe("HIGH_FREQUENCY_MEAN_TYPES (v1.7.0)", () => {
  it("is strictly disjoint from CUMULATIVE_HK_TYPES", () => {
    for (const type of HIGH_FREQUENCY_MEAN_TYPES) {
      expect(CUMULATIVE_HK_TYPES.has(type)).toBe(false);
    }
    for (const type of CUMULATIVE_HK_TYPES) {
      expect(HIGH_FREQUENCY_MEAN_TYPES.has(type)).toBe(false);
    }
  });

  it("excludes PULSE — correlation/scatter read raw PULSE rows", () => {
    expect(HIGH_FREQUENCY_MEAN_TYPES.has("PULSE" as MeasurementType)).toBe(
      false,
    );
  });

  it("covers the genuinely-orphan high-frequency spot metrics", () => {
    expect(Array.from(HIGH_FREQUENCY_MEAN_TYPES).sort()).toEqual(
      [
        "RESPIRATORY_RATE",
        "AUDIO_EXPOSURE_ENV",
        "AUDIO_EXPOSURE_HEADPHONE",
        "WALKING_SPEED",
        "WALKING_STEP_LENGTH",
        // v1.8.5 — the gait/mobility metrics that previously fell to no
        // consolidation set and piled up raw at sampling granularity.
        "WALKING_ASYMMETRY",
        "WALKING_DOUBLE_SUPPORT",
        "WALKING_STEADINESS",
        "WALKING_HEART_RATE_AVERAGE",
        // v1.10.0 — stair gait speeds arrive per-climb at sampling
        // granularity; the per-day mean is the right consolidation.
        "STAIR_ASCENT_SPEED",
        "STAIR_DESCENT_SPEED",
      ].sort(),
    );
  });

  it("consolidates the v1.8.5 gait/mobility metrics", () => {
    for (const type of [
      "WALKING_ASYMMETRY",
      "WALKING_DOUBLE_SUPPORT",
      "WALKING_STEADINESS",
      "WALKING_HEART_RATE_AVERAGE",
    ] as const) {
      expect(HIGH_FREQUENCY_MEAN_TYPES.has(type)).toBe(true);
    }
  });

  it("every mean type resolves to a HealthKit identifier", () => {
    for (const type of HIGH_FREQUENCY_MEAN_TYPES) {
      expect(hkIdentifierForType(type)).not.toBeNull();
    }
  });
});

describe("v1.10.0 additive HealthKit signals (WX-A)", () => {
  const WXA = {
    HKQuantityTypeIdentifierHeartRateRecoveryOneMinute: {
      type: "CARDIO_RECOVERY",
      dbUnit: "bpm",
    },
    HKQuantityTypeIdentifierAppleSleepingWristTemperature: {
      type: "WRIST_TEMPERATURE",
      dbUnit: "celsius",
    },
    HKQuantityTypeIdentifierNumberOfTimesFallen: {
      type: "FALL_COUNT",
      dbUnit: "count",
    },
    HKQuantityTypeIdentifierSixMinuteWalkTestDistance: {
      type: "SIX_MINUTE_WALK_DISTANCE",
      dbUnit: "m",
    },
    HKQuantityTypeIdentifierStairAscentSpeed: {
      type: "STAIR_ASCENT_SPEED",
      dbUnit: "m/s",
    },
    HKQuantityTypeIdentifierStairDescentSpeed: {
      type: "STAIR_DESCENT_SPEED",
      dbUnit: "m/s",
    },
    HKQuantityTypeIdentifierAppleSleepingBreathingDisturbances: {
      type: "BREATHING_DISTURBANCES",
      dbUnit: "count",
    },
  } as const;

  it("maps each new identifier to its canonical type + unit with identity conversion", () => {
    for (const [hk, expected] of Object.entries(WXA)) {
      const mapping = APPLE_HEALTH_TYPE_MAP[hk];
      expect(mapping, `${hk} mapping missing`).toBeDefined();
      expect(mapping!.measurementType).toBe(expected.type);
      expect(mapping!.dbUnit).toBe(expected.dbUnit);
      // None of the WX-A signals ships a 0..1 fraction — every one
      // passes through `convertToDbUnit` as identity.
      expect(mapping!.convertToDbUnit(42)).toBe(42);
    }
  });

  it("removes each wired identifier from the deferred set", () => {
    for (const hk of Object.keys(WXA)) {
      expect(
        HK_QUANTITY_TYPE_DEFERRED.has(hk),
        `${hk} should no longer be deferred`,
      ).toBe(false);
    }
  });

  it("round-trips a cardio-recovery sample through mapAppleHealthEntry", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierHeartRateRecoveryOneMinute",
      value: 35,
      unit: "count/min",
      startDate: "2026-06-02T08:00:00.000Z",
      endDate: "2026-06-02T08:01:00.000Z",
    });
    expect(out).toEqual({
      type: "CARDIO_RECOVERY",
      value: 35,
      unit: "bpm",
      takenAt: new Date("2026-06-02T08:01:00.000Z"),
    });
  });
});

describe("v1.10.0 categorical events (WX-B)", () => {
  const ts = "2026-06-02T07:30:00.000Z";

  it("maps every event identifier to its EVENT MeasurementType", () => {
    const expected: Array<[string, string]> = [
      [
        "HKCategoryTypeIdentifierIrregularHeartRhythmEvent",
        "IRREGULAR_RHYTHM_NOTIFICATION",
      ],
      ["HKCategoryTypeIdentifierHighHeartRateEvent", "HIGH_HEART_RATE_EVENT"],
      ["HKCategoryTypeIdentifierLowHeartRateEvent", "LOW_HEART_RATE_EVENT"],
      [
        "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
        "WALKING_STEADINESS_EVENT",
      ],
      [
        "HKCategoryTypeIdentifierSleepApneaEvent",
        "BREATHING_DISTURBANCE_EVENT",
      ],
    ];
    for (const [hkId, type] of expected) {
      const mapping = APPLE_HEALTH_TYPE_MAP[hkId];
      expect(mapping, `${hkId} should be mapped`).toBeDefined();
      expect(mapping.measurementType).toBe(type);
      // EVENT rows are always a single fired occurrence regardless of the
      // inbound number — the device fired it once.
      expect(mapping.convertToDbUnit(999)).toBe(1);
      expect(mapping.dbUnit).toBe("event");
    }
  });

  it("resolves the irregular-rhythm event to the device's IRREGULAR verdict", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierIrregularHeartRhythmEvent",
      value: 0,
      unit: "event",
      startDate: ts,
      endDate: ts,
      categoryValue: 0,
    });
    expect(out).toEqual({
      type: "IRREGULAR_RHYTHM_NOTIFICATION",
      value: 1,
      unit: "event",
      takenAt: new Date(ts),
      rhythmClassification: "IRREGULAR",
    });
  });

  it("grades the walking-steadiness event severity from the codepoint", () => {
    const low = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
      value: 0,
      unit: "event",
      startDate: ts,
      endDate: ts,
      categoryValue: 1, // initialLow
    });
    expect(low!.rhythmClassification).toBe("LOW");

    const veryLow = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
      value: 0,
      unit: "event",
      startDate: ts,
      endDate: ts,
      categoryValue: 3, // initialVeryLow
    });
    expect(veryLow!.rhythmClassification).toBe("VERY_LOW");
  });

  it("falls back to FIRED for the neutral high/low-HR + breathing events", () => {
    for (const hkId of [
      "HKCategoryTypeIdentifierHighHeartRateEvent",
      "HKCategoryTypeIdentifierLowHeartRateEvent",
      "HKCategoryTypeIdentifierSleepApneaEvent",
    ]) {
      const out = mapAppleHealthEntry({
        hkIdentifier: hkId,
        value: 0,
        unit: "event",
        startDate: ts,
        endDate: ts,
      });
      expect(out!.value).toBe(1);
      expect(out!.rhythmClassification).toBe("FIRED");
    }
  });

  it("degrades an unknown steadiness codepoint to the fallback rather than dropping it", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKCategoryTypeIdentifierAppleWalkingSteadinessEvent",
      value: 0,
      unit: "event",
      startDate: ts,
      endDate: ts,
      categoryValue: 99, // Apple introduced a codepoint we don't enumerate
    });
    expect(out).not.toBeNull();
    expect(out!.rhythmClassification).toBe("LOW");
  });

  it("never sets rhythmClassification on a continuous measurement", () => {
    const out = mapAppleHealthEntry({
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value: 80,
      unit: "kg",
      startDate: ts,
      endDate: ts,
      categoryValue: 1,
    });
    expect(out!.rhythmClassification).toBeUndefined();
  });
});
