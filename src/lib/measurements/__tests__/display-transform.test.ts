import { describe, it, expect } from "vitest";

import {
  applyDisplayTransform,
  getDisplayTransform,
  DEFAULT_UNIT_PREFERENCE,
} from "../display-transform";

describe("display-transform", () => {
  it("converts WALKING_SPEED m/s → km/h (factor 3.6)", () => {
    const t = getDisplayTransform("WALKING_SPEED", "metric");
    expect(t.factor).toBe(3.6);
    expect(t.displayUnit).toBe("km/h");
    expect(t.decimals).toBe(1);
    // 1.3 m/s → 4.68 km/h (1 dp → 4.7).
    const scaled = applyDisplayTransform(1.3, t);
    expect(scaled).toBeCloseTo(4.68, 5);
    expect(Number(scaled.toFixed(t.decimals))).toBe(4.7);
  });

  it("converts WALKING_RUNNING_DISTANCE m → km (factor 0.001)", () => {
    const t = getDisplayTransform("WALKING_RUNNING_DISTANCE", "metric");
    expect(t.factor).toBe(0.001);
    expect(t.displayUnit).toBe("km");
    expect(t.decimals).toBe(2);
    // 5000 m → 5.00 km.
    expect(applyDisplayTransform(5000, t)).toBeCloseTo(5, 5);
  });

  it("exposes imperial branches for speed + distance", () => {
    const speed = getDisplayTransform("WALKING_SPEED", "imperial");
    expect(speed.displayUnit).toBe("mph");
    // 1.34 m/s ≈ 3.0 mph.
    expect(applyDisplayTransform(1.34, speed)).toBeCloseTo(2.9975, 3);

    const dist = getDisplayTransform("WALKING_RUNNING_DISTANCE", "imperial");
    expect(dist.displayUnit).toBe("mi");
    // 1609.34 m ≈ 1 mile.
    expect(applyDisplayTransform(1609.344, dist)).toBeCloseTo(1, 3);
  });

  it("returns identity (factor 1) for untransformed types", () => {
    for (const type of ["PULSE", "WEIGHT", "RESPIRATORY_RATE", "AUDIO_EXPOSURE_ENV"]) {
      const t = getDisplayTransform(type);
      expect(t.factor).toBe(1);
      // identity scale leaves the raw value untouched
      expect(applyDisplayTransform(42, t)).toBe(42);
    }
  });

  it("identity transform surfaces the canonical unit", () => {
    expect(getDisplayTransform("WEIGHT").displayUnit).toBe("kg");
    expect(getDisplayTransform("PULSE").displayUnit).toBe("bpm");
    expect(getDisplayTransform("WALKING_STEP_LENGTH").displayUnit).toBe("m");
  });

  it("defaults to the metric preference", () => {
    expect(DEFAULT_UNIT_PREFERENCE).toBe("metric");
    expect(getDisplayTransform("WALKING_SPEED")).toEqual(
      getDisplayTransform("WALKING_SPEED", "metric"),
    );
  });
});
