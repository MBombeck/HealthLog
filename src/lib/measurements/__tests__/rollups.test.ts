/**
 * v1.5.0 — unit tests for the persistent measurement-rollup populator.
 *
 * `prisma` is mocked at the module level so we can pin:
 *   - the DAY-bucket sync recompute writes through the upsert path,
 *   - `collapseToTypeDayKeys` folds same-day entries,
 *   - the bucket-span helper anchors WEEK on Monday, MONTH / YEAR on
 *     calendar boundaries,
 *   - `enqueueRollupRecompute` calls `boss.send` with the documented
 *     queue name + singleton-key shape, and is a silent no-op when
 *     no boss is attached.
 *
 * Integration coverage (real Postgres + real `STDDEV_POP` /
 * `REGR_SLOPE`) lives in `tests/integration/measurement-rollups.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock factories run BEFORE module-level statements due to hoisting,
// so the mock fns must live inside the factory closure. We re-export
// them through `vi.hoisted` so the test body can reach them after.
const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  queryRawUnsafe: vi.fn(),
  transaction: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findFirstMeasurement: vi.fn(),
  bossSend: vi.fn(),
  getGlobalBossMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $transaction: mocks.transaction,
    measurementRollup: {
      upsert: mocks.upsert,
      deleteMany: mocks.deleteMany,
      findFirst: mocks.findFirst,
      findMany: mocks.findMany,
    },
    measurement: {
      findFirst: mocks.findFirstMeasurement,
    },
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => mocks.getGlobalBossMock(),
}));

const {
  queryRaw,
  queryRawUnsafe,
  transaction,
  upsert,
  deleteMany,
  findFirst,
  findFirstMeasurement,
  bossSend,
  getGlobalBossMock,
} = mocks;
// `findMany` and `queryRaw` are wired into the mock object so any
// indirect lookups via `prisma.measurementRollup.findMany` / `prisma.$queryRaw`
// don't throw, but the populator tests below exercise the
// `$queryRawUnsafe` + upsert paths so the references stay unused
// inside this file.
void mocks.findMany;
void queryRaw;

import {
  ROLLUP_FULL_BACKFILL_QUEUE,
  ROLLUP_RECOMPUTE_QUEUE,
  collapseToTypeDayKeys,
  enqueueBootTimeRollupBackfill,
  enqueueRollupRecompute,
  ensureUserRollupsFresh,
  recomputeBucketsForMeasurement,
} from "../rollups";

beforeEach(() => {
  queryRaw.mockReset();
  queryRawUnsafe.mockReset();
  transaction.mockReset();
  upsert.mockReset();
  deleteMany.mockReset();
  findFirst.mockReset();
  mocks.findMany.mockReset();
  findFirstMeasurement.mockReset();
  bossSend.mockReset();
  getGlobalBossMock.mockReset();
  // Default: $transaction takes an array of pre-built promises (the
  // populator passes `slice.map(prisma.measurementRollup.upsert(...))`)
  // and returns them awaited.
  transaction.mockImplementation(async (operations: unknown[]) => operations);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collapseToTypeDayKeys", () => {
  it("folds same-day same-type entries into one key", () => {
    const morning = new Date("2026-05-10T07:30:00.000Z");
    const evening = new Date("2026-05-10T21:30:00.000Z");
    const nextDay = new Date("2026-05-11T07:30:00.000Z");
    const keys = collapseToTypeDayKeys([
      { type: "WEIGHT", measuredAt: morning },
      { type: "WEIGHT", measuredAt: evening },
      { type: "WEIGHT", measuredAt: nextDay },
      { type: "PULSE", measuredAt: morning },
    ]);
    // 3 unique (type, day) pairs: WEIGHT×2026-05-10, WEIGHT×2026-05-11,
    // PULSE×2026-05-10.
    expect(keys).toHaveLength(3);
    const types = keys.map((k) => k.type).sort();
    expect(types).toEqual(["PULSE", "WEIGHT", "WEIGHT"]);
    // Every entry is anchored on UTC midnight so the worker enqueue
    // payload is deterministic.
    for (const k of keys) {
      expect(k.measuredAt.getUTCHours()).toBe(0);
      expect(k.measuredAt.getUTCMinutes()).toBe(0);
    }
  });

  it("returns an empty array when given no entries", () => {
    expect(collapseToTypeDayKeys([])).toEqual([]);
  });
});

describe("recomputeBucketsForMeasurement", () => {
  it("upserts the DAY rollup synchronously and enqueues WEEK/MONTH/YEAR", async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      {
        type: "WEIGHT",
        bucket_start: new Date("2026-05-10T00:00:00.000Z"),
        count: BigInt(3),
        mean: 82.5,
        min_value: 80.0,
        max_value: 85.0,
        sd: 2.0,
        slope: -0.1,
        r2: 0.9,
      },
    ]);
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValue("job-id");

    await recomputeBucketsForMeasurement(
      "user-1",
      "WEIGHT",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    // DAY pass — single upsert in a transaction.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    const upsertArg = upsert.mock.calls[0][0];
    expect(upsertArg.where.userId_type_granularity_bucketStart.userId).toBe(
      "user-1",
    );
    expect(upsertArg.where.userId_type_granularity_bucketStart.type).toBe(
      "WEIGHT",
    );
    expect(
      upsertArg.where.userId_type_granularity_bucketStart.granularity,
    ).toBe("DAY");
    expect(upsertArg.create.count).toBe(3);
    expect(upsertArg.create.mean).toBe(82.5);

    // WEEK / MONTH / YEAR — three enqueues against the worker queue.
    expect(bossSend).toHaveBeenCalledTimes(3);
    for (const call of bossSend.mock.calls) {
      expect(call[0]).toBe(ROLLUP_RECOMPUTE_QUEUE);
      expect(call[1].userId).toBe("user-1");
      expect(call[1].type).toBe("WEIGHT");
      expect(["WEEK", "MONTH", "YEAR"]).toContain(call[1].granularity);
    }
  });

  it("deletes the DAY row when the post-mutation aggregate is empty", async () => {
    // Post-delete recompute: the day now has zero rows.
    queryRawUnsafe.mockResolvedValueOnce([]);
    getGlobalBossMock.mockReturnValue(null);

    await recomputeBucketsForMeasurement(
      "user-1",
      "WEIGHT",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where.userId).toBe("user-1");
    expect(deleteMany.mock.calls[0][0].where.granularity).toBe("DAY");
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("enqueueRollupRecompute", () => {
  it("is a silent no-op when no boss is attached", async () => {
    getGlobalBossMock.mockReturnValue(null);
    await enqueueRollupRecompute({
      userId: "user-1",
      type: "WEIGHT",
      granularity: "WEEK",
      from: new Date("2026-05-04T00:00:00.000Z"),
      to: new Date("2026-05-11T00:00:00.000Z"),
    });
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("sends with the documented queue + singleton-key shape", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValue("job-1");
    const from = new Date("2026-05-04T00:00:00.000Z");
    await enqueueRollupRecompute({
      userId: "user-9",
      type: "PULSE",
      granularity: "WEEK",
      from,
      to: new Date("2026-05-11T00:00:00.000Z"),
    });
    expect(bossSend).toHaveBeenCalledTimes(1);
    const [queue, payload, opts] = bossSend.mock.calls[0];
    expect(queue).toBe(ROLLUP_RECOMPUTE_QUEUE);
    expect(payload.userId).toBe("user-9");
    expect(payload.type).toBe("PULSE");
    expect(payload.granularity).toBe("WEEK");
    expect(payload.from).toBe(from.toISOString());
    // The singleton key collapses repeat enqueues for the same bucket
    // so a multi-write minute doesn't fan out one worker run per row.
    expect(opts.singletonKey).toBe(
      `user-9|PULSE|WEEK|${from.toISOString()}`,
    );
  });
});

describe("ensureUserRollupsFresh", () => {
  it("is a no-op when the user has no measurements", async () => {
    findFirst.mockResolvedValueOnce(null);
    findFirstMeasurement.mockResolvedValueOnce(null);
    const result = await ensureUserRollupsFresh("user-1");
    expect(result.recomputed).toBe(false);
    // No subsequent live SQL pass.
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("is a no-op when the rollup is already ahead of the newest measurement", async () => {
    const rollupAt = new Date("2026-05-10T12:00:00.000Z");
    const measurementAt = new Date("2026-05-10T11:00:00.000Z");
    findFirst.mockResolvedValueOnce({ computedAt: rollupAt });
    findFirstMeasurement.mockResolvedValueOnce({
      updatedAt: measurementAt,
      measuredAt: measurementAt,
    });
    const result = await ensureUserRollupsFresh("user-1");
    expect(result.recomputed).toBe(false);
    expect(queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("triggers a DAY-window recompute when stale", async () => {
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const measurementAt = new Date("2026-05-10T12:00:00.000Z");
    findFirst.mockResolvedValueOnce({ computedAt: rollupAt });
    findFirstMeasurement.mockResolvedValueOnce({
      updatedAt: measurementAt,
      measuredAt: measurementAt,
    });
    queryRawUnsafe.mockResolvedValueOnce([]);
    const result = await ensureUserRollupsFresh("user-1");
    expect(result.recomputed).toBe(true);
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
  });

  it("swallows populator errors so the read path never fails", async () => {
    findFirst.mockRejectedValueOnce(new Error("pool exhausted"));
    findFirstMeasurement.mockRejectedValueOnce(new Error("pool exhausted"));
    const result = await ensureUserRollupsFresh("user-1");
    expect(result.recomputed).toBe(false);
  });
});

describe("enqueueBootTimeRollupBackfill", () => {
  it("is a silent no-op when no boss is attached", async () => {
    getGlobalBossMock.mockReturnValue(null);
    const result = await enqueueBootTimeRollupBackfill();
    expect(result).toEqual({ enqueued: 0, skipped: 0, error: null });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("enqueues one full-fold job per user who has measurements but no rollups", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([
      { id: "user-a" },
      { id: "user-b" },
      { id: "user-c" },
    ]);
    bossSend
      .mockResolvedValueOnce("job-a")
      .mockResolvedValueOnce("job-b")
      .mockResolvedValueOnce("job-c");

    const result = await enqueueBootTimeRollupBackfill();

    expect(result).toEqual({ enqueued: 3, skipped: 0, error: null });
    expect(bossSend).toHaveBeenCalledTimes(3);
    // The queue name is the boot-fold queue, not the per-bucket queue.
    for (const call of bossSend.mock.calls) {
      expect(call[0]).toBe(ROLLUP_FULL_BACKFILL_QUEUE);
    }
    // Singleton key per user — coalesces across rapid reboots.
    expect(bossSend.mock.calls[0][2].singletonKey).toBe("boot-backfill|user-a");
    expect(bossSend.mock.calls[1][2].singletonKey).toBe("boot-backfill|user-b");
    expect(bossSend.mock.calls[2][2].singletonKey).toBe("boot-backfill|user-c");
  });

  it("counts a `boss.send` returning null as 'skipped' (singleton coalesce)", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([{ id: "user-a" }, { id: "user-b" }]);
    bossSend.mockResolvedValueOnce(null).mockResolvedValueOnce("job-b");

    const result = await enqueueBootTimeRollupBackfill();

    expect(result).toEqual({ enqueued: 1, skipped: 1, error: null });
  });

  it("returns the error message when the discovery query throws", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockRejectedValueOnce(new Error("pool exhausted"));

    const result = await enqueueBootTimeRollupBackfill();

    expect(result.enqueued).toBe(0);
    expect(result.error).toBe("pool exhausted");
    expect(bossSend).not.toHaveBeenCalled();
  });

  it("returns { enqueued: 0 } when no users need backfill", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([]);

    const result = await enqueueBootTimeRollupBackfill();

    expect(result).toEqual({ enqueued: 0, skipped: 0, error: null });
    expect(bossSend).not.toHaveBeenCalled();
  });
});
