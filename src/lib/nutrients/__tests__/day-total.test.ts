/**
 * How one day's nutrient rows add up: the largest day-total source counts,
 * additive sources add on top, and the split always sums to the total.
 */
import { describe, expect, it } from "vitest";

import { foldNutrientDay, foldNutrientDays } from "../day-total";
import { DAY_TOTAL_SOURCES } from "../sources";

describe("foldNutrientDay", () => {
  it("counts only the larger of a tracker total and the Apple Health total", () => {
    const fold = foldNutrientDay([
      { source: "APPLE_HEALTH", amount: 2000 },
      { source: "EXTERNAL", amount: 2100 },
    ]);
    expect(fold).toEqual({ total: 2100, bySource: { EXTERNAL: 2100 } });
  });

  it("no longer adds Apple Health and Health Connect on top of each other", () => {
    const fold = foldNutrientDay([
      { source: "APPLE_HEALTH", amount: 1800 },
      { source: "HEALTH_CONNECT", amount: 1700 },
    ]);
    expect(fold).toEqual({ total: 1800, bySource: { APPLE_HEALTH: 1800 } });
  });

  it("adds manual and supplement rows on top of the counted day total", () => {
    const fold = foldNutrientDay([
      { source: "APPLE_HEALTH", amount: 1500 },
      { source: "EXTERNAL", amount: 1200 },
      { source: "MANUAL", amount: 250 },
      { source: "SUPPLEMENT", amount: 100 },
    ]);
    expect(fold).toEqual({
      total: 1850,
      bySource: { APPLE_HEALTH: 1500, MANUAL: 250, SUPPLEMENT: 100 },
    });
  });

  it("adds a source outside the closed set to the total without naming it", () => {
    const fold = foldNutrientDay([
      { source: "APPLE_HEALTH", amount: 10 },
      { source: "SOMETHING_NEW", amount: 5 },
    ]);
    expect(fold).toEqual({ total: 15, bySource: { APPLE_HEALTH: 10 } });
  });

  it("breaks a tie by source order, whatever order the rows arrive in", () => {
    const rows = DAY_TOTAL_SOURCES.map((source) => ({ source, amount: 70 }));
    const forward = foldNutrientDay(rows);
    const backward = foldNutrientDay([...rows].reverse());
    expect(forward).toEqual({ total: 70, bySource: { EXTERNAL: 70 } });
    expect(backward).toEqual(forward);
  });

  it("returns zero and an empty split for no rows", () => {
    expect(foldNutrientDay([])).toEqual({ total: 0, bySource: {} });
  });

  it("keeps the split summing to the total for every mix of known sources", () => {
    const sources = [
      "APPLE_HEALTH",
      "HEALTH_CONNECT",
      "EXTERNAL",
      "MANUAL",
      "SUPPLEMENT",
    ];
    for (let mask = 1; mask < 1 << sources.length; mask += 1) {
      const rows = sources
        .filter((_, i) => mask & (1 << i))
        .map((source, i) => ({ source, amount: 10 * (i + 1) + mask }));
      const fold = foldNutrientDay(rows);
      const sum = Object.values(fold.bySource).reduce((a, b) => a + b, 0);
      expect(sum, `mask ${mask}`).toBe(fold.total);
    }
  });
});

describe("foldNutrientDays", () => {
  it("folds each key on its own", () => {
    const folds = foldNutrientDays(
      [
        { day: "2026-11-01", source: "APPLE_HEALTH", amount: 1 },
        { day: "2026-11-01", source: "EXTERNAL", amount: 3 },
        { day: "2026-11-02", source: "MANUAL", amount: 2 },
      ],
      (row) => row.day,
    );
    expect(folds.get("2026-11-01")?.total).toBe(3);
    expect(folds.get("2026-11-02")?.total).toBe(2);
  });
});
