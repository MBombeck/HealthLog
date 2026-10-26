import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PolarWorkoutRow } from "@/lib/polar/map";

const {
  createManyAndReturn,
  update,
  emitInsertedWorkoutArrival,
  getPolarConnection,
  fetchExercises,
  recordSyncFailure,
  recordSyncSuccess,
} = vi.hoisted(() => ({
  createManyAndReturn: vi.fn(),
  update: vi.fn(),
  emitInsertedWorkoutArrival: vi.fn(async () => {}),
  getPolarConnection: vi.fn(),
  fetchExercises: vi.fn(),
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
}));

vi.mock("@/lib/db", () => ({
  prisma: { workout: { createManyAndReturn, update } },
}));
vi.mock("@/lib/arrivals/workout-emit", () => ({
  emitInsertedWorkoutArrival,
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
  getEvent: () => ({ addWarning: vi.fn(), addExternalCall: vi.fn() }),
}));
vi.mock("../credentials", () => ({ getPolarConnection }));
vi.mock("@/lib/integrations/status", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/status")>()),
  recordSyncFailure,
  recordSyncSuccess,
}));
vi.mock("../client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../client")>();
  return { ...actual, fetchExercises };
});

import { syncUserPolarWorkouts, upsertPolarWorkouts } from "../sync-workouts";
import { PolarApiError } from "../response-classifier";

const CONN = { accessToken: "tok", polarUserId: "42" };

const startedAt = new Date("2026-07-19T08:00:00.000Z");
const row: PolarWorkoutRow = {
  externalId: "polar-1",
  sportType: "running",
  startedAt,
  endedAt: new Date("2026-07-19T09:00:00.000Z"),
  durationSec: 3600,
  totalEnergyKcal: 500,
  totalDistanceM: 10_000,
  avgHeartRate: 145,
  maxHeartRate: 170,
  elevationM: null,
  metadata: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ id: "existing" });
  getPolarConnection.mockResolvedValue(CONN);
  fetchExercises.mockResolvedValue([]);
});

describe("upsertPolarWorkouts — exact inserted identity", () => {
  it("emits the exact row returned by the insert statement, tagged 'polar'", async () => {
    const inserted = { id: "new-workout", startedAt };
    createManyAndReturn.mockResolvedValue([inserted]);

    await expect(upsertPolarWorkouts("user-1", [row])).resolves.toBe(1);

    expect(emitInsertedWorkoutArrival).toHaveBeenCalledWith(
      "user-1",
      inserted,
      "polar",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("updates a duplicate (userId, POLAR, externalId) in place without emitting", async () => {
    createManyAndReturn.mockResolvedValue([]);

    await expect(upsertPolarWorkouts("user-1", [row])).resolves.toBe(1);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_source_externalId: {
            userId: "user-1",
            source: "POLAR",
            externalId: "polar-1",
          },
        },
        data: expect.objectContaining({ sportType: "running", startedAt }),
      }),
    );
    expect(emitInsertedWorkoutArrival).not.toHaveBeenCalled();
  });

  it("logs a failing row, continues the batch, and rethrows the FIRST error", async () => {
    const second = { ...row, externalId: "polar-2" };
    createManyAndReturn
      .mockRejectedValueOnce(new Error("boom-1"))
      .mockResolvedValueOnce([{ id: "new-2", startedAt }]);

    await expect(upsertPolarWorkouts("user-1", [row, second])).rejects.toThrow(
      "boom-1",
    );
    // The second row was still attempted after the first failed.
    expect(createManyAndReturn).toHaveBeenCalledTimes(2);
  });

  it("no-ops on an empty batch", async () => {
    await expect(upsertPolarWorkouts("user-1", [])).resolves.toBe(0);
    expect(createManyAndReturn).not.toHaveBeenCalled();
  });
});

describe("syncUserPolarWorkouts", () => {
  it("no-ops cleanly for an unconnected user", async () => {
    getPolarConnection.mockResolvedValue(null);
    await expect(syncUserPolarWorkouts("u1")).resolves.toBe(0);
    expect(fetchExercises).not.toHaveBeenCalled();
    expect(createManyAndReturn).not.toHaveBeenCalled();
  });

  it("fetches, maps, and upserts exercises as source POLAR", async () => {
    fetchExercises.mockResolvedValue([
      {
        id: 987,
        start_time: "2026-07-19T10:00:00",
        start_time_utc_offset: 0,
        duration: "PT1H",
        sport: "RUNNING",
        detailed_sport_info: "ROAD_RUNNING",
        calories: 500,
        distance: 10000,
        heart_rate: { average: 145, maximum: 170 },
      },
    ]);
    createManyAndReturn.mockResolvedValue([{ id: "w1", startedAt }]);

    await expect(syncUserPolarWorkouts("u1")).resolves.toBe(1);
    const arg = createManyAndReturn.mock.calls[0]![0];
    expect(arg.data.source).toBe("POLAR");
    expect(arg.data.externalId).toBe("987");
    expect(arg.data.sportType).toBe("running");
  });

  it("skips an unmappable exercise without throwing", async () => {
    fetchExercises.mockResolvedValue([{ id: null }, { id: "x" }]);
    createManyAndReturn.mockResolvedValue([{ id: "w", startedAt }]);
    // Only the valid one is upserted; the id-less one is skipped.
    // The valid row has no start_time → also skipped, so nothing is written.
    await expect(syncUserPolarWorkouts("u1")).resolves.toBe(0);
    expect(createManyAndReturn).not.toHaveBeenCalled();
  });

  it("records a failure on a fetch error and rethrows, never masking with success", async () => {
    fetchExercises.mockRejectedValue(
      new PolarApiError({
        verb: "fetchExercises",
        classification: "transient",
        httpStatus: 503,
        reason: "http_503",
      }),
    );
    await expect(syncUserPolarWorkouts("u1")).rejects.toBeInstanceOf(
      PolarApiError,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        integration: "polar",
        kind: "transient",
        errorCode: "503",
      }),
    );
  });

  // Without a read that proved the token, a 403 may be the account-wide
  // consent gap: recorded as reauth_required and rethrown for cohort isolation.
  it("records a 403 as a reauth_required failure when nothing proved the token", async () => {
    fetchExercises.mockRejectedValue(
      new PolarApiError({
        verb: "fetchExercises",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );
    await expect(syncUserPolarWorkouts("u1")).rejects.toBeInstanceOf(
      PolarApiError,
    );
    expect(recordSyncFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        integration: "polar",
        kind: "reauth_required",
        errorCode: "403",
      }),
    );
  });

  it("reads a 403 as a refused data type once the vitals leg proved the token", async () => {
    fetchExercises.mockRejectedValue(
      new PolarApiError({
        verb: "fetchExercises",
        classification: "reauth_required",
        httpStatus: 403,
        reason: "http_403",
      }),
    );
    await expect(
      syncUserPolarWorkouts("u1", { tokenProven: true }),
    ).resolves.toBe(0);
    expect(recordSyncFailure).not.toHaveBeenCalled();
    expect(recordSyncSuccess).toHaveBeenCalledWith("u1", "polar", {
      leg: "workouts",
    });
  });

  it("keeps a 401 a failure even after the vitals leg proved the token", async () => {
    fetchExercises.mockRejectedValue(
      new PolarApiError({
        verb: "fetchExercises",
        classification: "reauth_required",
        httpStatus: 401,
        reason: "http_401",
      }),
    );
    await expect(
      syncUserPolarWorkouts("u1", { tokenProven: true }),
    ).rejects.toBeInstanceOf(PolarApiError);
    expect(recordSyncFailure).toHaveBeenCalledTimes(1);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });

  // A leg-scoped success clears only its own leg, so this leg has to write
  // its own: left to the vitals leg, one workouts failure stayed on the row
  // for good.
  it("records its own leg's success after a clean read", async () => {
    fetchExercises.mockResolvedValue([]);
    await syncUserPolarWorkouts("u1");
    expect(recordSyncSuccess).toHaveBeenCalledWith("u1", "polar", {
      leg: "workouts",
    });
  });

  it("records no success when the read failed", async () => {
    fetchExercises.mockRejectedValue(new Error("boom"));
    await expect(syncUserPolarWorkouts("u1")).rejects.toThrow("boom");
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });
});
