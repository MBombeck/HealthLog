import { describe, expect, it } from "vitest";
import { buildGlucoseTargets } from "../glucose-builder";
import { buildMedicationTarget } from "../medication-builder";
import { buildMoodTargets } from "../mood-builder";
import { buildSleepTarget } from "../sleep-builder";
import { buildTargetPageSummary } from "../summary-builder";
import { buildVitalTargets } from "../vitals-builder";

const NOW = new Date("2026-07-21T12:00:00.000Z");
const TZ = "UTC";

describe("target section builders", () => {
  it("keeps the vital target order and profile-gated cards on an empty profile", () => {
    const result = buildVitalTargets({
      recentMeasurements: [],
      latestByType: {},
      average30ByType: {},
      heightCm: null,
      age: null,
      gender: null,
      timezone: TZ,
      now: NOW,
      weightTargetOverride: null,
    });

    expect(result.targets.map((target) => target.type)).toEqual([
      "WEIGHT",
      "BLOOD_PRESSURE",
      "PULSE",
      "BODY_FAT",
      "ACTIVITY_STEPS",
    ]);
    expect(result.bpRange).toBeNull();
    expect(result.targets.every((target) => target.insufficientData)).toBe(
      true,
    );
  });

  it("returns the sleep card with the exact empty-series public shape", () => {
    expect(
      buildSleepTarget({
        sleepStageRows: [],
        timezone: TZ,
        sourcePriorityJson: null,
        now: NOW,
      }),
    ).toEqual({
      type: "SLEEP_DURATION",
      label: "Sleep duration",
      current: null,
      average30: null,
      trend: null,
      unit: "h",
      range: { min: 7, max: 9 },
      classification: null,
      source: "AASM/SRS",
      daysInRange7d: 0,
      daysLogged7d: 0,
      daysInRange30d: 0,
      daysLogged30d: 0,
      lastMetGoalAt: null,
      streakDays: 0,
      insufficientData: true,
      consistency7d: [null, null, null, null, null, null, null],
    });
  });

  it("omits medication compliance when no scheduled medications are active", () => {
    expect(
      buildMedicationTarget({
        activeMedications: [],
        intakeEvents: [],
        timezone: TZ,
        now: NOW,
      }),
    ).toBeNull();
  });

  it("keeps mood hidden below the three-entry threshold", () => {
    expect(
      buildMoodTargets({
        moodRollups: [
          {
            bucketStart: NOW,
            count: 2,
            mean: 4,
          },
        ],
        recentRawMood: null,
        latestMoodEntry: { score: 4, moodLoggedAt: NOW },
        timezone: TZ,
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("emits glucose cards in public context order and skips empty contexts", () => {
    const rows = [
      {
        value: 130,
        measuredAt: NOW,
        glucoseContext: "RANDOM" as const,
      },
      {
        value: 90,
        measuredAt: NOW,
        glucoseContext: "FASTING" as const,
      },
    ];
    const targets = buildGlucoseTargets({
      rows,
      profile: {
        heightCm: 180,
        dateOfBirth: new Date("1985-01-01T00:00:00.000Z"),
        gender: "MALE",
        glucoseUnit: "mg/dL",
        hasDiabetes: false,
        thresholdsJson: null,
      },
      timezone: TZ,
      now: NOW,
    });

    expect(targets.map((target) => target.type)).toEqual([
      "BLOOD_GLUCOSE_FASTING",
      "BLOOD_GLUCOSE_RANDOM",
    ]);
    expect(targets[0]).toMatchObject({
      label: "targets.glucoseFasting",
      current: 90,
      average30: 90,
      unit: "mg/dL",
      source: "ADA 2024 / DDG",
      insufficientData: true,
    });
  });

  it("emits a card for readings with no meal-time context (#943)", () => {
    // A meter synced through Apple Health writes no HealthKit meal-time
    // metadata, so every row arrives with a null context. Iterating the four
    // named contexts alone returned no glucose target at all.
    const targets = buildGlucoseTargets({
      rows: [
        { value: 112, measuredAt: NOW, glucoseContext: null },
        { value: 104, measuredAt: NOW, glucoseContext: null },
      ],
      profile: {
        heightCm: 180,
        dateOfBirth: new Date("1985-01-01T00:00:00.000Z"),
        gender: "MALE",
        glucoseUnit: "mg/dL",
        hasDiabetes: false,
        thresholdsJson: null,
      },
      timezone: TZ,
      now: NOW,
    });

    expect(targets.map((target) => target.type)).toEqual([
      "BLOOD_GLUCOSE_UNSPECIFIED",
    ]);
    expect(targets[0]).toMatchObject({
      label: "targets.glucoseUnspecified",
      current: 112,
      average30: 108,
      unit: "mg/dL",
    });
    // The untagged bucket is judged against the RANDOM band, so it still
    // carries a range and a classification rather than a blank card.
    expect(targets[0].range).not.toBeNull();
    expect(targets[0].classification).not.toBeNull();
  });

  it("keeps the tagged breakdown and puts the untagged bucket last (#943)", () => {
    const targets = buildGlucoseTargets({
      rows: [
        { value: 130, measuredAt: NOW, glucoseContext: "RANDOM" as const },
        { value: 90, measuredAt: NOW, glucoseContext: "FASTING" as const },
        { value: 111, measuredAt: NOW, glucoseContext: null },
      ],
      profile: {
        heightCm: 180,
        dateOfBirth: new Date("1985-01-01T00:00:00.000Z"),
        gender: "MALE",
        glucoseUnit: "mg/dL",
        hasDiabetes: false,
        thresholdsJson: null,
      },
      timezone: TZ,
      now: NOW,
    });

    expect(targets.map((target) => target.type)).toEqual([
      "BLOOD_GLUCOSE_FASTING",
      "BLOOD_GLUCOSE_RANDOM",
      "BLOOD_GLUCOSE_UNSPECIFIED",
    ]);
  });

  it("keeps summary streak ties stable by public target order", () => {
    expect(
      buildTargetPageSummary([
        {
          type: "WEIGHT",
          daysInRange7d: 4,
          insufficientData: false,
          streakDays: 3,
        },
        {
          type: "PULSE",
          daysInRange7d: 5,
          insufficientData: false,
          streakDays: 3,
        },
        {
          type: "SLEEP_DURATION",
          daysInRange7d: 7,
          insufficientData: true,
          streakDays: 2,
        },
      ]),
    ).toEqual({
      targetsMetThisWeek: 2,
      totalTargets: 3,
      streakHighlight: { metric: "WEIGHT", days: 3 },
    });
  });
});

/**
 * v1.34 — the weight card grades against the user's own target when one is set,
 * so the `/targets` reference panel and the weight chart above it name the same
 * band. The panel used to show the WHO BMI band unconditionally.
 */
describe("buildVitalTargets — user weight target", () => {
  const base = {
    recentMeasurements: [],
    latestByType: {},
    average30ByType: {},
    heightCm: 178,
    age: 40,
    gender: null,
    timezone: TZ,
    now: NOW,
  };

  it("shows the WHO BMI band when no target is set", () => {
    const weight = buildVitalTargets({
      ...base,
      weightTargetOverride: null,
    }).targets.find((t) => t.type === "WEIGHT");
    expect(weight?.source).toBe("WHO BMI");
    expect(weight?.range).not.toEqual({ min: 74, max: 78 });
  });

  it("shows the user's own band, labelled as theirs, when one is set", () => {
    const weight = buildVitalTargets({
      ...base,
      weightTargetOverride: { min: 74, max: 78 },
    }).targets.find((t) => t.type === "WEIGHT");
    expect(weight?.range).toEqual({ min: 74, max: 78 });
    expect(weight?.source).toBe("Custom");
  });
});
