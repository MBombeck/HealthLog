import { describe, expect, it } from "vitest";

import { buildBiomarkerBody } from "../biomarker-form-body";

const empty = {
  name: " LDL ",
  unit: "mg/dL",
  lower: null,
  upper: null,
  panel: " ",
  context: "",
};

describe("buildBiomarkerBody", () => {
  it("omits every empty field on a new marker", () => {
    expect(buildBiomarkerBody(empty, null)).toEqual({
      name: "LDL",
      unit: "mg/dL",
    });
  });

  it("sends the filled fields trimmed", () => {
    expect(
      buildBiomarkerBody(
        { ...empty, lower: 0, upper: 116, panel: " Lipids ", context: " x " },
        null,
      ),
    ).toEqual({
      name: "LDL",
      unit: "mg/dL",
      lowerBound: 0,
      upperBound: 116,
      panel: "Lipids",
      context: "x",
    });
  });

  it("sends null for every field an edit emptied", () => {
    expect(
      buildBiomarkerBody(empty, {
        unit: "mmol/L",
        lowerBound: 10,
        upperBound: 0,
        panel: "Lipids",
        context: "note",
      }),
    ).toEqual({
      name: "LDL",
      unit: "mg/dL",
      lowerBound: null,
      upperBound: null,
      panel: null,
      context: null,
    });
  });

  it("leaves a field out that was empty when the edit began", () => {
    expect(
      buildBiomarkerBody(empty, {
        unit: "mmol/L",
        lowerBound: null,
        upperBound: null,
        panel: null,
        context: null,
      }),
    ).toEqual({ name: "LDL", unit: "mg/dL" });
  });
});

describe("buildBiomarkerBody: the unit on an edit", () => {
  const initial = {
    lowerBound: null,
    upperBound: null,
    panel: null,
    context: null,
  };

  it("leaves an unchanged unit out, so a rename never touches it", () => {
    expect(
      buildBiomarkerBody(
        { ...empty, name: "LDL-C" },
        { ...initial, unit: "mg/dL" },
      ),
    ).toEqual({ name: "LDL-C" });
  });

  it("leaves the unit out when only the whitespace around it moved", () => {
    expect(
      buildBiomarkerBody(
        { ...empty, unit: " mg/dL " },
        { ...initial, unit: "mg/dL" },
      ),
    ).toEqual({ name: "LDL" });
  });

  it("reads a marker minted from a text result and the ticked box as the same no unit", () => {
    expect(
      buildBiomarkerBody(
        { ...empty, name: "Urine protein", unit: "1" },
        { ...initial, unit: "" },
      ),
    ).toEqual({ name: "Urine protein" });
  });

  it("sends a unit the edit changed", () => {
    expect(
      buildBiomarkerBody({ ...empty, unit: "mg/dL" }, { ...initial, unit: "" }),
    ).toEqual({ name: "LDL", unit: "mg/dL" });
    expect(
      buildBiomarkerBody(
        { ...empty, unit: "1" },
        { ...initial, unit: "mg/dL" },
      ),
    ).toEqual({ name: "LDL", unit: "1" });
  });
});

describe("a no-unit marker given a unit in the editor", () => {
  const initial = {
    unit: "",
    lowerBound: 10,
    upperBound: 20,
    panel: null,
    context: null,
  };
  const fields = {
    name: "Ratio",
    unit: "mg/dL",
    lower: 10,
    upper: 20,
    panel: "",
    context: "",
  };

  it("does not send the unitless bounds back unchanged", () => {
    // They were read beside a text result with no unit; the server drops
    // what the edit does not set, as the first numeric import does.
    const body = buildBiomarkerBody(fields, initial);
    expect(body).toEqual({ name: "Ratio", unit: "mg/dL" });
  });

  it("sends a bound the person typed in the new unit", () => {
    const body = buildBiomarkerBody({ ...fields, upper: 150 }, initial);
    expect(body).toEqual({ name: "Ratio", unit: "mg/dL", upperBound: 150 });
  });

  it("keeps sending them while the marker stays without a unit", () => {
    const body = buildBiomarkerBody({ ...fields, unit: "1" }, initial);
    expect(body).toEqual({ name: "Ratio", lowerBound: 10, upperBound: 20 });
  });
});
