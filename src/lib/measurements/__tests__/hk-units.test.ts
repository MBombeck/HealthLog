import { describe, it, expect } from "vitest";

import {
  convertHkValue,
  hkDistanceToMetres,
  isConvertibleHkUnit,
} from "../hk-units";

describe("convertHkValue", () => {
  it("converts the km reading Apple writes on a metric archive", () => {
    expect(convertHkValue(2.484, "km", "m")).toBeCloseTo(2484, 9);
  });

  it("converts the mi reading Apple writes on an imperial archive", () => {
    expect(convertHkValue(1.543, "mi", "m")).toBeCloseTo(2483.217792, 9);
  });

  it("returns the reading untouched when the units already agree", () => {
    expect(convertHkValue(2.484, "m", "m")).toBe(2.484);
  });

  it("converts mass, energy and temperature the same way", () => {
    expect(convertHkValue(180, "lb", "kg")).toBeCloseTo(81.6466266, 6);
    expect(convertHkValue(1000, "kJ", "kcal")).toBeCloseTo(239.005736, 6);
    expect(convertHkValue(98.6, "degF", "degC")).toBeCloseTo(37, 9);
  });

  it("strips the molar mass Apple annotates a glucose unit with", () => {
    expect(convertHkValue(5.5, "mmol<180.156>/L", "mg/dL")).toBeCloseTo(
      99.0858,
      4,
    );
  });

  it("keeps the small calorie apart from the large one", () => {
    expect(convertHkValue(1, "Cal", "kcal")).toBe(1);
    expect(convertHkValue(1000, "cal", "kcal")).toBeCloseTo(1, 9);
  });

  it("refuses a unit it cannot place rather than guessing", () => {
    expect(convertHkValue(1, "furlong", "m")).toBeNull();
    expect(convertHkValue(1, "", "m")).toBeNull();
    expect(convertHkValue(1, undefined, "m")).toBeNull();
  });

  it("refuses to cross families", () => {
    expect(convertHkValue(1, "kg", "m")).toBeNull();
    expect(convertHkValue(1, "min", "kcal")).toBeNull();
  });

  it("refuses a non-finite reading", () => {
    expect(convertHkValue(Number.NaN, "km", "m")).toBeNull();
  });
});

describe("hkDistanceToMetres", () => {
  it("converts the workout distance units Apple ships", () => {
    expect(hkDistanceToMetres(6.5, "km")).toBeCloseTo(6500, 9);
    expect(hkDistanceToMetres(3, "mi")).toBeCloseTo(4828.032, 9);
    expect(hkDistanceToMetres(500, "m")).toBe(500);
  });

  it("falls back to the raw number for a missing unit attribute", () => {
    expect(hkDistanceToMetres(500, "")).toBe(500);
    expect(hkDistanceToMetres(500, undefined)).toBe(500);
  });
});

describe("isConvertibleHkUnit", () => {
  it("recognises the units the mapping table pins", () => {
    expect(isConvertibleHkUnit("m")).toBe(true);
    expect(isConvertibleHkUnit("kg")).toBe(true);
    expect(isConvertibleHkUnit("count")).toBe(false);
    expect(isConvertibleHkUnit("event")).toBe(false);
    expect(isConvertibleHkUnit("%")).toBe(false);
  });
});
