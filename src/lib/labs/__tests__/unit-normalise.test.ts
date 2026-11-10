import { describe, expect, it } from "vitest";

import {
  normaliseLabUnit,
  sameLabUnit,
  withoutLabUnitAnnotation,
} from "../unit-normalise";

describe("sameLabUnit — spellings of one unit", () => {
  it.each([
    ["mmol/L", "mmol/l"],
    ["mg/dL", "mg/dl"],
    ["mg/dL", "mg/DL"],
    ["mg/dL", " mg / dL "],
    ["mg/dL", "mg/ dL"],
    ["µg/L", "ug/L"],
    ["µg/L", "μg/L"],
    ["µg/L", "mcg/L"],
    ["µmol/L", "umol/l"],
    ["µIU/mL", "uIU/mL"],
    ["x10^3/µL", "x10^3/uL"],
    ["x10^3/µL", "x10^3/µl"],
    ["mg/dL", "MG/DL"],
    ["mmol/L", "MMOL/L"],
    ["µmol/L", "UMOL/L"],
    ["ng/mL", "NG/ML"],
    ["IU/L", "IU/l"],
    ["IU/L", "IU/L"],
  ])("%s = %s", (a, b) => {
    expect(sameLabUnit(a, b)).toBe(true);
    expect(sameLabUnit(b, a)).toBe(true);
  });
});

describe("sameLabUnit — never merges units of different magnitude or kind", () => {
  it.each([
    // The point of the module: nothing that changes the number.
    ["mg/dL", "mmol/L"],
    ["mg/dL", "mg/L"],
    ["mg/L", "µg/L"],
    ["g/dL", "g/L"],
    ["ng/mL", "ng/dL"],
    ["µg/L", "mg/L"],
    ["%", "mmol/mol"],
    ["mmol/L", "µmol/L"],
    ["mmol/L", "mol/L"],
    // Case that carries meaning stays significant.
    ["mIU/L", "MIU/L"],
    ["g/L", "G/L"],
    ["u/L", "U/L"],
    ["mmol/L", "Mmol/L"],
    ["pmol/L", "Pmol/L"],
    // A unit the module does not know compares exactly, so it cannot be guessed.
    ["mg/dL", "mg/dl."],
    ["mg/dL", "mg per dL"],
    ["mg/dL", ""],
  ])("%s ≠ %s", (a, b) => {
    expect(sameLabUnit(a, b)).toBe(false);
    expect(sameLabUnit(b, a)).toBe(false);
  });

  it("does not turn a unit printed in capitals into one that is not on the list", () => {
    // `G/L` shouted is the blood-count unit, not grams per litre.
    expect(normaliseLabUnit("G/L")).toBe("G/L");
    expect(normaliseLabUnit("MIU/L")).toBe("MIU/L");
  });

  it("keeps enzyme units apart from the micro prefix", () => {
    expect(normaliseLabUnit("u/L")).toBe("u/L");
    expect(normaliseLabUnit("U/L")).toBe("U/L");
  });
});

describe("normaliseLabUnit", () => {
  it("is idempotent", () => {
    for (const unit of [
      "ug/l",
      "MG/DL",
      "mmol/l",
      " x10^3 / uL ",
      "mIU/L",
      "G/L",
    ]) {
      const once = normaliseLabUnit(unit);
      expect(normaliseLabUnit(once)).toBe(once);
    }
  });

  it("names the canonical spelling", () => {
    expect(normaliseLabUnit("mmol/l")).toBe("mmol/L");
    expect(normaliseLabUnit("ug/l")).toBe("µg/L");
    expect(normaliseLabUnit("MG/DL")).toBe("mg/dL");
  });
});

describe("a calculated-value note in the unit", () => {
  it("is not part of the unit", () => {
    expect(sameLabUnit("g/dL (calc)", "g/dL")).toBe(true);
    expect(sameLabUnit("mmol/l (berechnet)", "mmol/L")).toBe(true);
    expect(sameLabUnit("mg/dL (Calc.)", "MG/DL")).toBe(true);
    expect(withoutLabUnitAnnotation("(calc)")).toBe("");
    expect(withoutLabUnitAnnotation(" g/dL (calculated) ")).toBe("g/dL");
  });

  it("keeps any other bracket, so it still surfaces as a mismatch", () => {
    expect(sameLabUnit("mg/dL (fasting)", "mg/dL")).toBe(false);
    expect(withoutLabUnitAnnotation("U/L (37 °C)")).toBe("U/L (37 °C)");
    expect(withoutLabUnitAnnotation("(calc) g/dL")).toBe("(calc) g/dL");
  });
});
