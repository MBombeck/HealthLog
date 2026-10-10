import { describe, expect, it } from "vitest";

import { MGDL_PER_MMOL } from "@/lib/glucose";

import { molarMass } from "../atomic-weights";
import {
  allAnalyteConversions,
  analyteConversionFor,
  defineAnalyteConversion,
  type AnalyteConversion,
} from "../registry";

/**
 * The guard over the registry. Every entry is checked for what makes a
 * conversion safe to ship: a named source, a hub that is one of its units, a
 * finite positive slope, a key nobody else claims, and, for the molar-mass
 * entries, a factor that equals one recomputed here from the molar mass written
 * out by hand, not by the code that built the entry.
 */

/** g/mol, summed by hand from H 1.008, C 12.011, N 14.007, O 15.999, Ca 40.078. */
const MOLAR_MASS: Record<string, number> = {
  "fasting-glucose": 180.156, // C6H12O6
  "total-cholesterol": 386.664, // C27H46O
  creatinine: 113.12, // C4H7N3O
  urea: 60.056, // CH4N2O
  "blood-urea-nitrogen": 28.014, // N2
  "uric-acid": 168.112, // C5H4N4O3
  "calcium-total": 40.078, // Ca
  "bilirubin-total": 584.673, // C33H36N4O6
  "vitamin-d": 400.647, // C27H44O2
};

/** Of the entry's amount unit: how many of its mass unit one of it is, per g/mol. */
const POWER_OF_TEN: Record<string, number> = {
  "fasting-glucose": 1 / 10, // mmol/L -> mg/dL
  "total-cholesterol": 1 / 10,
  creatinine: 1 / 10_000, // µmol/L -> mg/dL
  urea: 1 / 10,
  "blood-urea-nitrogen": 1 / 10,
  "uric-acid": 1 / 10_000,
  "calcium-total": 1 / 10,
  "bilirubin-total": 1 / 10_000,
  "vitamin-d": 1 / 1_000, // nmol/L -> ng/mL
};

describe("the registry's entries", () => {
  const entries = allAnalyteConversions();

  it("holds the starter set", () => {
    expect(entries.map((entry) => entry.key).sort()).toEqual(
      [
        "blood-urea-nitrogen",
        "bilirubin-total",
        "calcium-total",
        "creatinine",
        "fasting-glucose",
        "hba1c",
        "total-cholesterol",
        "uric-acid",
        "urea",
        "vitamin-d",
      ].sort(),
    );
  });

  it.each(entries.map((entry) => [entry.key, entry] as const))(
    "%s: names its source, has a hub among its units, and a finite positive slope",
    (_key, entry) => {
      expect(entry.source.trim().length).toBeGreaterThan(10);
      expect(Object.keys(entry.units)).toContain(entry.hub);
      for (const { a, b } of Object.values(entry.units)) {
        expect(Number.isFinite(a) && a > 0).toBe(true);
        expect(Number.isFinite(b)).toBe(true);
      }
      expect(entry.units[entry.hub]).toEqual({ a: 1, b: 0 });
    },
  );

  it("never lists a key or an alias twice, across entries", () => {
    const keys = entries.flatMap((entry) => [entry.key, ...entry.aliases]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("finds an analyte by its alias: LDL and HDL are cholesterol", () => {
    expect(analyteConversionFor("ldl")?.key).toBe("total-cholesterol");
    expect(analyteConversionFor("hdl")?.key).toBe("total-cholesterol");
    expect(analyteConversionFor("nope")).toBeNull();
    expect(analyteConversionFor(null)).toBeNull();
  });

  it("keeps urea and blood urea nitrogen, and the two calciums, apart", () => {
    expect(analyteConversionFor("urea")).not.toBe(
      analyteConversionFor("blood-urea-nitrogen"),
    );
    expect(analyteConversionFor("calcium-ionised")).toBeNull();
  });

  describe("the molar-mass entries", () => {
    const molar = entries.filter((entry) => entry.kind === "molar-mass");

    it("are exactly the ones this table knows", () => {
      expect(molar.map((entry) => entry.key).sort()).toEqual(
        Object.keys(MOLAR_MASS).sort(),
      );
    });

    it.each(molar.map((entry) => [entry.key, entry] as const))(
      "%s: the factor is the molar mass moved by its powers of ten",
      (key, entry) => {
        const [amountUnit] = Object.keys(entry.units).filter(
          (unit) => unit !== entry.hub,
        );
        const { a } = entry.units[amountUnit];
        const expected = MOLAR_MASS[key] * POWER_OF_TEN[key];
        if (key === "fasting-glucose") {
          // The constant the rest of the app uses.
          expect(a).toBe(MGDL_PER_MMOL);
        } else {
          expect(a).toBeCloseTo(expected, 9);
        }
      },
    );

    it("has glucose agree with the derived factor to within 0.02 %", () => {
      const derived = molarMass({ C: 6, H: 12, O: 6 }) / 10;
      expect(derived).toBeCloseTo(18.0156, 4);
      expect(Math.abs(MGDL_PER_MMOL - derived) / derived).toBeLessThan(0.0002);
    });
  });

  it("has HbA1c as the IFCC-NGSP master equation, affine and not a factor", () => {
    const hba1c = analyteConversionFor("hba1c")!;
    expect(hba1c.kind).toBe("standard");
    expect(hba1c.units["mmol/mol"]).toEqual({ a: 0.09148, b: 2.152 });
    expect(hba1c.source).toContain("Hoelzel");
  });

  it("has no convention-based entry until its source is cited (triglycerides)", () => {
    expect(entries.filter((entry) => entry.kind === "convention")).toEqual([]);
    expect(analyteConversionFor("triglycerides")).toBeNull();
  });
});

describe("an entry that is not safe cannot be defined", () => {
  const valid: AnalyteConversion = {
    key: "x",
    aliases: [],
    hub: "mg/dL",
    units: { "mg/dL": { a: 1, b: 0 }, "mmol/L": { a: 10, b: 0 } },
    kind: "molar-mass",
    source: "A cited source.",
  };

  it("accepts a valid entry", () => {
    expect(defineAnalyteConversion(valid).key).toBe("x");
  });

  it("refuses an entry with no source", () => {
    expect(() => defineAnalyteConversion({ ...valid, source: "  " })).toThrow(
      /no source/,
    );
  });

  it("refuses a hub that is not one of its units", () => {
    expect(() => defineAnalyteConversion({ ...valid, hub: "g/L" })).toThrow(
      /hub/,
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a slope of %s",
    (a) => {
      expect(() =>
        defineAnalyteConversion({
          ...valid,
          units: { ...valid.units, "mmol/L": { a, b: 0 } },
        }),
      ).toThrow(/finite positive/);
    },
  );

  it("refuses a unit that is not in its normalised spelling", () => {
    expect(() =>
      defineAnalyteConversion({
        ...valid,
        units: { ...valid.units, "mmol/l": { a: 10, b: 0 } },
      }),
    ).toThrow(/normalised/);
  });
});
