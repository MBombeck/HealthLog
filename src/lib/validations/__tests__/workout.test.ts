import { describe, expect, it } from "vitest";
import {
  createBatchWorkoutSchema,
  createWorkoutSchema,
  geoJsonLineStringSchema,
  MAX_ROUTE_POINTS,
  MAX_WORKOUTS_PER_BATCH,
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

  it("rejects a route geometry that exceeds the per-route point cap", () => {
    // One past the cap — schema MUST reject. The cap exists so a single
    // pathological workout can't blow the 5 MB request-body ceiling on
    // its own; a desync between the schema cap and the route route's
    // expected-size accounting would silently degrade ingest.
    const coords: [number, number][] = [];
    for (let i = 0; i < MAX_ROUTE_POINTS + 1; i++) {
      coords.push([11 + i * 1e-6, 49 + i * 1e-6]);
    }
    expect(() =>
      createWorkoutSchema.parse({
        ...minimalRun,
        route: {
          geometry: { type: "LineString", coordinates: coords },
        },
      }),
    ).toThrow(/20000-point cap/);
  });

  it("rejects a workout whose endedAt is before startedAt", () => {
    // Regression for the W16b ingest gate: a reversed pair produced a
    // negative `durationSec` that downstream consumers (PR detector,
    // weekly report) treated as a real zero — a fastest-5km PR of
    // zero seconds would lock in until manual cleanup. The schema
    // refuses the row at parse time.
    expect(() =>
      createWorkoutSchema.parse({
        ...minimalRun,
        startedAt: "2026-05-14T07:15:00.000Z",
        endedAt: "2026-05-14T06:30:00.000Z",
      }),
    ).toThrow(/endedAt must be strictly after startedAt/);
  });

  it("rejects a zero-duration workout (endedAt === startedAt)", () => {
    expect(() =>
      createWorkoutSchema.parse({
        ...minimalRun,
        startedAt: "2026-05-14T06:30:00.000Z",
        endedAt: "2026-05-14T06:30:00.000Z",
      }),
    ).toThrow(/endedAt must be strictly after startedAt/);
  });

  it("rejects a route whose sampleTimestamps length mismatches coordinates", () => {
    // Cross-field invariant: per-sample HR / speed must line up against
    // the parallel coordinate index, so a desynced pair silently
    // poisons downstream analytics. Hard-fail at parse time so the iOS
    // mapper surfaces the problem immediately.
    expect(() =>
      createWorkoutSchema.parse({
        ...minimalRun,
        route: {
          geometry: {
            type: "LineString",
            coordinates: [
              [11.077, 49.452],
              [11.078, 49.453],
              [11.079, 49.454],
            ],
          },
          sampleTimestamps: [
            { t: "2026-05-14T06:30:00.000Z" },
            { t: "2026-05-14T06:30:05.000Z" },
            // missing third entry — desync the parser MUST catch
          ],
        },
      }),
    ).toThrow(/sampleTimestamps length must match/);
  });

  it("accepts a route when sampleTimestamps length equals coordinates length", () => {
    const parsed = createWorkoutSchema.parse({
      ...minimalRun,
      route: {
        geometry: {
          type: "LineString",
          coordinates: [
            [11.077, 49.452],
            [11.078, 49.453],
          ],
        },
        sampleTimestamps: [
          { t: "2026-05-14T06:30:00.000Z", speedMs: 3.2, hr: 142 },
          { t: "2026-05-14T06:30:05.000Z", speedMs: 3.3, hr: 144 },
        ],
      },
    });
    expect(parsed.route?.sampleTimestamps).toHaveLength(2);
  });
});

describe("createBatchWorkoutSchema", () => {
  const minimalRun = (id: string) => ({
    sportType: "running",
    startedAt: "2026-05-14T06:30:00.000Z",
    endedAt: "2026-05-14T07:15:00.000Z",
    externalId: id,
  });

  it("accepts a single-workout batch", () => {
    const parsed = createBatchWorkoutSchema.parse({
      workouts: [minimalRun("hk-uuid-001")],
    });
    expect(parsed.workouts).toHaveLength(1);
  });

  it("accepts a batch at the cap (100 workouts)", () => {
    const workouts = Array.from(
      { length: MAX_WORKOUTS_PER_BATCH },
      (_, i) => minimalRun(`hk-uuid-${i}`),
    );
    const parsed = createBatchWorkoutSchema.parse({ workouts });
    expect(parsed.workouts).toHaveLength(MAX_WORKOUTS_PER_BATCH);
  });

  it("rejects a batch above the cap", () => {
    const workouts = Array.from(
      { length: MAX_WORKOUTS_PER_BATCH + 1 },
      (_, i) => minimalRun(`hk-uuid-${i}`),
    );
    expect(() => createBatchWorkoutSchema.parse({ workouts })).toThrow();
  });

  it("rejects an empty batch", () => {
    expect(() => createBatchWorkoutSchema.parse({ workouts: [] })).toThrow();
  });
});
