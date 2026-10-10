import { describe, expect, it } from "vitest";

import { molarMass, formulaLabel } from "../atomic-weights";
import {
  convertByScale,
  scaleUnitOf,
  scaleUnitsInFamilyOf,
  shiftPowerOfTen,
} from "../scale";

describe("scale families", () => {
  it("puts each unit in the family of its quantity", () => {
    expect(scaleUnitOf("mg/dL")?.family).toBe("mass");
    expect(scaleUnitOf("pmol/L")?.family).toBe("amount");
    expect(scaleUnitOf("mIU/L")?.family).toBe("activity");
    expect(scaleUnitOf("10³/µL")?.family).toBe("count");
  });

  it("derives the exponent from the prefix and the volume", () => {
    // Relative to g/L.
    expect(scaleUnitOf("g/L")?.exponent).toBe(0);
    expect(scaleUnitOf("g/dL")?.exponent).toBe(1);
    expect(scaleUnitOf("mg/dL")?.exponent).toBe(-2);
    expect(scaleUnitOf("ng/mL")?.exponent).toBe(-6);
    expect(scaleUnitOf("ng/dL")?.exponent).toBe(-8);
    expect(scaleUnitOf("pg/mL")?.exponent).toBe(-9);
  });

  it("knows a unit by any spelling the normaliser resolves", () => {
    expect(scaleUnitOf("mg/dl")).toEqual(scaleUnitOf("mg/dL"));
    expect(scaleUnitOf("ug/L")).toEqual(scaleUnitOf("µg/L"));
    expect(scaleUnitOf("umol/l")).toEqual(scaleUnitOf("µmol/L"));
  });

  it("knows no family for a unit that is not a plain scale", () => {
    expect(scaleUnitOf("%")).toBeNull();
    expect(scaleUnitOf("mmol/mol")).toBeNull();
    expect(scaleUnitOf("furlongs")).toBeNull();
    // A lone capital M is mega, not milli: not read as a scale unit at all.
    expect(scaleUnitOf("MIU/L")).toBeNull();
  });

  it("does not make mass to amount a scale pair", () => {
    expect(convertByScale(1, "mg/dL", "mmol/L")).toBeNull();
    expect(convertByScale(1, "g/L", "mol/L")).toBeNull();
  });

  it("keeps the 10^9/L of a blood count apart from g/L", () => {
    expect(scaleUnitOf("G/L")?.family).toBe("count");
    expect(scaleUnitOf("g/L")?.family).toBe("mass");
    expect(convertByScale(1, "G/L", "g/L")).toBeNull();
  });

  it("lists every unit of a family, in its own spelling", () => {
    const amount = scaleUnitsInFamilyOf("mmol/L");
    expect(amount).toEqual(
      expect.arrayContaining(["mol/L", "mmol/L", "µmol/L", "nmol/L", "pmol/L"]),
    );
    expect(amount).not.toContain("mg/dL");
    expect(scaleUnitsInFamilyOf("%")).toEqual([]);
  });
});

describe("shiftPowerOfTen", () => {
  it("multiplies for a positive power and divides for a negative one", () => {
    expect(shiftPowerOfTen(5, 3)).toBe(5000);
    expect(shiftPowerOfTen(5, -3)).toBe(0.005);
    expect(shiftPowerOfTen(5, 0)).toBe(5);
  });

  it("is exact where multiplying by 10^-n is not", () => {
    // 3 * 1e-3 is 0.003 with a stray last digit; 3 / 1000 is exact.
    expect(shiftPowerOfTen(3, -3)).toBe(0.003);
  });
});

describe("atomic weights", () => {
  it("sums a molar mass from the table, without float noise", () => {
    expect(molarMass({ C: 6, H: 12, O: 6 })).toBe(180.156);
    expect(molarMass({ Ca: 1 })).toBe(40.078);
    expect(molarMass({ N: 2 })).toBe(28.014);
  });

  it("writes a formula in a stable order", () => {
    expect(formulaLabel({ O: 6, H: 12, C: 6 })).toBe("C6H12O6");
    expect(formulaLabel({ Ca: 1 })).toBe("Ca");
    expect(formulaLabel({ C: 1, H: 4, N: 2, O: 1 })).toBe("CH4N2O");
  });
});
