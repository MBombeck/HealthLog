/**
 * The planner's enrichment arm: a stored workout gets the series or the
 * track it lacks from an entry that carries one, once per workout, and
 * nothing it already holds.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findMany } = vi.hoisted(() => ({
  findMany: vi.fn<(args: unknown) => Promise<unknown[]>>(),
}));
vi.mock("@/lib/db", () => ({
  prisma: { workout: { findMany } },
}));

import type { EntryResult, PreparedWorkout } from "../entries";
import { planWorkoutWrites } from "../plan";

const USER = "user-plan";
const ROUTE = {
  geometry: {
    type: "LineString",
    coordinates: [
      [11.077, 49.452, 300],
      [11.078, 49.453, 312],
    ],
  },
  sampleTimestamps: null,
};
const SAMPLES = {
  samples: [{ t: "2026-05-14T06:30:00.000Z", hr: 121 }],
  sampleCount: 1,
};

function entry(
  index: number,
  externalId: string,
  parts: Partial<Pick<PreparedWorkout, "route" | "samples">> = {},
): PreparedWorkout {
  return {
    index,
    row: {
      userId: USER,
      sportType: "running",
      startedAt: new Date("2026-05-14T06:30:00.000Z"),
      endedAt: new Date("2026-05-14T07:15:00.000Z"),
      durationSec: 2700,
      source: "APPLE_HEALTH",
      externalId,
    },
    route: parts.route ?? null,
    samples: parts.samples ?? null,
    dedupKey: { source: "APPLE_HEALTH", externalId },
  };
}

function stored(
  externalId: string,
  has: { route?: boolean; samples?: boolean } = {},
) {
  return {
    id: `w-${externalId}`,
    source: "APPLE_HEALTH",
    externalId,
    route: has.route ? { workoutId: `w-${externalId}` } : null,
    samples: has.samples ? { workoutId: `w-${externalId}` } : null,
    sportType: "running",
    startedAt: new Date("2026-05-14T06:30:00.000Z"),
    endedAt: new Date("2026-05-14T07:15:00.000Z"),
    durationSec: 2700,
    totalEnergyKcal: null,
    totalDistanceM: null,
    avgHeartRate: null,
    maxHeartRate: null,
    minHeartRate: null,
    stepCount: null,
    elevationM: null,
    pauseDurationSec: null,
  };
}

async function plan(rows: unknown[], survivors: PreparedWorkout[]) {
  findMany.mockResolvedValue(rows);
  const results: EntryResult[] = new Array(survivors.length);
  const written = await planWorkoutWrites(USER, survivors, results);
  return { plan: written, results };
}

beforeEach(() => {
  findMany.mockReset();
});

describe("planWorkoutWrites: track enrichment", () => {
  it("hands a stored workout without a track the one the entry carries", async () => {
    const { plan: p, results } = await plan(
      [stored("a")],
      [entry(0, "a", { route: ROUTE })],
    );
    expect(p.toEnrich).toEqual([
      { index: 0, workoutId: "w-a", samples: null, route: ROUTE },
    ]);
    expect(p.toInsert).toEqual([]);
    expect(p.duplicates).toBe(0);
    // Settled after the write, from what landed.
    expect(results[0]).toBeUndefined();
  });

  it("leaves a stored track alone and settles the entry as a duplicate", async () => {
    const { plan: p, results } = await plan(
      [stored("a", { route: true })],
      [entry(0, "a", { route: ROUTE })],
    );
    expect(p.toEnrich).toEqual([]);
    expect(p.duplicates).toBe(1);
    expect(results[0]).toEqual({ index: 0, status: "duplicate" });
  });

  it("plans one enrichment carrying both parts when both are missing", async () => {
    const { plan: p } = await plan(
      [stored("a")],
      [entry(0, "a", { route: ROUTE, samples: SAMPLES })],
    );
    expect(p.toEnrich).toEqual([
      { index: 0, workoutId: "w-a", samples: SAMPLES, route: ROUTE },
    ]);
  });

  it("drops only the part the stored workout already holds", async () => {
    const { plan: p } = await plan(
      [stored("a", { samples: true }), stored("b", { route: true })],
      [
        entry(0, "a", { route: ROUTE, samples: SAMPLES }),
        entry(1, "b", { route: ROUTE, samples: SAMPLES }),
      ],
    );
    expect(p.toEnrich).toEqual([
      { index: 0, workoutId: "w-a", samples: null, route: ROUTE },
      { index: 1, workoutId: "w-b", samples: SAMPLES, route: null },
    ]);
  });

  it("plans nothing for an entry whose track the opt-in already dropped", async () => {
    // `prepareWorkouts` hands a null route while the account keeps none.
    const { plan: p, results } = await plan([stored("a")], [entry(0, "a")]);
    expect(p.toEnrich).toEqual([]);
    expect(results[0]).toEqual({ index: 0, status: "duplicate" });
  });

  it("lets only the first entry of a batch enrich a given workout", async () => {
    const { plan: p, results } = await plan(
      [stored("a")],
      [entry(0, "a", { samples: SAMPLES }), entry(1, "a", { route: ROUTE })],
    );
    expect(p.toEnrich).toEqual([
      { index: 0, workoutId: "w-a", samples: SAMPLES, route: null },
    ]);
    expect(results[1]).toEqual({ index: 1, status: "duplicate" });
  });

  it("asks the probe whether a track is stored", async () => {
    await plan([], [entry(0, "a", { route: ROUTE })]);
    const args = findMany.mock.calls[0]?.[0] as {
      select: Record<string, unknown>;
    };
    expect(args.select.route).toEqual({ select: { workoutId: true } });
  });
});
