import { describe, expect, it } from "vitest";

import {
  buildWeightTargetFeature,
  resolveWeightTrend,
  weightTargetPosition,
  weightTrendReferenceKg,
} from "@/lib/targets/weight-trend";
import { getTrendSentiment } from "@/lib/insights/trend-sentiment";

const TARGET = { min: 70, max: 75 };

describe("weightTargetPosition", () => {
  it("places a reading below, inside or above the stored target", () => {
    expect(weightTargetPosition(TARGET, 65)).toBe("below");
    expect(weightTargetPosition(TARGET, 70)).toBe("inside");
    expect(weightTargetPosition(TARGET, 72.5)).toBe("inside");
    expect(weightTargetPosition(TARGET, 75)).toBe("inside");
    expect(weightTargetPosition(TARGET, 80)).toBe("above");
  });

  it("answers null without a target or without a usable reading", () => {
    expect(weightTargetPosition(null, 80)).toBeNull();
    expect(weightTargetPosition(TARGET, null)).toBeNull();
    expect(weightTargetPosition(TARGET, Number.NaN)).toBeNull();
  });
});

describe("resolveWeightTrend", () => {
  it("below the target, gaining is progress", () => {
    const trend = resolveWeightTrend(TARGET, 62);
    expect(trend).toEqual({ direction: "up-good", targetPosition: "below" });
    expect(getTrendSentiment(0.6, trend.direction)).toBe("positive");
    expect(getTrendSentiment(-0.6, trend.direction)).toBe("negative");
  });

  it("above the target, losing is progress", () => {
    const trend = resolveWeightTrend(TARGET, 84);
    expect(trend).toEqual({ direction: "up-bad", targetPosition: "above" });
    expect(getTrendSentiment(-0.6, trend.direction)).toBe("positive");
    expect(getTrendSentiment(0.6, trend.direction)).toBe("negative");
  });

  it("inside the target, holding steady is progress and no move is a setback", () => {
    const trend = resolveWeightTrend(TARGET, 72);
    expect(trend).toEqual({ direction: "hold", targetPosition: "inside" });
    expect(getTrendSentiment(0, trend.direction)).toBe("positive");
    expect(getTrendSentiment(0.01, trend.direction)).toBe("positive");
    expect(getTrendSentiment(0.6, trend.direction)).toBe("neutral");
    expect(getTrendSentiment(-0.6, trend.direction)).toBe("neutral");
  });

  it("without a stored target keeps the historical reading: a fall reads as good", () => {
    const trend = resolveWeightTrend(null, 84);
    expect(trend).toEqual({ direction: "up-bad", targetPosition: null });
    expect(getTrendSentiment(-0.6, trend.direction)).toBe("positive");
  });

  it("with a target but no reading yet keeps the historical reading too", () => {
    expect(resolveWeightTrend(TARGET, null)).toEqual({
      direction: "up-bad",
      targetPosition: null,
    });
  });
});

describe("weightTrendReferenceKg", () => {
  it("prefers the 7-day average so one noisy reading at the band edge does not flip the colour", () => {
    expect(weightTrendReferenceKg({ avg7: 71, latest: 69 })).toBe(71);
  });

  it("falls back to the latest reading, then to nothing", () => {
    expect(weightTrendReferenceKg({ avg7: null, latest: 69 })).toBe(69);
    expect(weightTrendReferenceKg({ avg7: null, latest: null })).toBeNull();
    expect(weightTrendReferenceKg(undefined)).toBeNull();
  });
});

describe("getTrendSentiment — existing directions unchanged", () => {
  it("still colours up-good, up-bad and neutral exactly as before", () => {
    expect(getTrendSentiment(1, "up-good")).toBe("positive");
    expect(getTrendSentiment(-1, "up-good")).toBe("negative");
    expect(getTrendSentiment(1, "up-bad")).toBe("negative");
    expect(getTrendSentiment(0.01, "up-bad")).toBe("neutral");
    expect(getTrendSentiment(1, "neutral")).toBe("neutral");
    expect(getTrendSentiment(null, "up-good")).toBe("neutral");
  });

  it("a hold direction with no signal at all stays neutral rather than claiming progress", () => {
    expect(getTrendSentiment(null, "hold")).toBe("neutral");
  });
});

describe("buildWeightTargetFeature", () => {
  it("names the progress direction for each side of the band", () => {
    expect(
      buildWeightTargetFeature(TARGET, { avg7: 66, latest: 66 })?.progress,
    ).toBe("gaining");
    expect(
      buildWeightTargetFeature(TARGET, { avg7: 72, latest: 72 })?.progress,
    ).toBe("holding steady");
    expect(
      buildWeightTargetFeature(TARGET, { avg7: 80, latest: 80 })?.progress,
    ).toBe("losing");
  });

  it("claims nothing without a stored target or a reading", () => {
    expect(buildWeightTargetFeature(null, { avg7: 80, latest: 80 })).toBeNull();
    expect(
      buildWeightTargetFeature(TARGET, { avg7: null, latest: null }),
    ).toBeNull();
  });
});

describe("buildWeightTargetFeature — the reader's mass unit", () => {
  it("quotes the band in pounds for an imperial reader and judges it in kilograms", () => {
    const feature = buildWeightTargetFeature(
      { min: 65, max: 70 },
      { avg7: 66, latest: 66 },
      "imperial",
    );
    expect(feature).toMatchObject({
      min: 143.3,
      max: 154.3,
      unit: "lb",
      position: "inside",
    });
    expect(feature?.reading).toContain("143.3–154.3\u00a0lb");
    expect(feature?.reading).not.toContain("kg");
  });

  it("keeps kilograms for a metric reader", () => {
    const feature = buildWeightTargetFeature(
      { min: 65, max: 70 },
      { avg7: 72, latest: 72 },
    );
    expect(feature).toMatchObject({ min: 65, max: 70, unit: "kg" });
    expect(feature?.reading).toContain("65–70\u00a0kg");
  });
});
