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

// v1.4.36 QA H3 — `ensureUserRollupsFresh` now annotates + console-
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
  _resetEnsureUserRollupsFreshInFlightForTests,
  collapseToTypeDayKeys,
  enqueueBootTimeRollupBackfill,
  enqueueRollupRecompute,
  ensureUserRollupsFresh,
  recomputeBucketsForMeasurement,
} from "../measurement-rollups";

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
  // v1.4.38 — clear the per-userId in-flight map so a previous test's
  // resolved promise does not short-circuit the next test's recompute
  // assertion.
  _resetEnsureUserRollupsFreshInFlightForTests();
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
        // v1.4.39 W-SUM — writer always populates `sum_value` (AVG
        // and SUM compose in the same $queryRaw aggregate). 3 * 82.5
        // = 247.5 so the round-trips line up with `mean * count`.
        sum_value: 247.5,
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
    // v1.4.39 W-SUM — sumValue flows through on both create + update
    // halves of the upsert. Cumulative read paths (steps, flights,
    // distance, daylight, active-energy) consume this directly.
    expect(upsertArg.create.sumValue).toBe(247.5);
    expect(upsertArg.update.sumValue).toBe(247.5);

    // WEEK / MONTH / YEAR — three enqueues against the worker queue.
    expect(bossSend).toHaveBeenCalledTimes(3);
    for (const call of bossSend.mock.calls) {
      expect(call[0]).toBe(ROLLUP_RECOMPUTE_QUEUE);
      expect(call[1].userId).toBe("user-1");
      expect(call[1].type).toBe("WEIGHT");
      expect(["WEEK", "MONTH", "YEAR"]).toContain(call[1].granularity);
    }
  });

  it("writes sum_value for cumulative ACTIVITY_STEPS buckets", async () => {
    // 5 step samples in a day summing to 12480: emulates an iOS
    // batch of HealthKit slices reaching the rollup aggregator.
    queryRawUnsafe.mockResolvedValueOnce([
      {
        type: "ACTIVITY_STEPS",
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

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0][0];
    expect(arg.create.sumValue).toBe(12480);
    // mean × count algebraic equivalence — the writer carries SUM
    // directly because the aggregator computed it once. Asserting
    // both gives parity coverage for the consumer-side fallback.
    expect(arg.create.mean * arg.create.count).toBe(12480);
  });

  it("passes through null sum_value when the aggregator returns NULL", async () => {
    // Defensive: an empty WHERE-clause window would NEVER return a
    // row here (the route filters by day boundaries), but a future
    // aggregator change that adds a HAVING clause should still
    // surface NULL cleanly rather than coercing to 0.
    queryRawUnsafe.mockResolvedValueOnce([
      {
        type: "WEIGHT",
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

    const arg = upsert.mock.calls[0][0];
    expect(arg.create.sumValue).toBeNull();
    expect(arg.update.sumValue).toBeNull();
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

  // v1.4.39 W-SUM — the discovery query now unions in users whose
  // existing DAY rollup rows carry `sum_value IS NULL`. Re-folding
  // converges those rows because `persistRollupRows` always writes the
  // new column on upsert; the union keeps the per-day missing-coverage
  // gap (v1.4.39.1) and the legacy-NULL backfill on the same indexed
  // pass.
  it("includes the sum_value IS NULL branch in the discovery query", async () => {
    getGlobalBossMock.mockReturnValue({ send: bossSend });
    queryRaw.mockResolvedValueOnce([{ id: "user-with-legacy-rollups" }]);
    bossSend.mockResolvedValueOnce("job-id");

    const result = await enqueueBootTimeRollupBackfill();

    expect(result).toEqual({ enqueued: 1, skipped: 0, error: null });
    // The discovery SQL surfaces both per-day missing coverage AND
    // legacy NULL sum_value rows under one UNION. The text-anchor is
    // the only durable assertion at the unit level — the integration
    // suite covers the planner shape on real Postgres.
    const sqlParts = queryRaw.mock.calls[0][0] as TemplateStringsArray;
    const sqlText = Array.isArray(sqlParts) ? sqlParts.join("?") : "";
    expect(sqlText).toContain("sum_value");
    expect(sqlText).toContain("UNION");
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
    // Inner DISTINCT widens to `(user_id, type, bucket_start)`.
    expect(sqlText).toContain('date_trunc(\'day\', m."measured_at")');
    // LEFT JOIN now compares bucket_start on both sides.
    expect(sqlText).toContain('r."bucket_start" = mt."bucket_start"');
  });
});
