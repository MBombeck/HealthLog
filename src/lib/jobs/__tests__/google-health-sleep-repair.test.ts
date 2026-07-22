/**
 * v1.28.x — Google Health one-shot sleep duplicate-repair self-convergence
 * tests (mocked).
 *   - discovery only matches connections not yet repaired
 *     (`sleepRepairedAt IS NULL`) and singleton-keys the enqueue per user;
 *   - a completed pass runs a FULL sleep re-read (no `start` lower bound),
 *     stamps `sleepRepairedAt` so the next discovery drops the account, and
 *     NEVER touches the `lastSyncedAt` sync watermark;
 *   - the discovery is best-effort — errors surface through the result value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, bossSend, syncUserSleep, isReauthRequiredMock } =
  vi.hoisted(() => ({
    prismaMock: {
      googleHealthConnection: { findMany: vi.fn(), update: vi.fn() },
    },
    bossSend: vi.fn(),
    syncUserSleep: vi.fn(),
    isReauthRequiredMock: vi.fn(async () => false),
  }));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: bossSend }),
}));

vi.mock("@/lib/google-health/sync-sleep", () => ({
  syncUserSleep: (...a: unknown[]) => syncUserSleep(...a),
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: isReauthRequiredMock,
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
}));

// The repair module threads the REAL hard-fail ledger from
// `@/lib/google-health/sync`; its heavy transitive deps are mocked the same
// way the google-health failsoft suite does.
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/google-health/credentials", () => ({
  getUserGoogleHealthCredentials: vi.fn(async () => null),
}));
vi.mock("@/lib/google-health/client", () => ({ refreshAccessToken: vi.fn() }));

import {
  GOOGLE_HEALTH_TOKEN_HARD_FAIL,
  noteHardFailure,
} from "@/lib/google-health/sync-core";
import {
  enqueueBootTimeGoogleHealthSleepRepair,
  runGoogleHealthSleepRepairForUser,
} from "../google-health-sleep-repair";

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequiredMock.mockResolvedValue(false);
});

describe("enqueueBootTimeGoogleHealthSleepRepair — discovery", () => {
  it("queries only un-repaired connections and enqueues one singleton-keyed job per user", async () => {
    prismaMock.googleHealthConnection.findMany.mockResolvedValue([
      { userId: "u1" },
      { userId: "u2" },
    ]);
    bossSend.mockResolvedValue("job-id");

    const result = await enqueueBootTimeGoogleHealthSleepRepair();

    expect(prismaMock.googleHealthConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { sleepRepairedAt: null } }),
    );
    expect(result.enqueued).toBe(2);
    expect(bossSend).toHaveBeenCalledWith(
      "google-health-sleep-repair",
      expect.objectContaining({ userId: "u1" }),
      expect.objectContaining({
        singletonKey: "google-health-sleep-repair|u1",
      }),
    );
    expect(bossSend).toHaveBeenCalledWith(
      "google-health-sleep-repair",
      expect.objectContaining({ userId: "u2" }),
      expect.objectContaining({
        singletonKey: "google-health-sleep-repair|u2",
      }),
    );
  });

  it("self-converges: no un-repaired connections → nothing enqueued", async () => {
    prismaMock.googleHealthConnection.findMany.mockResolvedValue([]);

    const result = await enqueueBootTimeGoogleHealthSleepRepair();

    expect(result.enqueued).toBe(0);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("never throws — surfaces a discovery error through the result value", async () => {
    prismaMock.googleHealthConnection.findMany.mockRejectedValue(
      new Error("db down"),
    );

    const result = await enqueueBootTimeGoogleHealthSleepRepair();

    expect(result.error).toBe("db down");
    expect(result.enqueued).toBe(0);
  });
});

describe("runGoogleHealthSleepRepairForUser", () => {
  it("runs a FULL sleep re-read (no start lower bound) and stamps sleepRepairedAt", async () => {
    syncUserSleep.mockResolvedValue(42);
    prismaMock.googleHealthConnection.update.mockResolvedValue({});

    const { imported } = await runGoogleHealthSleepRepairForUser("u1");

    expect(imported).toBe(42);
    // Full-history walk: no `start` in the options object.
    const syncOpts = syncUserSleep.mock.calls[0]![1] as Record<string, unknown>;
    expect(syncUserSleep).toHaveBeenCalledWith("u1", expect.any(Object));
    expect(syncOpts).not.toHaveProperty("start");

    const updateArg = prismaMock.googleHealthConnection.update.mock
      .calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArg.where).toEqual({ userId: "u1" });
    expect(updateArg.data.sleepRepairedAt).toBeInstanceOf(Date);
  });

  it("does NOT touch the lastSyncedAt sync watermark", async () => {
    syncUserSleep.mockResolvedValue(7);
    prismaMock.googleHealthConnection.update.mockResolvedValue({});

    await runGoogleHealthSleepRepairForUser("u1");

    // The single connection write stamps ONLY the repair marker — the
    // watermark stays where the incremental orchestrator left it.
    for (const call of prismaMock.googleHealthConnection.update.mock.calls) {
      const { data } = call[0] as { data: Record<string, unknown> };
      expect(data).not.toHaveProperty("lastSyncedAt");
      expect(Object.keys(data)).toEqual(["sleepRepairedAt"]);
    }
    expect(prismaMock.googleHealthConnection.update).toHaveBeenCalledTimes(1);
  });

  it("propagates a sync failure without stamping the marker (pg-boss retries)", async () => {
    syncUserSleep.mockRejectedValue(new Error("google 500"));

    await expect(runGoogleHealthSleepRepairForUser("u1")).rejects.toThrow(
      "google 500",
    );
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("a swallowed hard failure (ledger entry) throws and does NOT stamp — pg-boss retries", async () => {
    // `syncUserSleep` swallows fetch/write hard failures into the ambient
    // ledger and still resolves a count; the repair must read the ledger, not
    // the count, before stamping.
    syncUserSleep.mockImplementation(async () => {
      noteHardFailure("fetchSleep");
      return 5;
    });

    await expect(runGoogleHealthSleepRepairForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("a dead token returns WITHOUT stamping and WITHOUT throwing (boot discovery re-enqueues)", async () => {
    syncUserSleep.mockImplementation(async () => {
      noteHardFailure(GOOGLE_HEALTH_TOKEN_HARD_FAIL);
      return 0;
    });

    await expect(runGoogleHealthSleepRepairForUser("u1")).resolves.toEqual({
      imported: 0,
    });
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });

  it("a connection parked at error_reauth returns WITHOUT running the sync or stamping", async () => {
    isReauthRequiredMock.mockResolvedValue(true);

    await expect(runGoogleHealthSleepRepairForUser("u1")).resolves.toEqual({
      imported: 0,
    });
    expect(syncUserSleep).not.toHaveBeenCalled();
    expect(prismaMock.googleHealthConnection.update).not.toHaveBeenCalled();
  });
});
