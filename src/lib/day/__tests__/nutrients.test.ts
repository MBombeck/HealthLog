import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} }));

import { NUTRIENT_CODES } from "@/lib/nutrients/catalog";
import { shapeDayNutrients } from "../nutrients";

describe("shapeDayNutrients", () => {
  it("sums a day the way the nutrients page does, in catalog order", () => {
    const out = shapeDayNutrients([
      // A tracker and Apple Health report the same meals: the larger counts.
      { nutrient: "protein", source: "EXTERNAL", amount: 82.5 },
      { nutrient: "protein", source: "APPLE_HEALTH", amount: 80 },
      // Manual water adds to the synced total.
      { nutrient: "water", source: "APPLE_HEALTH", amount: 1200 },
      { nutrient: "water", source: "MANUAL", amount: 250 },
      { nutrient: "energy", source: "EXTERNAL", amount: 2150 },
    ]);
    const byCode = Object.fromEntries(out.map((n) => [n.code, n]));
    expect(byCode.protein).toEqual({
      code: "protein",
      amount: 82.5,
      unit: "g",
    });
    expect(byCode.water.amount).toBe(1450);
    expect(byCode.energy).toEqual({
      code: "energy",
      amount: 2150,
      unit: "kcal",
    });
    const order = out.map((n) =>
      NUTRIENT_CODES.indexOf(n.code as (typeof NUTRIENT_CODES)[number]),
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("leaves out a zero day total", () => {
    expect(
      shapeDayNutrients([
        { nutrient: "caffeine", source: "MANUAL", amount: 0 },
      ]),
    ).toEqual([]);
  });
});
