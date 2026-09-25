/**
 * Units-per-dose buttons ↔ server rule.
 *
 * The editor's buttons must never offer a value the server's validator
 * would 422, and a value outside the buttons is recognised as such so the
 * editor opens the "Other" field for it instead of dropping it.
 */
import { describe, expect, it } from "vitest";

import { isSupportedUnitsPerDose } from "@/lib/medications/units-per-dose";
import {
  UNITS_PER_DOSE_OPTIONS,
  formatUnitCount,
  isCuratedUnitsPerDose,
} from "@/components/medications/units-per-dose";

describe("units-per-dose buttons ↔ validator alignment", () => {
  it("offers only server-accepted values", () => {
    for (const opt of UNITS_PER_DOSE_OPTIONS) {
      expect(isSupportedUnitsPerDose(opt.value)).toBe(true);
      // The payload string round-trips to the same number.
      expect(Number(opt.raw)).toBe(opt.value);
    }
  });

  it("labels the fractions with their glyph", () => {
    expect(UNITS_PER_DOSE_OPTIONS.map((o) => o.label)).toEqual([
      "¼",
      "⅓",
      "½",
      "⅔",
      "¾",
      "1",
      "2",
      "3",
      "4",
    ]);
  });
});

describe("isCuratedUnitsPerDose", () => {
  it("recognises a button value", () => {
    expect(isCuratedUnitsPerDose("0.5")).toBe(true);
    expect(isCuratedUnitsPerDose("2")).toBe(true);
  });

  it("does not claim a value only the Other field can hold", () => {
    expect(isCuratedUnitsPerDose("1.5")).toBe(false);
    expect(isCuratedUnitsPerDose("10")).toBe(false);
    expect(isCuratedUnitsPerDose("1,5")).toBe(false);
    expect(isCuratedUnitsPerDose("")).toBe(false);
  });
});

describe("formatUnitCount — display rounding", () => {
  it("passes whole and half counts through unchanged", () => {
    expect(formatUnitCount(30)).toBe(30);
    expect(formatUnitCount(29.5)).toBe(29.5);
  });

  it("rounds the float noise a third-dose leaves", () => {
    expect(formatUnitCount(29.6667)).toBe(29.67);
  });
});
