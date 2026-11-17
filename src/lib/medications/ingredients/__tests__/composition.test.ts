/**
 * v1.43 — checking a composition against the nutrient catalogue, storing it
 * canonically and publishing it.
 */
import { describe, expect, it } from "vitest";

import {
  canonicalComposition,
  compositionSummary,
  nutrientLabel,
  toIngredientDtos,
} from "../composition";

describe("canonicalComposition", () => {
  it("converts an IU entry to the canonical unit and keeps what was entered", () => {
    const check = canonicalComposition([
      { nutrient: "vitamin_d", amount: 1000, unit: "IU" },
    ]);
    expect(check).toEqual({
      ok: true,
      ingredients: [
        {
          nutrient: "vitamin_d",
          amountPerUnit: 25,
          unit: "ug",
          enteredAmount: 1000,
          enteredUnit: "IU",
        },
      ],
    });
  });

  it("keeps no entered amount when the entry is already canonical", () => {
    const check = canonicalComposition([
      { nutrient: "magnesium", amount: 120, unit: "mg" },
    ]);
    expect(check.ok && check.ingredients[0]).toMatchObject({
      amountPerUnit: 120,
      enteredAmount: null,
      enteredUnit: null,
    });
  });

  it("names the row of an unknown code", () => {
    expect(
      canonicalComposition([
        { nutrient: "zinc", amount: 10, unit: "mg" },
        { nutrient: "coenzyme_q10", amount: 30, unit: "mg" },
      ]),
    ).toEqual({ ok: false, kind: "unknownNutrient", index: 1 });
  });

  it("refuses a catalogue code that is no ingredient: energy, a macro, alcohol, water", () => {
    for (const nutrient of ["energy", "protein", "alcohol", "water"]) {
      expect(
        canonicalComposition([
          { nutrient: "zinc", amount: 10, unit: "mg" },
          { nutrient, amount: 5, unit: "g" },
        ]),
        nutrient,
      ).toEqual({ ok: false, kind: "unknownNutrient", index: 1 });
    }
  });

  it("names the row and the allowed units of a unit the code does not offer", () => {
    expect(
      canonicalComposition([
        { nutrient: "vitamin_e", amount: 400, unit: "IU" },
      ]),
    ).toEqual({
      ok: false,
      kind: "unitMismatch",
      index: 0,
      allowedUnits: ["mg", "ug", "g"],
    });
  });

  it("accepts the supplement-only codes", () => {
    const check = canonicalComposition([
      { nutrient: "dha", amount: 0.25, unit: "g" },
      { nutrient: "epa", amount: 180, unit: "mg" },
    ]);
    expect(check.ok && check.ingredients.map((i) => i.amountPerUnit)).toEqual([
      250, 180,
    ]);
  });
});

describe("toIngredientDtos", () => {
  const rows = [
    {
      nutrient: "dha",
      amountPerUnit: 250,
      unit: "mg",
      enteredAmount: null,
      enteredUnit: null,
    },
    {
      nutrient: "vitamin_d",
      amountPerUnit: 25,
      unit: "ug",
      enteredAmount: 1000,
      enteredUnit: "IU",
    },
  ];

  it("orders by the catalogue and labels in the account language", () => {
    const dtos = toIngredientDtos(rows, "de");
    expect(dtos.map((d) => d.nutrient)).toEqual(["vitamin_d", "dha"]);
    expect(dtos[0]).toMatchObject({
      labelKey: "nutrients.names.vitamin_d",
      label: "Vitamin D",
      enteredUnit: "IU",
    });
    expect(dtos[1].label).toBe("DHA (Omega-3)");
  });

  it("keeps a code the catalogue no longer knows under its raw code", () => {
    const dtos = toIngredientDtos(
      [{ ...rows[0], nutrient: "retired_code" }],
      "en",
    );
    expect(dtos[0]).toMatchObject({
      nutrient: "retired_code",
      label: "retired_code",
    });
  });

  it("falls back to English for an unknown locale", () => {
    expect(nutrientLabel("vitamin_d", "xx")).toBe("Vitamin D");
  });
});

describe("compositionSummary", () => {
  it("is one sorted line, empty for no composition", () => {
    expect(
      compositionSummary([
        { nutrient: "zinc", amountPerUnit: 10, unit: "mg" },
        { nutrient: "dha", amountPerUnit: 250, unit: "mg" },
      ]),
    ).toBe("dha=250 mg; zinc=10 mg");
    expect(compositionSummary([])).toBe("");
  });
});
