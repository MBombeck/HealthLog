import { describe, expect, it } from "vitest";

import {
  mergeNutrientTargets,
  nutrientTargetCodes,
  nutrientTargetsPatchSchema,
  parseNutrientTargets,
} from "../nutrient-targets";

describe("nutrient targets", () => {
  it("accepts a target or a limit per catalog code and null to clear", () => {
    const parsed = nutrientTargetsPatchSchema.safeParse({
      targets: {
        protein: { value: 120, direction: "target" },
        sugar: { value: 40, direction: "limit" },
        energy: null,
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses an unknown code, a value at or below zero, and one above the code's cap", () => {
    for (const targets of [
      { creatine: { value: 5, direction: "target" } },
      { protein: { value: 0, direction: "target" } },
      { protein: { value: 1001, direction: "target" } },
      { energy: { value: 2000, direction: "maximum" } },
      { energy: { value: 2000, direction: "target", extra: 1 } },
    ]) {
      expect(
        nutrientTargetsPatchSchema.safeParse({ targets }).success,
        JSON.stringify(targets),
      ).toBe(false);
    }
  });

  it("merges code by code: named codes change, null clears, the rest stay", () => {
    const current = parseNutrientTargets({
      protein: { value: 100, direction: "target" },
      sugar: { value: 50, direction: "limit" },
    });
    const next = mergeNutrientTargets(current, {
      targets: {
        protein: { value: 120, direction: "target" },
        sugar: null,
        fiber: { value: 30, direction: "target" },
      },
    });
    expect(next).toEqual({
      protein: { value: 120, direction: "target" },
      fiber: { value: 30, direction: "target" },
    });
    expect(nutrientTargetCodes(next)).toEqual(["protein", "fiber"]);
  });

  it("reads a damaged stored value code by code and never throws", () => {
    expect(parseNutrientTargets(null)).toEqual({});
    expect(parseNutrientTargets([1, 2])).toEqual({});
    expect(
      parseNutrientTargets({
        protein: { value: 120, direction: "target" },
        sugar: { value: -1, direction: "limit" },
        retired_code: { value: 1, direction: "target" },
      }),
    ).toEqual({ protein: { value: 120, direction: "target" } });
  });
});
