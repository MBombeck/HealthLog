/**
 * Mapping per Garmin resource, over made-up records shaped from Garmin's
 * OpenAPI document (Personal API 1.0.0). No value here comes from a real
 * account.
 */
import { describe, expect, it } from "vitest";

import {
  mapGarminDailySummary,
  mapGarminHrv,
  mapGarminSleep,
  mapGarminWeightRange,
  parseGarminInstant,
} from "../map";
import { mapGarminActivity } from "../sync-workouts";
import { mapGarminSportType } from "../sport-map";
import { garminCycleDay, periodFromGarminCycleSummary } from "../cycle-sync";
import { estimateGarminKeyExpiry, resolveGarminKeyExpiry } from "../key-expiry";

const TZ = "Europe/Berlin";

function byType(rows: Array<{ type: string; value: number }>) {
  return Object.fromEntries(rows.map((r) => [r.type, r.value]));
}

describe("parseGarminInstant", () => {
  it("reads epoch ms and zone-less GMT strings", () => {
    expect(parseGarminInstant(1_792_560_600_000)?.toISOString()).toBe(
      "2026-10-21T05:30:00.000Z",
    );
    expect(parseGarminInstant("2026-10-22 05:15:02")?.toISOString()).toBe(
      "2026-10-22T05:15:02.000Z",
    );
    expect(parseGarminInstant("2026-10-22T05:40:00.0")?.toISOString()).toBe(
      "2026-10-22T05:40:00.000Z",
    );
    expect(parseGarminInstant(null)).toBeNull();
    expect(parseGarminInstant("")).toBeNull();
  });
});

describe("mapGarminDailySummary", () => {
  const day = {
    calendarDate: "2026-10-22",
    includesWellnessData: true,
    movement: {
      steps: { value: 8421, distanceInMeters: 6410.5 },
      floorsAscended: { value: 7 },
    },
    calories: { burnedActive: 512 },
    heartRate: { restingValue: 55 },
    stress: { avgLevel: 31 },
    bodyBattery: { maxValue: 88 },
  };

  it("maps every daily field to its type and unit, keyed on the day", () => {
    const rows = mapGarminDailySummary(day, TZ);
    expect(byType(rows)).toEqual({
      ACTIVITY_STEPS: 8421,
      WALKING_RUNNING_DISTANCE: 6410.5,
      FLIGHTS_CLIMBED: 7,
      ACTIVE_ENERGY_BURNED: 512,
      RESTING_HEART_RATE: 55,
      STRESS_LEVEL: 31,
      BODY_BATTERY: 88,
    });
    const units = Object.fromEntries(rows.map((r) => [r.type, r.unit]));
    expect(units).toMatchObject({
      ACTIVITY_STEPS: "steps",
      WALKING_RUNNING_DISTANCE: "m",
      FLIGHTS_CLIMBED: "flights",
      ACTIVE_ENERGY_BURNED: "kcal",
      RESTING_HEART_RATE: "bpm",
      STRESS_LEVEL: "score",
      BODY_BATTERY: "score",
    });
    expect(rows.map((r) => r.externalId)).toContain(
      "daily:2026-10-22:body_battery",
    );
    // Local noon of the date in the user's zone (CEST, UTC+2).
    expect(rows[0]!.measuredAt.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });

  it("writes nothing for a day the watch recorded nothing", () => {
    expect(
      mapGarminDailySummary({ ...day, includesWellnessData: false }, TZ),
    ).toEqual([]);
    expect(
      mapGarminDailySummary({ ...day, includesWellnessData: null }, TZ),
    ).toEqual([]);
  });

  it("drops Garmin's negative not-enough-data sentinels", () => {
    const rows = mapGarminDailySummary(
      { ...day, stress: { avgLevel: -1 }, bodyBattery: { maxValue: -2 } },
      TZ,
    );
    expect(rows.map((r) => r.type)).not.toContain("STRESS_LEVEL");
    expect(rows.map((r) => r.type)).not.toContain("BODY_BATTERY");
  });
});

describe("mapGarminSleep", () => {
  const night = {
    calendarDate: "2026-10-22",
    sleepTimeSeconds: 25_200,
    sleepEndTimestampGMT: 1_792_647_000_000,
    deepSleepSeconds: 5_400,
    lightSleepSeconds: 13_800,
    remSleepSeconds: 6_000,
    awakeSleepSeconds: 900,
    averageSpO2Value: 95,
    averageRespirationValue: 14.5,
    sleepScores: { overall: { value: 79, qualifierKey: "FAIR" } },
  };

  it("maps stage totals onto the wake instant, light as CORE", () => {
    const rows = mapGarminSleep(night, TZ);
    const stages = rows
      .filter((r) => r.type === "SLEEP_DURATION")
      .map((r) => [r.sleepStage, r.value]);
    expect(stages).toEqual([
      ["CORE", 230],
      ["DEEP", 90],
      ["REM", 100],
      ["AWAKE", 15],
    ]);
    for (const r of rows) {
      expect(r.measuredAt.getTime()).toBe(1_792_647_000_000);
    }
    expect(byType(rows.filter((r) => r.type !== "SLEEP_DURATION"))).toEqual({
      SLEEP_SCORE: 79,
      OXYGEN_SATURATION: 95,
      RESPIRATORY_RATE: 14.5,
    });
    expect(new Set(rows.map((r) => r.externalId)).size).toBe(rows.length);
  });

  it("maps a no-sleep day (null date, all-null fields) to nothing", () => {
    expect(
      mapGarminSleep(
        {
          calendarDate: null,
          sleepTimeSeconds: null,
          deepSleepSeconds: null,
        },
        TZ,
      ),
    ).toEqual([]);
    expect(mapGarminSleep({ ...night, sleepTimeSeconds: 0 }, TZ)).toEqual([]);
  });
});

describe("mapGarminHrv", () => {
  it("maps the overnight average to HRV_RMSSD and skips empty nights", () => {
    const rows = mapGarminHrv(
      {
        hrvSummaries: [
          { calendarDate: "2026-10-21", lastNightAvg: 41 },
          { calendarDate: "2026-10-22", lastNightAvg: null },
          { calendarDate: null, lastNightAvg: 50 },
        ],
      },
      TZ,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "HRV_RMSSD",
      value: 41,
      unit: "ms",
      externalId: "hrv:2026-10-21:hrv_rmssd",
    });
    expect(mapGarminHrv(null, TZ)).toEqual([]);
  });
});

describe("mapGarminWeightRange", () => {
  it("converts grams to kilograms and body water from percent", () => {
    const rows = mapGarminWeightRange({
      dailyWeightSummaries: [
        {
          summaryDate: "2026-10-20",
          allWeightMetrics: [
            {
              samplePk: 11,
              timestampGMT: 1_792_474_200_000,
              weight: 80_000,
              bmi: 24.7,
              bodyFat: 18.5,
              bodyWater: 55,
              muscleMass: 36_400,
              boneMass: 3_200,
              visceralFat: 7,
              sourceType: "INDEX_SCALE",
            },
          ],
        },
        {
          summaryDate: "2026-10-21",
          latestWeight: {
            samplePk: 12,
            date: 1_792_560_000_000,
            weight: 79_600,
          },
        },
      ],
    });
    const first = rows.filter((r) => r.externalId.startsWith("weight:11:"));
    expect(byType(first)).toEqual({
      WEIGHT: 80,
      BODY_MASS_INDEX: 24.7,
      BODY_FAT: 18.5,
      TOTAL_BODY_WATER: 44,
      MUSCLE_MASS: 36.4,
      BONE_MASS: 3.2,
      VISCERAL_FAT: 7,
    });
    expect(first.every((r) => r.deviceType === "scale")).toBe(true);
    const second = rows.filter((r) => r.externalId.startsWith("weight:12:"));
    expect(byType(second)).toEqual({ WEIGHT: 79.6 });
    expect(second[0]!.deviceType).toBeUndefined();
  });

  it("does not write a weigh-in twice when it is both latest and listed", () => {
    const w = { samplePk: 5, date: 1_792_560_000_000, weight: 70_000 };
    const rows = mapGarminWeightRange({
      dailyWeightSummaries: [{ latestWeight: w, allWeightMetrics: [w] }],
    });
    expect(rows).toHaveLength(1);
  });
});

describe("mapGarminActivity", () => {
  it("maps an activity to a workout row", () => {
    const row = mapGarminActivity({
      activityId: 10_000_000_001,
      startTimeGMT: "2026-10-22 05:15:02",
      activityType: { typeKey: "trail_running" },
      distance: 8012.4,
      duration: 2701.3,
      elapsedDuration: 2750.5,
      elevationGain: 54,
      calories: 610.4,
      averageHR: 148,
      maxHR: 171,
      steps: 7400,
      aerobicTrainingEffect: 3.2,
      activityTrainingLoad: 112.5,
    });
    expect(row).toMatchObject({
      externalId: "10000000001",
      sportType: "running",
      durationSec: 2701,
      totalEnergyKcal: 610,
      totalDistanceM: 8012.4,
      avgHeartRate: 148,
      maxHeartRate: 171,
      stepCount: 7400,
      elevationM: 54,
      metadata: {
        garminActivity: "trail_running",
        garminAerobicEffect: 3.2,
        garminTrainingLoad: 112.5,
      },
    });
    expect(row!.startedAt.toISOString()).toBe("2026-10-22T05:15:02.000Z");
    expect(row!.endedAt.getTime() - row!.startedAt.getTime()).toBe(2_750_500);
  });

  it("drops an activity without id, start or duration", () => {
    expect(
      mapGarminActivity({ startTimeGMT: "2026-10-22 05:15:02" }),
    ).toBeNull();
    expect(mapGarminActivity({ activityId: 1, duration: 60 })).toBeNull();
    expect(
      mapGarminActivity({
        activityId: 1,
        beginTimestamp: 1_792_560_000_000,
        duration: 0,
      }),
    ).toBeNull();
  });
});

describe("mapGarminSportType", () => {
  it.each([
    ["running", "running"],
    ["road_biking", "cycling"],
    ["lap_swimming", "swimming"],
    ["kayaking_v2", "rowing"],
    ["strength_training", "strength"],
    ["yoga", "yoga"],
    ["resort_skiing", "other"],
    ["something_new", "other"],
    [null, "other"],
  ])("%s → %s", (key, expected) => {
    expect(mapGarminSportType(key)).toBe(expected);
  });
});

describe("cycle summary", () => {
  it("reads a cycle date bare or wrapped", () => {
    expect(garminCycleDay("2026-10-10")).toBe("2026-10-10");
    expect(garminCycleDay({ localDate: "2026-10-10" })).toBe("2026-10-10");
    expect(garminCycleDay({ date: "2026-10-10T00:00:00Z" })).toBe("2026-10-10");
    expect(garminCycleDay(null)).toBeNull();
  });

  it("derives the logged period days, never in the future", () => {
    expect(
      periodFromGarminCycleSummary(
        { startDate: "2026-10-10", periodLength: 5, predictedCycle: false },
        "2026-11-04",
      ),
    ).toEqual({
      start: "2026-10-10",
      days: [
        "2026-10-10",
        "2026-10-11",
        "2026-10-12",
        "2026-10-13",
        "2026-10-14",
      ],
    });
    expect(
      periodFromGarminCycleSummary(
        { startDate: "2026-11-03", periodLength: 5 },
        "2026-11-04",
      )?.days,
    ).toEqual(["2026-11-03", "2026-11-04"]);
  });

  it("imports nothing from a predicted cycle or a pregnancy", () => {
    expect(
      periodFromGarminCycleSummary(
        { startDate: "2026-10-10", periodLength: 5, predictedCycle: true },
        "2026-11-04",
      ),
    ).toBeNull();
    expect(
      periodFromGarminCycleSummary(
        { startDate: "2026-10-10", periodLength: 5, pregnancyCycle: true },
        "2026-11-04",
      ),
    ).toBeNull();
    expect(periodFromGarminCycleSummary({}, "2026-11-04")).toBeNull();
  });
});

describe("key expiry", () => {
  const now = new Date("2026-11-04T12:00:00Z");

  it("estimates the end from the picked validity", () => {
    expect(
      estimateGarminKeyExpiry(
        new Date("2026-11-01T00:00:00Z"),
        90,
      ).toISOString(),
    ).toBe("2027-01-30T00:00:00.000Z");
  });

  it("is ok well ahead, expiring inside the last week, expired after", () => {
    expect(
      resolveGarminKeyExpiry(new Date("2026-12-01T00:00:00Z"), now).state,
    ).toBe("ok");
    const soon = resolveGarminKeyExpiry(new Date("2026-11-08T00:00:00Z"), now);
    expect(soon).toMatchObject({ state: "expiring", daysLeft: 3 });
    expect(
      resolveGarminKeyExpiry(new Date("2026-11-04T18:00:00Z"), now).daysLeft,
    ).toBe(0);
    expect(
      resolveGarminKeyExpiry(new Date("2026-11-01T00:00:00Z"), now),
    ).toMatchObject({ state: "expired", daysLeft: null });
    expect(resolveGarminKeyExpiry(null, now)).toEqual({
      state: "unknown",
      expiresAt: null,
      daysLeft: null,
    });
  });
});
