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
  createMany: vi.fn(),
  deleteMany: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  findFirstMeasurement: vi.fn(),
  txExecuteRawUnsafe: vi.fn(),
  txExecuteRaw: vi.fn(),
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
      createMany: mocks.createMany,
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

// v1.4.36 — `ensureUserRollupsFresh` now annotates + console-
// errors on populator failures so silent regressions show up in ops.
// Mock the annotate boundary so the test can assert the meta payload.
vi.mock("@/lib/logging/context", () => ({
  annotate: vi.fn(),
}));

import { annotate } from "@/lib/logging/context";

const {
  queryRaw,
  queryRawUnsafe,
  transaction,
  upsert,
  createMany,
  deleteMany,
  findFirst,
  findFirstMeasurement,
  txExecuteRawUnsafe,
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
  enqueueBootTimeRollupBackfill,
} from "../full-backfill";
import {
  ROLLUP_RECOMPUTE_QUEUE,
  _resetEnsureUserRollupsFreshInFlightForTests,
  collapseToTypeDayKeys,
  enqueueRollupRecompute,
  ensureUserRollupsFresh,
  recomputeBucketsForMeasurement,
  recomputeUserRollups,
} from "../measurement-rollups";

beforeEach(() => {
  queryRaw.mockReset();
  queryRawUnsafe.mockReset();
  transaction.mockReset();
  upsert.mockReset();
  createMany.mockReset();
  deleteMany.mockReset();
  findFirst.mockReset();
  mocks.findMany.mockReset();
  findFirstMeasurement.mockReset();
  txExecuteRawUnsafe.mockReset();
  bossSend.mockReset();
  getGlobalBossMock.mockReset();
  // v1.4.38 — clear the per-userId in-flight map so a previous test's
  // resolved promise does not short-circuit the next test's recompute
  // assertion.
  _resetEnsureUserRollupsFreshInFlightForTests();
  // Default: $transaction invokes the interactive callback with a tx
  // proxy wired to the same delegate mocks so the assertions can
  // observe the in-transaction calls; the batched array form (legacy —
  // no persist path uses it any more) resolves the pre-built promises
  // like the real client.
  transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => Promise<unknown>)({
        measurementRollup: {
          deleteMany: mocks.deleteMany,
          createMany: mocks.createMany,
        },
        $executeRawUnsafe: mocks.txExecuteRawUnsafe,
        $executeRaw: mocks.txExecuteRaw,
        $queryRaw: mocks.queryRaw,
      });
    }
    return Promise.all(arg as unknown[]);
  });
  // v1.28.33 — persistRollupRows writes via a raw ON CONFLICT upsert;
  // default one affected row per chunk call.
  txExecuteRawUnsafe.mockResolvedValue(1);
  createMany.mockResolvedValue({ count: 1 });
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
  it("writes the DAY rollup synchronously and enqueues WEEK/MONTH/YEAR", async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      {
        type: "WEIGHT",
        source: "MANUAL",
        bucket_start: new Date("2026-05-10T00:00:00.000Z"),
        count: BigInt(3),
        mean: 82.5,
        min_value: 80.0,
        max_value: 85.0,
        // v1.4.39 — writer always populates `sum_value` (AVG
        // and SUM compose in the same $queryRaw aggregate). 3 * 82.5
        // = 247.5 so the round-trips line up with `mean * count`.
        sum_value: 247.5,
        sd: 2.0,
        slope: -0.1,
        r2: 0.9,
        reading_min_value: 80.5,
        reading_max_value: 84.5,
      },
    ]);
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValue("job-id");

    await recomputeBucketsForMeasurement(
      "user-1",
      "WEIGHT",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    // DAY pass — v1.11.1 delete-then-upsert the day partition in one tx.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where.userId).toBe("user-1");
    expect(deleteMany.mock.calls[0][0].where.granularity).toBe("DAY");
    expect(deleteMany.mock.calls[0][0].where.type.in).toContain("WEIGHT");
    // v1.28.33 (issue #486) — the insert leg is a raw ON CONFLICT DO
    // UPDATE upsert so a concurrent same-partition writer overwrites
    // instead of raising (or being dropped). Param layout per row:
    // [userId, type, granularity, bucketStart, source, count, mean,
    //  min, max, sum, sd, slope, r2, sumX, sumXy, sumXx, sumYy,
    //  readingMin, readingMax, computedAt].
    expect(txExecuteRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, ...params] = txExecuteRawUnsafe.mock.calls[0];
    expect(sql).toContain(
      "ON CONFLICT (user_id, type, granularity, bucket_start, source)",
    );
    expect(sql).toContain("DO UPDATE SET");
    expect(params).toHaveLength(20);
    expect(params[0]).toBe("user-1");
    expect(params[1]).toBe("WEIGHT");
    expect(params[2]).toBe("DAY");
    expect(params[4]).toBe("MANUAL");
    expect(params[5]).toBe(3);
    expect(params[6]).toBe(82.5);
    // v1.4.39 — sumValue flows through. Cumulative read paths
    // (steps, flights, distance, daylight, active-energy) consume it.
    expect(params[9]).toBe(247.5);
    // The reading extremes, beside the range-widened min / max.
    expect(params[7]).toBe(80.0);
    expect(params[17]).toBe(80.5);
    expect(params[18]).toBe(84.5);

    // WEEK / MONTH / YEAR — three enqueues against the worker queue.
    expect(bossSend).toHaveBeenCalledTimes(3);
    for (const call of bossSend.mock.calls) {
      expect(call[0]).toBe(ROLLUP_RECOMPUTE_QUEUE);
      expect(call[1].userId).toBe("user-1");
      expect(call[1].type).toBe("WEIGHT");
      expect(["WEEK", "MONTH", "YEAR"]).toContain(call[1].granularity);
    }
  });

  it("upserts every stat column so a racing recompute overwrites last-write-wins", async () => {
    // v1.28.33 (issue #486) — two writes on the same (user, type, day)
    // can interleave the delete-then-insert (no pg-boss singleton on
    // the sync DAY hook). The pre-fix shape swallowed the loser's
    // P2002 and DROPPED its freshly computed aggregate — leaving the
    // bucket stale whenever the loser had seen newer measurements than
    // the winner. The upsert must instead carry EVERY stat column in
    // its DO UPDATE clause so the later recompute lands its values.
    queryRawUnsafe.mockResolvedValueOnce([
      {
        type: "WEIGHT",
        source: "MANUAL",
        bucket_start: new Date("2026-05-10T00:00:00.000Z"),
        count: BigInt(1),
        mean: 80.0,
        min_value: 80.0,
        max_value: 80.0,
        sum_value: 80.0,
        sd: 0,
        slope: 0,
        r2: 0,
      },
    ]);
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    bossSend.mockResolvedValue("job-id");

    await recomputeBucketsForMeasurement(
      "user-1",
      "WEIGHT",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    const [sql] = txExecuteRawUnsafe.mock.calls[0];
    for (const column of [
      "count",
      "mean",
      "min_value",
      "max_value",
      "sum_value",
      "sd",
      "slope",
      "r2",
      "sum_x",
      "sum_xy",
      "sum_xx",
      "sum_yy",
      "computed_at",
    ]) {
      expect(sql).toMatch(new RegExp(`${column}\\s*= EXCLUDED.${column}`));
    }
  });

  it("rethrows a transaction error", async () => {
    queryRawUnsafe.mockResolvedValueOnce([
      {
        type: "WEIGHT",
        source: "MANUAL",
        bucket_start: new Date("2026-05-10T00:00:00.000Z"),
        count: BigInt(1),
        mean: 80.0,
        min_value: 80.0,
        max_value: 80.0,
        sum_value: 80.0,
        sd: 0,
        slope: 0,
        r2: 0,
      },
    ]);
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    transaction.mockRejectedValueOnce({ code: "P2010" });

    await expect(
      recomputeBucketsForMeasurement(
        "user-1",
        "WEIGHT",
        new Date("2026-05-10T14:30:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "P2010" });
  });

  it("writes sum_value for cumulative ACTIVITY_STEPS buckets", async () => {
    // 5 step samples in a day summing to 12480: emulates an iOS
    // batch of HealthKit slices reaching the rollup aggregator.
    queryRawUnsafe.mockResolvedValueOnce([
      {
        type: "ACTIVITY_STEPS",
        source: "APPLE_HEALTH",
        bucket_start: new Date("2026-05-10T00:00:00.000Z"),
        count: BigInt(5),
        mean: 2496,
        min_value: 100,
        max_value: 9000,
        // 100 + 2500 + 9000 + 500 + 380 = 12480
        sum_value: 12480,
        sd: 3200,
        slope: null,
        r2: null,
      },
    ]);
    getGlobalBossMock.mockReturnValue(null);

    await recomputeBucketsForMeasurement(
      "user-7",
      "ACTIVITY_STEPS",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    expect(txExecuteRawUnsafe).toHaveBeenCalledTimes(1);
    const [, ...params] = txExecuteRawUnsafe.mock.calls[0];
    expect(params[9]).toBe(12480);
    // mean × count algebraic equivalence — the writer carries SUM
    // directly because the aggregator computed it once. Asserting
    // both gives parity coverage for the consumer-side fallback.
    expect((params[6] as number) * (params[5] as number)).toBe(12480);
  });

  it("passes through null sum_value when the aggregator returns NULL", async () => {
    // Defensive: an empty WHERE-clause window would NEVER return a
    // row here (the route filters by day boundaries), but a future
    // aggregator change that adds a HAVING clause should still
    // surface NULL cleanly rather than coercing to 0.
    queryRawUnsafe.mockResolvedValueOnce([
      {
        type: "WEIGHT",
        source: "MANUAL",
        bucket_start: new Date("2026-05-10T00:00:00.000Z"),
        count: BigInt(1),
        mean: 82.5,
        min_value: 82.5,
        max_value: 82.5,
        sum_value: null,
        sd: null,
        slope: null,
        r2: null,
      },
    ]);
    getGlobalBossMock.mockReturnValue(null);

    await recomputeBucketsForMeasurement(
      "user-1",
      "WEIGHT",
      new Date("2026-05-10T14:30:00.000Z"),
    );

    const [, ...params] = txExecuteRawUnsafe.mock.calls[0];
    expect(params[9]).toBeNull();
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
    expect(txExecuteRawUnsafe).not.toHaveBeenCalled();
  });
});

describe("persistRollupRows — large path (via recomputeUserRollups)", () => {
  /** One synthetic aggregate row per call — distinct bucket per index. */
  function syntheticRows(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      type: "WEIGHT",
      source: "MANUAL",
      bucket_start: new Date(Date.UTC(2024, 0, 1 + (i % 1800))),
      count: BigInt(1),
      mean: 80,
      min_value: 80,
      max_value: 80,
      sum_value: 80,
      sd: 0,
      slope: 0,
      r2: 0,
    }));
  }

  it("wraps the delete + every upsert chunk in ONE interactive transaction", async () => {
    // 1200 rows → 3 upsert chunks (500/500/200).
    queryRawUnsafe.mockResolvedValueOnce(syntheticRows(1200));
    txExecuteRawUnsafe
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(500)
      .mockResolvedValueOnce(200);

    const result = await recomputeUserRollups("user-1", {
      granularities: ["DAY"],
    });

    // ONE interactive transaction — the callback form, not the batched
    // array. The committed-delete-without-inserts window of the
    // pre-v1.16.10 shape (delete commits, a concurrent write-hook
    // unique violation aborts the chunk loop, the types lose ALL
    // buckets) cannot exist when both legs share the transaction.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(typeof transaction.mock.calls[0][0]).toBe("function");
    // A generous interactive timeout — the chunk loop on a multi-year
    // fold outlives Prisma's 5 s default.
    expect(transaction.mock.calls[0][1]).toMatchObject({
      timeout: 120_000,
    });

    // Delete fired once over the full (types × bucket-range) partition.
    expect(deleteMany).toHaveBeenCalledTimes(1);
    expect(deleteMany.mock.calls[0][0].where.userId).toBe("user-1");
    expect(deleteMany.mock.calls[0][0].where.granularity).toBe("DAY");

    // 3 chunks of 20 params per row, every one an ON CONFLICT DO UPDATE
    // upsert — tolerant of a mid-transaction hook insert AND of a
    // concurrent fold on the same partition (v1.28.33, issue #486).
    expect(txExecuteRawUnsafe).toHaveBeenCalledTimes(3);
    expect(txExecuteRawUnsafe.mock.calls[0]).toHaveLength(1 + 500 * 20);
    expect(txExecuteRawUnsafe.mock.calls[1]).toHaveLength(1 + 500 * 20);
    expect(txExecuteRawUnsafe.mock.calls[2]).toHaveLength(1 + 200 * 20);
    for (const call of txExecuteRawUnsafe.mock.calls) {
      expect(call[0]).toContain("ON CONFLICT");
      expect(call[0]).toContain("DO UPDATE SET");
    }

    expect(result.rowsUpserted).toBe(1200);
  });

  it("a failing chunk rejects through the transaction so the delete rolls back with it", async () => {
    queryRawUnsafe.mockResolvedValueOnce(syntheticRows(700));
    txExecuteRawUnsafe
      .mockResolvedValueOnce(500)
      .mockRejectedValueOnce(new Error("connection reset"));

    // The error must bubble (pg-boss retries the fold); the structural
    // guarantee is that the delete ran INSIDE the same transaction, so
    // the real client rolls it back — no standalone committed delete.
    await expect(
      recomputeUserRollups("user-1", { granularities: ["DAY"] }),
    ).rejects.toThrow("connection reset");
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(typeof transaction.mock.calls[0][0]).toBe("function");
    // The delete was only ever issued through the transaction client —
    // it cannot have committed ahead of the failed chunk.
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  /**
   * The aggregate filters measurements by `measured_at` but GROUPS them by
   * `date_trunc`, and `persistRollupRows` then deletes every rollup row in
   * the bucket range it writes. A `from` that lands mid-bucket therefore
   * replaced a COMPLETE bucket with an aggregate built only from the
   * readings after that instant — and because every caller passes a moving
   * instant, a different oldest bucket was corrupted on each run and nothing
   * repaired it. The window must be snapped out to whole buckets first.
   */
  it("stops between granularities once the job's budget is spent", async () => {
    queryRawUnsafe.mockResolvedValue([]);
    let asked = 0;
    const result = await recomputeUserRollups("user-1", {
      // The budget runs out after the first granularity was folded.
      shouldStop: () => ++asked > 1,
    });
    expect(result.stopped).toBe(true);
    // The first granularity's aggregate, then nothing more.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    queryRawUnsafe.mockReset();
  });

  describe("bucket alignment of the recompute window", () => {
    it("snaps a mid-day `from` down to the start of its DAY bucket", async () => {
      queryRawUnsafe.mockResolvedValueOnce(syntheticRows(1));
      txExecuteRawUnsafe.mockResolvedValueOnce(1);

      // 14:37:12Z on 2024-03-10 — squarely inside a day bucket.
      const midDay = new Date(Date.UTC(2024, 2, 10, 14, 37, 12, 500));
      await recomputeUserRollups("user-1", {
        granularities: ["DAY"],
        from: midDay,
        to: new Date(Date.UTC(2024, 2, 20, 9, 5, 0)),
      });

      // runRollupAggregate → $queryRawUnsafe(sql, userId, from, to)
      const [, userId, fromArg, toArg] = queryRawUnsafe.mock.calls[0];
      expect(userId).toBe("user-1");
      // Whole-bucket lower edge — the morning of the 10th must be included.
      expect((fromArg as Date).toISOString()).toBe("2024-03-10T00:00:00.000Z");
      // Upper edge snaps out to the end of the closing bucket.
      expect((toArg as Date).toISOString()).toBe("2024-03-21T00:00:00.000Z");
    });

    it("snaps a mid-month `from` back to the 1st for MONTH granularity", async () => {
      queryRawUnsafe.mockResolvedValueOnce(syntheticRows(1));
      txExecuteRawUnsafe.mockResolvedValueOnce(1);

      await recomputeUserRollups("user-1", {
        granularities: ["MONTH"],
        from: new Date(Date.UTC(2024, 4, 17, 8, 0, 0)),
        to: new Date(Date.UTC(2024, 6, 3, 0, 0, 0)),
      });

      const [, , fromArg, toArg] = queryRawUnsafe.mock.calls[0];
      expect((fromArg as Date).toISOString()).toBe("2024-05-01T00:00:00.000Z");
      expect((toArg as Date).toISOString()).toBe("2024-08-01T00:00:00.000Z");
    });

    it("leaves an already-aligned window untouched", async () => {
      queryRawUnsafe.mockResolvedValueOnce(syntheticRows(1));
      txExecuteRawUnsafe.mockResolvedValueOnce(1);

      const from = new Date(Date.UTC(2024, 2, 10));
      const to = new Date(Date.UTC(2024, 2, 20));
      await recomputeUserRollups("user-1", {
        granularities: ["DAY"],
        from,
        to,
      });

      const [, , fromArg, toArg] = queryRawUnsafe.mock.calls[0];
      expect((fromArg as Date).getTime()).toBe(from.getTime());
      expect((toArg as Date).getTime()).toBe(to.getTime());
    });
  });

  it("the ≤500-row path runs through the same interactive upsert transaction", async () => {
    queryRawUnsafe.mockResolvedValueOnce(syntheticRows(2));
    txExecuteRawUnsafe.mockResolvedValueOnce(2);

    const result = await recomputeUserRollups("user-1", {
      granularities: ["DAY"],
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(typeof transaction.mock.calls[0][0]).toBe("function");
    expect(txExecuteRawUnsafe).toHaveBeenCalledTimes(1);
    expect(txExecuteRawUnsafe.mock.calls[0]).toHaveLength(1 + 2 * 20);
    expect(result.rowsUpserted).toBe(2);
  });
});

/**
 * A recompute REPLACES every bucket in the window it was asked for.
 *
 * Scoping the delete to the [min, max] range of the rows the aggregate
 * RETURNED made the repair self-limiting in exactly the case that needs it: a
 * bucket whose source rows all disappeared is not in the returned range, so it
 * survived with its stale aggregate while `probeRollupCoverage` still reported
 * `hasBuckets = true` and the read-swap served it instead of falling back to
 * live SQL. The write hook masked this for DAY (it deletes its own bucket by
 * hand when the day empties) but nothing covered the WEEK / MONTH / YEAR
 * worker, which recomputes one bucket span at a time.
 */
describe("recomputeUserRollups — prunes the whole recomputed window", () => {
  function rowsInBucket(bucketStart: Date, type = "WEIGHT") {
    return [
      {
        type,
        source: "MANUAL",
        bucket_start: bucketStart,
        count: BigInt(1),
        mean: 80,
        min_value: 80,
        max_value: 80,
        sum_value: 80,
        sd: 0,
        slope: 0,
        r2: 0,
      },
    ];
  }

  it("deletes the stale bucket when the window's last reading is gone", async () => {
    // The exact damage: the user deleted their last WEIGHT reading of the
    // week, so the WEEK aggregate for that span now returns nothing.
    queryRawUnsafe.mockResolvedValueOnce([]);

    await recomputeUserRollups("user-1", {
      granularities: ["WEEK"],
      types: ["WEIGHT"],
      from: new Date(Date.UTC(2024, 2, 4)),
      to: new Date(Date.UTC(2024, 2, 11)),
    });

    expect(deleteMany).toHaveBeenCalledTimes(1);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      userId: "user-1",
      granularity: "WEEK",
      type: { in: ["WEIGHT"] },
    });
    expect(where.bucketStart.gte.toISOString()).toBe(
      "2024-03-04T00:00:00.000Z",
    );
    expect(where.bucketStart.lt.toISOString()).toBe("2024-03-11T00:00:00.000Z");
    // Nothing to write — the window is authoritatively empty.
    expect(txExecuteRawUnsafe).not.toHaveBeenCalled();
  });

  it("covers the requested window, not just the range the aggregate returned", async () => {
    // Readings survive only in the middle of the window; the buckets at both
    // edges lost theirs. The delete must still reach the edges.
    queryRawUnsafe.mockResolvedValueOnce(
      rowsInBucket(new Date(Date.UTC(2024, 2, 10))),
    );
    txExecuteRawUnsafe.mockResolvedValueOnce(1);

    await recomputeUserRollups("user-1", {
      granularities: ["DAY"],
      from: new Date(Date.UTC(2024, 2, 1)),
      to: new Date(Date.UTC(2024, 2, 20)),
    });

    const where = deleteMany.mock.calls[0][0].where;
    expect(where.bucketStart.gte.toISOString()).toBe(
      "2024-03-01T00:00:00.000Z",
    );
    expect(where.bucketStart.lt.toISOString()).toBe("2024-03-20T00:00:00.000Z");
  });

  it("prunes every type when the recompute was not type-scoped", async () => {
    // A type that lost all its readings drops out of the returned rows
    // entirely, so a `type: { in: <returned types> }` filter could never
    // reach its buckets.
    queryRawUnsafe.mockResolvedValueOnce(
      rowsInBucket(new Date(Date.UTC(2024, 2, 10))),
    );
    txExecuteRawUnsafe.mockResolvedValueOnce(1);

    await recomputeUserRollups("user-1", {
      granularities: ["DAY"],
      from: new Date(Date.UTC(2024, 2, 1)),
      to: new Date(Date.UTC(2024, 2, 20)),
    });

    const where = deleteMany.mock.calls[0][0].where;
    expect(where.type).toBeUndefined();
  });

  it("still writes the fresh rows it did compute", async () => {
    queryRawUnsafe.mockResolvedValueOnce(
      rowsInBucket(new Date(Date.UTC(2024, 2, 10))),
    );
    txExecuteRawUnsafe.mockResolvedValueOnce(1);

    const result = await recomputeUserRollups("user-1", {
      granularities: ["DAY"],
      from: new Date(Date.UTC(2024, 2, 1)),
      to: new Date(Date.UTC(2024, 2, 20)),
    });

    // Delete and upsert share the one interactive transaction, so a reader
    // never observes the pruned window without its replacement rows.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(txExecuteRawUnsafe).toHaveBeenCalledTimes(1);
    expect(result.rowsUpserted).toBe(1);
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
    expect(opts.singletonKey).toBe(`user-9|PULSE|WEEK|${from.toISOString()}`);
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

  // Watched red: restoring `deletedAt: null` to the probe's `where`
  // makes the exact-match assertion below fail — that filter was the
  // bug (a soft-delete bumps `updatedAt` on the tombstone, and hiding
  // tombstones from the probe left ghost aggregates reading as fresh).
  it("keeps tombstones visible to the freshness probe", async () => {
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const deletionAt = new Date("2026-05-10T12:00:00.000Z");
    findFirst.mockResolvedValueOnce({ computedAt: rollupAt });
    // Newest row is a tombstone whose soft-delete bumped `updatedAt`
    // past the rollup watermark — the probe must see it as staleness.
    findFirstMeasurement.mockResolvedValueOnce({
      updatedAt: deletionAt,
      measuredAt: new Date("2026-05-01T08:00:00.000Z"),
    });
    queryRawUnsafe.mockResolvedValueOnce([]);
    const result = await ensureUserRollupsFresh("user-1");
    expect(result.recomputed).toBe(true);
    // Exact `where` match: the probe scopes by user only — no
    // `deletedAt` filter that would blind it to deletions.
    expect(findFirstMeasurement).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });

  it("swallows populator errors so the read path never fails", async () => {
    findFirst.mockRejectedValueOnce(new Error("pool exhausted"));
    findFirstMeasurement.mockRejectedValueOnce(new Error("pool exhausted"));
    const result = await ensureUserRollupsFresh("user-1");
    expect(result.recomputed).toBe(false);
  });

  // v1.4.38 — concurrent callers for the same userId share one
  // in-flight promise so a cold fan-out can never queue N parallel
  // recompute runs against the same 90-day window.
  it("dedups concurrent callers for the same userId onto one in-flight promise", async () => {
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const measurementAt = new Date("2026-05-10T12:00:00.000Z");
    // Both round-trips inside the helper run twice (the helper issues
    // a parallel `Promise.all` for the rollup-most-recent + measurement
    // -most-recent). With dedup, those should fire ONCE across two
    // concurrent callers.
    findFirst.mockResolvedValue({ computedAt: rollupAt });
    findFirstMeasurement.mockResolvedValue({
      updatedAt: measurementAt,
      measuredAt: measurementAt,
    });
    queryRawUnsafe.mockResolvedValue([]);

    const [a, b, c] = await Promise.all([
      ensureUserRollupsFresh("user-1"),
      ensureUserRollupsFresh("user-1"),
      ensureUserRollupsFresh("user-1"),
    ]);
    expect(a.recomputed).toBe(true);
    expect(b.recomputed).toBe(true);
    expect(c.recomputed).toBe(true);
    // The Postgres-side recompute fires exactly once across the three
    // concurrent callers — proof the dedup map collapsed the fan-out.
    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    // The findFirst probe fires exactly once per call type (rollup,
    // measurement) across all three concurrent callers.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(findFirstMeasurement).toHaveBeenCalledTimes(1);
  });

  it("clears the in-flight slot after resolution so the next call runs fresh", async () => {
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const measurementAt = new Date("2026-05-10T12:00:00.000Z");
    findFirst.mockResolvedValue({ computedAt: rollupAt });
    findFirstMeasurement.mockResolvedValue({
      updatedAt: measurementAt,
      measuredAt: measurementAt,
    });
    queryRawUnsafe.mockResolvedValue([]);

    await ensureUserRollupsFresh("user-1");
    await ensureUserRollupsFresh("user-1");
    // Two serial calls => two recompute runs (no dedup short-circuit
    // because the first call already resolved and dropped its slot).
    expect(queryRawUnsafe).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight slot on rejection so the next call retries", async () => {
    findFirst.mockRejectedValueOnce(new Error("pool exhausted"));
    findFirstMeasurement.mockRejectedValueOnce(new Error("pool exhausted"));
    const first = await ensureUserRollupsFresh("user-1");
    expect(first.recomputed).toBe(false);

    // Second call: probe succeeds, stale watermark triggers a recompute.
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const measurementAt = new Date("2026-05-10T12:00:00.000Z");
    findFirst.mockResolvedValueOnce({ computedAt: rollupAt });
    findFirstMeasurement.mockResolvedValueOnce({
      updatedAt: measurementAt,
      measuredAt: measurementAt,
    });
    queryRawUnsafe.mockResolvedValueOnce([]);
    const second = await ensureUserRollupsFresh("user-1");
    expect(second.recomputed).toBe(true);
  });

  it("annotates the failure when the inner recompute throws (H3)", async () => {
    // Stale watermark — rollup older than the newest measurement so
    // the inner recompute branch fires.
    const rollupAt = new Date("2026-05-10T10:00:00.000Z");
    const measurementAt = new Date("2026-05-10T12:00:00.000Z");
    findFirst.mockResolvedValueOnce({ computedAt: rollupAt });
    findFirstMeasurement.mockResolvedValueOnce({
      updatedAt: measurementAt,
      measuredAt: measurementAt,
    });
    // The recompute aggregate query throws — simulates a populator
    // regression (pool exhausted, deadlock, etc).
    queryRawUnsafe.mockRejectedValueOnce(new Error("deadlock detected"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await ensureUserRollupsFresh("user-1");

    // The read path still gets a clean `{ recomputed: false }`.
    expect(result.recomputed).toBe(false);
    // The annotate event fires with the documented shape so ops can
    // spot the silent populator regression in the wide-event pipeline.
    expect(annotate).toHaveBeenCalledWith({
      meta: {
        rollup_refresh_failed: true,
        rollup_refresh_error: "deadlock detected",
      },
    });
    // And the console.error fallback fires so the worker log path
    // surfaces the failure even when there's no request context.
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
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

  // v1.4.39.1 — the discovery anchor moved from per-type to per-day so
  // accounts whose Withings sync / `/api/import` / admin restore wrote
  // measurements without firing the rollup write hook get re-enqueued
  // on the next worker boot. Pre-fix, the per-type LEFT JOIN matched
  // on `(user, type)` and the user dropped off the discovery list as
  // soon as ONE rollup row existed for the type — even if 27 OTHER
  // days for that type were missing rollup rows.
  it("anchors the missing-coverage join on (user, type, bucket_start) so per-day gaps surface", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([{ id: "withings-stranded-user" }]);
    bossSend.mockResolvedValueOnce("job-id");

    await enqueueBootTimeRollupBackfill();

    const sqlParts = queryRaw.mock.calls[0][0] as TemplateStringsArray;
    const sqlText = Array.isArray(sqlParts) ? sqlParts.join("?") : "";
    // The day walk steps from each day's first reading to the next UTC day.
    expect(sqlText).toContain("date_trunc('day', d.at) + interval '1 day'");
    // The coverage check compares the walked day with the DAY bucket.
    expect(sqlText).toContain(`r."bucket_start" = date_trunc('day', d.at)`);
  });

  // v1.16.10 — discovery and fold share one trailing window. Unbounded
  // discovery re-flagged accounts whose oldest measurement pre-dated
  // the 5-year fold bound on EVERY worker boot: the fold can never
  // write buckets for those days, so the per-day gap never closed and
  // the full backfill re-ran forever.
  it("bounds discovery to the fold window so pre-window history cannot re-flag accounts", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([]);
    const before = Date.now();

    await enqueueBootTimeRollupBackfill();

    const after = Date.now();
    const sqlParts = queryRaw.mock.calls[0][0] as TemplateStringsArray;
    const sqlText = Array.isArray(sqlParts) ? sqlParts.join("?") : "";
    // The day walk starts at measured_at >= <fold window start>.
    expect(sqlText).toContain('m."measured_at" >=');
    // The bound parameter is now − ROLLUP_FOLD_WINDOW_MS (5 years),
    // matching the `recomputeUserRollups` default the backfill worker
    // runs with.
    const boundArg = queryRaw.mock.calls[0].find(
      (arg: unknown) => arg instanceof Date,
    ) as Date;
    expect(boundArg).toBeInstanceOf(Date);
    const fiveYearsMs = 5 * 365 * 24 * 60 * 60 * 1000;
    expect(boundArg.getTime()).toBeGreaterThanOrEqual(before - fiveYearsMs);
    expect(boundArg.getTime()).toBeLessThanOrEqual(after - fiveYearsMs);
  });
});
