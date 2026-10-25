/**
 * v1.11.0 — WHOOP backfill self-convergence tests (mocked).
 *   - discovery only matches un-backfilled connections;
 *   - a completed backfill stamps `backfillCompletedAt` so the next discovery
 *     pass drops the account (idempotent across reboots);
 *   - the discovery enqueue is singleton-keyed per user.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, bossSend, syncUserWhoop, isReauthRequiredMock } =
  vi.hoisted(() => ({
    prismaMock: {
      whoopConnection: {
        findMany: vi.fn(),
        update: vi.fn(),
      },
    },
    bossSend: vi.fn(),
    syncUserWhoop: vi.fn(),
    isReauthRequiredMock: vi.fn(async () => false),
  }));

vi.mock("@/lib/db", () => ({ prisma: prismaMock }));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => ({ send: bossSend }),
}));

vi.mock("@/lib/whoop/sync", () => ({
  syncUserWhoop: (...a: unknown[]) => syncUserWhoop(...a),
}));

vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: isReauthRequiredMock,
}));

vi.mock("@/lib/logging/context", () => ({
  annotate: () => {},
  getEvent: () => null,
}));

import {
  enqueueBootTimeWhoopBackfill,
  runWhoopBackfillForUser,
} from "../whoop-backfill";

beforeEach(() => {
  vi.clearAllMocks();
  isReauthRequiredMock.mockResolvedValue(false);
  prismaMock.whoopConnection.update.mockResolvedValue({});
});

describe("enqueueBootTimeWhoopBackfill — discovery", () => {
  it("queries only un-backfilled connections", async () => {
    prismaMock.whoopConnection.findMany.mockResolvedValue([
      { userId: "u1" },
      { userId: "u2" },
    ]);
    bossSend.mockResolvedValue("job-id");

    const result = await enqueueBootTimeWhoopBackfill();

    expect(prismaMock.whoopConnection.findMany).toHaveBeenCalledWith(
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
      "whoop-backfill",
      expect.objectContaining({ userId: "u1" }),
      expect.objectContaining({ singletonKey: "whoop-backfill|u1" }),
    );
  });

  it("self-converges: no un-backfilled connections → nothing enqueued", async () => {
    prismaMock.whoopConnection.findMany.mockResolvedValue([]);

    const result = await enqueueBootTimeWhoopBackfill();

    expect(result.enqueued).toBe(0);
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("never throws — surfaces a discovery error through the result value", async () => {
    prismaMock.whoopConnection.findMany.mockRejectedValue(new Error("db down"));

    const result = await enqueueBootTimeWhoopBackfill();

    expect(result.error).toBe("db down");
    expect(result.enqueued).toBe(0);
  });
});

describe("runWhoopBackfillForUser — verdict-gated marker", () => {
  it("stamps backfillCompletedAt after a CLEAN full-history run", async () => {
    syncUserWhoop.mockResolvedValue({ imported: 123, failed: false });

    const { imported } = await runWhoopBackfillForUser("u1");

    expect(imported).toBe(123);
    expect(syncUserWhoop).toHaveBeenCalledWith("u1", { fullSync: true });
    const updateArg = prismaMock.whoopConnection.update.mock.calls[0]![0];
    expect(updateArg.where).toEqual({ userId: "u1" });
    expect(updateArg.data.backfillCompletedAt).toBeInstanceOf(Date);
  });

  it("a failed verdict THROWS without stamping — pg-boss retries become real", async () => {
    syncUserWhoop.mockResolvedValue({ imported: 7, failed: true });

    await expect(runWhoopBackfillForUser("u1")).rejects.toThrow(/incomplete/);
    expect(prismaMock.whoopConnection.update).not.toHaveBeenCalled();
  });

  it("a connection parked at error_reauth returns WITHOUT running the sync or stamping", async () => {
    isReauthRequiredMock.mockResolvedValue(true);

    await expect(runWhoopBackfillForUser("u1")).resolves.toEqual({
      imported: 0,
    });
    expect(syncUserWhoop).not.toHaveBeenCalled();
    expect(prismaMock.whoopConnection.update).not.toHaveBeenCalled();
  });
});
