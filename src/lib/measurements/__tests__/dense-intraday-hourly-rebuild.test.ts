/**
 * v1.28.31 — one-shot hourly history rebuild for pre-hourly folded
 * dense-tier days.
 *
 * Pins the rebuild contract: a folded day (live daily `stats:` row +
 * tombstoned raw rows) is converted to hourly means AND the daily row is
 * retired in the SAME transaction (no instant where both grains are live —
 * the double-count invariant); days with zero tombstoned raws keep their
 * daily row; the day scan is bounded by the retention window; a re-run
 * converges to zero work; non-APPLE_HEALTH sources are never touched; the
 * DAY-rollup handling is per type (HRV recomputed from the hourly rows,
 * PULSE/SpO2 untouched with only whole-span WEEK/MONTH/YEAR enqueues).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recomputeBucketsForMeasurement, enqueueRollupRecompute, bucketSpan } =
  vi.hoisted(() => ({
    recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
    enqueueRollupRecompute: vi.fn().mockResolvedValue(undefined),
    bucketSpan: vi.fn((measuredAt: Date) => ({
      from: measuredAt,
      to: measuredAt,
    })),
  }));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement,
  enqueueRollupRecompute,
  bucketSpan,
}));

import { runDenseIntradayHourlyRebuild } from "../dense-intraday-hourly-rebuild";
import type { PrismaClient } from "@/generated/prisma/client";
import { candidateLookup, createManyVia } from "./hourly-mint-mock";

const HRV_DAILY_ID =
  "stats:HKQuantityTypeIdentifierHeartRateVariabilitySDNN:2026-05-01";
const PULSE_DAILY_ID = "stats:HKQuantityTypeIdentifierHeartRate:2026-05-01";

interface MockRow {
  id: string;
  externalId: string | null;
  type?: string;
  value?: number;
  measuredAt?: Date;
  unit?: string;
}

function tombstone(
  id: string,
  value: number,
  iso: string,
  type: string,
  unit = "ms",
): MockRow {
  return {
    id,
    type,
    value,
    measuredAt: new Date(iso),
    externalId: `hk-${id}`,
    unit,
  };
}

/**
 * Prisma mock for the rebuild flow. `findMany` discriminates the two scans
 * by their predicates: the daily-candidate scan filters live rows
 * (`deletedAt: null` + `externalId.startsWith`), the tombstone scan filters
 * `deletedAt: { not: null }`.
 */
function buildPrismaMock(opts: {
  dailyByType: Record<string, MockRow[]>;
  tombstonesByType: Record<string, MockRow[]>;
}) {
  const txCreate = vi.fn().mockResolvedValue({ id: "minted-hourly" });
  const txUpdate = vi.fn().mockResolvedValue({});
  const txFindFirst = vi.fn().mockResolvedValue(null);
  const tx = {
    measurement: {
      create: txCreate,
      update: txUpdate,
      findFirst: txFindFirst,
      findMany: candidateLookup(),
      createManyAndReturn: createManyVia(txCreate),
    },
  };

  const findMany = vi.fn(
    async (args: {
      where: {
        type: string;
        deletedAt?: null | { not: null };
        externalId?: { startsWith: string };
      };
    }) => {
      if (args.where.deletedAt === null) {
        return opts.dailyByType[args.where.type] ?? [];
      }
      return opts.tombstonesByType[args.where.type] ?? [];
    },
  );
  const topUpdate = vi.fn().mockResolvedValue({});
  const $transaction = vi.fn(async (cb: (t: unknown) => Promise<unknown>) =>
    cb(tx),
  );

  const mock = {
    user: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]),
    },
    measurement: { findMany, update: topUpdate },
    $transaction,
  } as unknown as PrismaClient;

  return {
    mock,
    findMany,
    txCreate,
    txUpdate,
    txFindFirst,
    topUpdate,
    $transaction,
  };
}

beforeEach(() => {
  recomputeBucketsForMeasurement.mockClear();
  enqueueRollupRecompute.mockClear();
  bucketSpan.mockClear();
});

describe("runDenseIntradayHourlyRebuild — rebuild flow", () => {
  it("mints hourly means from the tombstoned raws and retires the daily row in the SAME transaction", async () => {
    const { mock, txCreate, txUpdate, topUpdate, $transaction } =
      buildPrismaMock({
        dailyByType: {
          HEART_RATE_VARIABILITY: [{ id: "daily-1", externalId: HRV_DAILY_ID }],
        },
        tombstonesByType: {
          HEART_RATE_VARIABILITY: [
            tombstone(
              "a",
              40,
              "2026-05-01T08:00:00.000Z",
              "HEART_RATE_VARIABILITY",
            ),
            tombstone(
              "b",
              60,
              "2026-05-01T09:00:00.000Z",
              "HEART_RATE_VARIABILITY",
            ),
          ],
        },
      });

    const summary = await runDenseIntradayHourlyRebuild(mock, {
      log: () => {},
    });

    // Hourly rows: Berlin UTC+2 → local hours 10 and 11, each its own mean.
    expect(txCreate).toHaveBeenCalledTimes(2);
    const createArgs = txCreate.mock.calls.map(
      (c) => (c[0] as { data: { externalId: string; value: number } }).data,
    );
    expect(createArgs.map((d) => d.externalId)).toEqual([
      `${HRV_DAILY_ID}T10`,
      `${HRV_DAILY_ID}T11`,
    ]);
    expect(createArgs.map((d) => d.value)).toEqual([40, 60]);

    // The daily row is tombstoned via the TRANSACTION client — never the
    // top-level client — inside the single per-day transaction, so no
    // reader ever sees the daily and hourly rows live at once.
    expect($transaction).toHaveBeenCalledTimes(1);
    expect(topUpdate).not.toHaveBeenCalled();
    const retire = txUpdate.mock.calls.find(
      (c) => (c[0] as { where: { id: string } }).where.id === "daily-1",
    );
    expect(retire).toBeDefined();
    expect(
      (retire?.[0] as { data: { deletedAt: Date } }).data.deletedAt,
    ).toBeInstanceOf(Date);

    expect(summary.totals.daysRebuilt).toBe(1);
    expect(summary.totals.hourlyRowsUpserted).toBe(2);
    expect(summary.totals.dailyRowsRetired).toBe(1);
    expect(summary.totals.daysSkippedNoTombstones).toBe(0);
  });

  it("HRV: recomputes the DAY bucket from the now-live hourly rows after the rebuild", async () => {
    const { mock } = buildPrismaMock({
      dailyByType: {
        HEART_RATE_VARIABILITY: [{ id: "daily-1", externalId: HRV_DAILY_ID }],
      },
      tombstonesByType: {
        HEART_RATE_VARIABILITY: [
          tombstone(
            "a",
            40,
            "2026-05-01T08:00:00.000Z",
            "HEART_RATE_VARIABILITY",
          ),
        ],
      },
    });

    await runDenseIntradayHourlyRebuild(mock, { log: () => {} });

    // Historical HRV DAY buckets were collapsed to min == max == mean at
    // fold time; hourly-derived stats are strictly better.
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledTimes(1);
    expect(recomputeBucketsForMeasurement).toHaveBeenCalledWith(
      "user-1",
      "HEART_RATE_VARIABILITY",
      expect.any(Date),
    );
    // The DAY recompute call owns the WEEK/MONTH/YEAR enqueue for HRV.
    expect(enqueueRollupRecompute).not.toHaveBeenCalled();
  });

  it("PULSE: leaves the DAY bucket untouched (true pre-fold min/max/mean) and enqueues WEEK/MONTH/YEAR only", async () => {
    const { mock } = buildPrismaMock({
      dailyByType: {
        PULSE: [{ id: "daily-p", externalId: PULSE_DAILY_ID }],
      },
      tombstonesByType: {
        PULSE: [tombstone("a", 60, "2026-05-01T08:00:00.000Z", "PULSE", "bpm")],
      },
    });

    await runDenseIntradayHourlyRebuild(mock, { log: () => {} });

    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
    const granularities = enqueueRollupRecompute.mock.calls
      .map((c) => (c[0] as { granularity: string }).granularity)
      .sort();
    expect(granularities).toEqual(["MONTH", "WEEK", "YEAR"]);
  });

  it("skips days with ZERO tombstoned raws — the daily row is the only surviving representation", async () => {
    const { mock, $transaction, txUpdate, topUpdate } = buildPrismaMock({
      dailyByType: {
        HEART_RATE_VARIABILITY: [{ id: "daily-1", externalId: HRV_DAILY_ID }],
      },
      tombstonesByType: {},
    });

    const summary = await runDenseIntradayHourlyRebuild(mock, {
      log: () => {},
    });

    expect($transaction).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
    expect(topUpdate).not.toHaveBeenCalled();
    expect(summary.totals.daysRebuilt).toBe(0);
    expect(summary.totals.dailyRowsRetired).toBe(0);
    expect(summary.totals.daysSkippedNoTombstones).toBe(1);
  });

  it("never considers days inside the retention window (bounded candidate scan)", async () => {
    const { mock, findMany } = buildPrismaMock({
      dailyByType: {},
      tombstonesByType: {},
    });

    await runDenseIntradayHourlyRebuild(mock, { log: () => {} });

    // Every daily-candidate scan carries the window bound.
    const candidateCalls = findMany.mock.calls.filter(
      (c) => (c[0] as { where: { deletedAt?: null } }).where.deletedAt === null,
    );
    expect(candidateCalls.length).toBeGreaterThan(0);
    for (const call of candidateCalls) {
      const where = (call[0] as { where: { measuredAt?: { lt: Date } } }).where;
      expect(where.measuredAt?.lt).toBeInstanceOf(Date);
    }
  });

  it("scopes every scan to APPLE_HEALTH and excludes stats: rows from the tombstone read", async () => {
    const { mock, findMany } = buildPrismaMock({
      dailyByType: {
        HEART_RATE_VARIABILITY: [{ id: "daily-1", externalId: HRV_DAILY_ID }],
      },
      tombstonesByType: {
        HEART_RATE_VARIABILITY: [
          tombstone(
            "a",
            40,
            "2026-05-01T08:00:00.000Z",
            "HEART_RATE_VARIABILITY",
          ),
        ],
      },
    });

    await runDenseIntradayHourlyRebuild(mock, { log: () => {} });

    for (const call of findMany.mock.calls) {
      const where = (call[0] as unknown as { where: { source: string } }).where;
      expect(where.source).toBe("APPLE_HEALTH");
    }
    // The tombstone scan must never feed a `stats:` row (e.g. a retired
    // daily row of a neighbouring day) into an hourly mean.
    const tombstoneCall = findMany.mock.calls.find(
      (c) =>
        (c[0] as { where: { deletedAt?: { not: null } } }).where.deletedAt !==
        null,
    );
    expect(
      (
        tombstoneCall?.[0] as unknown as {
          where: { NOT: { externalId: { startsWith: string } } };
        }
      ).where.NOT.externalId.startsWith,
    ).toBe("stats:");
  });

  it("ignores hourly-shaped and iOS wire-shaped stats externalIds in the candidate set", async () => {
    const { mock, $transaction } = buildPrismaMock({
      dailyByType: {
        PULSE: [
          // Already-hourly row (this tier's own output) — not a candidate.
          { id: "h", externalId: `${PULSE_DAILY_ID}T10` },
          // iOS hourly-HR wire row (ISO-instant suffix) — not a candidate.
          {
            id: "ios",
            externalId:
              "stats:HKQuantityTypeIdentifierHeartRate:2026-05-01T14:00:00.000Z",
          },
        ],
      },
      tombstonesByType: {
        PULSE: [tombstone("a", 60, "2026-05-01T08:00:00.000Z", "PULSE", "bpm")],
      },
    });

    const summary = await runDenseIntradayHourlyRebuild(mock, {
      log: () => {},
    });

    expect($transaction).not.toHaveBeenCalled();
    expect(summary.totals.daysRebuilt).toBe(0);
    expect(summary.totals.daysSkippedNoTombstones).toBe(0);
  });

  it("converges: a run with no live daily rows does zero work", async () => {
    const { mock, $transaction } = buildPrismaMock({
      dailyByType: {},
      tombstonesByType: {
        HEART_RATE_VARIABILITY: [
          tombstone(
            "a",
            40,
            "2026-05-01T08:00:00.000Z",
            "HEART_RATE_VARIABILITY",
          ),
        ],
      },
    });

    const summary = await runDenseIntradayHourlyRebuild(mock, {
      log: () => {},
    });

    expect($transaction).not.toHaveBeenCalled();
    expect(summary.totals.daysRebuilt).toBe(0);
    expect(summary.totals.hourlyRowsUpserted).toBe(0);
    expect(summary.totals.dailyRowsRetired).toBe(0);
  });

  it("writes nothing on a dry-run", async () => {
    const { mock, $transaction, txCreate, txUpdate, topUpdate } =
      buildPrismaMock({
        dailyByType: {
          HEART_RATE_VARIABILITY: [{ id: "daily-1", externalId: HRV_DAILY_ID }],
        },
        tombstonesByType: {
          HEART_RATE_VARIABILITY: [
            tombstone(
              "a",
              40,
              "2026-05-01T08:00:00.000Z",
              "HEART_RATE_VARIABILITY",
            ),
          ],
        },
      });

    const summary = await runDenseIntradayHourlyRebuild(mock, {
      dryRun: true,
      log: () => {},
    });

    expect($transaction).not.toHaveBeenCalled();
    expect(txCreate).not.toHaveBeenCalled();
    expect(txUpdate).not.toHaveBeenCalled();
    expect(topUpdate).not.toHaveBeenCalled();
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
    expect(enqueueRollupRecompute).not.toHaveBeenCalled();
    // The preview still reports what a real run would do.
    expect(summary.totals.daysRebuilt).toBe(1);
    expect(summary.totals.hourlyRowsUpserted).toBe(1);
  });

  it("per-day failure boundary: a poisoned day is stepped over and the rest still rebuilds", async () => {
    const { mock, $transaction } = buildPrismaMock({
      dailyByType: {
        HEART_RATE_VARIABILITY: [
          { id: "daily-1", externalId: HRV_DAILY_ID },
          {
            id: "daily-2",
            externalId:
              "stats:HKQuantityTypeIdentifierHeartRateVariabilitySDNN:2026-05-02",
          },
        ],
      },
      tombstonesByType: {
        HEART_RATE_VARIABILITY: [
          tombstone(
            "a",
            40,
            "2026-05-01T08:00:00.000Z",
            "HEART_RATE_VARIABILITY",
          ),
          tombstone(
            "b",
            44,
            "2026-05-02T08:00:00.000Z",
            "HEART_RATE_VARIABILITY",
          ),
        ],
      },
    });

    // First day's transaction throws a non-P2002 error; the boundary must
    // absorb it and continue to the second day.
    let call = 0;
    ($transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (t: unknown) => Promise<unknown>) => {
        call += 1;
        if (call === 1) throw new Error("boom — poisoned day");
        return cb({
          measurement: {
            create: vi.fn().mockResolvedValue({ id: "minted" }),
            update: vi.fn().mockResolvedValue({}),
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: candidateLookup(),
            createManyAndReturn: createManyVia(
              vi.fn().mockResolvedValue({ id: "minted" }),
            ),
          },
        });
      },
    );

    const summary = await runDenseIntradayHourlyRebuild(mock, {
      log: () => {},
    });

    expect(summary.totals.daysFailed).toBe(1);
    expect(summary.totals.daysRebuilt).toBe(1);
  });

  it("stops before the next day once its budget is spent (#1031)", async () => {
    const { mock, $transaction } = buildPrismaMock({
      dailyByType: {
        HEART_RATE_VARIABILITY: [
          { id: "daily-1", externalId: HRV_DAILY_ID },
          {
            id: "daily-2",
            externalId:
              "stats:HKQuantityTypeIdentifierHeartRateVariabilitySDNN:2026-05-02",
          },
        ],
      },
      tombstonesByType: {
        HEART_RATE_VARIABILITY: [
          tombstone(
            "a",
            40,
            "2026-05-01T08:00:00.000Z",
            "HEART_RATE_VARIABILITY",
          ),
          tombstone(
            "b",
            44,
            "2026-05-02T08:00:00.000Z",
            "HEART_RATE_VARIABILITY",
          ),
        ],
      },
    });
    let asked = 0;
    const summary = await runDenseIntradayHourlyRebuild(mock, {
      log: () => {},
      shouldStop: () => asked++ >= 1,
    });

    expect(summary.stoppedEarly).toBe(true);
    expect(summary.totals.daysRebuilt).toBe(1);
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});
