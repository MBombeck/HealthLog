import { describe, expect, it, vi } from "vitest";

import { createWorkoutEvidenceBuilder } from "../workout-evidence-builder";
import type { WorkoutEvidenceInput } from "../workout-evidence";

describe("workout evidence builder", () => {
  it("keeps tenancy and derived evidence dependencies explicit", async () => {
    const startedAt = new Date("2026-07-01T06:00:00Z");
    const endedAt = new Date("2026-07-01T06:40:00Z");
    const findWorkout = vi.fn(async () => ({
      sportType: "running",
      source: "APPLE_HEALTH",
      startedAt,
      endedAt,
      durationSec: 2400,
      totalEnergyKcal: 410,
      totalDistanceM: 7200,
      avgHeartRate: 148,
      maxHeartRate: 171,
      minHeartRate: 96,
      stepCount: 6800,
      elevationM: 62,
      pauseDurationSec: 0,
      metadata: { zones: true },
      samples: { samples: [{ tSec: 0, mean: 120 }] },
    }));
    const findProfile = vi.fn(async () => ({
      sourcePriorityJson: { workouts: ["APPLE_HEALTH"] },
      dateOfBirth: new Date("1990-01-01T00:00:00Z"),
      timezone: "Europe/London",
    }));
    const buildHrSeries = vi.fn(async () => ({
      source: "workout_series" as const,
      points: [{ tSec: 0, mean: 120, min: 110, max: 130 }],
      bucketSec: 60,
      envelope: false,
    }));
    const computeZones = vi.fn(() => ({
      model: "tanaka" as const,
      hrMax: 185,
      zones: [{ zone: 3, lowBpm: 130, highBpm: 148, seconds: 900 }],
    }));
    const buildSportContext = vi.fn(async () => ({
      count: 4,
      avgDurationSec: 2100,
      avgDistanceM: 6400,
      avgAvgHr: 151,
    }));
    const buildEvidence = vi.fn((input: WorkoutEvidenceInput) => ({
      ...input,
    }));
    const onSkipped = vi.fn();
    const buildWorkoutEvidenceSection = createWorkoutEvidenceBuilder({
      findWorkout,
      findProfile,
      buildHrSeries,
      computeZones,
      hrMaxFromAge: vi.fn(() => 185),
      getAgeFromDateOfBirth: vi.fn(() => 36),
      parseWhoopZoneDurations: vi.fn(() => [0, 0, 900, 0, 0]),
      buildSportContext,
      buildEvidence,
      onSkipped,
    });

    const result = await buildWorkoutEvidenceSection("u1", "w1");

    expect(findWorkout).toHaveBeenCalledWith("u1", "w1");
    expect(buildHrSeries).toHaveBeenCalledWith({
      userId: "u1",
      startedAt,
      endedAt,
      durationSec: 2400,
      storedSamples: [{ tSec: 0, mean: 120 }],
    });
    expect(buildSportContext).toHaveBeenCalledWith(
      "u1",
      "running",
      { workouts: ["APPLE_HEALTH"] },
      "w1",
    );
    expect(buildEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        sportType: "running",
        timezone: "Europe/London",
        zones: {
          model: "tanaka",
          hrMax: 185,
          zones: [{ zone: 3, lowBpm: 130, highBpm: 148, seconds: 900 }],
        },
        hrPoints: [{ tSec: 0, mean: 120, min: 110, max: 130 }],
        sportContext: {
          count: 4,
          avgDurationSec: 2100,
          avgDistanceM: 6400,
          avgAvgHr: 151,
        },
      }),
    );
    expect(result).toEqual(expect.objectContaining({ sportType: "running" }));
    expect(onSkipped).not.toHaveBeenCalled();
  });

  it("fails open through the injected skip observer", async () => {
    const onSkipped = vi.fn();
    const buildWorkoutEvidenceSection = createWorkoutEvidenceBuilder({
      findWorkout: vi.fn(async () => {
        throw new Error("read failed");
      }),
      findProfile: vi.fn(),
      buildHrSeries: vi.fn(),
      computeZones: vi.fn(),
      hrMaxFromAge: vi.fn(),
      getAgeFromDateOfBirth: vi.fn(),
      parseWhoopZoneDurations: vi.fn(),
      buildSportContext: vi.fn(),
      buildEvidence: vi.fn(),
      onSkipped,
    });

    await expect(buildWorkoutEvidenceSection("u1", "w1")).resolves.toBeNull();
    expect(onSkipped).toHaveBeenCalledTimes(1);
  });
});
