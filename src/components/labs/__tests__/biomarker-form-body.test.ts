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
        lowerBound: null,
        upperBound: null,
        panel: null,
        context: null,
      }),
    ).toEqual({ name: "LDL", unit: "mg/dL" });
  });
});
