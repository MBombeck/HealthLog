/**
 * #1034 — units per dose beyond the curated set.
 *
 * One rule, shared by every server write path and the web editor: any value
 * above 0 and at most 100 with at most four decimal places, which is exactly
 * what the `Decimal(10,4)` column stores. The parser reads what a person
 * types into the "Other" field; the formatter renders a stored value with a
 * fraction glyph when it has one (1½, 2¼, ⅓).
 */
import { describe, expect, it } from "vitest";

import {
  UNITS_PER_DOSE_FRACTIONS,
  formatUnitsPerDose,
  isSupportedUnitsPerDose,
  parseUnitsPerDoseInput,
} from "@/lib/medications/units-per-dose";

describe("isSupportedUnitsPerDose", () => {
  it("accepts whole numbers 1–100 and the curated fractions", () => {
    for (const v of [1, 2, 10, 100, 0.25, 0.3333, 0.5, 0.6667, 0.75]) {
      expect(isSupportedUnitsPerDose(v)).toBe(true);
    }
  });

  it("accepts a whole number plus a fraction", () => {
    for (const v of [1.5, 2.25, 1.3333, 3.75, 99.5]) {
      expect(isSupportedUnitsPerDose(v)).toBe(true);
    }
  });

  it("accepts any decimal with up to four places, as the column stores it", () => {
    for (const v of [1.2, 0.8, 2.4, 0.1, 0.0001, 12.3456]) {
      expect(isSupportedUnitsPerDose(v)).toBe(true);
    }
  });

  it("refuses zero, negatives, values above 100 and more than four places", () => {
    for (const v of [0, -1, -0.5, 100.0001, 100.5, 101, 1.23456, 0.00001]) {
      expect(isSupportedUnitsPerDose(v)).toBe(false);
    }
  });

  it("refuses non-finite values", () => {
    for (const v of [Number.NaN, Infinity, -Infinity]) {
      expect(isSupportedUnitsPerDose(v)).toBe(false);
    }
  });

  it("every curated fraction passes the rule", () => {
    for (const f of UNITS_PER_DOSE_FRACTIONS) {
      expect(isSupportedUnitsPerDose(f.value)).toBe(true);
    }
  });
});

describe("parseUnitsPerDoseInput", () => {
  it("reads a decimal point and a decimal comma alike", () => {
    expect(parseUnitsPerDoseInput("1.5")).toBe(1.5);
    expect(parseUnitsPerDoseInput("1,5")).toBe(1.5);
    expect(parseUnitsPerDoseInput(" 2,25 ")).toBe(2.25);
    expect(parseUnitsPerDoseInput("0.8")).toBe(0.8);
  });

  it("reads a mixed number written with a slash", () => {
    expect(parseUnitsPerDoseInput("1 1/2")).toBe(1.5);
    expect(parseUnitsPerDoseInput("2 1/4")).toBe(2.25);
    expect(parseUnitsPerDoseInput("3/4")).toBe(0.75);
    expect(parseUnitsPerDoseInput("1 1/3")).toBe(1.3333);
    expect(parseUnitsPerDoseInput("2/3")).toBe(0.6667);
  });

  it("reads a fraction glyph, alone or after a whole number", () => {
    expect(parseUnitsPerDoseInput("½")).toBe(0.5);
    expect(parseUnitsPerDoseInput("1½")).toBe(1.5);
    expect(parseUnitsPerDoseInput("1 ½")).toBe(1.5);
    expect(parseUnitsPerDoseInput("2⅓")).toBe(2.3333);
  });

  it("returns null for anything the server would refuse", () => {
    for (const raw of [
      "",
      "   ",
      "abc",
      "0",
      "0,0",
      "-1",
      "101",
      "1.23456",
      "1/0",
      "1 1/2 1",
      "1,5,5",
      "1.5.5",
      "2 abc",
    ]) {
      expect(parseUnitsPerDoseInput(raw)).toBeNull();
    }
  });

  it("does not silently truncate at the comma the way parseFloat would", () => {
    // parseFloat("1,5") is 1; the parser must never produce that.
    expect(parseUnitsPerDoseInput("1,5")).not.toBe(1);
  });
});

describe("formatUnitsPerDose", () => {
  it("renders the curated fractions as glyphs", () => {
    expect(formatUnitsPerDose(0.25)).toBe("¼");
    expect(formatUnitsPerDose(0.3333)).toBe("⅓");
    expect(formatUnitsPerDose(0.5)).toBe("½");
    expect(formatUnitsPerDose(0.6667)).toBe("⅔");
    expect(formatUnitsPerDose(0.75)).toBe("¾");
  });

  it("renders a whole number plus a fraction as a mixed glyph", () => {
    expect(formatUnitsPerDose(1.5)).toBe("1½");
    expect(formatUnitsPerDose(2.25)).toBe("2¼");
    expect(formatUnitsPerDose(1.3333)).toBe("1⅓");
    expect(formatUnitsPerDose(3.75)).toBe("3¾");
  });

  it("renders whole numbers plainly", () => {
    expect(formatUnitsPerDose(1)).toBe("1");
    expect(formatUnitsPerDose(10)).toBe("10");
  });

  it("renders any other decimal in the reader's locale", () => {
    expect(formatUnitsPerDose(1.2)).toBe("1.2");
    expect(formatUnitsPerDose(1.2, "de")).toBe("1,2");
    expect(formatUnitsPerDose(0.8, "en")).toBe("0.8");
    expect(formatUnitsPerDose(12.3456, "de")).toBe("12,3456");
  });

  it("round-trips through the parser for every glyph it emits", () => {
    for (const v of [0.5, 1.5, 2.25, 1.3333, 3.75, 7, 1.2]) {
      expect(parseUnitsPerDoseInput(formatUnitsPerDose(v))).toBe(v);
    }
  });
});
