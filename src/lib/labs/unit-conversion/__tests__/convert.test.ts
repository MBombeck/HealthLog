import { describe, expect, it } from "vitest";

import { allAnalyteConversions } from "../registry";
import {
  convertLabRange,
  convertLabValue,
  conversionsFor,
  type ConvertedValue,
} from "../convert";

const ok = (result: ConvertedValue) => {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result;
};

const convert = (
  analyteKey: string | null | undefined,
  value: number,
  from: string,
  to: string,
) => convertLabValue({ analyteKey, value, from, to });

describe("reference pairs, checked by hand", () => {
  it("5.6 mmol/L glucose is 100.9 mg/dL", () => {
    const r = ok(convert("fasting-glucose", 5.6, "mmol/L", "mg/dL"));
    expect(r.value).toBeCloseTo(100.9, 1);
    expect(r.via).toBe("analyte");
  });

  it("1.0 mg/dL creatinine is 88.4 µmol/L", () => {
    expect(ok(convert("creatinine", 1, "mg/dL", "µmol/L")).value).toBeCloseTo(
      88.4,
      1,
    );
  });

  it("6.5 % HbA1c is 47.5 mmol/mol, and back", () => {
    const ifcc = ok(convert("hba1c", 6.5, "%", "mmol/mol")).value;
    expect(ifcc).toBeCloseTo(47.5, 1);
    expect(ok(convert("hba1c", ifcc, "mmol/mol", "%")).value).toBeCloseTo(
      6.5,
      9,
    );
  });

  it("30 ng/mL vitamin D is 74.9 nmol/L", () => {
    expect(ok(convert("vitamin-d", 30, "ng/mL", "nmol/L")).value).toBeCloseTo(
      74.9,
      1,
    );
  });

  it("5.2 mmol/L total cholesterol is 201 mg/dL, and LDL goes the same way", () => {
    expect(
      ok(convert("total-cholesterol", 5.2, "mmol/L", "mg/dL")).value,
    ).toBeCloseTo(201.1, 1);
    expect(ok(convert("ldl", 3, "mmol/L", "mg/dL")).value).toBeCloseTo(116, 0);
  });

  it("5 mmol/L urea is 30.0 mg/dL, and 5 mmol/L is 14.0 mg/dL as BUN", () => {
    expect(ok(convert("urea", 5, "mmol/L", "mg/dL")).value).toBeCloseTo(
      30.03,
      2,
    );
    expect(
      ok(convert("blood-urea-nitrogen", 5, "mmol/L", "mg/dL")).value,
    ).toBeCloseTo(14.007, 2);
  });

  it("2.4 mmol/L total calcium is 9.6 mg/dL", () => {
    expect(
      ok(convert("calcium-total", 2.4, "mmol/L", "mg/dL")).value,
    ).toBeCloseTo(9.62, 1);
  });

  it("300 µmol/L uric acid is 5.0 mg/dL and 17.1 µmol/L bilirubin is 1.0 mg/dL", () => {
    expect(ok(convert("uric-acid", 300, "µmol/L", "mg/dL")).value).toBeCloseTo(
      5.04,
      2,
    );
    expect(
      ok(convert("bilirubin-total", 17.1, "µmol/L", "mg/dL")).value,
    ).toBeCloseTo(1.0, 2);
  });
});

describe("the same unit written two ways", () => {
  it("returns the value untouched", () => {
    expect(ok(convert(null, 5.6, "mmol/l", "mmol/L")).value).toBe(5.6);
    expect(ok(convert(null, 5.6, "MG/DL", "mg/dl")).value).toBe(5.6);
    expect(ok(convert("fasting-glucose", 5.6, "mg/dl", "mg/dL")).value).toBe(
      5.6,
    );
  });

  it("reads a spelling of the unit through the normaliser", () => {
    const a = ok(convert("creatinine", 88.4, "umol/l", "mg/dl"));
    const b = ok(convert("creatinine", 88.4, "µmol/L", "mg/dL"));
    expect(a.value).toBe(b.value);
  });
});

describe("a pair of scale units needs no analyte", () => {
  it.each([
    [1, "g/L", "mg/L", 1000],
    [1, "mg/dL", "mg/L", 10],
    [1, "g/dL", "g/L", 10],
    [1, "ng/mL", "µg/L", 1],
    [1, "ng/mL", "pg/mL", 1000],
    [1, "ng/dL", "ng/L", 10],
    [1, "mmol/L", "µmol/L", 1000],
    [1, "mol/L", "pmol/L", 1e12],
    [1, "mIU/L", "µIU/mL", 1],
    [1, "IU/L", "mIU/L", 1000],
    [4.5, "10³/µL", "10⁹/L", 4.5],
    [1, "10⁶/µL", "10¹²/L", 1],
    [1, "10⁶/µL", "10³/µL", 1000],
    [1, "G/L", "10³/µL", 1],
  ])("%s %s is %s %s", (value, from, to, expected) => {
    const r = ok(convert(null, value, from, to));
    expect(r.via).toBe("scale");
    expect(r.value).toBeCloseTo(expected, 9);
  });

  it("is exact where a power of ten is exactly representable", () => {
    expect(ok(convert(null, 5, "g/L", "mg/L")).value).toBe(5000);
    expect(ok(convert(null, 5, "mg/L", "g/L")).value).toBe(0.005);
  });

  it("works for an analyte's own mass units too: glucose in g/L", () => {
    expect(ok(convert("fasting-glucose", 1, "g/L", "mg/dL")).value).toBe(100);
  });
});

describe("an analyte's units reach each other across a scale", () => {
  it("glucose in g/L to mmol/L", () => {
    // 1 g/L = 100 mg/dL = 100 / 18.0182 mmol/L
    expect(
      ok(convert("fasting-glucose", 1, "g/L", "mmol/L")).value,
    ).toBeCloseTo(100 / 18.0182, 9);
  });

  it("creatinine in mmol/L to mg/dL (the entry lists µmol/L)", () => {
    expect(
      ok(convert("creatinine", 0.0884, "mmol/L", "mg/dL")).value,
    ).toBeCloseTo(1.0, 3);
  });

  it("vitamin D in µg/L to nmol/L (the entry lists ng/mL)", () => {
    expect(ok(convert("vitamin-d", 30, "µg/L", "nmol/L")).value).toBeCloseTo(
      74.9,
      1,
    );
  });
});

describe("a round trip returns the start, for every unit of every analyte", () => {
  for (const entry of allAnalyteConversions()) {
    const units = Object.keys(entry.units);
    for (const from of units) {
      for (const to of units) {
        it(`${entry.key}: ${from} -> ${to} -> ${from}`, () => {
          for (const start of [0.5, 1, 7.3, 120.45]) {
            const there = ok(convert(entry.key, start, from, to)).value;
            const back = ok(convert(entry.key, there, to, from)).value;
            expect(Math.abs(back - start) / start).toBeLessThan(1e-12);
          }
        });
      }
    }
  }

  it("holds for the scale pairs", () => {
    const units = ["g/L", "mg/dL", "µg/L", "ng/mL", "pg/mL", "ng/dL", "g/dL"];
    for (const from of units) {
      for (const to of units) {
        const there = ok(convert(null, 7.3, from, to)).value;
        const back = ok(convert(null, there, to, from)).value;
        expect(Math.abs(back - 7.3) / 7.3).toBeLessThan(1e-12);
      }
    }
  });
});

describe("a refusal, never a guess", () => {
  it("refuses a unit nobody knows", () => {
    expect(convert("fasting-glucose", 5, "mmol/L", "furlongs")).toEqual({
      ok: false,
      reason: "unknown_unit",
    });
    expect(convert(null, 5, "foo", "bar")).toEqual({
      ok: false,
      reason: "unknown_unit",
    });
  });

  it("refuses an analyte it has no entry for", () => {
    expect(convert("sodium", 140, "mmol/L", "mg/dL")).toEqual({
      ok: false,
      reason: "unknown_analyte",
    });
    expect(convert("triglycerides", 1.7, "mmol/L", "mg/dL")).toEqual({
      ok: false,
      reason: "unknown_analyte",
    });
  });

  it("refuses mass to amount when no analyte key is given", () => {
    expect(convert(null, 100, "mg/dL", "mmol/L")).toEqual({
      ok: false,
      reason: "unknown_analyte",
    });
    expect(convert(undefined, 100, "mg/dL", "mmol/L")).toEqual({
      ok: false,
      reason: "unknown_analyte",
    });
  });

  it("refuses a unit the entry does not reach", () => {
    // HbA1c knows % and mmol/mol; g/L is neither, and not a scale of either.
    expect(convert("hba1c", 6.5, "%", "g/L")).toEqual({
      ok: false,
      reason: "unknown_unit",
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "refuses %s",
    (value) => {
      expect(convert("fasting-glucose", value, "mmol/L", "mg/dL")).toEqual({
        ok: false,
        reason: "not_finite",
      });
      expect(convert(null, value, "g/L", "mg/L")).toEqual({
        ok: false,
        reason: "not_finite",
      });
    },
  );

  it("never turns the lookalike pairs into a conversion", () => {
    // Different measurements, not different units of one.
    expect(convert("urea", 5, "mmol/L", "mg/dL").ok).toBe(true);
    expect(convert("calcium-total", 2.4, "mmol/L", "mg/dL").ok).toBe(true);
    expect(convert("calcium-ionised", 1.2, "mmol/L", "mg/dL").ok).toBe(false);
  });
});

describe("a reference range", () => {
  it("converts both bounds together and keeps them in order", () => {
    const r = convertLabRange({
      analyteKey: "fasting-glucose",
      low: 3.9,
      high: 5.6,
      from: "mmol/L",
      to: "mg/dL",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.low).toBeCloseTo(70.3, 1);
    expect(r.high).toBeCloseTo(100.9, 1);
    expect(r.low!).toBeLessThan(r.high!);
    expect(r.via).toBe("analyte");
  });

  it("keeps the order for HbA1c, whose map has an offset", () => {
    const r = convertLabRange({
      analyteKey: "hba1c",
      low: 4,
      high: 5.6,
      from: "%",
      to: "mmol/mol",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.low!).toBeLessThan(r.high!);
    expect(r.low).toBeCloseTo(20.2, 1);
    expect(r.high).toBeCloseTo(37.7, 1);
  });

  it("leaves an open bound open", () => {
    expect(
      convertLabRange({
        analyteKey: "fasting-glucose",
        low: null,
        high: 5.6,
        from: "mmol/L",
        to: "mg/dL",
      }),
    ).toMatchObject({ ok: true, low: null });
    expect(
      convertLabRange({
        analyteKey: "fasting-glucose",
        low: 3.9,
        high: null,
        from: "mmol/L",
        to: "mg/dL",
      }),
    ).toMatchObject({ ok: true, high: null });
  });

  it("refuses the whole range when the units do not convert", () => {
    expect(
      convertLabRange({
        analyteKey: null,
        low: 3.9,
        high: 5.6,
        from: "mmol/L",
        to: "mg/dL",
      }),
    ).toEqual({ ok: false, reason: "unknown_analyte" });
  });

  it("refuses a range of two open bounds when the units do not convert either", () => {
    expect(
      convertLabRange({
        analyteKey: null,
        low: null,
        high: null,
        from: "mmol/L",
        to: "mg/dL",
      }),
    ).toEqual({ ok: false, reason: "unknown_analyte" });
  });

  it("is the unit spelled another way: no conversion, bounds as they are", () => {
    expect(
      convertLabRange({
        analyteKey: null,
        low: 3.9,
        high: 5.6,
        from: "mmol/l",
        to: "mmol/L",
      }),
    ).toEqual({ ok: true, low: 3.9, high: 5.6, via: "scale" });
  });
});

describe("conversionsFor", () => {
  it("lists what glucose in mg/dL can arrive as, without mg/dL itself", () => {
    const units = conversionsFor({
      analyteKey: "fasting-glucose",
      to: "mg/dL",
    });
    expect(units).toContain("mmol/L");
    expect(units).toContain("g/L");
    expect(units).toContain("µmol/L"); // the amount family, scaled
    expect(units).not.toContain("mg/dL");
    expect(units).not.toContain("mg/dl");
  });

  it("lists only the scale family for a marker with no entry", () => {
    const units = conversionsFor({ analyteKey: null, to: "mg/dL" });
    expect(units).toContain("g/L");
    expect(units).not.toContain("mmol/L");
  });

  it("lists nothing for a unit that has no family and no entry", () => {
    expect(conversionsFor({ analyteKey: null, to: "%" })).toEqual([]);
  });

  it("lists HbA1c's two units", () => {
    expect(conversionsFor({ analyteKey: "hba1c", to: "%" })).toEqual([
      "mmol/mol",
    ]);
  });

  it("every listed unit really converts", () => {
    for (const entry of allAnalyteConversions()) {
      for (const to of Object.keys(entry.units)) {
        for (const from of conversionsFor({ analyteKey: entry.key, to })) {
          expect(
            convert(entry.key, 1, from, to).ok,
            `${entry.key}: ${from} -> ${to}`,
          ).toBe(true);
        }
      }
    }
  });
});
