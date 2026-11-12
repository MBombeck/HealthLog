import { describe, expect, it } from "vitest";

import { resolvePlanMetric } from "../plan-metric";

describe("resolvePlanMetric", () => {
  it("maps the keys the model writes to a series and a label", () => {
    expect(resolvePlanMetric("SLEEP")?.type).toBe("SLEEP_DURATION");
    expect(resolvePlanMetric("blood pressure")).toMatchObject({
      type: "BLOOD_PRESSURE_SYS",
      labelKey: "measurements.typeBloodPressure",
    });
    expect(resolvePlanMetric("Steps")?.type).toBe("ACTIVITY_STEPS");
    expect(resolvePlanMetric("pulse")?.type).toBe("RESTING_HEART_RATE");
    expect(resolvePlanMetric("HRV")?.labelKey).toBe(
      "measurements.typeHeartRateVariability",
    );
  });

  it("returns null for a metric HealthLog does not read", () => {
    expect(resolvePlanMetric("mood vibes")).toBeNull();
  });
});
