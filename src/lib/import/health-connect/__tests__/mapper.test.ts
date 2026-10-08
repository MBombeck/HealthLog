/**
 * Health Connect records onto HealthLog rows: units (grams, small calories,
 * mmol/L), blood pressure as two rows, the TEXT enum columns, sport types,
 * device classes, identities and the per-category app ranking.
 */
import { describe, expect, it } from "vitest";

import {
  AppRanking,
  DAILY_SUM_SPECS,
  INSTANT_SPECS,
  NUTRITION_COLUMNS,
  dayKeyFromEpochDay,
  deviceClassFromHc,
  glucoseContextFromRelation,
  hcDailyStatsExternalId,
  hcExternalId,
  hcHourlyPulseExternalId,
  mapHealthConnectSportType,
} from "../mapper";

const spec = (table: string) => {
  const found = INSTANT_SPECS.find((s) => s.table === table);
  if (!found) throw new Error(table);
  return found;
};

describe("instant readings", () => {
  it("weight and lean mass arrive in grams and are stored in kilograms", () => {
    expect(spec("weight_record_table").map({ weight: 80_250 })).toEqual([
      { type: "WEIGHT", value: 80.25 },
    ]);
    expect(spec("lean_body_mass_record_table").map({ mass: 61_000 })).toEqual([
      { type: "LEAN_BODY_MASS", value: 61 },
    ]);
  });

  it("blood pressure becomes a systolic and a diastolic row, never half of one", () => {
    // The location and body position are TEXT columns holding '3' and '2';
    // they must not get in the way of the reading.
    expect(
      spec("blood_pressure_record_table").map({
        systolic: 128,
        diastolic: 84,
        measurement_location: "3",
        body_position: "2",
      }),
    ).toEqual([
      { type: "BLOOD_PRESSURE_SYS", value: 128 },
      { type: "BLOOD_PRESSURE_DIA", value: 84 },
    ]);
    expect(
      spec("blood_pressure_record_table").map({
        systolic: 128,
        diastolic: null,
      }),
    ).toEqual([]);
  });

  it("glucose arrives in mmol/L and is stored in mg/dL with its meal relation", () => {
    expect(
      spec("blood_glucose_record_table").map({
        level: 5.5,
        relation_to_meal: "2",
      }),
    ).toEqual([
      { type: "BLOOD_GLUCOSE", value: 99, glucoseContext: "FASTING" },
    ]);
    expect(glucoseContextFromRelation(4)).toBe("POSTPRANDIAL");
    expect(glucoseContextFromRelation(3)).toBeNull();
    expect(glucoseContextFromRelation(null)).toBeNull();
  });

  it("vital signs pass through in their own units", () => {
    expect(
      spec("heart_rate_variability_rmssd_record_table").map({
        heart_rate_variability_millis: 42.5,
      }),
    ).toEqual([{ type: "HRV_RMSSD", value: 42.5 }]);
    expect(
      spec("oxygen_saturation_record_table").map({ percentage: 96 }),
    ).toEqual([{ type: "OXYGEN_SATURATION", value: 96 }]);
    expect(spec("respiratory_rate_record_table").map({ rate: 14.5 })).toEqual([
      { type: "RESPIRATORY_RATE", value: 14.5 },
    ]);
    expect(
      spec("body_temperature_record_table").map({ temperature: 36.6 }),
    ).toEqual([{ type: "BODY_TEMPERATURE", value: 36.6 }]);
    expect(
      spec("vo2_max_record_table").map({
        vo2_milliliters_per_minute_kilogram: 44.2,
      }),
    ).toEqual([{ type: "VO2_MAX", value: 44.2 }]);
    expect(
      spec("resting_heart_rate_record_table").map({ beats_per_minute: 58 }),
    ).toEqual([{ type: "RESTING_HEART_RATE", value: 58 }]);
    expect(spec("body_fat_record_table").map({ percentage: 21.5 })).toEqual([
      { type: "BODY_FAT", value: 21.5 },
    ]);
  });

  it("drops a record whose value column is not a number", () => {
    expect(spec("weight_record_table").map({ weight: null })).toEqual([]);
    expect(spec("weight_record_table").map({ weight: "heavy" })).toEqual([]);
  });
});

describe("day totals and nutrients", () => {
  it("active energy is stored in kcal, from small calories", () => {
    const energy = DAILY_SUM_SPECS.find(
      (s) => s.type === "ACTIVE_ENERGY_BURNED",
    );
    expect(320_000 * energy!.factor).toBe(320);
  });

  it("micronutrients arrive in grams and land in the catalog's unit", () => {
    expect(0.06 * NUTRITION_COLUMNS.vitamin_c!.factor).toBeCloseTo(60);
    expect(0.00001 * NUTRITION_COLUMNS.vitamin_d!.factor).toBeCloseTo(10);
    // Energy and macros are not part of the catalog.
    expect(Object.keys(NUTRITION_COLUMNS)).not.toContain("protein");
    expect(Object.keys(NUTRITION_COLUMNS)).not.toContain("energy");
  });
});

describe("identities", () => {
  it("keys records by their UUID and derived rows by UUID and instant", () => {
    const uuid = "01234567-89ab-cdef-0123-456789abcdef";
    expect(hcExternalId(uuid)).toBe(`hc:${uuid}`);
    expect(hcExternalId(uuid, 1_700_000_000_000)).toBe(
      `hc:${uuid}:1700000000000`,
    );
  });

  it("uses the stats: family for day totals and hourly means", () => {
    expect(hcDailyStatsExternalId("ACTIVITY_STEPS", "2026-09-01")).toBe(
      "stats:HKQuantityTypeIdentifierStepCount:2026-09-01",
    );
    expect(hcHourlyPulseExternalId("2026-09-01", 7)).toBe(
      "stats:HKQuantityTypeIdentifierHeartRate:2026-09-01T07",
    );
  });

  it("turns local_date into a calendar day", () => {
    expect(dayKeyFromEpochDay(0)).toBe("1970-01-01");
    expect(dayKeyFromEpochDay(20_697)).toBe("2026-09-01");
  });
});

describe("sports and devices", () => {
  it("maps exercise types and falls back to other", () => {
    expect(mapHealthConnectSportType(33)).toBe("running");
    expect(mapHealthConnectSportType(79)).toBe("other");
    expect(mapHealthConnectSportType(null)).toBe("other");
  });

  it("maps device types onto the picker's classes", () => {
    expect(deviceClassFromHc(1)).toBe("watch");
    expect(deviceClassFromHc(3)).toBe("scale");
    expect(deviceClassFromHc(7)).toBe("other");
    expect(deviceClassFromHc(null)).toBeNull();
  });
});

describe("AppRanking", () => {
  const ranking = new AppRanking([{ category: 1, order: "3,2" }]);

  it("ranks listed apps in order and unlisted ones after them", () => {
    expect(ranking.rank(1, 3)).toBeLessThan(ranking.rank(1, 2));
    expect(ranking.rank(1, 2)).toBeLessThan(ranking.rank(1, 9));
    expect(ranking.better(1, 2, 3)).toBe(3);
    expect(ranking.better(5, 7, 4)).toBe(4);
  });

  it("takes a day's total from the listed app even when another counted more", () => {
    expect(
      ranking.pickDaily(1, [
        { appId: 2, total: 9000 },
        { appId: 3, total: 7000 },
      ]),
    ).toEqual({ appId: 3, total: 7000 });
  });

  it("takes the largest total when no app is listed", () => {
    expect(
      ranking.pickDaily(4, [
        { appId: 5, total: 300 },
        { appId: 6, total: 900 },
      ]),
    ).toEqual({ appId: 6, total: 900 });
  });
});
