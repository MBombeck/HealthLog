/**
 * Pins the safety contract of `replaceStaleGoogleHealthSleep` — the
 * replace-by-window cleanup that keeps a re-scored Google night from
 * double-counting. The query MUST be tightly bounded: only LIVE
 * `GOOGLE_HEALTH` `SLEEP_DURATION` rows, only inside the session window, and
 * NEVER a row in the fresh keep-set. A session with no window is skipped
 * entirely (nothing to clean, and an unbounded delete would be data loss).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateManyMock } = vi.hoisted(() => ({
  updateManyMock: vi.fn(async () => ({ count: 0 })),
}));

vi.mock("@/lib/db", () => ({
  prisma: { measurement: { updateMany: updateManyMock } },
}));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/integrations/status", () => ({
  isReauthRequired: vi.fn(async () => false),
  recordSyncFailure: vi.fn(async () => {}),
  recordSyncSuccess: vi.fn(async () => {}),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  collapseToTypeDayKeys: vi.fn(() => []),
  recomputeBucketsForMeasurement: vi.fn(async () => {}),
  recomputeUserRollups: vi.fn(async () => {}),
}));
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("../credentials", () => ({
  getUserGoogleHealthCredentials: vi.fn(async () => null),
}));
vi.mock("../client", () => ({ refreshAccessToken: vi.fn() }));

import { replaceStaleGoogleHealthSleep } from "../sync-core";

beforeEach(() => {
  updateManyMock.mockClear();
  updateManyMock.mockResolvedValue({ count: 1 });
});

describe("replaceStaleGoogleHealthSleep — bounded replace-by-window", () => {
  it("soft-deletes only live GOOGLE_HEALTH sleep rows in the window, excluding the fresh set", async () => {
    const windowStart = new Date("2026-06-01T22:30:00.000Z");
    const windowEnd = new Date("2026-06-02T06:30:00.000Z");
    const keepIds = ["anchor:sleep:a", "anchor:sleep:b"];

    const removed = await replaceStaleGoogleHealthSleep("user-1", [
      { windowStart, windowEnd, keepIds },
    ]);

    expect(removed).toBe(1);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    const arg = (updateManyMock.mock.calls[0]! as unknown[])[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toEqual({
      userId: "user-1",
      source: "GOOGLE_HEALTH",
      type: "SLEEP_DURATION",
      deletedAt: null,
      measuredAt: { gte: windowStart, lte: windowEnd },
      externalId: { notIn: keepIds },
    });
    // A soft delete — the row is tombstoned, never hard-removed.
    expect(arg.data).toHaveProperty("deletedAt");
    expect(arg.data.deletedAt).toBeInstanceOf(Date);
  });

  it("skips a session with a null window (never issues an unbounded delete)", async () => {
    await replaceStaleGoogleHealthSleep("user-1", [
      { windowStart: null, windowEnd: null, keepIds: ["x"] },
      {
        windowStart: new Date("2026-06-01T22:00:00.000Z"),
        windowEnd: new Date("2026-06-02T06:00:00.000Z"),
        keepIds: [],
      },
    ]);
    // Both sessions are unsafe to clean (no window, or no fresh ids to keep) —
    // neither may issue a delete.
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("never fails the sync when the cleanup query throws", async () => {
    updateManyMock.mockRejectedValueOnce(new Error("db down"));
    await expect(
      replaceStaleGoogleHealthSleep("user-1", [
        {
          windowStart: new Date("2026-06-01T22:00:00.000Z"),
          windowEnd: new Date("2026-06-02T06:00:00.000Z"),
          keepIds: ["anchor:sleep:a"],
        },
      ]),
    ).resolves.toBe(0);
  });
});
