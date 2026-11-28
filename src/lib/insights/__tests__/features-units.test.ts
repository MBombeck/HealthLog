/**
 * The feature set a briefing or the Coach reads is stated in the reader's
 * units: absolute values through the full transform, differences and slopes
 * through the factor alone, every converted block labelled.
 */
import { describe, expect, it } from "vitest";

import type { AggregatedFeatures } from "../features";
import { featuresInReaderUnits } from "../features-units";

const coverage = { count: 10 } as unknown as NonNullable<
  AggregatedFeatures["weight"]
>["coverage"];

const FEATURES = {
  weight: {
    latest: 80,
    avg7: 80,
    avg30: 81,
    avg90: null,
    allTimeAvg: 82,
    allTimeMin: 70,
    allTimeMax: 90,
    slope30: -0.1,
    outlierCount: 0,
    bmi: 24.7,
    coverage,
    target: {
      min: 65,
      max: 70,
      unit: "kg",
      position: "above",
      progress: "losing",
      reading: "The person set their own weight target at 65–70\u00a0kg …",
    },
  },
  glucose: {
    avg7: 108,
    avg30: 99,
    avg90: null,
    latest: 126,
    latestDaysAgo: 0,
    slope30: 1.8,
    coverage,
  },
  signalsOfDay: [
    {
      metric: "weight",
      label: "weight",
      unit: "kg",
      latest: 80,
      latestDaysAgo: 0,
      avg7: 80.5,
      avg30: 81,
      deltaVs7: -0.5,
      deltaVs30: -1,
      spread30: 0.6,
      outsideNormalSwing: true,
      emergingTrend: "falling",
      recentAnomaly: { kind: "trough", value: 79, anomalyDaysAgo: 2 },
    },
    {
      metric: "glucose",
      label: "blood glucose",
      latest: 90,
      latestDaysAgo: 0,
      avg7: 99,
      avg30: 108,
      deltaVs7: -9,
      deltaVs30: -18,
      spread30: 9,
      outsideNormalSwing: true,
      emergingTrend: "flat",
      recentAnomaly: null,
    },
    {
      metric: "bp",
      label: "blood pressure (systolic)",
      unit: "mmHg",
      latest: 128,
      latestDaysAgo: 0,
      avg7: 125,
      avg30: 124,
      deltaVs7: 3,
      deltaVs30: 4,
      spread30: 5,
      outsideNormalSwing: false,
      emergingTrend: "flat",
      recentAnomaly: null,
    },
  ],
  historicalComparison: {
    weight: { current7dAvg: 80, previous30dAvg: 82, change: -2 },
  },
  workouts: {
    last7: { count: 2, totalDurationMin: 90, totalDistanceKm: 10 },
    last30: { count: 6, totalDurationMin: 300, totalDistanceKm: null },
    latest: {
      sportType: "running",
      daysAgo: 1,
      durationMin: 45,
      distanceKm: 5,
    },
  },
  context: {},
} as unknown as AggregatedFeatures;

describe("featuresInReaderUnits", () => {
  it("states weight in pounds for an imperial reader, labelled", () => {
    const out = featuresInReaderUnits(FEATURES, {
      system: "imperial",
      glucoseUnit: "mg/dL",
    });
    expect(out.weight).toMatchObject({
      unit: "lb",
      latest: 176.4,
      avg30: 178.6,
      avg90: null,
      allTimeMin: 154.3,
      slope30: -0.2,
      bmi: 24.7,
    });
    // The target band is quoted in pounds and still judged in kilograms.
    expect(out.weight?.target).toMatchObject({
      min: 143.3,
      max: 154.3,
      unit: "lb",
      position: "above",
    });
    expect(out.weight?.target?.reading).toContain("143.3–154.3\u00a0lb");
    expect(out.historicalComparison?.weight).toMatchObject({
      current7dAvg: 176.4,
      change: -4.4,
      unit: "lb",
    });
  });

  it("converts every figure of a weight signal, deltas by the factor alone", () => {
    const [weight, glucose, bp] = featuresInReaderUnits(FEATURES, {
      system: "imperial",
      glucoseUnit: "mmol/L",
    }).signalsOfDay!;
    expect(weight).toMatchObject({
      unit: "lb",
      latest: 176.4,
      deltaVs7: -1.1,
      spread30: 1.3,
      recentAnomaly: { value: 174.2 },
    });
    expect(glucose).toMatchObject({
      unit: "mmol/L",
      latest: 5,
      avg30: 6,
      deltaVs30: -1,
    });
    expect(bp).toEqual(FEATURES.signalsOfDay![2]);
  });

  it("states glucose in mmol/L for a mmol/L reader", () => {
    const out = featuresInReaderUnits(FEATURES, {
      system: "metric",
      glucoseUnit: "mmol/L",
    });
    expect(out.glucose).toMatchObject({
      unit: "mmol/L",
      avg7: 6,
      avg30: 5.5,
      latest: 7,
      slope30: 0.1,
    });
  });

  it("states workout distance in the reader's unit under unit-neutral keys", () => {
    const out = featuresInReaderUnits(FEATURES, {
      system: "imperial",
      glucoseUnit: "mg/dL",
    }) as unknown as {
      workouts: Record<string, Record<string, unknown> | string>;
    };
    expect(out.workouts.distanceUnit).toBe("mi");
    expect(out.workouts.last7).toMatchObject({ totalDistance: 6.21 });
    expect(out.workouts.last7).not.toHaveProperty("totalDistanceKm");
    expect(out.workouts.last30).toMatchObject({ totalDistance: null });
    expect(out.workouts.latest).toMatchObject({ distance: 3.11 });
  });

  it("keeps every number for a metric mg/dL reader and only adds labels", () => {
    const out = featuresInReaderUnits(FEATURES, {
      system: "metric",
      glucoseUnit: "mg/dL",
    });
    expect(out.weight).toMatchObject({ unit: "kg", latest: 80, avg30: 81 });
    expect(out.glucose).toMatchObject({ unit: "mg/dL", avg7: 108 });
    expect(out.signalsOfDay![1]).toMatchObject({ unit: "mg/dL", latest: 90 });
  });

  it("leaves the input untouched", () => {
    const before = JSON.stringify(FEATURES);
    featuresInReaderUnits(FEATURES, {
      system: "imperial",
      glucoseUnit: "mmol/L",
    });
    expect(JSON.stringify(FEATURES)).toBe(before);
  });
});
