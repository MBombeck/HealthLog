/**
 * `upsertWhoopWorkout` — canonical sport mapping + metadata traceability.
 *
 * Regression coverage for the confirmed prod bug: a WHOOP cycling workout
 * wrote `Workout.sportType = "whoop_sport_1"` (or the raw `sport_name`)
 * instead of the canonical `"cycling"`, so it never rendered as cycling on
 * `/insights/workouts`. `upsertWhoopWorkout` must now route through
 * `mapWhoopSportType()` and keep the raw WHOOP fields in `metadata` for
 * traceability.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client", () => ({
  fetchWorkouts: vi.fn(),
  fetchWorkoutById: vi.fn(),
  KJ_TO_KCAL: 0.239006,
}));

vi.mock("../sync-core", async () => {
  const actual =
    await vi.importActual<typeof import("../sync-core")>("../sync-core");
  return {
    ...actual,
    getValidToken: vi.fn(),
    markResourceSynced: vi.fn(),
  };
});

const { createManyAndReturn, workoutUpdate, emitInsertedWorkoutArrival } =
  vi.hoisted(() => ({
    createManyAndReturn: vi.fn(),
    workoutUpdate: vi.fn(),
    emitInsertedWorkoutArrival: vi.fn(async () => {}),
  }));
vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnection: { findUnique: vi.fn() },
    workout: { createManyAndReturn, update: workoutUpdate },
  },
}));
vi.mock("@/lib/arrivals/workout-emit", () => ({
  emitInsertedWorkoutArrival,
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

import { upsertWhoopWorkout } from "../sync-workout";
import type { WhoopWorkout } from "../client";

function scoredWorkout(overrides: Partial<WhoopWorkout>): WhoopWorkout {
  return {
    id: "w-1",
    user_id: 1,
    created_at: "2026-06-14T07:00:00.000Z",
    updated_at: "2026-06-14T08:00:00.000Z",
    start: "2026-06-14T07:00:00.000Z",
    end: "2026-06-14T08:00:00.000Z",
    score_state: "SCORED",
    score: {
      strain: 12.3,
      average_heart_rate: 130,
      max_heart_rate: 165,
      kilojoule: 1500,
      percent_recorded: 99,
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  createManyAndReturn.mockResolvedValue([
    { id: "inserted-workout", startedAt: new Date("2026-06-14T07:00:00.000Z") },
  ]);
  workoutUpdate.mockResolvedValue({ id: "existing-workout" });
});

describe("upsertWhoopWorkout — canonical sportType", () => {
  it("writes canonical 'cycling' for sport_id 1, never whoop_sport_1", async () => {
    await upsertWhoopWorkout("user-1", scoredWorkout({ sport_id: 1 }));
    const row = createManyAndReturn.mock.calls[0]![0].data;
    expect(row.sportType).toBe("cycling");
  });

  it("writes canonical 'cycling' when WHOOP sends sport_name instead of sport_id", async () => {
    await upsertWhoopWorkout(
      "user-1",
      scoredWorkout({ sport_id: undefined, sport_name: "cycling" }),
    );
    const row = createManyAndReturn.mock.calls[0]![0].data;
    expect(row.sportType).toBe("cycling");
  });

  it("falls back to 'other' for an unrecognised sport, never a whoop_sport_<n> placeholder", async () => {
    await upsertWhoopWorkout(
      "user-1",
      scoredWorkout({ sport_id: 999_999, sport_name: undefined }),
    );
    const row = createManyAndReturn.mock.calls[0]![0].data;
    expect(row.sportType).toBe("other");
    expect(row.sportType).not.toMatch(/^whoop_sport_/);
  });

  it("uses the same mapped sportType on the update branch (re-sync / re-score)", async () => {
    createManyAndReturn.mockResolvedValue([]);
    await upsertWhoopWorkout("user-1", scoredWorkout({ sport_id: 1 }));
    const update = workoutUpdate.mock.calls[0]![0].data;
    expect(update.sportType).toBe("cycling");
  });
});

describe("upsertWhoopWorkout — raw sport fields kept in metadata for traceability", () => {
  it("stamps whoopSportId and whoopSportName onto metadata", async () => {
    await upsertWhoopWorkout(
      "user-1",
      scoredWorkout({ sport_id: 1, sport_name: "cycling" }),
    );
    const row = createManyAndReturn.mock.calls[0]![0].data;
    expect(row.metadata.whoopSportId).toBe(1);
    expect(row.metadata.whoopSportName).toBe("cycling");
  });

  it("omits whoopSportId / whoopSportName from metadata when WHOOP sent neither", async () => {
    await upsertWhoopWorkout(
      "user-1",
      scoredWorkout({ sport_id: undefined, sport_name: undefined }),
    );
    const row = createManyAndReturn.mock.calls[0]![0].data;
    expect(row.metadata).not.toHaveProperty("whoopSportId");
    expect(row.metadata).not.toHaveProperty("whoopSportName");
  });
});

describe("upsertWhoopWorkout — exact inserted identity", () => {
  it("emits the exact row returned by the insert statement", async () => {
    const inserted = {
      id: "new-workout",
      startedAt: new Date("2026-06-14T07:00:00.000Z"),
    };
    createManyAndReturn.mockResolvedValue([inserted]);

    await expect(
      upsertWhoopWorkout("user-1", scoredWorkout({ sport_id: 1 })),
    ).resolves.toBe(1);

    expect(emitInsertedWorkoutArrival).toHaveBeenCalledWith(
      "user-1",
      inserted,
      "whoop",
    );
    expect(workoutUpdate).not.toHaveBeenCalled();
  });

  it("updates and counts an existing workout without emitting", async () => {
    createManyAndReturn.mockResolvedValue([]);

    await expect(
      upsertWhoopWorkout("user-1", scoredWorkout({ sport_id: 1 })),
    ).resolves.toBe(1);

    expect(workoutUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_source_externalId: {
            userId: "user-1",
            source: "WHOOP",
            externalId: "w-1",
          },
        },
      }),
    );
    expect(emitInsertedWorkoutArrival).not.toHaveBeenCalled();
  });

  it("treats a duplicate-race short return as an update, never an insert", async () => {
    createManyAndReturn.mockResolvedValue([]);
    workoutUpdate.mockResolvedValue({ id: "concurrent-winner" });

    await expect(
      upsertWhoopWorkout("user-1", scoredWorkout({ sport_id: 1 })),
    ).resolves.toBe(1);

    expect(createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(workoutUpdate).toHaveBeenCalledTimes(1);
    expect(emitInsertedWorkoutArrival).not.toHaveBeenCalled();
  });

  it("keeps a successful insert when arrival dispatch fails", async () => {
    createManyAndReturn.mockResolvedValue([
      {
        id: "new-workout",
        startedAt: new Date("2026-06-14T07:00:00.000Z"),
      },
    ]);
    emitInsertedWorkoutArrival.mockRejectedValueOnce(new Error("queue down"));

    await expect(
      upsertWhoopWorkout("user-1", scoredWorkout({ sport_id: 1 })),
    ).resolves.toBe(1);
  });
});
