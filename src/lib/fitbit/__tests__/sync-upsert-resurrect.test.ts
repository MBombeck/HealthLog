/**
 * Pins the tombstone-resurrect contract of `upsertFitbitMeasurements`.
 *
 * The measurements unique index on `(userId, type, source, externalId)` is
 * FULL — it covers soft-deleted rows — so a tombstoned row permanently owns
 * its key. The probe must therefore match tombstoned rows too and route them
 * into the UPDATE branch with `deletedAt: null`: treating them as absent plans
 * an insert that `skipDuplicates` drops SILENTLY against the tombstone's key,
 * wedging the key forever (the same wedge shipped live on the Google
 * transport).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { findManyMock, createManyMock, updateMock, addWarningMock } = vi.hoisted(
  () => ({
    findManyMock: vi.fn(async () => [] as unknown[]),
    createManyMock: vi.fn<
      () => Promise<
        Array<{ id: string; type: "DAILY_STEPS"; measuredAt: Date }>
      >
    >(async () => []),
    updateMock: vi.fn(async () => ({})),
    addWarningMock: vi.fn(),
  }),
);

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: {
      findMany: findManyMock,
      createManyAndReturn: createManyMock,
      update: updateMock,
    },
  },
}));
vi.mock("@/lib/crypto", () => ({ encrypt: vi.fn(), decrypt: vi.fn() }));
vi.mock("@/lib/logging/context", () => ({
  getEvent: () => ({ addWarning: addWarningMock }),
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
vi.mock("@/lib/insights/comprehensive-generate", () => ({
  invalidateStatusInsightsForTypes: vi.fn(async () => {}),
}));
vi.mock("@/lib/integrations/oauth-refresh", () => ({
  persistRotatedToken: vi.fn(async () => {}),
}));
vi.mock("../credentials", () => ({
  getUserFitbitCredentials: vi.fn(async () => null),
}));
vi.mock("../client", () => ({ refreshAccessToken: vi.fn() }));

import { upsertFitbitMeasurements } from "../sync-core";

const STEPS_READING = {
  type: "ACTIVITY_STEPS",
  value: 8123,
  unit: "steps",
  measuredAt: new Date("2026-07-08T00:00:00.000Z"),
  externalId: "stats:steps:2026-07-08",
};

beforeEach(() => {
  findManyMock.mockReset().mockResolvedValue([]);
  createManyMock.mockReset().mockResolvedValue([]);
  updateMock.mockReset().mockResolvedValue({});
  addWarningMock.mockReset();
});

describe("upsertFitbitMeasurements — tombstones resurrect", () => {
  it("probes WITHOUT a deletedAt filter (a tombstoned row must be matched)", async () => {
    await upsertFitbitMeasurements("user-1", [STEPS_READING], {
      deferRollup: true,
    });
    const arg = (findManyMock.mock.calls[0] as unknown[])[0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where).toEqual({
      userId: "user-1",
      source: "FITBIT",
      externalId: { in: ["stats:steps:2026-07-08"] },
    });
    expect(arg.where).not.toHaveProperty("deletedAt");
  });

  it("routes a matched (tombstoned) row into an update that clears deletedAt", async () => {
    findManyMock.mockResolvedValue([
      {
        id: "row-1",
        type: "ACTIVITY_STEPS",
        externalId: "stats:steps:2026-07-08",
      },
    ]);

    const { imported } = await upsertFitbitMeasurements(
      "user-1",
      [STEPS_READING],
      { deferRollup: true },
    );

    // No insert is planned for an owned key — the update resurrects in place.
    expect(createManyMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = (updateMock.mock.calls[0] as unknown[])[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(upd.where).toEqual({ id: "row-1" });
    expect(upd.data.deletedAt).toBeNull();
    expect(upd.data.value).toBe(8123);
    expect(upd.data.syncVersion).toEqual({ increment: 1 });
    expect(imported).toBe(1);
  });

  it("still creates a genuinely fresh key", async () => {
    createManyMock.mockResolvedValue([
      { id: "inserted-1", type: "DAILY_STEPS", measuredAt: new Date() },
    ]);
    const { imported } = await upsertFitbitMeasurements(
      "user-1",
      [STEPS_READING],
      { deferRollup: true },
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(imported).toBe(1);
  });
});

describe("upsertFitbitMeasurements — natural-key migration rescue", () => {
  const SLEEP_READING = {
    type: "SLEEP_DURATION",
    value: 45,
    unit: "minutes",
    measuredAt: new Date("2026-07-08T06:30:00.000Z"),
    externalId: "log-42:sleep:2026-07-08T05:45:00.000Z",
    sleepStage: "DEEP" as const,
  };

  it("re-keys a tombstoned natural-key twin instead of dropping the insert", async () => {
    // externalId probe: no match (the key FORMAT changed); natural-key probe:
    // the old-key row (tombstoned by the sweep) occupies the same
    // (type, measuredAt, sleepStage) slot — without the rescue the insert
    // would silently die on the 0055 unique via skipDuplicates.
    findManyMock
      .mockResolvedValueOnce([]) // externalId probe
      .mockResolvedValueOnce([
        {
          id: "old-row",
          type: "SLEEP_DURATION",
          measuredAt: new Date("2026-07-08T06:30:00.000Z"),
          sleepStage: "DEEP",
        },
      ]); // natural-key rescue probe

    const { imported } = await upsertFitbitMeasurements(
      "user-1",
      [SLEEP_READING],
      { deferRollup: true },
    );

    // The rescue probe must see tombstoned rows too: no deletedAt filter.
    const probe = (findManyMock.mock.calls[1] as unknown[])[0] as {
      where: Record<string, unknown>;
    };
    expect(probe.where).toEqual({
      userId: "user-1",
      source: "FITBIT",
      type: { in: ["SLEEP_DURATION"] },
      measuredAt: { in: [new Date("2026-07-08T06:30:00.000Z")] },
    });
    expect(probe.where).not.toHaveProperty("deletedAt");

    expect(createManyMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = (updateMock.mock.calls[0] as unknown[])[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(upd.where).toEqual({ id: "old-row" });
    expect(upd.data.externalId).toBe("log-42:sleep:2026-07-08T05:45:00.000Z");
    expect(upd.data.deletedAt).toBeNull();
    expect(upd.data.value).toBe(45);
    expect(imported).toBe(1);
  });

  it("re-keys a LIVE natural-key twin in place (update, never a duplicate insert)", async () => {
    findManyMock
      .mockResolvedValueOnce([]) // externalId probe
      .mockResolvedValueOnce([
        {
          id: "live-row",
          type: "ACTIVITY_STEPS",
          measuredAt: new Date("2026-07-08T00:00:00.000Z"),
          sleepStage: null,
        },
      ]); // natural-key rescue probe

    const reading = { ...STEPS_READING, externalId: "log-99:steps:2026-07-08" };
    const { imported } = await upsertFitbitMeasurements("user-1", [reading], {
      deferRollup: true,
    });

    expect(createManyMock).not.toHaveBeenCalled();
    expect(updateMock).toHaveBeenCalledTimes(1);
    const upd = (updateMock.mock.calls[0] as unknown[])[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(upd.where).toEqual({ id: "live-row" });
    expect(upd.data.externalId).toBe("log-99:steps:2026-07-08");
    expect(upd.data.deletedAt).toBeNull();
    expect(imported).toBe(1);
  });

  it("creates normally when no natural-key twin exists", async () => {
    findManyMock.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    createManyMock.mockResolvedValue([
      { id: "inserted-1", type: "DAILY_STEPS", measuredAt: new Date() },
    ]);
    const { imported } = await upsertFitbitMeasurements(
      "user-1",
      [STEPS_READING],
      { deferRollup: true },
    );
    expect(updateMock).not.toHaveBeenCalled();
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(imported).toBe(1);
  });

  it("a rescue-probe failure warns and still attempts the insert (never throws)", async () => {
    // The ledger note that fails the cycle's verdict is pinned at the
    // `syncUserFitbit` level (sync-user-fitbit.test.ts) — the ambient
    // hard-fail scope only exists inside the orchestrator.
    findManyMock
      .mockResolvedValueOnce([]) // externalId probe
      .mockRejectedValueOnce(new Error("db down")); // natural-key rescue probe
    createManyMock.mockResolvedValue([
      { id: "inserted-1", type: "DAILY_STEPS", measuredAt: new Date() },
    ]);

    const { imported } = await upsertFitbitMeasurements(
      "user-1",
      [STEPS_READING],
      { deferRollup: true },
    );

    expect(addWarningMock).toHaveBeenCalledWith(
      expect.stringContaining("natural-key rescue probe failed"),
    );
    // The planned create still goes to createMany — skipDuplicates absorbs a
    // twin collision and the held watermark retries the rescue next tick.
    expect(createManyMock).toHaveBeenCalledTimes(1);
    expect(imported).toBe(1);
  });
});
