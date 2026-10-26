/**
 * Pins the safety contract of `replaceStaleFitbitSleep` — the replace-by-window
 * cleanup that keeps a re-scored Fitbit night from double-counting — and the
 * end-to-end heal it produces together with the stable segment key and the
 * natural-key rescue.
 *
 * The query MUST be tightly bounded: only LIVE `FITBIT` `SLEEP_DURATION` rows,
 * only inside the session window, and NEVER a row in the fresh keep-set. A
 * session with no window is skipped entirely (nothing to clean, and an
 * unbounded delete would be data loss).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  findManyMock,
  createManyMock,
  updateMock,
  updateManyMock,
  connectionFindUniqueMock,
  fetchSleepRangeMock,
  callOrder,
} = vi.hoisted(() => ({
  findManyMock: vi.fn(async () => [] as unknown[]),
  createManyMock: vi.fn<
    () => Promise<Array<{ id: string; type: string; measuredAt: Date }>>
  >(async () => []),
  updateMock: vi.fn(async () => ({})),
  updateManyMock: vi.fn(async () => ({ count: 0 })),
  connectionFindUniqueMock: vi.fn(async () => null as unknown),
  fetchSleepRangeMock: vi.fn(async () => ({}) as unknown),
  callOrder: [] as string[],
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: findManyMock,
      createManyAndReturn: createManyMock,
      update: updateMock,
      updateMany: updateManyMock,
    },
    fitbitConnection: { findUnique: connectionFindUniqueMock },
  },
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: vi.fn((v: string) => v),
  decrypt: vi.fn((v: string) => v),
}));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: vi.fn() }),
  annotate: () => {},
}));
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
vi.mock("@/lib/insights/status-invalidation", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/integrations/oauth-refresh", () => ({
  persistRotatedToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/arrivals/measurement-emit", () => ({
  emitInsertedMeasurementArrivals: vi.fn(async () => {}),
}));
vi.mock("@/lib/daily/morning-refresh-trigger", () => ({
  maybeEnqueueMorningRefresh: vi.fn(async () => {}),
}));
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "UTC"),
}));
vi.mock("../credentials", () => ({
  getUserFitbitCredentials: vi.fn(async () => null),
}));
vi.mock("../client", async () => {
  const actual = await vi.importActual<typeof import("../client")>("../client");
  return { ...actual, fetchSleepRange: fetchSleepRangeMock };
});

import { replaceStaleFitbitSleep } from "../sync-core";
import { syncUserSleep } from "../sync-sleep";

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  findManyMock.mockReset().mockImplementation(async () => {
    callOrder.push("probe");
    return [];
  });
  createManyMock.mockReset().mockImplementation(async () => {
    callOrder.push("create");
    return [];
  });
  updateMock.mockReset().mockImplementation(async () => {
    callOrder.push("update");
    return {};
  });
  updateManyMock.mockReset().mockImplementation(async () => {
    callOrder.push("sweep");
    return { count: 0 };
  });
});

describe("replaceStaleFitbitSleep — bounded replace-by-window", () => {
  it("soft-deletes only live FITBIT sleep rows in the window, excluding the fresh set", async () => {
    updateManyMock.mockImplementation(async () => {
      callOrder.push("sweep");
      return { count: 1 };
    });
    const windowStart = new Date("2026-06-01T22:30:00.000Z");
    const windowEnd = new Date("2026-06-02T06:30:00.000Z");
    const keepIds = ["777:sleep:a", "777:sleep:b"];

    const removed = await replaceStaleFitbitSleep("user-1", [
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
      source: "FITBIT",
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
    await replaceStaleFitbitSleep("user-1", [
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
      replaceStaleFitbitSleep("user-1", [
        {
          windowStart: new Date("2026-06-01T22:00:00.000Z"),
          windowEnd: new Date("2026-06-02T06:00:00.000Z"),
          keepIds: ["777:sleep:a"],
        },
      ]),
    ).resolves.toBe(0);
  });
});

// ── End-to-end: a re-scored night heals through the write path ──────────────
//
// One night stored under the OLD key format, then re-fetched after a re-score.
// The sweep tombstones the old-keyed rows FIRST, so the upsert's natural-key
// rescue re-keys those very rows in place — no parallel copy, no silent drop
// against the natural unique index, and the night total stays the fresh total.

const SEG_A_START = "2026-06-01T22:00:00.000Z";
const SEG_A_END = new Date("2026-06-01T22:30:00.000Z");
const SEG_B_START = "2026-06-01T22:30:00.000Z";
const SEG_B_END = new Date("2026-06-01T23:30:00.000Z");
const NEW_KEY_A = `777:sleep:${SEG_A_START}`;
const NEW_KEY_B = `777:sleep:${SEG_B_START}`;

const RESCORED_NIGHT = {
  sleep: [
    {
      logId: 777,
      startTime: SEG_A_START,
      endTime: SEG_B_END.toISOString(),
      levels: {
        data: [
          // Re-classified from light → deep on the SAME block.
          { dateTime: SEG_A_START, level: "deep", seconds: 1800 },
          { dateTime: SEG_B_START, level: "rem", seconds: 3600 },
        ],
      },
    },
  ],
};

const SYNC_WINDOW = {
  start: new Date("2026-06-01T00:00:00.000Z"),
  end: new Date("2026-06-03T00:00:00.000Z"),
  deferRollup: true,
};

function connectionAlive() {
  connectionFindUniqueMock.mockResolvedValue({
    id: "conn-1",
    fitbitUserId: "fb-1",
    accessToken: "tok",
    refreshToken: "ref",
    tokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
}

describe("syncUserSleep — a re-scored night neither duplicates nor disappears", () => {
  beforeEach(() => {
    connectionAlive();
    fetchSleepRangeMock.mockResolvedValue(RESCORED_NIGHT);
  });

  it("sweeps the night's window BEFORE the upsert and re-keys the tombstoned rows in place", async () => {
    updateManyMock.mockImplementation(async () => {
      callOrder.push("sweep");
      return { count: 2 };
    });
    findManyMock
      .mockImplementationOnce(async () => {
        // externalId probe: the fresh keys do not exist yet (the stored rows
        // still carry the old positional format).
        callOrder.push("probe:externalId");
        return [];
      })
      .mockImplementationOnce(async () => {
        // natural-key probe: the rows the sweep just tombstoned occupy the
        // same (type, measuredAt, sleepStage) slots.
        callOrder.push("probe:naturalKey");
        return [
          {
            id: "old-a",
            type: "SLEEP_DURATION",
            measuredAt: SEG_A_END,
            sleepStage: "DEEP",
          },
          {
            id: "old-b",
            type: "SLEEP_DURATION",
            measuredAt: SEG_B_END,
            sleepStage: "REM",
          },
        ];
      });

    const imported = await syncUserSleep("user-1", SYNC_WINDOW);

    // The sweep runs first — reversing the order would tombstone the rows the
    // upsert had just written.
    expect(callOrder[0]).toBe("sweep");
    expect(callOrder.indexOf("sweep")).toBeLessThan(
      callOrder.indexOf("probe:externalId"),
    );

    const sweepArg = (updateManyMock.mock.calls[0]! as unknown[])[0] as {
      where: Record<string, unknown>;
    };
    expect(sweepArg.where).toMatchObject({
      userId: "user-1",
      source: "FITBIT",
      type: "SLEEP_DURATION",
      deletedAt: null,
      measuredAt: {
        gte: new Date(SEG_A_START),
        lte: SEG_B_END,
      },
      externalId: { notIn: [NEW_KEY_A, NEW_KEY_B] },
    });

    // No parallel copy: both rows are re-keyed in place, none inserted.
    expect(createManyMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(2);
    const updates = updateMock.mock.calls.map(
      (c) =>
        (c as unknown[])[0] as {
          where: { id: string };
          data: Record<string, unknown>;
        },
    );
    expect(updates.map((u) => u.where.id)).toEqual(["old-a", "old-b"]);
    expect(updates.map((u) => u.data.externalId)).toEqual([
      NEW_KEY_A,
      NEW_KEY_B,
    ]);
    for (const u of updates) {
      expect(u.data.deletedAt).toBeNull();
    }
    // The re-classification lands on the stage axis of the same row.
    expect(updates[0]!.data.sleepStage).toBe("DEEP");
    // Two segments in, two rows out — the night total is the fresh total.
    expect(imported).toBe(2);
  });

  it("is a no-op on the second pass (idempotent — no churn, no duplicates)", async () => {
    findManyMock.mockImplementation(async () => {
      callOrder.push("probe");
      // Both rows now carry the fresh keys and the fresh payload.
      return [
        {
          id: "row-a",
          type: "SLEEP_DURATION",
          externalId: NEW_KEY_A,
          value: 30,
          unit: "minutes",
          measuredAt: SEG_A_END,
          sleepStage: "DEEP",
          deletedAt: null,
        },
        {
          id: "row-b",
          type: "SLEEP_DURATION",
          externalId: NEW_KEY_B,
          value: 60,
          unit: "minutes",
          measuredAt: SEG_B_END,
          sleepStage: "REM",
          deletedAt: null,
        },
      ];
    });

    const imported = await syncUserSleep("user-1", SYNC_WINDOW);

    // The sweep still runs, but it excludes both fresh keys, so it removes
    // nothing; the upsert writes nothing at all.
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(createManyMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(imported).toBe(0);
  });
});
