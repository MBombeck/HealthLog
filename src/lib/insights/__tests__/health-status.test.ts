import { describe, it, expect } from "vitest";

import { summariseHealthStatus } from "@/lib/insights/health-status";
import type { VitalDeviation } from "@/lib/insights/derived/coincident-deviation";
import type { ChangepointSignal } from "@/lib/insights/derived/changepoint";

function vital(
  outside: boolean,
  direction: VitalDeviation["direction"],
  daysAgo = 0,
): VitalDeviation {
  return {
    type: "RESTING_HEART_RATE",
    value: 70,
    center: 60,
    low: 55,
    high: 65,
    outside,
    direction,
    daysAgo,
  };
}

function shift(): ChangepointSignal {
  return {
    metric: "WEIGHT",
    breakDate: "2026-06-10",
    beforeMean: 80,
    afterMean: 82,
    direction: "up",
    magnitude: 1.6,
  };
}

describe("summariseHealthStatus", () => {
  it("is absent when nothing is outside and no shift fired", () => {
    const s = summariseHealthStatus([vital(false, "in")], []);
    expect(s.present).toBe(false);
    expect(s.deviations).toHaveLength(0);
    expect(s.shifts).toHaveLength(0);
  });

  it("surfaces an out-of-band deviation", () => {
    const s = summariseHealthStatus([vital(true, "above")], []);
    expect(s.present).toBe(true);
    expect(s.deviations).toHaveLength(1);
    expect(s.deviations[0]).toMatchObject({
      type: "RESTING_HEART_RATE",
      direction: "above",
    });
  });

  it("surfaces a changepoint shift even with no deviation", () => {
    const s = summariseHealthStatus([vital(false, "in")], [shift()]);
    expect(s.present).toBe(true);
    expect(s.shifts).toHaveLength(1);
    expect(s.shifts[0]).toMatchObject({ metric: "WEIGHT", direction: "up" });
  });

  it("drops a vital flagged outside but with an 'in' direction", () => {
    const s = summariseHealthStatus([vital(true, "in")], []);
    expect(s.present).toBe(false);
  });

  it("says when a deviation is measured against the same hours", () => {
    const s = summariseHealthStatus(
      [
        { ...vital(true, "below"), type: "BLOOD_GLUCOSE", basis: "sameHours" },
        vital(true, "above"),
      ],
      [],
    );
    expect(s.deviations.map((d) => d.basis)).toEqual(["sameHours", "day"]);
  });
});
