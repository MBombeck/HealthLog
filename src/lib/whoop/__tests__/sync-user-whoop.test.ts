/**
 * v1.11.5 — `syncUserWhoop` orchestration tests (mocked resource syncs).
 *
 * Covers the all-403 "looks-healthy" guard: a genuine grant-revoke 403s EVERY
 * collection. Each per-resource sync soft-skips (returns 0, records no failure)
 * via `handleCollectionFetchError`, so the orchestrator sees `total === 0` with
 * no thrown error — and without the guard would stamp `recordSyncSuccess`,
 * keeping a dead connection "connected" until the token-refresh path catches
 * the 401 up to ~1 h later. The guard refuses to stamp success when every
 * enabled resource soft-skipped and nothing imported.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  recordSyncSuccess,
  recordSyncFailure,
  isReauthRequired,
  syncUserRecovery,
  syncUserSleep,
  syncUserCycle,
  syncUserWorkout,
  syncUserBody,
} = vi.hoisted(() => ({
  recordSyncSuccess: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  recordSyncFailure: vi.fn<(...a: unknown[]) => Promise<void>>(async () => {}),
  isReauthRequired: vi.fn<(...a: unknown[]) => Promise<boolean>>(
    async () => false,
  ),
  syncUserRecovery: vi.fn<(...a: unknown[]) => Promise<number>>(),
  syncUserSleep: vi.fn<(...a: unknown[]) => Promise<number>>(),
  syncUserCycle: vi.fn<(...a: unknown[]) => Promise<number>>(),
  syncUserWorkout: vi.fn<(...a: unknown[]) => Promise<number>>(),
  syncUserBody: vi.fn<(...a: unknown[]) => Promise<number>>(),
}));

vi.mock("@/lib/db", () => ({ prisma: {} }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => s,
  decrypt: (s: string) => s,
}));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => null,
  annotate: () => {},
}));
vi.mock("@/lib/integrations/status", () => ({
  recordSyncFailure: (...a: unknown[]) => recordSyncFailure(...a),
  recordSyncSuccess: (...a: unknown[]) => recordSyncSuccess(...a),
  isReauthRequired: (...a: unknown[]) => isReauthRequired(...a),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: () => [],
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));

vi.mock("../sync-recovery", () => ({
  syncUserRecovery: (...a: unknown[]) => syncUserRecovery(...a),
}));
vi.mock("../sync-sleep", () => ({
  syncUserSleep: (...a: unknown[]) => syncUserSleep(...a),
}));
vi.mock("../sync-cycle", () => ({
  syncUserCycle: (...a: unknown[]) => syncUserCycle(...a),
}));
vi.mock("../sync-workout", () => ({
  syncUserWorkout: (...a: unknown[]) => syncUserWorkout(...a),
}));
vi.mock("../sync-body", () => ({
  syncUserBody: (...a: unknown[]) => syncUserBody(...a),
}));

import {
  handleCollectionFetchError,
  syncWhoopResourceWithStatus,
} from "../sync-core";
import { syncUserWhoop } from "../sync";
import { WhoopApiError } from "../response-classifier";

/** A resource sync that 403s its collection and soft-skips, like the real one. */
async function softSkip403(...args: unknown[]): Promise<number> {
  return handleCollectionFetchError(
    "test-resource",
    String(args[0]),
    new WhoopApiError({
      verb: "fetchTest",
      classification: "reauth_required",
      httpStatus: 403,
      reason: "http_403",
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequired.mockResolvedValue(false);
});

describe("syncUserWhoop — all-403 looks-healthy guard", () => {
  it("does NOT stamp success when EVERY resource soft-skipped and nothing imported", async () => {
    for (const fn of [
      syncUserRecovery,
      syncUserSleep,
      syncUserCycle,
      syncUserWorkout,
      syncUserBody,
    ]) {
      fn.mockImplementation(softSkip403);
    }

    const total = await syncUserWhoop("user1");

    expect(total).toBe(0);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    // Soft-skips record no failure either — the status is left exactly as-is so
    // the token-refresh 401 path is the one that flips it to reauth.
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("stamps success on a partial cycle (some imported, rest soft-skipped)", async () => {
    syncUserRecovery.mockResolvedValue(3);
    syncUserSleep.mockImplementation(softSkip403);
    syncUserCycle.mockImplementation(softSkip403);
    syncUserWorkout.mockImplementation(softSkip403);
    syncUserBody.mockImplementation(softSkip403);

    const total = await syncUserWhoop("user1");

    expect(total).toBe(3);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user1", "whoop");
  });

  it("stamps success on a clean cycle that imported rows", async () => {
    syncUserRecovery.mockResolvedValue(2);
    syncUserSleep.mockResolvedValue(1);
    syncUserCycle.mockResolvedValue(0);
    syncUserWorkout.mockResolvedValue(0);
    syncUserBody.mockResolvedValue(0);

    const total = await syncUserWhoop("user1");

    expect(total).toBe(3);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user1", "whoop");
  });

  it("stamps success on a quiet cycle (no soft-skips, nothing new)", async () => {
    for (const fn of [
      syncUserRecovery,
      syncUserSleep,
      syncUserCycle,
      syncUserWorkout,
      syncUserBody,
    ]) {
      fn.mockResolvedValue(0);
    }

    const total = await syncUserWhoop("user1");

    expect(total).toBe(0);
    // No collection was 403'd → this is a genuine "nothing changed" tick.
    expect(recordSyncSuccess).toHaveBeenCalledWith("user1", "whoop");
  });

  it("short-circuits without stamping success when parked at error_reauth", async () => {
    isReauthRequired.mockResolvedValue(true);

    const total = await syncUserWhoop("user1");

    expect(total).toBe(0);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    expect(syncUserRecovery).not.toHaveBeenCalled();
  });
});

describe("syncWhoopResourceWithStatus — per-resource lastSuccessAt stamp", () => {
  it("stamps success when the resource imported rows", async () => {
    const imported = await syncWhoopResourceWithStatus("user1", async () => 5);

    expect(imported).toBe(5);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user1", "whoop");
  });

  it("stamps success on a clean fetch that imported nothing new", async () => {
    // No 403 soft-skip → a genuine "nothing changed" webhook/cron tick still
    // proves the connection is alive, so `lastSuccessAt` advances.
    const imported = await syncWhoopResourceWithStatus("user1", async () => 0);

    expect(imported).toBe(0);
    expect(recordSyncSuccess).toHaveBeenCalledWith("user1", "whoop");
  });

  it("does NOT stamp success when the resource soft-skipped a 403 and imported nothing", async () => {
    const imported = await syncWhoopResourceWithStatus("user1", () =>
      softSkip403("user1"),
    );

    expect(imported).toBe(0);
    expect(recordSyncSuccess).not.toHaveBeenCalled();
    expect(recordSyncFailure).not.toHaveBeenCalled();
  });

  it("propagates a hard failure without stamping success", async () => {
    await expect(
      syncWhoopResourceWithStatus("user1", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(recordSyncSuccess).not.toHaveBeenCalled();
  });
});
