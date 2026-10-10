import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createManyAndReturn,
  update,
  emitInsertedWorkoutArrival,
  fetchDataPoints,
  getValidToken,
  mapWorkout,
} = vi.hoisted(() => ({
  createManyAndReturn: vi.fn(),
  update: vi.fn(),
  emitInsertedWorkoutArrival: vi.fn(async () => {}),
  fetchDataPoints: vi.fn(),
  getValidToken: vi.fn(),
  mapWorkout: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: { workout: { createManyAndReturn, update } },
}));
vi.mock("@/lib/arrivals/workout-emit", () => ({
  emitInsertedWorkoutArrival,
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ addWarning: vi.fn() }),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));
vi.mock("../client", () => ({
  GOOGLE_HEALTH_ACTIVITY_PAGE_SIZE: 100,
  GOOGLE_HEALTH_DATA_TYPES: { exercise: "exercise" },
  fetchDataPoints,
  mapWorkout,
}));
vi.mock("../sync-core", () => ({
  getValidToken,
  handleCollectionFetchError: vi.fn(),
  googleHealthTokenSource:
    (_userId: string, info: { accessToken: string }) => async () =>
      info.accessToken,
  runGoogleHealthCollection: (_key: string, fn: () => Promise<number>) => fn(),
  noteHardFailure: vi.fn(),
}));

import { syncUserWorkout } from "../sync-workout";

const startedAt = new Date("2026-07-19T08:00:00.000Z");
const mapped = {
  externalId: "google-1",
  sportType: "running",
  sportTypeRaw: "RUNNING",
  startedAt,
  endedAt: new Date("2026-07-19T09:00:00.000Z"),
  durationSec: 3600,
  totalEnergyKcal: 500,
  totalDistanceM: 10_000,
  avgHeartRate: 145,
  maxHeartRate: 170,
  minHeartRate: 90,
};

beforeEach(() => {
  vi.clearAllMocks();
  getValidToken.mockResolvedValue({ accessToken: "token" });
  fetchDataPoints.mockResolvedValue([{}]);
  mapWorkout.mockReturnValue(mapped);
  update.mockResolvedValue({ id: "existing" });
});

describe("syncUserWorkout — exact inserted identity", () => {
  it("emits the exact row returned by the insert statement", async () => {
    const inserted = { id: "new-workout", startedAt };
    createManyAndReturn.mockResolvedValue([inserted]);

    await expect(syncUserWorkout("user-1")).resolves.toBe(1);

    expect(emitInsertedWorkoutArrival).toHaveBeenCalledWith(
      "user-1",
      inserted,
      "google-health",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("updates and counts an existing workout without emitting", async () => {
    createManyAndReturn.mockResolvedValue([]);

    await expect(syncUserWorkout("user-1")).resolves.toBe(1);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_source_externalId: {
            userId: "user-1",
            source: "GOOGLE_HEALTH",
            externalId: "google-1",
          },
        },
        data: expect.objectContaining({
          sportType: "running",
          startedAt,
          totalDistanceM: 10_000,
        }),
      }),
    );
    expect(emitInsertedWorkoutArrival).not.toHaveBeenCalled();
  });

  it("treats a duplicate-race short return as an update, never an insert", async () => {
    createManyAndReturn.mockResolvedValue([]);
    update.mockResolvedValue({ id: "concurrent-winner" });

    await expect(syncUserWorkout("user-1")).resolves.toBe(1);

    expect(createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(update).toHaveBeenCalledTimes(1);
    expect(emitInsertedWorkoutArrival).not.toHaveBeenCalled();
  });

  it("keeps a successful insert when arrival dispatch fails", async () => {
    createManyAndReturn.mockResolvedValue([{ id: "new-workout", startedAt }]);
    emitInsertedWorkoutArrival.mockRejectedValueOnce(new Error("queue down"));

    await expect(syncUserWorkout("user-1")).resolves.toBe(1);
  });
});

describe("syncUserWorkout — raw activity-type provenance", () => {
  it("writes the raw exerciseType to metadata on insert", async () => {
    createManyAndReturn.mockResolvedValue([{ id: "new-workout", startedAt }]);
    mapWorkout.mockReturnValue({ ...mapped, sportTypeRaw: "KITESURFING" });

    await expect(syncUserWorkout("user-1")).resolves.toBe(1);

    expect(createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: { googleExerciseType: "KITESURFING" },
        }),
      }),
    );
  });

  it("repairs an existing row in place, because the update reuses the payload", async () => {
    // A row synced before the provenance write existed has no metadata; the
    // update arm is what a full re-sync goes through, so it has to carry the
    // key too or the repair path advertised to users does nothing.
    createManyAndReturn.mockResolvedValue([]);
    mapWorkout.mockReturnValue({ ...mapped, sportTypeRaw: "KITESURFING" });

    await expect(syncUserWorkout("user-1")).resolves.toBe(1);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          metadata: { googleExerciseType: "KITESURFING" },
        }),
      }),
    );
  });

  it("omits the key entirely when the session carried no type", async () => {
    // Omitted, not null: an update writing `metadata: null` would wipe what an
    // earlier sync recorded.
    createManyAndReturn.mockResolvedValue([]);
    mapWorkout.mockReturnValue({ ...mapped, sportTypeRaw: null });

    await expect(syncUserWorkout("user-1")).resolves.toBe(1);

    const insertData = createManyAndReturn.mock.calls[0][0].data;
    const updateData = update.mock.calls[0][0].data;
    expect("metadata" in insertData).toBe(false);
    expect("metadata" in updateData).toBe(false);
  });
});
