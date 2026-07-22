/**
 * v1.16.13 (iOS #17) — WHOOP workout ingest used only a 1 h overlap window
 * while recovery/sleep use the wide re-score overlap. A workout whose phone
 * sync to the WHOOP cloud lands more than 1 h after the workout's own time
 * window then falls permanently before the incremental `start` and is never
 * ingested. This pins the workout sync onto the SAME overlap recovery/sleep
 * use, so a late-synced workout is still re-fetched (the upsert is idempotent).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWorkouts = vi.fn();
const fetchWorkoutById = vi.fn();

vi.mock("../client", () => ({
  fetchWorkouts: (...a: unknown[]) => fetchWorkouts(...a),
  fetchWorkoutById: (...a: unknown[]) => fetchWorkoutById(...a),
  KJ_TO_KCAL: 0.239006,
}));

const getValidToken = vi.fn();
const markResourceSynced = vi.fn();
vi.mock("../sync-core", async () => {
  const actual =
    await vi.importActual<typeof import("../sync-core")>("../sync-core");
  return {
    ...actual,
    getValidToken: (...a: unknown[]) => getValidToken(...a),
    markResourceSynced: (...a: unknown[]) => markResourceSynced(...a),
  };
});

const whoopConnectionFindUnique = vi.fn();
const workoutCreateManyAndReturn = vi.fn();
const workoutUpdate = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    whoopConnection: {
      findUnique: (...a: unknown[]) => whoopConnectionFindUnique(...a),
    },
    workout: {
      createManyAndReturn: (...a: unknown[]) =>
        workoutCreateManyAndReturn(...a),
      update: (...a: unknown[]) => workoutUpdate(...a),
    },
  },
}));

vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
}));

import { syncUserWorkout, syncWhoopWorkoutById } from "../sync-workout";
import {
  WHOOP_FULL_SYNC_ANCHOR,
  WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
} from "../sync-core";

const LAST_SYNCED = new Date("2026-06-10T12:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  getValidToken.mockResolvedValue({
    accessToken: "tok",
    connection: { id: "c1", whoopUserId: "w1" },
  });
  // No per-resource cursor yet → falls back to the shared lastSyncedAt.
  whoopConnectionFindUnique.mockResolvedValue({
    lastSyncedAt: LAST_SYNCED,
    resourceCursors: null,
  });
  markResourceSynced.mockResolvedValue(undefined);
  fetchWorkouts.mockResolvedValue([]);
  workoutCreateManyAndReturn.mockResolvedValue([
    { id: "inserted-workout", startedAt: new Date("2026-06-14T07:00:00.000Z") },
  ]);
  workoutUpdate.mockResolvedValue({ id: "existing-workout" });
});

describe("syncUserWorkout — late-synced workout overlap window", () => {
  it("fetches from lastSyncedAt minus the recovery/sleep overlap, not 1 h", async () => {
    await syncUserWorkout("user-1");
    expect(fetchWorkouts).toHaveBeenCalledTimes(1);
    const arg = fetchWorkouts.mock.calls[0]![1] as { start?: Date };
    expect(arg.start?.getTime()).toBe(
      LAST_SYNCED.getTime() - WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    );
    // A workout that landed in the WHOOP cloud 6 h after its window is still
    // inside the fetch range; under the old 1 h overlap it would be missed.
    const sixHoursBefore = LAST_SYNCED.getTime() - 6 * 60 * 60 * 1000;
    expect(arg.start!.getTime()).toBeLessThanOrEqual(sixHoursBefore);
  });

  it("fullSync anchors at the deep-history anchor, not the cursor", async () => {
    await syncUserWorkout("user-1", { fullSync: true });
    const arg = fetchWorkouts.mock.calls[0]![1] as { start?: Date };
    expect(arg.start).toEqual(WHOOP_FULL_SYNC_ANCHOR);
  });

  it("uses the per-resource workout cursor when present, ignoring siblings", async () => {
    const workoutCursor = new Date("2026-06-04T12:00:00.000Z");
    whoopConnectionFindUnique.mockResolvedValue({
      // recovery synced far more recently — must NOT pull the workout window
      // forward.
      lastSyncedAt: new Date("2026-06-12T00:00:00.000Z"),
      resourceCursors: {
        recovery: "2026-06-12T00:00:00.000Z",
        workout: workoutCursor.toISOString(),
      },
    });

    await syncUserWorkout("user-1");

    const arg = fetchWorkouts.mock.calls[0]![1] as { start?: Date };
    expect(arg.start!.getTime()).toBe(
      workoutCursor.getTime() - WHOOP_RECOVERY_SLEEP_OVERLAP_MS,
    );
  });
});

describe("syncWhoopWorkoutById — webhook fetch-by-id", () => {
  const SCORED_WORKOUT = {
    id: "w-123",
    start: "2026-06-14T07:00:00.000Z",
    end: "2026-06-14T08:00:00.000Z",
    sport_id: 1,
    score: {
      strain: 12.3,
      average_heart_rate: 130,
      max_heart_rate: 165,
      kilojoule: 1500,
      percent_recorded: 99,
    },
  };

  it("resolves the ONE record by id and writes it (no collection walk)", async () => {
    fetchWorkoutById.mockResolvedValue(SCORED_WORKOUT);

    const imported = await syncWhoopWorkoutById("user-1", "w-123");

    expect(imported).toBe(1);
    // Targeted fetch-by-id, never the collection.
    expect(fetchWorkoutById).toHaveBeenCalledWith("tok", "w-123");
    expect(fetchWorkouts).not.toHaveBeenCalled();
    const insertArg = workoutCreateManyAndReturn.mock.calls[0]![0];
    expect(insertArg.data).toEqual(
      expect.objectContaining({
        userId: "user-1",
        source: "WHOOP",
        externalId: "w-123",
      }),
    );
  });

  it("a single-id refresh does NOT advance the resource cursor", async () => {
    fetchWorkoutById.mockResolvedValue(SCORED_WORKOUT);

    await syncWhoopWorkoutById("user-1", "w-123");

    expect(markResourceSynced).not.toHaveBeenCalled();
  });

  it("an unscored record stores nothing", async () => {
    fetchWorkoutById.mockResolvedValue({ ...SCORED_WORKOUT, score: null });

    const imported = await syncWhoopWorkoutById("user-1", "w-123");

    expect(imported).toBe(0);
    expect(workoutCreateManyAndReturn).not.toHaveBeenCalled();
    expect(workoutUpdate).not.toHaveBeenCalled();
  });
});
