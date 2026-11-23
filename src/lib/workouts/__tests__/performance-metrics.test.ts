import { describe, expect, it } from "vitest";

import {
  missingPerformanceFigures,
  readWorkoutPerformance,
} from "../performance-metrics";

describe("readWorkoutPerformance", () => {
  it("reads the FIT keys and falls back to the Garmin integration's keys", () => {
    const perf = readWorkoutPerformance({
      garminAerobicEffect: 2.8,
      garminAnaerobicEffect: 0.4,
      garminTrainingLoad: 61,
      sweatLossMl: 700,
    });
    expect(perf).toMatchObject({
      aerobicTrainingEffect: 2.8,
      anaerobicTrainingEffect: 0.4,
      trainingLoad: 61,
      sweatLossMl: 700,
      recoveryTimeMin: null,
    });
  });

  it("prefers the figure under its own key", () => {
    expect(
      readWorkoutPerformance({
        aerobicTrainingEffect: 3.1,
        garminAerobicEffect: 2.8,
      })?.aerobicTrainingEffect,
    ).toBe(3.1);
  });

  it("is null for metadata without a plausible figure", () => {
    expect(readWorkoutPerformance(null)).toBeNull();
    expect(readWorkoutPerformance([3])).toBeNull();
    expect(
      readWorkoutPerformance({ aerobicTrainingEffect: 9, sweatLossMl: "1" }),
    ).toBeNull();
  });
});

describe("missingPerformanceFigures", () => {
  it("hands over only what the stored workout does not show yet", () => {
    expect(
      missingPerformanceFigures(
        { garminAerobicEffect: 2.8 },
        { aerobicTrainingEffect: 3, recoveryTimeMin: 900, fitSport: "running" },
      ),
    ).toEqual({ recoveryTimeMin: 900 });
  });

  it("is null when there is nothing to add", () => {
    expect(
      missingPerformanceFigures(
        { recoveryTimeMin: 900 },
        { recoveryTimeMin: 800 },
      ),
    ).toBeNull();
    expect(missingPerformanceFigures(null, { importFormat: "fit" })).toBeNull();
  });
});
