import { describe, expect, it } from "vitest";
import {
  createWorkoutSchema,
  geoJsonLineStringSchema,
  workoutRouteSamplesSchema,
  workoutSportTypeEnum,
  type CreateWorkoutInput,
} from "../workout";

describe("workoutSportTypeEnum", () => {
  it("accepts every documented sport", () => {
    for (const sport of [
      "walking",
      "running",
      "cycling",
      "swimming",
      "hiit",
      "other",
    ]) {
      expect(workoutSportTypeEnum.parse(sport)).toBe(sport);
    }
  });

  it("rejects an unknown sport", () => {
    expect(() => workoutSportTypeEnum.parse("teleportation")).toThrow();
  });
});

describe("geoJsonLineStringSchema", () => {
  it("accepts a valid GeoJSON LineString with lon/lat pairs", () => {
    const parsed = geoJsonLineStringSchema.parse({
      type: "LineString",
      coordinates: [
        [11.077, 49.452],
        [11.078, 49.453],
      ],
    });
    expect(parsed.type).toBe("LineString");
    expect(parsed.coordinates).toHaveLength(2);
  });

  it("accepts coordinates with an altitude component", () => {
    const parsed = geoJsonLineStringSchema.parse({
      type: "LineString",
      coordinates: [
        [11.077, 49.452, 320.5],
        [11.078, 49.453, 322.1],
      ],
    });
    expect(parsed.coordinates[0]).toHaveLength(3);
  });

  it("rejects a Point geometry", () => {
    expect(() =>
      geoJsonLineStringSchema.parse({
        type: "Point",
        coordinates: [11.077, 49.452],
      }),
    ).toThrow();
  });

  it("rejects a single-point LineString", () => {
    expect(() =>
      geoJsonLineStringSchema.parse({
        type: "LineString",
        coordinates: [[11.077, 49.452]],
      }),
    ).toThrow(/at least 2 points/);
  });

  it("rejects out-of-bounds longitude / latitude", () => {
    expect(() =>
      geoJsonLineStringSchema.parse({
        type: "LineString",
        coordinates: [
          [200, 49.452],
          [201, 49.453],
        ],
      }),
    ).toThrow();
    expect(() =>
      geoJsonLineStringSchema.parse({
        type: "LineString",
        coordinates: [
          [11.077, 200],
          [11.078, 201],
        ],
      }),
    ).toThrow();
  });
});

describe("workoutRouteSamplesSchema", () => {
  it("accepts an array of timestamp + optional speed/hr entries", () => {
    const parsed = workoutRouteSamplesSchema.parse([
      { t: "2026-05-14T07:00:00.000Z", speedMs: 3.2, hr: 142 },
      { t: "2026-05-14T07:00:05.000Z" },
    ]);
    expect(parsed).toHaveLength(2);
  });

  it("rejects negative speed", () => {
    expect(() =>
      workoutRouteSamplesSchema.parse([
        { t: "2026-05-14T07:00:00.000Z", speedMs: -1 },
      ]),
    ).toThrow();
  });
});

describe("createWorkoutSchema", () => {
  const minimalRun: Record<string, unknown> = {
    sportType: "running",
    startedAt: "2026-05-14T06:30:00.000Z",
    endedAt: "2026-05-14T07:15:00.000Z",
  };

  it("accepts a minimal workout payload", () => {
    const parsed = createWorkoutSchema.parse(minimalRun);
    expect(parsed.sportType).toBe("running");
    expect(parsed.startedAt).toBeInstanceOf(Date);
    expect(parsed.endedAt).toBeInstanceOf(Date);
    expect(parsed.source).toBe("MANUAL");
  });

  it("accepts an Apple-Health-shaped HKWorkout payload", () => {
    const input: Record<string, unknown> = {
      sportType: "running",
      startedAt: "2026-05-14T06:30:00.000Z",
      endedAt: "2026-05-14T07:15:00.000Z",
      totalEnergyKcal: 412.3,
      totalDistanceM: 7_800,
      avgHeartRate: 154,
      maxHeartRate: 178,
      minHeartRate: 92,
      source: "APPLE_HEALTH",
      externalId: "B5F8-...-A3",
      metadata: { HKAverageMETs: 8.4, sourceBundleId: "com.apple.health" },
      route: {
        geometry: {
          type: "LineString",
          coordinates: [
            [11.077, 49.452, 320.5],
            [11.078, 49.453, 322.1],
          ],
        },
        sampleTimestamps: [
          { t: "2026-05-14T06:30:00.000Z", speedMs: 3.2, hr: 142 },
          { t: "2026-05-14T06:30:05.000Z", speedMs: 3.3, hr: 144 },
        ],
      },
    };
    const parsed: CreateWorkoutInput = createWorkoutSchema.parse(input);
    expect(parsed.source).toBe("APPLE_HEALTH");
    expect(parsed.totalDistanceM).toBe(7_800);
    expect(parsed.route?.geometry.coordinates).toHaveLength(2);
  });

  it("rejects an unknown sportType", () => {
    expect(() =>
      createWorkoutSchema.parse({ ...minimalRun, sportType: "fartlek" }),
    ).toThrow();
  });

  it("rejects a max heart rate below the resting floor", () => {
    expect(() =>
      createWorkoutSchema.parse({ ...minimalRun, maxHeartRate: 5 }),
    ).toThrow();
  });
});
