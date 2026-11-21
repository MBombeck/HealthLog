/**
 * The range delta in the account's unit: an affine transform (°C to °F)
 * shifts absolute values, never the delta, and a sum takes the shift once
 * per reading.
 */
import { describe, expect, it } from "vitest";

import { rangeDeltaInUnit } from "@/lib/analytics/range-display";
import type { RangeDeltaResult } from "@/lib/analytics/range-shared";

const stored: RangeDeltaResult = {
  range: "7d",
  windowDays: 7,
  granularity: "DAY",
  current: { count: 2, min: 36.5, max: 37.5, mean: 37, sum: 74 },
  previous: { count: 2, min: 36, max: 37, mean: 36.5, sum: 73 },
  delta: 0.5,
  deltaPct: 0.5 / 36.5,
  trend: "up",
};

describe("rangeDeltaInUnit", () => {
  it("converts temperature for an imperial account", () => {
    const out = rangeDeltaInUnit(stored, "BODY_TEMPERATURE", {
      system: "imperial",
      glucoseUnit: "mg/dL",
    });
    expect(out.unit).toBe("°F");
    expect(out.current.mean).toBeCloseTo(98.6, 1);
    expect(out.delta).toBeCloseTo(0.9, 1);
    expect(out.current.sum).toBeCloseTo(2 * 98.6, 0);
    expect(out.deltaPct).toBeCloseTo(0.9 / 97.7, 3);
    expect(out.trend).toBe("up");
  });

  it("leaves a metric account's numbers alone and names the stored unit", () => {
    const out = rangeDeltaInUnit(stored, "BODY_TEMPERATURE", {
      system: "metric",
      glucoseUnit: "mg/dL",
    });
    expect(out.current).toEqual(stored.current);
    expect(out.delta).toBe(0.5);
    expect(out.unit.length).toBeGreaterThan(0);
  });
});
