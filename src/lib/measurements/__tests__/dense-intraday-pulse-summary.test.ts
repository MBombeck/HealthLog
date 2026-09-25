/**
 * iOS#34 / #69 — server-side aggregation of high-frequency heart rate.
 *
 * The dense intra-day retention drain folds out-of-window per-sample PULSE
 * rows to hourly-MEAN `stats:` rows to bound the ~16k-rows-per-user bloat.
 * The mean fold alone would erase the two clinically-meaningful daily
 * figures the app derives from the raw stream:
 *
 *   1. Resting HR — the read-path resolver derives it from the 20th-percentile
 *      of each day's RAW PULSE for users with no native RESTING_HEART_RATE.
 *   2. Daily min/max — the persistent rollup DAY bucket, which aggregates LIVE
 *      rows, would collapse min == max == mean after the fold.
 *
 * This suite pins the PULSE facet that preserves both: the pre-fold DAY-rollup
 * recompute (true min/max captured while raw rows are live), the derived
 * RESTING_HEART_RATE row minted from the day's 20th percentile for proxy users
 * only, the no-double-count guard for native-resting users, the derive helper's
 * percentile + sample-floor semantics, idempotency, and the per-day failure
 * boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { recomputeBucketsForMeasurement } = vi.hoisted(() => ({
  recomputeBucketsForMeasurement: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/rollups/measurement-rollups", () => ({
  recomputeBucketsForMeasurement,
}));

import {
  runDenseIntradayRetention,
  deriveDailyRestingFromPulse,
} from "../dense-intraday-retention";
import type { PerSampleRow } from "../drain-per-sample-cumulative";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { candidateLookup, createManyVia } from "./hourly-mint-mock";

function pulseRow(id: string, value: number, iso: string): PerSampleRow {
  return {
    id,
    type: "PULSE" as MeasurementType,
    value,
    measuredAt: new Date(iso),
    externalId: null,
    unit: "bpm",
  };
}

/**
 * Prisma mock covering the full PULSE-summary flow: the scan (per-type rows),
 * the per-user native-resting probe (top-level `findFirst`), the fold
 * transaction (`create`/`update`/`findFirst`/`updateMany`), and the derived
 * resting `upsert` (top-level).
 */
function buildPrismaMock(opts: {
  pulseRows: PerSampleRow[];
  hasNativeResting?: boolean;
}) {
  // Inside the fold transaction: no pre-existing canonical row → create path.
  const txCreate = vi.fn().mockResolvedValue({ id: "minted-daily" });
  const txUpdate = vi.fn().mockResolvedValue({});
  const txFindFirst = vi.fn().mockResolvedValue(null);
  const txUpdateMany = vi
    .fn()
    .mockResolvedValue({ count: opts.pulseRows.length });
  const tx = {
    measurement: {
      create: txCreate,
      update: txUpdate,
      findFirst: txFindFirst,
      updateMany: txUpdateMany,
      findMany: candidateLookup(),
      createManyAndReturn: createManyVia(txCreate),
    },
  };

  // Top-level client.
  const findMany = vi.fn(async (args: { where: { type: string } }) =>
    args.where.type === "PULSE" ? opts.pulseRows : [],
  );
  // Native-resting probe is the only top-level `findFirst` call.
  const topFindFirst = vi
    .fn()
    .mockResolvedValue(opts.hasNativeResting ? { id: "native-rhr" } : null);
  const upsert = vi.fn().mockResolvedValue({ id: "derived-rhr" });

  const mock = {
    user: {
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: "user-1", timezone: "Europe/Berlin" }]),
    },
    measurement: { findMany, findFirst: topFindFirst, upsert },
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaClient;

  return { mock, txCreate, txUpdateMany, upsert, topFindFirst };
}

beforeEach(() => {
  recomputeBucketsForMeasurement.mockClear();
});

describe("deriveDailyRestingFromPulse", () => {
  it("returns the rounded 20th percentile of the day's samples", () => {
    // 10 samples 60..69 → p20 ≈ 61.8 → round 62.
    const rows = Array.from({ length: 10 }, (_, i) =>
      pulseRow(`r${i}`, 60 + i, "2026-05-01T08:00:00.000Z"),
    );
    expect(deriveDailyRestingFromPulse(rows)).toBe(62);
  });

  it("excludes the workout burst — a dense high tail cannot drag resting up", () => {
    // 8 resting samples ~58 + 4 workout samples ~150. p20 stays in the low band.
    const rows = [
      ...[57, 58, 58, 59, 59, 60, 60, 61].map((v, i) =>
        pulseRow(`a${i}`, v, "2026-05-01T07:00:00.000Z"),
      ),
      ...[140, 150, 155, 160].map((v, i) =>
        pulseRow(`w${i}`, v, "2026-05-01T18:00:00.000Z"),
      ),
    ];
    const resting = deriveDailyRestingFromPulse(rows);
    expect(resting).toBeLessThan(70);
    expect(resting).toBeGreaterThan(50);
  });

  it("returns null below the minimum daily sample floor", () => {
    expect(
      deriveDailyRestingFromPulse([
        pulseRow("a", 130, "2026-05-01T18:00:00.000Z"),
        pulseRow("b", 135, "2026-05-01T18:05:00.000Z"),
      ]),
    ).toBeNull();
  });
});

describe("PULSE fold — min/max preservation via pre-fold rollup recompute", () => {
  it("recomputes the PULSE DAY rollup from RAW rows BEFORE the fold, and NOT after", async () => {
    const rows = [
      pulseRow("a", 55, "2026-05-01T06:00:00.000Z"),
      pulseRow("b", 70, "2026-05-01T12:00:00.000Z"),
      pulseRow("c", 160, "2026-05-01T18:00:00.000Z"),
    ];
    const { mock, txCreate } = buildPrismaMock({
      pulseRows: rows,
      hasNativeResting: true, // isolate the min/max path from the resting mint
    });

    await runDenseIntradayRetention(mock, { retentionDays: 0, log: () => {} });

    // The fold minted one hourly mean row per distinct local hour (06:00Z /
    // 12:00Z / 18:00Z land in three different Berlin hours).
    expect(txCreate).toHaveBeenCalledTimes(3);

    // PULSE recompute happens EXACTLY once — the pre-fold capture. A second
    // (post-fold) PULSE recompute would aggregate the hourly mean rows and
    // degrade min/max to hourly-mean extremes (and the DAY mean to an
    // unweighted mean-of-hourly-means), erasing the intraday bounds.
    const pulseRecomputes = recomputeBucketsForMeasurement.mock.calls.filter(
      (c) => c[1] === "PULSE",
    );
    expect(pulseRecomputes).toHaveLength(1);
  });
});

describe("PULSE fold — derived resting row for proxy users", () => {
  it("mints a COMPUTED RESTING_HEART_RATE row from the day's 20th percentile when no native resting exists", async () => {
    const rows = [
      ...[58, 59, 60, 61, 62].map((v, i) =>
        pulseRow(`a${i}`, v, "2026-05-01T07:00:00.000Z"),
      ),
      pulseRow("w", 155, "2026-05-01T18:00:00.000Z"),
    ];
    const { mock, upsert } = buildPrismaMock({
      pulseRows: rows,
      hasNativeResting: false,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const arg = upsert.mock.calls[0]?.[0] as {
      create: { type: string; source: string; value: number; unit: string };
      where: {
        userId_type_source_externalId: { source: string; externalId: string };
      };
    };
    expect(arg.create.type).toBe("RESTING_HEART_RATE");
    // COMPUTED keeps it off both unique indexes Apple's own resting rows use.
    expect(arg.create.source).toBe("COMPUTED");
    expect(arg.where.userId_type_source_externalId.source).toBe("COMPUTED");
    expect(
      arg.where.userId_type_source_externalId.externalId.startsWith(
        "stats:HKQuantityTypeIdentifierRestingHeartRate:",
      ),
    ).toBe(true);
    // Resting value is in the low band, not the workout-polluted mean.
    expect(arg.create.value).toBeLessThan(70);
    expect(summary.totals.derivedRestingRowsUpserted).toBe(1);
  });

  it("does NOT mint a derived resting row when the user already has native resting (no double-count)", async () => {
    const rows = [58, 59, 60, 61, 62].map((v, i) =>
      pulseRow(`a${i}`, v, "2026-05-01T07:00:00.000Z"),
    );
    const { mock, upsert } = buildPrismaMock({
      pulseRows: rows,
      hasNativeResting: true,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(summary.totals.derivedRestingRowsUpserted).toBe(0);
  });

  it("does NOT mint a derived resting row for a day below the sample floor", async () => {
    const rows = [
      pulseRow("a", 130, "2026-05-01T18:00:00.000Z"),
      pulseRow("b", 135, "2026-05-01T18:05:00.000Z"),
    ];
    const { mock, upsert } = buildPrismaMock({
      pulseRows: rows,
      hasNativeResting: false,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    expect(upsert).not.toHaveBeenCalled();
    expect(summary.totals.derivedRestingRowsUpserted).toBe(0);
  });

  it("probes native resting once per user (memoised across days)", async () => {
    const rows = [
      ...[58, 59, 60, 61, 62].map((v, i) =>
        pulseRow(`a${i}`, v, "2026-05-01T07:00:00.000Z"),
      ),
      ...[57, 58, 59, 60, 61].map((v, i) =>
        pulseRow(`b${i}`, v, "2026-05-02T07:00:00.000Z"),
      ),
    ];
    const { mock, upsert, topFindFirst } = buildPrismaMock({
      pulseRows: rows,
      hasNativeResting: false,
    });

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    // Two folded days → two derived resting rows, but the native probe runs
    // once (memoised).
    expect(summary.totals.derivedRestingRowsUpserted).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(topFindFirst).toHaveBeenCalledTimes(1);
  });
});

describe("PULSE fold — idempotency + dry-run", () => {
  it("converges to zero work when the scan returns no live rows (re-run)", async () => {
    const { mock, upsert, txCreate } = buildPrismaMock({
      pulseRows: [],
      hasNativeResting: false,
    });
    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });
    expect(txCreate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(summary.totals.daysConsolidated).toBe(0);
    expect(summary.totals.derivedRestingRowsUpserted).toBe(0);
  });

  it("writes nothing on a dry-run (no fold, no pre-fold recompute, no resting mint)", async () => {
    const rows = [58, 59, 60, 61, 62].map((v, i) =>
      pulseRow(`a${i}`, v, "2026-05-01T07:00:00.000Z"),
    );
    const { mock, upsert, txCreate } = buildPrismaMock({
      pulseRows: rows,
      hasNativeResting: false,
    });
    await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      dryRun: true,
      log: () => {},
    });
    expect(txCreate).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(recomputeBucketsForMeasurement).not.toHaveBeenCalled();
  });
});

describe("PULSE fold — per-day failure boundary", () => {
  it("steps over a day whose fold throws and keeps draining the rest", async () => {
    const day1 = [58, 59, 60, 61, 62].map((v, i) =>
      pulseRow(`a${i}`, v, "2026-05-01T07:00:00.000Z"),
    );
    const day2 = [57, 58, 59, 60, 61].map((v, i) =>
      pulseRow(`b${i}`, v, "2026-05-02T07:00:00.000Z"),
    );
    const { mock, upsert } = buildPrismaMock({
      pulseRows: [...day1, ...day2],
      hasNativeResting: false,
    });

    // Make the FIRST day's fold transaction throw a non-P2002 error; the
    // boundary must absorb it and continue to the second day.
    let call = 0;
    (mock.$transaction as ReturnType<typeof vi.fn>).mockImplementation(
      async (cb: (t: unknown) => Promise<unknown>) => {
        call += 1;
        if (call === 1) throw new Error("boom — poisoned day");
        return cb({
          measurement: {
            create: vi.fn().mockResolvedValue({ id: "minted" }),
            update: vi.fn(),
            findFirst: vi.fn().mockResolvedValue(null),
            updateMany: vi.fn().mockResolvedValue({ count: 5 }),
            findMany: candidateLookup(),
            createManyAndReturn: createManyVia(
              vi.fn().mockResolvedValue({ id: "minted" }),
            ),
          },
        });
      },
    );

    const summary = await runDenseIntradayRetention(mock, {
      retentionDays: 0,
      log: () => {},
    });

    // The second day still folded + minted its resting row despite the first
    // day's failure — the boundary isolated the poison.
    expect(summary.totals.daysConsolidated).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
