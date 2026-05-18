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
  readMonthRollups,
  readWeekRollups,
  readYearRollups,
  type RollupBucketRow,
} from "../rollup-read-wmy";

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

describe("readWeekRollups", () => {
  it("returns the WEEK buckets for (userId, type, since)", async () => {
    const rows = [
      bucket("2026-04-27T00:00:00.000Z"),
      bucket("2026-05-04T00:00:00.000Z", { mean: 81 }),
    ];
    findMany.mockResolvedValueOnce(rows);
    const since = new Date("2026-04-20T00:00:00.000Z");

    const result = await readWeekRollups("user-1", "WEIGHT", since);

    expect(result).not.toBeNull();
    expect(result).toHaveLength(2);
    expect(result?.[0].mean).toBe(82);
    expect(result?.[1].mean).toBe(81);
    const args = findMany.mock.calls[0][0];
    expect(args.where.granularity).toBe("WEEK");
    expect(args.where.userId).toBe("user-1");
    expect(args.where.type).toBe("WEIGHT");
    expect(args.where.bucketStart.gte).toBe(since);
    expect(args.orderBy).toEqual({ bucketStart: "asc" });
  });

  it("returns null when the WEEK window has no coverage", async () => {
    findMany.mockResolvedValueOnce([]);
    const result = await readWeekRollups(
      "user-1",
      "WEIGHT",
      new Date("2026-04-20T00:00:00.000Z"),
    );
    expect(result).toBeNull();
  });
});

describe("readMonthRollups", () => {
  it("returns the MONTH buckets and pins the granularity filter", async () => {
    findMany.mockResolvedValueOnce([bucket("2026-04-01T00:00:00.000Z")]);
    const result = await readMonthRollups(
      "user-2",
      "PULSE",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(result).toHaveLength(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("MONTH");
  });

  it("returns null on coverage miss", async () => {
    findMany.mockResolvedValueOnce([]);
    const result = await readMonthRollups(
      "user-2",
      "PULSE",
      new Date("2026-01-01T00:00:00.000Z"),
    );
    expect(result).toBeNull();
  });
});

describe("readYearRollups", () => {
  it("returns the YEAR buckets and pins the granularity filter", async () => {
    findMany.mockResolvedValueOnce([bucket("2025-01-01T00:00:00.000Z")]);
    const result = await readYearRollups(
      "user-3",
      "WEIGHT",
      new Date("2023-01-01T00:00:00.000Z"),
    );
    expect(result).toHaveLength(1);
    expect(findMany.mock.calls[0][0].where.granularity).toBe("YEAR");
  });

  it("returns null on coverage miss", async () => {
    findMany.mockResolvedValueOnce([]);
    const result = await readYearRollups(
      "user-3",
      "WEIGHT",
      new Date("2023-01-01T00:00:00.000Z"),
    );
    expect(result).toBeNull();
  });
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
