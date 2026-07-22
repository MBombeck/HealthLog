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
