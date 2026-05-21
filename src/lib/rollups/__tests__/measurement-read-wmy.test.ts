/**
 * v1.4.39 W-WMY — unit tests for the WEEK / MONTH / YEAR rollup
 * readers and the auto-router that picks the largest granularity
 * that still resolves a requested window.
 *
 * `prisma.measurementRollup.findMany` is mocked at the module level
 * so the test pins:
 *   - each per-granularity reader filters by the correct
 *     `granularity` literal,
 *   - empty rollups return `null` so the caller can branch on
 *     coverage miss,
 *   - the auto-router walks YEAR → MONTH → WEEK → DAY and stops at
 *     the first granularity whose floor the window clears AND which
 *     has coverage,
 *   - `aggregateWmyBuckets` composes `count / min / max / mean / sum`
 *     linearly across coarser buckets (the same compositional
 *     contract `rollup-read.ts:aggregateBuckets` carries for DAY).
 *
 * Integration coverage against a real Postgres lives outside this
 * file — the writer's `STDDEV_POP / REGR_SLOPE` semantics are pinned
 * in `tests/integration/measurement-rollups.test.ts` already.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurementRollup: {
      findMany: mocks.findMany,
    },
  },
}));

import {
  aggregateWmyBuckets,
  readBestGranularityRollups,
  type RollupBucketRow,
} from "../measurement-read-wmy";

const { findMany } = mocks;

function bucket(
  bucketStart: string,
  partial: Partial<RollupBucketRow> = {},
): RollupBucketRow {
  return {
    bucketStart: new Date(bucketStart),
    count: 10,
    mean: 82,
    sd: 1,
    slope: -0.01,
    r2: 0.3,
    sumValue: null,
    minValue: 80,
    maxValue: 84,
    ...partial,
  };
}

beforeEach(() => {
  findMany.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readBestGranularityRollups", () => {
  it("returns null on a non-positive window", async () => {
    expect(await readBestGranularityRollups("user", "WEIGHT", 0)).toBeNull();
    expect(await readBestGranularityRollups("user", "WEIGHT", -10)).toBeNull();
    expect(await readBestGranularityRollups("user", "WEIGHT", NaN)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("routes a 90-day window to DAY (every coarser floor is too low)", async () => {
    findMany.mockResolvedValueOnce([bucket("2026-04-01T00:00:00.000Z")]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 90);
    expect(result).not.toBeNull();
    expect(result?.granularity).toBe("DAY");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("DAY");
  });

  it("routes a 365-day window to MONTH (clears the 62-day MONTH floor)", async () => {
    findMany.mockResolvedValueOnce([bucket("2026-01-01T00:00:00.000Z")]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 365);
    expect(result).not.toBeNull();
    expect(result?.granularity).toBe("MONTH");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("MONTH");
  });

  it("routes a 1095-day window to YEAR (clears the 730-day YEAR floor)", async () => {
    findMany.mockResolvedValueOnce([bucket("2024-01-01T00:00:00.000Z")]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);
    expect(result).not.toBeNull();
    expect(result?.granularity).toBe("YEAR");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("YEAR");
  });

  it("falls back to MONTH when YEAR has no coverage", async () => {
    // 1095-day window asks for YEAR first; coverage miss → MONTH.
    findMany
      .mockResolvedValueOnce([]) // YEAR miss
      .mockResolvedValueOnce([bucket("2024-01-01T00:00:00.000Z")]); // MONTH hit

    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);

    expect(result?.granularity).toBe("MONTH");
    expect(findMany.mock.calls[0][0].where.granularity).toBe("YEAR");
    expect(findMany.mock.calls[1][0].where.granularity).toBe("MONTH");
  });

  it("falls all the way through to DAY when every coarser tier misses", async () => {
    findMany
      .mockResolvedValueOnce([]) // YEAR miss
      .mockResolvedValueOnce([]) // MONTH miss
      .mockResolvedValueOnce([]) // WEEK miss
      .mockResolvedValueOnce([bucket("2024-01-01T00:00:00.000Z")]); // DAY hit

    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);

    expect(result?.granularity).toBe("DAY");
    expect(findMany).toHaveBeenCalledTimes(4);
  });

  it("returns null when no granularity carries any coverage", async () => {
    findMany.mockResolvedValue([]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);
    expect(result).toBeNull();
    // YEAR, MONTH, WEEK, DAY all probed.
    expect(findMany).toHaveBeenCalledTimes(4);
  });
});

describe("aggregateWmyBuckets", () => {
  it("returns the empty-window shape on no rows", () => {
    expect(aggregateWmyBuckets([])).toEqual({
      count: 0,
      min: null,
      max: null,
      mean: null,
      sum: null,
    });
  });

  it("sums count + folds min/max + weights mean across MONTH buckets", () => {
    // Two MONTH buckets — same compositional contract as DAY because
    // `count / min / max / mean` are linearly composable across any
    // bucket granularity.
    //   April: count=10, mean=82, min=79, max=84
    //   May:   count=20, mean=80, min=77, max=83
    //   ⇒ totalCount=30, min=77, max=84,
    //      mean = (10×82 + 20×80) / 30 = 80.6666…
    const rows: RollupBucketRow[] = [
      bucket("2026-04-01T00:00:00.000Z", {
        count: 10,
        mean: 82,
        minValue: 79,
        maxValue: 84,
      }),
      bucket("2026-05-01T00:00:00.000Z", {
        count: 20,
        mean: 80,
        minValue: 77,
        maxValue: 83,
      }),
    ];
    const result = aggregateWmyBuckets(rows);
    expect(result.count).toBe(30);
    expect(result.min).toBe(77);
    expect(result.max).toBe(84);
    expect(result.mean).toBeCloseTo((10 * 82 + 20 * 80) / 30, 5);
  });

  it("sums cumulative sumValue when every bucket carries one", () => {
    const rows: RollupBucketRow[] = [
      bucket("2026-04-01T00:00:00.000Z", { sumValue: 12_500 }),
      bucket("2026-05-01T00:00:00.000Z", { sumValue: 8_200 }),
    ];
    const result = aggregateWmyBuckets(rows);
    expect(result.sum).toBe(20_700);
  });

  it("returns null sum when no bucket carries sumValue (pre-W-SUM data)", () => {
    const rows: RollupBucketRow[] = [
      bucket("2026-04-01T00:00:00.000Z", { sumValue: null }),
      bucket("2026-05-01T00:00:00.000Z", { sumValue: null }),
    ];
    expect(aggregateWmyBuckets(rows).sum).toBeNull();
  });

  it("treats sumValue NaN/Infinity as missing", () => {
    const rows: RollupBucketRow[] = [
      bucket("2026-04-01T00:00:00.000Z", { sumValue: 100 }),
      bucket("2026-05-01T00:00:00.000Z", {
        // simulate a Postgres NaN slipping through serialisation.
        sumValue: Number.NaN,
      }),
    ];
    // Only the finite sumValue contributes.
    expect(aggregateWmyBuckets(rows).sum).toBe(100);
  });
});

/**
 * v1.4.40 W-WMY-WIRE — granularity-routing parity across the v1.4.40
 * consumers (summaries-slice + health-score-fast-path). Both consumers
 * now call `readBestGranularityRollups` for their long-window probes;
 * this pins:
 *   - 90 d → DAY (every coarser floor too high — DAY is canonical
 *     for the trailing quarter regardless of consumer),
 *   - 365 d → MONTH (clears MONTH floor 181 d, short of YEAR floor
 *     731 d) — the granularity health-score-fast-path's weight long-
 *     window read and summaries-slice's year-ago baseline both
 *     consume,
 *   - 1095 d → YEAR (clears the 731-day YEAR floor) — the v1.5
 *     multi-year trend card target.
 *
 * The parity assertion ensures the routing contract is a single
 * source of truth: any future floor adjustment forces both consumers
 * to re-pin in lock-step rather than silently diverging.
 */
describe("readBestGranularityRollups — cross-consumer routing parity", () => {
  it("pins the 90 / 365 / 1095 day routing targets the consumers depend on", async () => {
    // Three sequential probes with non-empty results so the router
    // stops at the first matching tier per window.
    findMany
      .mockResolvedValueOnce([bucket("2026-02-15T00:00:00.000Z")]) // 90d → DAY
      .mockResolvedValueOnce([bucket("2025-08-01T00:00:00.000Z")]) // 365d → MONTH
      .mockResolvedValueOnce([bucket("2024-01-01T00:00:00.000Z")]); // 1095d → YEAR

    const ninety = await readBestGranularityRollups("user", "WEIGHT", 90);
    const yearLong = await readBestGranularityRollups("user", "WEIGHT", 365);
    const threeYear = await readBestGranularityRollups("user", "WEIGHT", 1095);

    expect(ninety?.granularity).toBe("DAY");
    expect(yearLong?.granularity).toBe("MONTH");
    expect(threeYear?.granularity).toBe("YEAR");
    // Each consumer-relevant window only fires one round-trip on the
    // happy path; the per-tier walk is reserved for coverage-miss
    // scenarios already pinned above.
    expect(findMany).toHaveBeenCalledTimes(3);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("DAY");
    expect(findMany.mock.calls[1][0].where.granularity).toBe("MONTH");
    expect(findMany.mock.calls[2][0].where.granularity).toBe("YEAR");
  });

  it("aggregates MONTH buckets to a byte-identical mean compared to the underlying DAY buckets", async () => {
    // The compositional contract `count / mean` are linearly
    // composable across granularities — pin it by simulating "MONTH
    // routing for a 365-day window" vs "DAY routing for the same
    // window" against the same underlying counts/means and asserting
    // the count-weighted mean agrees.
    //
    // MONTH bucket (consolidated):    count=30, mean=80
    // DAY buckets (per-day refresh):  count=10/mean=82 + count=20/mean=79
    //   ⇒ DAY-derived mean = (10*82 + 20*79) / 30 = 80.0
    // Both must agree numerically — the routing helper's choice is a
    // performance optimisation, not a math change.
    const monthBuckets: RollupBucketRow[] = [
      bucket("2025-08-01T00:00:00.000Z", { count: 30, mean: 80 }),
    ];
    const dayBuckets: RollupBucketRow[] = [
      bucket("2025-08-05T00:00:00.000Z", { count: 10, mean: 82 }),
      bucket("2025-08-20T00:00:00.000Z", { count: 20, mean: 79 }),
    ];
    const monthAgg = aggregateWmyBuckets(monthBuckets);
    const dayAgg = aggregateWmyBuckets(dayBuckets);

    expect(monthAgg.count).toBe(dayAgg.count);
    expect(monthAgg.mean).toBeCloseTo(dayAgg.mean ?? Number.NaN, 5);
  });
});
