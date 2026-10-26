/**
 * v1.12.0 — Fitbit backfill self-convergence tests (mocked).
 *   - discovery only matches un-backfilled connections;
 *   - a completed backfill stamps `backfillCompletedAt` so the next discovery
 *     pass drops the account (idempotent across reboots);
 *   - the discovery enqueue is singleton-keyed per user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, bossSend, syncUserFitbit, isReauthRequiredMock } =
  vi.hoisted(() => ({
    prismaMock: {
      fitbitConnection: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
    bossSend: vi.fn(),
    syncUserFitbit: vi.fn(),
    isReauthRequiredMock: vi.fn(async () => false),
  }));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: bossSend }),
}));

vi.mock("@/lib/fitbit/sync", () => ({
  syncUserFitbit: (...a: unknown[]) => syncUserFitbit(...a),
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: isReauthRequiredMock,
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

import {
  enqueueBootTimeFitbitBackfill,
  runFitbitBackfillForUser,
} from "@/lib/fitbit/jobs/backfill";
import { isFitbitRetired } from "@/lib/fitbit/retirement";

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequiredMock.mockResolvedValue(false);
  prismaMock.fitbitConnection.update.mockResolvedValue({});
});

describe("enqueueBootTimeFitbitBackfill — discovery", () => {
  it("queries only un-backfilled connections", async () => {
    prismaMock.fitbitConnection.findMany.mockResolvedValue([
      { userId: "u1" },
      { userId: "u2" },
    ]);
    bossSend.mockResolvedValue("job-id");

    const result = await enqueueBootTimeFitbitBackfill();

    expect(prismaMock.fitbitConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          backfillCompletedAt: null,
          user: { deletionRequestedAt: null },
        },
      }),
    );
    expect(result.enqueued).toBe(2);
    // Singleton-keyed per user so a fast restart never double-enqueues.
    expect(bossSend).toHaveBeenCalledWith(
      "fitbit-backfill",
      expect.objectContaining({ userId: "u1" }),
      expect.objectContaining({ singletonKey: "fitbit-backfill|u1" }),
    );
  });

  it("self-converges: no un-backfilled connections → nothing enqueued", async () => {
    prismaMock.fitbitConnection.findMany.mockResolvedValue([]);

    const result = await enqueueBootTimeFitbitBackfill();

    expect(result.enqueued).toBe(0);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("never throws — surfaces a discovery error through the result value", async () => {
    prismaMock.fitbitConnection.findMany.mockRejectedValue(
      new Error("db down"),
    );

    const result = await enqueueBootTimeFitbitBackfill();

    expect(result.error).toBe("db down");
    expect(result.enqueued).toBe(0);
  });
});

describe("runFitbitBackfillForUser — verdict-gated marker", () => {
  it("stamps backfillCompletedAt after a CLEAN full-history run", async () => {
    syncUserFitbit.mockResolvedValue({ imported: 42, failed: false });

    const { imported } = await runFitbitBackfillForUser("u1");

    expect(imported).toBe(42);
    expect(syncUserFitbit).toHaveBeenCalledWith("u1", { fullSync: true });
    const updateArg = prismaMock.fitbitConnection.update.mock.calls[0]![0];
    expect(updateArg.where).toEqual({ userId: "u1" });
    expect(updateArg.data.backfillCompletedAt).toBeInstanceOf(Date);
  });

  it("a failed verdict THROWS without stamping — pg-boss retries become real", async () => {
    syncUserFitbit.mockResolvedValue({ imported: 7, failed: true });

    await expect(runFitbitBackfillForUser("u1")).rejects.toThrow(/incomplete/);
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });

  it("a connection parked at error_reauth returns WITHOUT running the sync or stamping", async () => {
    isReauthRequiredMock.mockResolvedValue(true);

    await expect(runFitbitBackfillForUser("u1")).resolves.toEqual({
      imported: 0,
    });
    expect(syncUserFitbit).not.toHaveBeenCalled();
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });
});

describe("runFitbitBackfillForUser — a walk that reached its ceiling", () => {
  it("leaves the marker unset and does not throw", async () => {
    const { walkPages } = await import("@/lib/integrations/page-walk");
    syncUserFitbit.mockImplementation(async () => {
      // A history longer than the walk may read: every page has a next.
      await walkPages<number, number>(
        "fitbit.exercise",
        3,
        async (cursor) => ({ items: [1], next: (cursor ?? 0) + 1 }),
        0,
      );
      return { imported: 3, failed: false };
    });

    await expect(runFitbitBackfillForUser("u1")).resolves.toEqual({
      imported: 3,
    });
    expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
  });
});

describe("after Google turned the Fitbit Web API off", () => {
  it("enqueues no backfill and runs a queued one without walking or stamping", async () => {
    vi.mocked(isFitbitRetired).mockReturnValue(true);
    try {
      prismaMock.fitbitConnection.findMany.mockResolvedValue([
        { userId: "u1" },
      ]);
      await expect(enqueueBootTimeFitbitBackfill()).resolves.toEqual({
        enqueued: 0,
        skipped: 0,
        error: null,
      });
      expect(bossSend).not.toHaveBeenCalled();

      await expect(runFitbitBackfillForUser("u1")).resolves.toEqual({
        imported: 0,
      });
      expect(syncUserFitbit).not.toHaveBeenCalled();
      expect(prismaMock.fitbitConnection.update).not.toHaveBeenCalled();
    } finally {
      vi.mocked(isFitbitRetired).mockReturnValue(false);
    }
  });
});
