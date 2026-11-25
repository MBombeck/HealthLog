/**
 * The statements the rollup populator sends, and the keyed DAY refold.
 *
 * `measurement-rollups.test.ts` pins the write paths end to end against a
 * mocked client; this file pins what those paths say to Postgres: which
 * window an aggregate covers, which types and days it filters on, which
 * buckets a refold deletes and rewrites, the order rows are written in, the
 * placeholder layout of the upsert, and which coarse recomputes a refold
 * enqueues. Real Postgres semantics (the aggregate values themselves) live in
 * `tests/integration/measurement-rollups.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queryRawUnsafe: vi.fn(),
  transaction: vi.fn(),
  deleteMany: vi.fn(),
  rollupFindFirst: vi.fn(),
  measurementFindFirst: vi.fn(),
  txExecuteRawUnsafe: vi.fn(),
  txExecuteRaw: vi.fn(),
  bossSend: vi.fn(),
  getGlobalBoss: vi.fn(),
  readCanonical: vi.fn(),
  annotate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $queryRawUnsafe: mocks.queryRawUnsafe,
    $transaction: mocks.transaction,
    measurementRollup: {
      deleteMany: mocks.deleteMany,
      findFirst: mocks.rollupFindFirst,
    },
    measurement: { findFirst: mocks.measurementFindFirst },
  },
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => mocks.getGlobalBoss(),
}));

vi.mock("@/lib/logging/context", () => ({ annotate: mocks.annotate }));

vi.mock("@/lib/rollups/measurement-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rollups/measurement-read")>()),
  readCanonicalRollupBuckets: mocks.readCanonical,
}));

import {
  ROLLUP_FOLD_WINDOW_MS,
  ROLLUP_RECOMPUTE_QUEUE,
  _resetEnsureUserRollupsFreshInFlightForTests,
  applyStatementBudget,
  enqueueRollupRecompute,
  ensureUserRollupsFresh,
  readRollupBuckets,
  recomputeBucketsForKeys,
  recomputeBucketsForMeasurement,
  recomputeUserRollups,
} from "../measurement-rollups";

const DAY_MS = 24 * 60 * 60 * 1000;

function iso(s: string): Date {
  return new Date(s);
}

/** One aggregate row as `runRollupAggregate` returns it from Postgres. */
function aggRow(
  type: string,
  source: string,
  bucketStart: string,
  extra: Record<string, unknown> = {},
) {
  return {
    type,
    source,
    bucket_start: iso(bucketStart),
    count: BigInt(2),
    mean: 80,
    min_value: 79,
    max_value: 81,
    sum_value: 160,
    sd: 1,
    slope: 0,
    r2: 0,
    ...extra,
  };
}

/** The `(type, bucket_start, source)` of each upserted row, in write order. */
function upsertedKeys(call: unknown[]): string[] {
  const params = call.slice(1);
  const out: string[] = [];
  for (let i = 0; i < params.length; i += 20) {
    out.push(
      `${params[i + 1]}|${(params[i + 3] as Date).toISOString().slice(0, 10)}|${params[i + 4]}`,
    );
  }
  return out;
}

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  _resetEnsureUserRollupsFreshInFlightForTests();
  mocks.transaction.mockImplementation(async (fn: unknown) =>
    (fn as (tx: unknown) => Promise<unknown>)({
      measurementRollup: { deleteMany: mocks.deleteMany },
      $executeRawUnsafe: mocks.txExecuteRawUnsafe,
      $executeRaw: mocks.txExecuteRaw,
      $queryRawUnsafe: mocks.queryRawUnsafe,
    }),
  );
  mocks.txExecuteRawUnsafe.mockResolvedValue(1);
  mocks.txExecuteRaw.mockResolvedValue(0);
  mocks.queryRawUnsafe.mockResolvedValue([]);
  mocks.getGlobalBoss.mockReturnValue({ send: mocks.bossSend });
  mocks.bossSend.mockResolvedValue("job");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("recomputeBucketsForKeys — keyed DAY refold", () => {
  const touched = [
    // Two readings on one WEIGHT day collapse to one key.
    { type: "WEIGHT" as const, measuredAt: iso("2026-05-05T20:00:00.000Z") },
    { type: "WEIGHT" as const, measuredAt: iso("2026-05-12T07:00:00.000Z") },
    { type: "WEIGHT" as const, measuredAt: iso("2026-05-05T08:00:00.000Z") },
    { type: "BODY_FAT" as const, measuredAt: iso("2026-05-04T09:00:00.000Z") },
  ];

  it("aggregates only the touched types and days, from the first day to the end of the last", async () => {
    await recomputeBucketsForKeys("u1", touched);

    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, userId, from, to, days] = mocks.queryRawUnsafe.mock.calls[0];
    expect(userId).toBe("u1");
    expect((from as Date).toISOString()).toBe("2026-05-04T00:00:00.000Z");
    expect((to as Date).toISOString()).toBe("2026-05-13T00:00:00.000Z");
    // UTC wall-clock literals for a `timestamp[]` parameter, no zone suffix.
    expect(days).toEqual([
      "2026-05-04T00:00:00.000",
      "2026-05-05T00:00:00.000",
      "2026-05-12T00:00:00.000",
    ]);
    expect(sql).toContain(
      `m."type" IN ('BODY_FAT'::"measurement_type",'WEIGHT'::"measurement_type")`,
    );
    expect(sql).toContain(
      `AND date_trunc('day', m."measured_at") = ANY($4::timestamp[])`,
    );
    expect(sql).toContain(
      `GROUP BY m."type", m."source", date_trunc('day', m."measured_at")`,
    );
  });

  it("deletes exactly the touched buckets and rewrites only those, in lock order", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      aggRow("WEIGHT", "WITHINGS", "2026-05-05T00:00:00.000Z"),
      aggRow("WEIGHT", "MANUAL", "2026-05-12T00:00:00.000Z"),
      // The day filter is per day: WEIGHT on BODY_FAT's day comes back too,
      // but that bucket was not touched and must not be rewritten.
      aggRow("WEIGHT", "MANUAL", "2026-05-04T00:00:00.000Z"),
      aggRow("WEIGHT", "MANUAL", "2026-05-05T00:00:00.000Z"),
      aggRow("BODY_FAT", "MANUAL", "2026-05-04T00:00:00.000Z"),
    ]);

    await recomputeBucketsForKeys("u1", touched);

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      maxWait: 10_000,
      timeout: 120_000,
    });
    expect(mocks.txExecuteRawUnsafe).toHaveBeenCalledTimes(2);

    const [deleteSql, ...deleteParams] = mocks.txExecuteRawUnsafe.mock.calls[0];
    expect(deleteSql).toContain("DELETE FROM measurement_rollups");
    expect(deleteSql).toContain(
      `granularity = 'DAY'::"measurement_rollup_granularity"`,
    );
    expect(deleteSql).toContain("unnest($2::text[], $3::timestamp[])");
    expect(deleteParams).toEqual([
      "u1",
      ["BODY_FAT", "WEIGHT", "WEIGHT"],
      [
        "2026-05-04T00:00:00.000",
        "2026-05-05T00:00:00.000",
        "2026-05-12T00:00:00.000",
      ],
    ]);

    const upsert = mocks.txExecuteRawUnsafe.mock.calls[1];
    expect(upsert[0]).toContain("INSERT INTO measurement_rollups");
    expect(upsertedKeys(upsert)).toEqual([
      "BODY_FAT|2026-05-04|MANUAL",
      "WEIGHT|2026-05-05|MANUAL",
      "WEIGHT|2026-05-12|MANUAL",
      "WEIGHT|2026-05-05|WITHINGS",
    ]);
    expect(upsert[3]).toBe("DAY");
  });

  it("still deletes the touched buckets when every touched day emptied out", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([]);
    await recomputeBucketsForKeys("u1", touched);
    expect(mocks.txExecuteRawUnsafe).toHaveBeenCalledTimes(1);
    expect(mocks.txExecuteRawUnsafe.mock.calls[0][0]).toContain("DELETE");
  });

  it("enqueues one coarse recompute per run of adjacent buckets per type", async () => {
    await recomputeBucketsForKeys("u1", touched);

    const sends = mocks.bossSend.mock.calls.map(([queue, p, opts]) => ({
      queue,
      key: `${p.granularity} ${p.type} ${p.from.slice(0, 10)}..${p.to.slice(0, 10)}`,
      singletonKey: opts.singletonKey as string,
    }));
    expect(sends.map((s) => s.key)).toEqual([
      // 2026-05-04 is a Monday: the two WEIGHT weeks touch and merge.
      "WEEK BODY_FAT 2026-05-04..2026-05-11",
      "WEEK WEIGHT 2026-05-04..2026-05-18",
      "MONTH BODY_FAT 2026-05-01..2026-06-01",
      "MONTH WEIGHT 2026-05-01..2026-06-01",
      "YEAR BODY_FAT 2026-01-01..2027-01-01",
      "YEAR WEIGHT 2026-01-01..2027-01-01",
    ]);
    for (const s of sends) expect(s.queue).toBe(ROLLUP_RECOMPUTE_QUEUE);
    // A run covering several buckets carries its end in the singleton key,
    // so it cannot collapse into a queued single-bucket job.
    expect(sends[1].singletonKey).toBe(
      "u1|WEIGHT|WEEK|2026-05-04T00:00:00.000Z|2026-05-18T00:00:00.000Z",
    );
    expect(sends[0].singletonKey).toBe(
      "u1|BODY_FAT|WEEK|2026-05-04T00:00:00.000Z",
    );
  });

  it("keeps non-adjacent buckets of one type as separate runs", async () => {
    await recomputeBucketsForKeys("u1", [
      { type: "WEIGHT", measuredAt: iso("2026-05-19T08:00:00.000Z") },
      { type: "WEIGHT", measuredAt: iso("2026-05-05T08:00:00.000Z") },
    ]);
    const weeks = mocks.bossSend.mock.calls
      .map(([, p]) => p)
      .filter((p) => p.granularity === "WEEK")
      .map((p) => `${p.from.slice(0, 10)}..${p.to.slice(0, 10)}`);
    expect(weeks).toEqual(["2026-05-04..2026-05-11", "2026-05-18..2026-05-25"]);
  });

  it("does nothing for an empty key set", async () => {
    await recomputeBucketsForKeys("u1", []);
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.bossSend).not.toHaveBeenCalled();
  });

  it("refolds in chunks of 500 keys", async () => {
    mocks.getGlobalBoss.mockReturnValue(null);
    const start = Date.UTC(2024, 0, 1);
    const rows = Array.from({ length: 501 }, (_, i) => ({
      type: "WEIGHT" as const,
      measuredAt: new Date(start + i * DAY_MS + 6 * 60 * 60 * 1000),
    }));
    await recomputeBucketsForKeys("u1", rows);

    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(2);
    const [, , from1, to1, days1] = mocks.queryRawUnsafe.mock.calls[0];
    const [, , from2, to2, days2] = mocks.queryRawUnsafe.mock.calls[1];
    expect((days1 as string[]).length).toBe(500);
    expect((days2 as string[]).length).toBe(1);
    expect((from1 as Date).getTime()).toBe(start);
    expect((to1 as Date).getTime()).toBe(start + 500 * DAY_MS);
    expect((from2 as Date).getTime()).toBe(start + 500 * DAY_MS);
    expect((to2 as Date).getTime()).toBe(start + 501 * DAY_MS);
  });
});

describe("runRollupAggregate — the statement it sends", () => {
  const from = iso("2024-03-01T00:00:00.000Z");
  const to = iso("2024-04-01T00:00:00.000Z");

  it("covers every type when the recompute is not type-scoped", async () => {
    await recomputeUserRollups("u1", { granularities: ["MONTH"], from, to });
    const call = mocks.queryRawUnsafe.mock.calls[0];
    const sql = call[0] as string;
    expect(call).toHaveLength(4);
    expect(call.slice(1)).toEqual(["u1", from, to]);
    expect(sql).toContain("FROM measurements m");
    expect(sql).toContain(`m."deleted_at" IS NULL`);
    expect(sql).not.toContain(`m."type" IN`);
    expect(sql).not.toContain("ANY($4");
    expect(sql).toContain(
      `GROUP BY m."type", m."source", date_trunc('month', m."measured_at")`,
    );
    // Regression x is rebased to 2020-01-01 (epoch day 18262).
    expect(sql).toContain(
      `SUM((EXTRACT(EPOCH FROM m."measured_at") / 86400.0 - 18262))::double precision`,
    );
  });

  it("splices a validated type list when the recompute is type-scoped", async () => {
    await recomputeUserRollups("u1", {
      granularities: ["WEEK"],
      types: ["WEIGHT", "VO2_MAX"],
      from,
      to,
    });
    const sql = mocks.queryRawUnsafe.mock.calls[0][0] as string;
    expect(sql).toContain(
      `m."type" IN ('WEIGHT'::"measurement_type",'VO2_MAX'::"measurement_type")`,
    );
    expect(sql).toContain(
      `GROUP BY m."type", m."source", date_trunc('week', m."measured_at")`,
    );
    expect(sql).toContain("- 18262)");
  });

  it.each([
    ["lower case", "weight"],
    ["a quote after a valid prefix", "WEIGHT'); DROP TABLE measurements;--"],
    ["a quote before a valid suffix", "x'WEIGHT"],
    ["an empty string", ""],
  ])("refuses a type that is not an enum literal (%s)", async (_, bad) => {
    await expect(
      recomputeUserRollups("u1", {
        granularities: ["DAY"],
        // Deliberately outside the enum: the guard is what stands between
        // this value and the SQL text.
        types: [bad as "WEIGHT"],
        from,
        to,
      }),
    ).rejects.toThrow("invalid measurement type");
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("runs no aggregate for an empty type list, and prunes nothing beyond it", async () => {
    await recomputeUserRollups("u1", {
      granularities: ["DAY"],
      types: [],
      from,
      to,
    });
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        granularity: "DAY",
        type: { in: [] },
        bucketStart: { gte: from, lt: to },
      },
    });
  });

  it("folds every granularity, finest first, when none is named", async () => {
    await recomputeUserRollups("u1", { from, to });
    const units = mocks.queryRawUnsafe.mock.calls.map(
      ([sql]) => /date_trunc\('(\w+)', m\."measured_at"\)/.exec(sql)?.[1],
    );
    expect(units).toEqual(["day", "week", "month", "year"]);
  });

  it("defaults to the five-year fold window ending now", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(iso("2026-06-15T12:34:00.000Z"));
    const result = await recomputeUserRollups("u1", { granularities: ["DAY"] });
    const [, , fromArg, toArg] = mocks.queryRawUnsafe.mock.calls[0];
    const expectedFrom = new Date(
      iso("2026-06-15T12:34:00.000Z").getTime() - ROLLUP_FOLD_WINDOW_MS,
    );
    expectedFrom.setUTCHours(0, 0, 0, 0);
    expect((fromArg as Date).toISOString()).toBe(expectedFrom.toISOString());
    expect((toArg as Date).toISOString()).toBe("2026-06-16T00:00:00.000Z");
    expect(result.durationMs).toBe(0);
  });

  it("reports an elapsed duration, not a timestamp", async () => {
    const result = await recomputeUserRollups("u1", {
      granularities: ["DAY"],
      from,
      to,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(60_000);
    const stopped = await recomputeUserRollups("u1", {
      shouldStop: () => true,
    });
    expect(stopped).toMatchObject({ rowsUpserted: 0, stopped: true });
    expect(stopped.durationMs).toBeLessThan(60_000);
  });

  it("covers the whole bucket of `from` when `to` sits on that bucket's start", async () => {
    await recomputeUserRollups("u1", {
      granularities: ["DAY"],
      from: iso("2024-03-10T14:00:00.000Z"),
      to: iso("2024-03-10T00:00:00.000Z"),
    });
    const [, , fromArg, toArg] = mocks.queryRawUnsafe.mock.calls[0];
    expect((fromArg as Date).toISOString()).toBe("2024-03-10T00:00:00.000Z");
    expect((toArg as Date).toISOString()).toBe("2024-03-11T00:00:00.000Z");
  });
});

describe("statement budget", () => {
  it("rounds up to whole milliseconds and never goes below one", async () => {
    const tx = { $executeRaw: vi.fn().mockResolvedValue(0) };
    await applyStatementBudget(tx as never, 1500.2);
    await applyStatementBudget(tx as never, 0);
    expect(tx.$executeRaw.mock.calls[0].slice(1)).toEqual(["1501", "1501"]);
    expect(tx.$executeRaw.mock.calls[1].slice(1)).toEqual(["1", "1"]);
    const text = (tx.$executeRaw.mock.calls[0][0] as string[]).join("?");
    expect(text).toContain("set_config('statement_timeout', ?, true)");
    expect(text).toContain(
      "set_config('idle_in_transaction_session_timeout', ?, true)",
    );
  });

  it("applies to the aggregate and the write, and stretches the write's transaction", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      aggRow("WEIGHT", "MANUAL", "2024-03-10T00:00:00.000Z"),
    ]);
    await recomputeUserRollups("u1", {
      granularities: ["DAY"],
      from: iso("2024-03-10T00:00:00.000Z"),
      to: iso("2024-03-11T00:00:00.000Z"),
      statementTimeoutMs: 200_000,
    });
    // One transaction for the aggregate, one for the delete + upsert.
    expect(mocks.transaction).toHaveBeenCalledTimes(2);
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      maxWait: 10_000,
      timeout: 230_000,
    });
    expect(mocks.transaction.mock.calls[1][1]).toEqual({
      maxWait: 10_000,
      timeout: 230_000,
    });
    expect(mocks.txExecuteRaw).toHaveBeenCalledTimes(2);
    for (const call of mocks.txExecuteRaw.mock.calls) {
      expect(call.slice(1)).toEqual(["200000", "200000"]);
    }
  });

  it("sets no budget when none is asked for", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      aggRow("WEIGHT", "MANUAL", "2024-03-10T00:00:00.000Z"),
    ]);
    await recomputeUserRollups("u1", {
      granularities: ["DAY"],
      from: iso("2024-03-10T00:00:00.000Z"),
      to: iso("2024-03-11T00:00:00.000Z"),
    });
    expect(mocks.txExecuteRaw).not.toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transaction.mock.calls[0][1]).toEqual({
      maxWait: 10_000,
      timeout: 120_000,
    });
  });
});

describe("hourly-mean day types", () => {
  const from = iso("2026-05-04T00:00:00.000Z");
  const to = iso("2026-05-11T00:00:00.000Z");

  it("replaces a pulse bucket's mean with the mean of its days' hourly means", async () => {
    mocks.queryRawUnsafe
      .mockResolvedValueOnce([
        aggRow("PULSE", "MANUAL", "2026-05-04T00:00:00.000Z", { mean: 90 }),
        aggRow("PULSE", "APPLE_HEALTH", "2026-05-04T00:00:00.000Z", {
          mean: 80,
        }),
      ])
      .mockResolvedValueOnce([
        {
          type: "PULSE",
          source: "MANUAL",
          bucket_start: iso("2026-05-04T00:00:00.000Z"),
          mean: 72,
        },
      ]);

    await recomputeUserRollups("u1", {
      granularities: ["WEEK"],
      types: ["PULSE"],
      from,
      to,
    });

    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(2);
    const meansCall = mocks.queryRawUnsafe.mock.calls[1];
    expect(meansCall.slice(1)).toEqual(["u1", from, to]);
    const sql = meansCall[0] as string;
    expect(sql).toContain(`date_trunc('week', d.day) AS bucket_start`);
    expect(sql).toContain(`m."type" IN ('PULSE'::"measurement_type")`);
    expect(sql).toContain(`date_trunc('hour', m."measured_at")`);
    expect(sql).toContain("h.hour_mean");
    expect(sql).not.toContain("ANY($4");

    const upsert = mocks.txExecuteRawUnsafe.mock.calls[0].slice(1);
    // Sorted by source: APPLE_HEALTH first, untouched; MANUAL replaced.
    expect(upsert[4]).toBe("APPLE_HEALTH");
    expect(upsert[6]).toBe(80);
    expect(upsert[24]).toBe("MANUAL");
    expect(upsert[26]).toBe(72);
    // Count, min and max stay over every reading.
    expect(upsert[25]).toBe(2);
    expect(upsert[27]).toBe(79);
    expect(upsert[28]).toBe(81);
  });

  it("filters the hourly means to the touched days on a keyed refold", async () => {
    mocks.queryRawUnsafe
      .mockResolvedValueOnce([
        aggRow("PULSE", "MANUAL", "2026-05-05T00:00:00.000Z"),
      ])
      .mockResolvedValueOnce([]);
    await recomputeBucketsForKeys("u1", [
      { type: "PULSE", measuredAt: iso("2026-05-05T10:00:00.000Z") },
    ]);
    const meansCall = mocks.queryRawUnsafe.mock.calls[1];
    expect(meansCall[0]).toContain(
      `AND date_trunc('day', m."measured_at") = ANY($4::timestamp[])`,
    );
    expect(meansCall[0]).toContain(`date_trunc('day', d.day)`);
    expect(meansCall.slice(1)).toEqual([
      "u1",
      iso("2026-05-05T00:00:00.000Z"),
      iso("2026-05-06T00:00:00.000Z"),
      ["2026-05-05T00:00:00.000"],
    ]);
  });

  it("asks nothing more for a type whose day is the mean of its readings", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      aggRow("WEIGHT", "MANUAL", "2026-05-04T00:00:00.000Z"),
    ]);
    await recomputeUserRollups("u1", {
      granularities: ["WEEK"],
      from,
      to,
    });
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
  });
});

describe("the upsert statement", () => {
  it("numbers each row's twenty placeholders after the previous row's", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      aggRow("WEIGHT", "MANUAL", "2024-03-10T00:00:00.000Z"),
      aggRow("WEIGHT", "MANUAL", "2024-03-11T00:00:00.000Z"),
    ]);
    await recomputeUserRollups("u1", {
      granularities: ["DAY"],
      from: iso("2024-03-10T00:00:00.000Z"),
      to: iso("2024-03-12T00:00:00.000Z"),
    });
    const [sql, ...params] = mocks.txExecuteRawUnsafe.mock.calls[0];
    expect(params).toHaveLength(40);
    const values = (sql as string).replace(/\s+/g, " ");
    const tuple = (b: number) =>
      `($${b + 1}, $${b + 2}::"measurement_type", $${b + 3}::"measurement_rollup_granularity", ` +
      `$${b + 4}::timestamptz, $${b + 5}::"measurement_source", $${b + 6}::int, ` +
      `$${b + 7}, $${b + 8}, $${b + 9}, $${b + 10}, $${b + 11}, $${b + 12}, ` +
      `$${b + 13}, $${b + 14}, $${b + 15}, $${b + 16}, $${b + 17}, $${b + 18}, ` +
      `$${b + 19}, $${b + 20}::timestamptz)`;
    expect(values).toContain(`VALUES ${tuple(0)}, ${tuple(20)} ON CONFLICT`);
    expect(values).toContain(
      "(user_id, type, granularity, bucket_start, source, count, mean, min_value, max_value, sum_value, sd, slope, r2, sum_x, sum_xy, sum_xx, sum_yy, reading_min_value, reading_max_value, computed_at)",
    );
  });

  it("writes zero for a missing mean or range, and null for a missing sum", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      aggRow("WEIGHT", "MANUAL", "2024-03-10T00:00:00.000Z", {
        mean: null,
        min_value: null,
        max_value: null,
        sum_value: undefined,
        sum_x: 1.5,
        sum_xy: 2.5,
        sum_xx: 3.5,
        sum_yy: 4.5,
        reading_min_value: 70,
        reading_max_value: 90,
      }),
      aggRow("WEIGHT", "MANUAL", "2024-03-11T00:00:00.000Z", {
        mean: 81,
        min_value: 80,
        max_value: 82,
      }),
    ]);
    await recomputeUserRollups("u1", {
      granularities: ["DAY"],
      from: iso("2024-03-10T00:00:00.000Z"),
      to: iso("2024-03-12T00:00:00.000Z"),
    });
    const params = mocks.txExecuteRawUnsafe.mock.calls[0].slice(1);
    expect(params.slice(6, 10)).toEqual([0, 0, 0, null]);
    expect(params.slice(13, 19)).toEqual([1.5, 2.5, 3.5, 4.5, 70, 90]);
    expect(params[19]).toBeInstanceOf(Date);
    // The second row has no accumulators at all: null, never undefined.
    expect(params.slice(26, 29)).toEqual([81, 80, 82]);
    expect(params.slice(33, 39)).toEqual([null, null, null, null, null, null]);
  });
});

describe("recomputeBucketsForMeasurement — the windows it touches", () => {
  it("aggregates exactly the UTC day of the reading and enqueues its enclosing buckets", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      aggRow("WEIGHT", "MANUAL", "2026-05-07T00:00:00.000Z"),
    ]);
    await recomputeBucketsForMeasurement(
      "u1",
      "WEIGHT",
      iso("2026-05-07T23:59:00.000Z"),
    );
    const [, , from, to] = mocks.queryRawUnsafe.mock.calls[0];
    expect((from as Date).toISOString()).toBe("2026-05-07T00:00:00.000Z");
    expect((to as Date).toISOString()).toBe("2026-05-08T00:00:00.000Z");

    const spans = mocks.bossSend.mock.calls.map(
      ([, p]) =>
        `${p.granularity} ${p.from.slice(0, 10)}..${p.to.slice(0, 10)}`,
    );
    expect(spans.sort()).toEqual([
      "MONTH 2026-05-01..2026-06-01",
      "WEEK 2026-05-04..2026-05-11",
      "YEAR 2026-01-01..2027-01-01",
    ]);
  });

  it("deletes the full range of buckets the aggregate returned, whatever their order", async () => {
    mocks.queryRawUnsafe.mockResolvedValueOnce([
      aggRow("WEIGHT", "MANUAL", "2026-05-08T00:00:00.000Z"),
      aggRow("WEIGHT", "WITHINGS", "2026-05-06T00:00:00.000Z"),
      aggRow("BODY_FAT", "MANUAL", "2026-05-09T00:00:00.000Z"),
      aggRow("WEIGHT", "MANUAL", "2026-05-07T00:00:00.000Z"),
    ]);
    await recomputeBucketsForMeasurement(
      "u1",
      "WEIGHT",
      iso("2026-05-07T10:00:00.000Z"),
    );
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: {
        userId: "u1",
        granularity: "DAY",
        type: { in: ["WEIGHT", "BODY_FAT"] },
        bucketStart: {
          gte: iso("2026-05-06T00:00:00.000Z"),
          lte: iso("2026-05-09T00:00:00.000Z"),
        },
      },
    });
    expect(upsertedKeys(mocks.txExecuteRawUnsafe.mock.calls[0])).toEqual([
      "BODY_FAT|2026-05-09|MANUAL",
      "WEIGHT|2026-05-07|MANUAL",
      "WEIGHT|2026-05-08|MANUAL",
      "WEIGHT|2026-05-06|WITHINGS",
    ]);
  });
});

describe("enqueueRollupRecompute — job options", () => {
  it("retries with backoff on the documented queue", async () => {
    await enqueueRollupRecompute({
      userId: "u1",
      type: "WEIGHT",
      granularity: "MONTH",
      from: iso("2026-05-01T00:00:00.000Z"),
      to: iso("2026-06-01T00:00:00.000Z"),
    });
    const [queue, payload, opts] = mocks.bossSend.mock.calls[0];
    // The queue name is persisted with every queued job; renaming it strands
    // the jobs a running deployment already enqueued.
    expect(queue).toBe("rollup-recompute");
    expect(payload.to).toBe("2026-06-01T00:00:00.000Z");
    expect(opts).toMatchObject({
      retryLimit: 3,
      retryDelay: 30,
      retryBackoff: true,
      singletonKey: "u1|WEIGHT|MONTH|2026-05-01T00:00:00.000Z",
    });
  });
});

describe("readRollupBuckets", () => {
  it("reads the canonical buckets for the window and returns the rollup shape", async () => {
    const bucket = {
      bucketStart: iso("2026-05-01T00:00:00.000Z"),
      count: 4,
      days: 2,
      mean: 80,
      minValue: 78,
      maxValue: 83,
      sd: 1.2,
      slope: 0.1,
      r2: 0.5,
      computedAt: iso("2026-05-10T00:00:00.000Z"),
      source: "MANUAL",
    };
    mocks.readCanonical.mockResolvedValueOnce([bucket]);
    const from = iso("2026-05-01T00:00:00.000Z");
    const to = iso("2026-06-01T00:00:00.000Z");
    const prio = { WEIGHT: ["MANUAL"] };
    const rows = await readRollupBuckets(
      "u1",
      "WEIGHT",
      "MONTH",
      from,
      to,
      prio,
    );
    expect(mocks.readCanonical).toHaveBeenCalledWith({
      userId: "u1",
      type: "WEIGHT",
      granularity: "MONTH",
      from,
      to,
      userPriorityJson: prio,
    });
    expect(rows).toEqual([
      {
        bucketStart: bucket.bucketStart,
        count: 4,
        mean: 80,
        minValue: 78,
        maxValue: 83,
        sd: 1.2,
        slope: 0.1,
        r2: 0.5,
        computedAt: bucket.computedAt,
      },
    ]);
  });
});

describe("ensureUserRollupsFresh — the freshness probe", () => {
  it("compares the newest DAY rollup against the newest measurement change", async () => {
    mocks.rollupFindFirst.mockResolvedValueOnce(null);
    mocks.measurementFindFirst.mockResolvedValueOnce(null);
    await ensureUserRollupsFresh("u1");
    expect(mocks.rollupFindFirst).toHaveBeenCalledWith({
      where: { userId: "u1", granularity: "DAY" },
      orderBy: { computedAt: "desc" },
      select: { computedAt: true },
    });
    expect(mocks.measurementFindFirst).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: { updatedAt: "desc" },
      select: { updatedAt: true, measuredAt: true },
    });
    expect(mocks.annotate).not.toHaveBeenCalled();
  });

  it("counts a reading measured after its last edit as newer than the rollup", async () => {
    // A reading stamped in the future of its own write (a device clock, a
    // scheduled entry): its measuredAt is the watermark, not its updatedAt.
    mocks.rollupFindFirst.mockResolvedValueOnce({
      computedAt: iso("2026-05-10T12:00:00.000Z"),
    });
    mocks.measurementFindFirst.mockResolvedValueOnce({
      updatedAt: iso("2026-05-10T10:00:00.000Z"),
      measuredAt: iso("2026-05-10T14:00:00.000Z"),
    });
    const result = await ensureUserRollupsFresh("u1");
    expect(result.recomputed).toBe(true);
  });

  it("treats a rollup computed at the very instant of the last change as fresh", async () => {
    const at = iso("2026-05-10T12:00:00.000Z");
    mocks.rollupFindFirst.mockResolvedValueOnce({ computedAt: at });
    mocks.measurementFindFirst.mockResolvedValueOnce({
      updatedAt: at,
      measuredAt: iso("2026-05-10T08:00:00.000Z"),
    });
    const result = await ensureUserRollupsFresh("u1");
    expect(result.recomputed).toBe(false);
    expect(mocks.queryRawUnsafe).not.toHaveBeenCalled();
  });

  it("refreshes only the trailing 90 days of DAY buckets", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(iso("2026-06-15T12:00:00.000Z"));
    mocks.rollupFindFirst.mockResolvedValueOnce(null);
    mocks.measurementFindFirst.mockResolvedValueOnce({
      updatedAt: iso("2026-06-15T11:00:00.000Z"),
      measuredAt: iso("2026-06-15T11:00:00.000Z"),
    });
    await ensureUserRollupsFresh("u1");
    expect(mocks.queryRawUnsafe).toHaveBeenCalledTimes(1);
    const [sql, , from, to] = mocks.queryRawUnsafe.mock.calls[0];
    expect(sql).toContain(`date_trunc('day', m."measured_at")`);
    expect((from as Date).toISOString()).toBe(
      new Date(Date.UTC(2026, 5, 15) - 90 * DAY_MS).toISOString(),
    );
    expect((to as Date).toISOString()).toBe("2026-06-16T00:00:00.000Z");
  });

  it("logs a failed refresh under the rollups prefix", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.rollupFindFirst.mockRejectedValueOnce(new Error("db down"));
    mocks.measurementFindFirst.mockResolvedValueOnce(null);
    const result = await ensureUserRollupsFresh("u1");
    expect(result.recomputed).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "[rollups] ensureUserRollupsFresh failed:",
      "db down",
    );
    expect(mocks.annotate).toHaveBeenCalledWith({
      meta: { rollup_refresh_failed: true, rollup_refresh_error: "db down" },
    });
  });
});
