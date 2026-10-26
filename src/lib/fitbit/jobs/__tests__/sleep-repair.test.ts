/**
 * Fitbit one-shot sleep duplicate-repair self-convergence tests (mocked).
 *   - discovery only matches connections not yet repaired
 *     (`sleepRepairedAt IS NULL`) and singleton-keys the enqueue per user;
 *   - a completed pass re-reads the BOUNDED sleep history (an explicit 365-day
 *     `start`, not `syncUserSleep`'s 30-day default), stamps `sleepRepairedAt`
 *     so the next discovery drops the account, and NEVER touches the
 *     `lastSyncedAt` sync watermark;
 *   - the discovery is best-effort — errors surface through the result value.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, bossSend, syncUserSleep, isReauthRequiredMock } =
  vi.hoisted(() => ({
    prismaMock: {
      fitbitConnection: { findMany: vi.fn(), update: vi.fn() },
    },
    bossSend: vi.fn(),
    syncUserSleep: vi.fn(),
    isReauthRequiredMock: vi.fn(async () => false),
  }));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: bossSend }),
}));

vi.mock("@/lib/fitbit/sync-sleep", () => ({
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
// `@/lib/fitbit/sync-core`; its heavy transitive deps are mocked the same way
// the Fitbit upsert suites do.
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/integrations/oauth-refresh", () => ({
  persistRotatedToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/fitbit/credentials", () => ({
  getUserFitbitCredentials: vi.fn(async () => null),
}));
vi.mock("@/lib/fitbit/oauth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/fitbit/oauth")>();
  return {
    ...actual,
    fitbitOAuth: { ...actual.fitbitOAuth, refresh: vi.fn() },
  };
});

import {
  FITBIT_BACKFILL_DAYS,
  FITBIT_TOKEN_HARD_FAIL,
  noteHardFailure,
  noteSleepSwept,
} from "@/lib/fitbit/sync-core";
import {
  enqueueBootTimeFitbitSleepRepair,
  runFitbitSleepRepairForUser,
} from "@/lib/fitbit/jobs/sleep-repair";
import { isFitbitRetired } from "@/lib/fitbit/retirement";

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequiredMock.mockResolvedValue(false);
});

describe("enqueueBootTimeFitbitSleepRepair — discovery", () => {
  it("queries only un-repaired connections and enqueues one singleton-keyed job per user", async () => {
    prismaMock.fitbitConnection.findMany.mockResolvedValue([
      { userId: "u1" },
      { userId: "u2" },
    ]);
    bossSend.mockResolvedValue("job-id");

    const result = await enqueueBootTimeFitbitSleepRepair();

    expect(prismaMock.fitbitConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sleepRepairedAt: null,
          user: { deletionRequestedAt: null },
        },
      }),
    );
    expect(result.enqueued).toBe(2);
    expect(bossSend).toHaveBeenCalledWith(
      "fitbit-sleep-repair",
      expect.objectContaining({ userId: "u1" }),
      expect.objectContaining({ singletonKey: "fitbit-sleep-repair|u1" }),
    );
    expect(bossSend).toHaveBeenCalledWith(
      "fitbit-sleep-repair",
      expect.objectContaining({ userId: "u2" }),
      expect.objectContaining({ singletonKey: "fitbit-sleep-repair|u2" }),
    );
  });

  it("self-converges: no un-repaired connections → nothing enqueued", async () => {
    prismaMock.fitbitConnection.findMany.mockResolvedValue([]);

    const result = await enqueueBootTimeFitbitSleepRepair();

    expect(result.enqueued).toBe(0);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("never throws — surfaces a discovery error through the result value", async () => {
    prismaMock.fitbitConnection.findMany.mockRejectedValue(
      new Error("db down"),
    );

    const result = await enqueueBootTimeFitbitSleepRepair();

    expect(result.error).toBe("db down");
    expect(result.enqueued).toBe(0);
  });
});

describe("runFitbitSleepRepairForUser", () => {
  it("re-reads the bounded 365-day window (NOT the 30-day default) and stamps sleepRepairedAt", async () => {
    syncUserSleep.mockResolvedValue(42);
    prismaMock.fitbitConnection.update.mockResolvedValue({});

    const before = Date.now();
    const { imported } = await runFitbitSleepRepairForUser("u1");
    const after = Date.now();

    expect(imported).toBe(42);
    // The explicit lower bound is what makes the repair reach history: the
    // resource sync's own default only walks 30 days back.
    const syncOpts = syncUserSleep.mock.calls[0]![1] as { start: Date };
    expect(syncUserSleep).toHaveBeenCalledWith("u1", expect.any(Object));
    expect(FITBIT_BACKFILL_DAYS).toBe(365);
    const horizonMs = FITBIT_BACKFILL_DAYS * 24 * 60 * 60 * 1000;
    expect(syncOpts.start).toBeInstanceOf(Date);
    expect(syncOpts.start.getTime()).toBeGreaterThanOrEqual(
      before - horizonMs - 1000,
    );
    expect(syncOpts.start.getTime()).toBeLessThanOrEqual(after - horizonMs);

    const updateArg = prismaMock.fitbitConnection.update.mock.calls[0]![0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(updateArg.where).toEqual({ userId: "u1" });
    expect(updateArg.data.sleepRepairedAt).toBeInstanceOf(Date);
  });

  it("does NOT touch the lastSyncedAt sync watermark", async () => {
    syncUserSleep.mockResolvedValue(7);
    prismaMock.fitbitConnection.update.mockResolvedValue({});

    await runFitbitSleepRepairForUser("u1");

    // The single connection write stamps ONLY the repair marker — the
    // watermark stays where the incremental orchestrator left it.
    for (const call of prismaMock.fitbitConnection.update.mock.calls) {
      const { data } = call[0] as { data: Record<string, unknown> };
      expect(data).not.toHaveProperty("lastSyncedAt");
      expect(Object.keys(data)).toEqual(["sleepRepairedAt"]);
    }
    expect(prismaMock.fitbitConnection.update).toHaveBeenCalledTimes(1);
  });

  it("reports the rows the replace-by-window sweep removed (the deploy signal)", async () => {
    syncUserSleep.mockImplementation(async () => {
      noteSleepSwept(9);
      return 12;
    });
    prismaMock.fitbitConnection.update.mockResolvedValue({});

    await expect(runFitbitSleepRepairForUser("u1")).resolves.toEqual({
      imported: 12,
      removed: 9,
    });
  });

  it("propagates a sync failure without stamping the marker (pg-boss retries)", async () => {
    syncUserSleep.mockRejectedValue(new Error("fitbit 500"));

    await expect(runFitbitSleepRepairForUser("u1")).rejects.toThrow(
      "fitbit 500",
    );
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });

  it("a swallowed hard failure (ledger entry) throws and does NOT stamp — pg-boss retries", async () => {
    // `syncUserSleep` swallows fetch/write hard failures into the ambient
    // ledger and still resolves a count; the repair must read the ledger, not
    // the count, before stamping.
    syncUserSleep.mockImplementation(async () => {
      noteHardFailure("fetchSleep");
      return 5;
    });

    await expect(runFitbitSleepRepairForUser("u1")).rejects.toThrow(
      /incomplete/,
    );
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });

  it("a dead token returns WITHOUT stamping and WITHOUT throwing (boot discovery re-enqueues)", async () => {
    syncUserSleep.mockImplementation(async () => {
      noteHardFailure(FITBIT_TOKEN_HARD_FAIL);
      return 0;
    });

    await expect(runFitbitSleepRepairForUser("u1")).resolves.toEqual({
      imported: 0,
      removed: 0,
    });
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });

  it("a connection parked at error_reauth returns WITHOUT running the sync or stamping", async () => {
    isReauthRequiredMock.mockResolvedValue(true);

    await expect(runFitbitSleepRepairForUser("u1")).resolves.toEqual({
      imported: 0,
      removed: 0,
    });
    expect(syncUserSleep).not.toHaveBeenCalled();
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });
});

describe("after Google turned the Fitbit Web API off", () => {
  it("enqueues no repair and runs a queued one without reading or stamping", async () => {
    vi.mocked(isFitbitRetired).mockReturnValue(true);
    try {
      prismaMock.fitbitConnection.findMany.mockResolvedValue([
        { userId: "u1" },
      ]);
      await expect(enqueueBootTimeFitbitSleepRepair()).resolves.toEqual({
        enqueued: 0,
        skipped: 0,
        error: null,
      });
      expect(bossSend).not.toHaveBeenCalled();

      await expect(runFitbitSleepRepairForUser("u1")).resolves.toEqual({
        imported: 0,
        removed: 0,
      });
      expect(syncUserSleep).not.toHaveBeenCalled();
      expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
    } finally {
      vi.mocked(isFitbitRetired).mockReturnValue(false);
    }
  });
});
