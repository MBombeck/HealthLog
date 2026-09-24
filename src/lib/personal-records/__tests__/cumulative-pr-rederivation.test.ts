/**
 * v1.30.3 (QA F4) — the one-shot repair for the pre-fix inflated
 * cumulative-type PersonalRecord rows: deletes the suspect row(s) for a
 * user and re-runs detection silently so the honest re-derived best takes
 * its place, plus the boot-discovery enqueue that finds affected accounts.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const deleteMany = vi.fn();
const findMany = vi.fn();
// The delete and the re-derivation share one transaction; the stub hands the
// callback a client that routes to the same spies.
const txClient = {
  personalRecord: {
    deleteMany: (a: unknown) => deleteMany(a),
  },
};
vi.mock("@/lib/db", () => ({
  prisma: {
    personalRecord: {
      deleteMany: (a: unknown) => deleteMany(a),
      findMany: (a: unknown) => findMany(a),
    },
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(txClient),
  },
}));

const detectPersonalRecordsForUser = vi.fn();
vi.mock("@/lib/personal-records/pr-detection-worker", () => ({
  detectPersonalRecordsForUser: (...args: unknown[]) =>
    detectPersonalRecordsForUser(...args),
}));

const send = vi.fn();
const getGlobalBoss = vi.fn();
vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => getGlobalBoss(),
}));

const annotate = vi.fn();
vi.mock("@/lib/logging/context", () => ({
  annotate: (...a: unknown[]) => annotate(...a),
}));

import {
  runCumulativePrRederivationForUser,
  enqueueBootTimeCumulativePrRederivation,
  CUMULATIVE_PR_FIX_CUTOFF,
} from "@/lib/personal-records/cumulative-pr-rederivation";

describe("runCumulativePrRederivationForUser", () => {
  beforeEach(() => {
    deleteMany.mockReset();
    detectPersonalRecordsForUser.mockReset();
    annotate.mockReset();
  });

  it("deletes suspect rows created before the fix cutoff and re-derives silently", async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    detectPersonalRecordsForUser.mockResolvedValue({
      inserted: 1,
      ties: 0,
      scanned: 6,
      silent: true,
    });

    const summary = await runCumulativePrRederivationForUser("u1");

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        metricSlot: null,
        metricType: { in: expect.arrayContaining(["ACTIVITY_STEPS"]) },
        createdAt: { lt: CUMULATIVE_PR_FIX_CUTOFF },
      },
    });
    // Re-derivation always runs silent — this is data hygiene, not a new
    // achievement, so no push should fire for it.
    // It reads through the transaction, so it sees the deletion.
    expect(detectPersonalRecordsForUser).toHaveBeenCalledWith("u1", {
      silent: true,
      prisma: txClient,
    });
    expect(summary).toEqual({ rowsDeleted: 1, rowsReinserted: 1 });
  });

  it("skips re-derivation entirely when nothing was deleted", async () => {
    deleteMany.mockResolvedValue({ count: 0 });

    const summary = await runCumulativePrRederivationForUser("u2");

    expect(detectPersonalRecordsForUser).not.toHaveBeenCalled();
    expect(summary).toEqual({ rowsDeleted: 0, rowsReinserted: 0 });
  });

  it("counts a tie as a reinserted row (the honest re-derived value can equal a still-live sibling metric's best)", async () => {
    deleteMany.mockResolvedValue({ count: 2 });
    detectPersonalRecordsForUser.mockResolvedValue({
      inserted: 0,
      ties: 1,
      scanned: 6,
      silent: true,
    });

    const summary = await runCumulativePrRederivationForUser("u3");
    expect(summary).toEqual({ rowsDeleted: 2, rowsReinserted: 1 });
  });
});

describe("enqueueBootTimeCumulativePrRederivation", () => {
  beforeEach(() => {
    findMany.mockReset();
    send.mockReset();
    getGlobalBoss.mockReset();
  });

  it("no-ops when no boss is attached (test / scriptless context)", async () => {
    getGlobalBoss.mockReturnValue(null);
    const result = await enqueueBootTimeCumulativePrRederivation();
    expect(result).toEqual({ enqueued: 0, skipped: 0, error: null });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("finds zero affected users and enqueues nothing", async () => {
    getGlobalBoss.mockReturnValue({ send });
    findMany.mockResolvedValue([]);
    const result = await enqueueBootTimeCumulativePrRederivation();
    expect(result).toEqual({ enqueued: 0, skipped: 0, error: null });
    expect(send).not.toHaveBeenCalled();
  });

  it("enqueues one job per distinct affected user with a coalescing singletonKey", async () => {
    getGlobalBoss.mockReturnValue({ send });
    findMany.mockResolvedValue([{ userId: "u1" }, { userId: "u2" }]);
    send.mockResolvedValue("job-id");

    const result = await enqueueBootTimeCumulativePrRederivation(30);

    expect(result).toEqual({ enqueued: 2, skipped: 0, error: null });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          metricSlot: null,
          createdAt: { lt: CUMULATIVE_PR_FIX_CUTOFF },
        }),
        distinct: ["userId"],
      }),
    );
    expect(send).toHaveBeenCalledWith(
      "cumulative-pr-rederive",
      expect.objectContaining({ userId: "u1" }),
      expect.objectContaining({
        singletonKey: "cumulative-pr-rederive|u1",
        startAfter: 30,
      }),
    );
  });

  it("counts a coalesced send (pg-boss returns null) as skipped, not an error", async () => {
    getGlobalBoss.mockReturnValue({ send });
    findMany.mockResolvedValue([{ userId: "u1" }]);
    send.mockResolvedValue(null);

    const result = await enqueueBootTimeCumulativePrRederivation();
    expect(result).toEqual({ enqueued: 0, skipped: 1, error: null });
  });

  it("returns the error message instead of throwing on a discovery failure", async () => {
    getGlobalBoss.mockReturnValue({ send });
    findMany.mockRejectedValue(new Error("db down"));

    const result = await enqueueBootTimeCumulativePrRederivation();
    expect(result.enqueued).toBe(0);
    expect(result.error).toBe("db down");
  });
});
