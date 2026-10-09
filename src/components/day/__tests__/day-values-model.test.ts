import { describe, expect, it } from "vitest";

import type { DayValue } from "@/lib/day/contract";

import {
  CURATED_VALUE_COUNT,
  curateDayValues,
  numberLinePositions,
} from "../day-values-model";

function value(type: string, v = 1, at = "2026-01-03T07:12:00.000Z"): DayValue {
  return {
    type,
    value: v,
    unit: "x",
    at,
    source: "MANUAL",
    band: null,
  };
}

describe("curateDayValues", () => {
  it("folds a blood pressure into one tile, systolic first", () => {
    const { curated } = curateDayValues([
      value("BLOOD_PRESSURE_DIA", 88),
      value("BLOOD_PRESSURE_SYS", 138),
    ]);
    expect(curated).toHaveLength(1);
    expect(curated[0]!.key).toBe("BLOOD_PRESSURE");
    expect(curated[0]!.values.map((v) => v.value)).toEqual([138, 88]);
  });

  it("shows two blood pressure readings of a day as their mean, not four numbers", () => {
    const { curated } = curateDayValues([
      value("BLOOD_PRESSURE_SYS", 127, "2026-01-03T07:00:00.000Z"),
      value("BLOOD_PRESSURE_DIA", 86, "2026-01-03T07:00:00.000Z"),
      value("BLOOD_PRESSURE_SYS", 135, "2026-01-03T19:00:00.000Z"),
      value("BLOOD_PRESSURE_DIA", 87, "2026-01-03T19:00:00.000Z"),
    ]);
    expect(curated).toHaveLength(1);
    const tile = curated[0]!;
    expect(tile.values.map((v) => v.type)).toEqual([
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
    ]);
    expect(tile.values.map((v) => v.value)).toEqual([131, 86.5]);
    expect(tile.values[0]!.at).toBe("2026-01-03T19:00:00.000Z");
    expect(tile.readings).toBe(2);
  });

  it("keeps a single reading as it is", () => {
    const { curated } = curateDayValues([value("WEIGHT", 80.4)]);
    expect(curated[0]!.values.map((v) => v.value)).toEqual([80.4]);
    expect(curated[0]!.readings).toBe(1);
  });

  it("shows eight tiles in reading order and keeps the rest for All", () => {
    const types = [
      "WALKING_SPEED",
      "ACTIVITY_STEPS",
      "WEIGHT",
      "BLOOD_PRESSURE_SYS",
      "BLOOD_PRESSURE_DIA",
      "RESTING_HEART_RATE",
      "SLEEP_DURATION",
      "BODY_TEMPERATURE",
      "HEART_RATE_VARIABILITY",
      "BLOOD_GLUCOSE",
      "VO2_MAX",
    ];
    const { curated, rest } = curateDayValues(types.map((t) => value(t)));
    expect(curated).toHaveLength(CURATED_VALUE_COUNT);
    expect(curated.map((t) => t.key).slice(0, 4)).toEqual([
      "BLOOD_PRESSURE",
      "RESTING_HEART_RATE",
      "WEIGHT",
      "BODY_TEMPERATURE",
    ]);
    expect(rest.map((t) => t.key)).toEqual(["WALKING_SPEED", "VO2_MAX"]);
  });

  it("always shows the value the person came from among the first tiles", () => {
    const types = [
      "BLOOD_PRESSURE_SYS",
      "RESTING_HEART_RATE",
      "PULSE",
      "WEIGHT",
      "BODY_TEMPERATURE",
      "SLEEP_DURATION",
      "ACTIVITY_STEPS",
      "HEART_RATE_VARIABILITY",
      "BLOOD_GLUCOSE",
      "VO2_MAX",
    ];
    const { curated, rest } = curateDayValues(
      types.map((t) => value(t)),
      ["VO2_MAX"],
    );
    expect(curated.map((t) => t.key)).toContain("VO2_MAX");
    expect(rest.map((t) => t.key)).not.toContain("VO2_MAX");
    expect(curated).toHaveLength(CURATED_VALUE_COUNT);
  });
});

describe("numberLinePositions", () => {
  it("places a value inside its usual range inside the band", () => {
    const pos = numberLinePositions(130, { lo: 124, hi: 134 });
    expect(pos.point).toBeGreaterThan(pos.lo);
    expect(pos.point).toBeLessThan(pos.hi);
    expect(pos.lo).toBeGreaterThan(0);
    expect(pos.hi).toBeLessThan(100);
  });

  it("stretches the line to a value outside the band, never past 100", () => {
    const pos = numberLinePositions(180, { lo: 124, hi: 134 });
    expect(pos.point).toBeGreaterThan(pos.hi);
    expect(pos.point).toBeLessThanOrEqual(100);
    const low = numberLinePositions(-5, { lo: 3, hi: 4 });
    expect(low.point).toBeGreaterThanOrEqual(0);
    expect(low.point).toBeLessThan(low.lo);
  });

  it("copes with a band of zero width", () => {
    const pos = numberLinePositions(70, { lo: 70, hi: 70 });
    expect(Number.isFinite(pos.point)).toBe(true);
  });
});
