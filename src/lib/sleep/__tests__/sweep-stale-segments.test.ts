/**
 * Pins the safety contract of `sweepStaleSleepSegments` — the session-scoped
 * cleanup that keeps a re-scored wearable night from double-counting (the
 * prefix-bound sibling of Google Health's `replaceStaleGoogleHealthSleep`,
 * whose test this mirrors). The query MUST be tightly bounded: only LIVE rows,
 * only `SLEEP_DURATION`, only ONE source, only under ONE session's externalId
 * prefix, and NEVER a row in the fresh keep-set. An entry with no fresh ids
 * (or no prefix) is skipped entirely — an unbounded delete would be data loss.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateManyMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { updateMany: updateManyMock } },
}));

import { sweepStaleSleepSegments } from "../sweep-stale-segments";

beforeEach(() => {
  updateManyMock.mockClear();
  updateManyMock.mockResolvedValue({ count: 2 });
});

describe("sweepStaleSleepSegments — bounded session-scoped sweep", () => {
  it("soft-deletes only live SLEEP_DURATION rows under the session prefix, excluding the fresh set", async () => {
    const keepIds = ["night-1:seg:sleep_core", "night-1:seg:sleep_deep"];

    const removed = await sweepStaleSleepSegments("user-1", "WHOOP", [
      { prefix: "night-1:", keepIds },
    ]);

    expect(removed).toBe(2);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = (updateManyMock.mock.calls[0]! as unknown[])[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({
      userId: "user-1",
      source: "WHOOP",
      type: "SLEEP_DURATION",
      deletedAt: null,
      externalId: { startsWith: "night-1:", notIn: keepIds },
    });
    // A soft delete — the row is tombstoned, never hard-removed.
    expect(arg.data).toEqual({
      deletedAt: expect.any(Date),
      syncVersion: { increment: 1 },
    });
  });

  it("sweeps a legacy indexed row: inside the prefix, outside the keep-set", async () => {
    // The legacy volatile formats (`night-1:seg:sleep_core:1`, Withings'
    // running index, Oura's `seg:<i>`) all live under the session prefix and
    // can never appear in a fresh keep-set — so the where-clause the sweep
    // issues matches them by construction. Pin that with a literal check
    // against the emitted filter.
    await sweepStaleSleepSegments("user-1", "WHOOP", [
      { prefix: "night-1:", keepIds: ["night-1:seg:sleep_core"] },
    ]);
    const where = (
      (updateManyMock.mock.calls[0]! as unknown[])[0] as {
        where: { externalId: { startsWith: string; notIn: string[] } };
      }
    ).where;
    const legacyId = "night-1:seg:sleep_core:1";
    expect(legacyId.startsWith(where.externalId.startsWith)).toBe(true);
    expect(where.externalId.notIn).not.toContain(legacyId);
    // …while the fresh row is protected.
    expect(where.externalId.notIn).toContain("night-1:seg:sleep_core");
  });

  it("skips an entry with no fresh ids or no prefix (never an unbounded delete)", async () => {
    await sweepStaleSleepSegments("user-1", "OURA", [
      { prefix: "sleep:rec-1:", keepIds: [] },
      { prefix: "", keepIds: ["sleep:rec-2:seg:x"] },
    ]);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("is bounded to the sessions of THIS fetch — one updateMany per entry, each under its own prefix", async () => {
    await sweepStaleSleepSegments("user-1", "POLAR", [
      { prefix: "sleep:2026-06-10:seg:", keepIds: ["a"] },
      { prefix: "sleep:2026-06-11:seg:", keepIds: ["b"] },
    ]);
    expect(updateManyMock).toHaveBeenCalledTimes(2);
    const prefixes = updateManyMock.mock.calls.map(
      (c) =>
        (
          (c as unknown[])[0] as {
            where: { externalId: { startsWith: string } };
          }
        ).where.externalId.startsWith,
    );
    expect(prefixes).toEqual([
      "sleep:2026-06-10:seg:",
      "sleep:2026-06-11:seg:",
    ]);
  });

  it("never throws when the cleanup query fails (best-effort)", async () => {
    updateManyMock.mockRejectedValueOnce(new Error("db down"));
    await expect(
      sweepStaleSleepSegments("user-1", "WITHINGS", [
        { prefix: "withings:sleep:u:1:", keepIds: ["withings:sleep:u:1:5"] },
      ]),
    ).resolves.toBe(0);
  });
});
