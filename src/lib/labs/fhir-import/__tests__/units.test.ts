import { describe, expect, it } from "vitest";

import { convertLabValue } from "@/lib/labs/unit-conversion/convert";
import { scaleUnitOf } from "@/lib/labs/unit-conversion/scale";
import { sameLabUnit } from "@/lib/labs/unit-normalise";

import { labUnitFromFhirQuantity } from "../units";

describe("labUnitFromFhirQuantity", () => {
  it.each([
    [{ code: "10*3/uL" }, "10^3/µL"],
    [{ code: "10*6/uL" }, "10^6/µL"],
    [{ code: "10*9/L" }, "10^9/L"],
    [{ code: "10*12/L" }, "10^12/L"],
    [{ code: "[IU]/L" }, "IU/L"],
    [{ code: "m[IU]/L" }, "mIU/L"],
    [{ code: "m[IU]/mL" }, "mIU/mL"],
    [{ code: "u[IU]/mL" }, "µIU/mL"],
    [{ code: "meq/L" }, "mEq/L"],
    [{ code: "/uL" }, "/µL"],
    [{ code: "mL/min/{1.73_m2}" }, "mL/min/1.73m²"],
    [{ code: "1" }, "1"],
    [{ code: "{INR}" }, "1"],
    [{ unit: "mg/dL", code: "mg/dL" }, "mg/dL"],
    [{ unit: "x10^3/uL", code: "10*3/uL" }, "10^3/µL"],
    [{ unit: "mmol/L" }, "mmol/L"],
    [{ unit: "  ", code: "g/L" }, "g/L"],
    [{}, null],
    [{ unit: 4 }, null],
  ])("%j -> %j", (quantity, expected) => {
    expect(labUnitFromFhirQuantity(quantity)).toBe(expected);
  });

  it("produces spellings the normaliser and conversion understand", () => {
    for (const code of [
      "10*3/uL",
      "10*6/uL",
      "10*9/L",
      "10*12/L",
      "m[IU]/L",
      "u[IU]/mL",
      "[IU]/L",
    ]) {
      expect(scaleUnitOf(labUnitFromFhirQuantity({ code })!)).not.toBeNull();
    }
    expect(
      sameLabUnit(labUnitFromFhirQuantity({ code: "u[IU]/mL" })!, "µIU/ml"),
    ).toBe(true);
    expect(
      convertLabValue({
        analyteKey: "tsh",
        value: 2,
        from: labUnitFromFhirQuantity({ code: "u[IU]/mL" })!,
        to: "mIU/L",
      }),
    ).toMatchObject({ ok: true, value: 2 });
    expect(
      convertLabValue({
        analyteKey: "ldl",
        value: 3.1,
        from: labUnitFromFhirQuantity({ code: "mmol/L" })!,
        to: "mg/dL",
      }).ok,
    ).toBe(true);
  });
});
