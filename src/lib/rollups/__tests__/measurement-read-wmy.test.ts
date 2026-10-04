/**
 * v1.4.39 W-WMY — unit tests for the WEEK / MONTH / YEAR rollup
 * readers and the auto-router that picks the largest granularity
 * that still resolves a requested window.
 *
 * Prisma is mocked at the module level (DAY rows through `findMany`, the
 * coarse fold through `$queryRaw`, the chart span through `aggregate`), so
 * the test pins:
 *   - DAY reads the DAY tier; WEEK / MONTH / YEAR read the SQL fold of the
 *     canonical DAY buckets (the per-day source pick and the fold are SQL,
 *     pinned against real Postgres in
 *     `tests/integration/rollup-per-day-canonical.test.ts`),
 *   - a coarse bucket's spread and slope compose from its days'
 *     accumulators,
 *   - empty rollups return `null` so the caller can branch on
 *     coverage miss,
 *   - the auto-router picks the coarsest granularity whose floor the
 *     window clears,
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
  aggregate: vi.fn(),
  queryRaw: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurementRollup: {
      findMany: mocks.findMany,
      aggregate: mocks.aggregate,
    },
    $queryRaw: mocks.queryRaw,
    user: {
      findUnique: mocks.userFindUnique,
    },
  },
}));

import {
  aggregateWmyBuckets,
  pickRollupGranularityForWindow,
  readBestGranularityRollups,
  readTieredRollupSeries,
  type RollupBucketRow,
} from "../measurement-read-wmy";
import { bucketTimeSeries, pickBucket } from "@/lib/charts/bucket-time-series";

const { findMany, aggregate, queryRaw } = mocks;
const DAY_MS = 86_400_000;
const ORIGIN_DAYS = 18262;

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

/** One stored DAY rollup row, as the DAY `findMany` returns it. */
function dayRow(day: string, source: string, count: number, mean: number) {
  const bucketStart = new Date(`${day}T00:00:00.000Z`);
  return {
    bucketStart,
    source,
    count,
    mean,
    minValue: mean,
    maxValue: mean,
    sumValue: count * mean,
    sd: 0,
    slope: null,
    r2: null,
    sumX: null,
    sumXy: null,
    sumXx: null,
    sumYy: null,
    computedAt: new Date("2026-06-01T00:00:00.000Z"),
  };
}

/**
 * One coarse bucket as the SQL fold returns it, from `(day, value)` single
 * readings; the accumulators are the sums a real fold would carry.
 */
function folded(
  bucketStart: string,
  readings: Array<[string, number]>,
  withAccumulators = true,
) {
  let sumX = 0;
  let sumXy = 0;
  let sumXx = 0;
  let sumYy = 0;
  let sumY = 0;
  for (const [day, value] of readings) {
    const x = Date.parse(`${day}T12:00:00.000Z`) / DAY_MS - ORIGIN_DAYS;
    sumX += x;
    sumXy += x * value;
    sumXx += x * x;
    sumYy += value * value;
    sumY += value;
  }
  const values = readings.map(([, v]) => v);
  const byDay = new Map<string, number[]>();
  for (const [day, value] of readings) {
    byDay.set(day, [...(byDay.get(day) ?? []), value]);
  }
  const dayMeans = [...byDay.values()].map(
    (v) => v.reduce((s, x) => s + x, 0) / v.length,
  );
  return {
    bucket_start: new Date(bucketStart),
    count: readings.length,
    days: byDay.size,
    sum_day_mean: dayMeans.reduce((s, x) => s + x, 0),
    sum_y: sumY,
    min_value: Math.min(...values),
    max_value: Math.max(...values),
    sum_x: withAccumulators ? sumX : null,
    sum_xy: withAccumulators ? sumXy : null,
    sum_xx: withAccumulators ? sumXx : null,
    sum_yy: withAccumulators ? sumYy : null,
    computed_at: new Date("2026-06-01T00:00:00.000Z"),
  };
}

/** The SQL text and bound values of a `$queryRaw` call, as one string. */
function sqlOf(call: unknown[]): string {
  return JSON.stringify(call);
}

beforeEach(() => {
  findMany.mockReset();
  findMany.mockResolvedValue([]);
  aggregate.mockReset();
  aggregate.mockResolvedValue({
    _min: { bucketStart: null },
    _max: { bucketStart: null },
  });
  queryRaw.mockReset();
  queryRaw.mockResolvedValue([]);
  mocks.userFindUnique.mockReset();
  mocks.userFindUnique.mockResolvedValue({ sourcePriorityJson: null });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readBestGranularityRollups", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null on a non-positive window", async () => {
    expect(await readBestGranularityRollups("user", "WEIGHT", 0)).toBeNull();
    expect(await readBestGranularityRollups("user", "WEIGHT", -10)).toBeNull();
    expect(await readBestGranularityRollups("user", "WEIGHT", NaN)).toBeNull();
    expect(findMany).not.toHaveBeenCalled();
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("routes a 90-day window to the DAY tier", async () => {
    findMany.mockResolvedValueOnce([dayRow("2025-12-20", "MANUAL", 1, 80)]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 90);
    expect(result?.granularity).toBe("DAY");
    expect(findMany.mock.calls[0][0].where.granularity).toBe("DAY");
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it.each([
    [120, "WEEK", "week"],
    [365, "MONTH", "month"],
    [1095, "YEAR", "year"],
  ] as const)(
    "routes a %i-day window to %s, folded from the DAY tier in SQL",
    async (windowDays, granularity, unit) => {
      queryRaw.mockResolvedValueOnce([
        folded("2025-12-01T00:00:00.000Z", [["2025-12-02", 80]]),
      ]);
      const result = await readBestGranularityRollups(
        "user",
        "WEIGHT",
        windowDays,
      );
      expect(result?.granularity).toBe(granularity);
      expect(queryRaw).toHaveBeenCalledTimes(1);
      const sql = sqlOf(queryRaw.mock.calls[0]);
      expect(sql).toContain(`'${unit}'`);
      // The fold reads the DAY rows and picks one source per day.
      expect(sql).toContain(`granularity\\" = 'DAY'`);
      expect(sql).toContain("DISTINCT ON");
      expect(findMany).not.toHaveBeenCalled();
    },
  );

  it("returns null when the window holds no buckets", async () => {
    const result = await readBestGranularityRollups("user", "WEIGHT", 1095);
    expect(result).toBeNull();
    // YEAR, MONTH and WEEK folds, then the DAY tier.
    expect(queryRaw).toHaveBeenCalledTimes(3);
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("steps one tier finer when the data sits only in the leading partial bucket", async () => {
    // A 731-day window on 2026-09-26 starts 2024-09-25. October to December
    // 2024 fold into the YEAR bucket 2024-01-01, which starts before the
    // window and is left out; the MONTH tier starts inside it.
    vi.setSystemTime(new Date("2026-09-26T12:00:00.000Z"));
    const readings: Array<[string, number]> = [
      ["2024-10-05", 80],
      ["2024-11-05", 81],
      ["2024-12-05", 82],
    ];
    queryRaw
      .mockResolvedValueOnce([folded("2024-01-01T00:00:00.000Z", readings)])
      .mockResolvedValueOnce(
        readings.map(([day, value]) =>
          folded(`${day.slice(0, 7)}-01T00:00:00.000Z`, [[day, value]]),
        ),
      );
    const result = await readBestGranularityRollups("user", "WEIGHT", 731);
    expect(result?.granularity).toBe("MONTH");
    expect(result?.rows.map((r) => r.mean)).toEqual([80, 81, 82]);
    expect(sqlOf(queryRaw.mock.calls[0])).toContain("'year'");
    expect(sqlOf(queryRaw.mock.calls[1])).toContain("'month'");
  });

  it("composes a coarse bucket's mean, spread and slope from its days", async () => {
    // Three days of one reading each: 70, 72, 74 → mean 72, slope 2 per
    // day, population sd sqrt(8/3), r² 1.
    queryRaw.mockResolvedValueOnce([
      folded("2025-11-01T00:00:00.000Z", [
        ["2025-11-03", 70],
        ["2025-11-04", 72],
        ["2025-11-05", 74],
      ]),
    ]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 365);
    const month = result?.rows[0];
    expect(month?.count).toBe(3);
    expect(month?.mean).toBeCloseTo(72, 9);
    expect(month?.sumValue).toBe(216);
    expect(month?.slope).toBeCloseTo(2, 6);
    expect(month?.r2).toBeCloseTo(1, 6);
    expect(month?.sd).toBeCloseTo(Math.sqrt(8 / 3), 6);
  });

  it("reports no spread or slope for a bucket with a day lacking accumulators", async () => {
    queryRaw.mockResolvedValueOnce([
      folded(
        "2025-11-01T00:00:00.000Z",
        [
          ["2025-11-03", 70],
          ["2025-11-04", 72],
        ],
        false,
      ),
    ]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 365);
    expect(result?.rows[0].mean).toBe(71);
    expect(result?.rows[0].sd).toBeNull();
    expect(result?.rows[0].slope).toBeNull();
  });

  it("leaves out a bucket that starts before the window", async () => {
    // The 365-day window starts 2025-01-15; January 2025 began before it.
    queryRaw.mockResolvedValueOnce([
      folded("2025-01-01T00:00:00.000Z", [["2025-01-20", 80]]),
      folded("2025-02-01T00:00:00.000Z", [["2025-02-03", 81]]),
    ]);
    const result = await readBestGranularityRollups("user", "WEIGHT", 365);
    expect(result?.rows.map((r) => r.bucketStart.toISOString())).toEqual([
      "2025-02-01T00:00:00.000Z",
    ]);
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
 * Granularity-routing boundaries for the shared WMY reader:
 * 90 days resolves to DAY, 365 days to MONTH, and 1095 days to YEAR.
 * A floor adjustment must update this single routing contract.
 */
describe("readBestGranularityRollups — cross-consumer routing parity", () => {
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

/**
 * v1.19.2 W-CHARTS — whole-history series reader. Pins that a very long
 * "Alle" window reads the display-matching coarse tier (WEEK for 1–2 y,
 * MONTH beyond) and returns coverage spanning the FULL span rather than a
 * truncated recent slice; that the finer fallback rescues a coverage
 * miss; and that the wire shape mirrors the daily reader.
 */
/**
 * Whole-history series reader. Pins that a very long "Alle" window reads
 * the display-matching tier (chosen from the real span of the data, WEEK for
 * 1–2 years, MONTH beyond), that it spans the whole history, and that the
 * wire shape mirrors the daily reader.
 */
describe("readTieredRollupSeries", () => {
  const NOW = new Date("2026-06-21T00:00:00.000Z");
  const win = (days: number, to: Date = NOW) => ({
    from: new Date(to.getTime() - days * DAY_MS),
    to,
  });
  const spanOf = (first: string, last: string) => ({
    _min: { bucketStart: new Date(first) },
    _max: { bucketStart: new Date(last) },
  });

  it("returns null on a non-positive window without touching the db", async () => {
    expect(
      await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        from: NOW,
        to: NOW,
      }),
    ).toBeNull();
    expect(aggregate).not.toHaveBeenCalled();
  });

  it("returns null when the window holds no DAY buckets", async () => {
    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });
    expect(result).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("serves MONTH buckets over a multi-year history and keeps the oldest", async () => {
    aggregate.mockResolvedValueOnce(
      spanOf("2017-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"),
    );
    queryRaw.mockResolvedValueOnce([
      folded("2017-01-01T00:00:00.000Z", [["2017-01-01", 80]]),
      folded("2026-01-01T00:00:00.000Z", [["2026-01-01", 82]]),
    ]);

    const result = await readTieredRollupSeries({
      userId: "u",
      type: "WEIGHT",
      ...win(3650),
    });

    expect(result?.granularity).toBe("MONTH");
    expect(sqlOf(queryRaw.mock.calls[0])).toContain("'month'");
    expect(result?.rows[0].measuredAt).toBe("2017-01-01T12:00:00.000Z");
    expect(result?.rows).toHaveLength(2);
  });

  // v1.26.0 SEAM-N2 — a historic window entirely in the past bounds the read
  // on BOTH ends.
  it("bounds the span read on both ends for a historic window", async () => {
    const from = new Date("2020-01-01T00:00:00.000Z");
    const to = new Date("2022-01-01T00:00:00.000Z");
    await readTieredRollupSeries({ userId: "u", type: "WEIGHT", from, to });
    expect(aggregate.mock.calls[0][0].where.bucketStart).toEqual({
      gte: from,
      lte: to,
    });
  });

  // The chart folds its shorter ranges (and the live fallback) from day
  // points into the average day of each week or month. A tier row must be the
  // same quantity, whichever tier the history's length selects.
  describe("the average day at every tier", () => {
    // January 2026: steps on 20 of its days, from 4 000 to 13 500.
    const JAN = Array.from({ length: 20 }, (_, i): [string, number] => [
      `2026-01-${String(i + 1).padStart(2, "0")}`,
      4_000 + i * 500,
    ]);
    const averageDay = JAN.reduce((s, [, v]) => s + v, 0) / JAN.length;

    /** How the chart folds a tier's rows into the month on screen. */
    function chartMonth(rows: Array<{ measuredAt: string; value: number }>) {
      return bucketTimeSeries(
        rows.map((row) => ({
          timestamp: new Date(row.measuredAt),
          values: { v: row.value },
        })),
        { bucket: "month", timeZone: "Europe/Berlin" },
      ).points.map((p) => p.values.v);
    }

    it("serves a MONTH row of a long history as its average day", async () => {
      aggregate.mockResolvedValueOnce(
        spanOf("2023-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z"),
      );
      queryRaw.mockResolvedValueOnce([folded("2026-01-01T00:00:00.000Z", JAN)]);
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "ACTIVITY_STEPS",
        ...win(3650),
      });
      expect(result?.granularity).toBe("MONTH");
      expect(result?.rows[0].value).toBe(averageDay);
      expect(result?.rows[0].count).toBe(JAN.length);
      expect(result?.rows[0].minValue).toBeUndefined();
      expect(result?.rows[0].maxValue).toBeUndefined();
    });

    it("gives the same month for a short history served by days", async () => {
      aggregate.mockResolvedValueOnce(
        spanOf("2026-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z"),
      );
      findMany.mockResolvedValueOnce(
        JAN.map(([day, value]) => dayRow(day, "APPLE_HEALTH", 1, value)),
      );
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "ACTIVITY_STEPS",
        ...win(3650),
      });
      expect(result?.granularity).toBe("DAY");
      expect(chartMonth(result!.rows)).toEqual([averageDay]);
    });

    it("gives each WEEK row of a middle-length history its own average day", async () => {
      aggregate.mockResolvedValueOnce(
        spanOf("2025-01-01T00:00:00.000Z", "2026-01-20T00:00:00.000Z"),
      );
      const week = JAN.slice(4, 11); // Monday 5 to Sunday 11 January
      queryRaw.mockResolvedValueOnce([
        folded("2026-01-05T00:00:00.000Z", week),
      ]);
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "ACTIVITY_STEPS",
        ...win(3650),
      });
      expect(result?.granularity).toBe("WEEK");
      expect(result?.rows[0].value).toBe(
        week.reduce((s, [, v]) => s + v, 0) / week.length,
      );
    });

    it("weighs each day once for a level, as the chart's own fold does", async () => {
      // Two readings on the 3rd (120, 130), one on the 4th (100): the
      // average day is 112.5, while every reading weighing one gives 116.7.
      const readings: Array<[string, number]> = [
        ["2026-01-03", 120],
        ["2026-01-03", 130],
        ["2026-01-04", 100],
      ];
      aggregate.mockResolvedValueOnce(
        spanOf("2023-01-01T00:00:00.000Z", "2026-01-04T00:00:00.000Z"),
      );
      queryRaw.mockResolvedValueOnce([
        folded("2026-01-01T00:00:00.000Z", readings),
      ]);
      const monthly = await readTieredRollupSeries({
        userId: "u",
        type: "BLOOD_PRESSURE_SYS",
        ...win(3650),
      });
      expect(monthly?.rows[0].value).toBe(112.5);

      aggregate.mockResolvedValueOnce(
        spanOf("2026-01-03T00:00:00.000Z", "2026-01-04T00:00:00.000Z"),
      );
      findMany.mockResolvedValueOnce([
        dayRow("2026-01-03", "MANUAL", 2, 125),
        dayRow("2026-01-04", "MANUAL", 1, 100),
      ]);
      const daily = await readTieredRollupSeries({
        userId: "u",
        type: "BLOOD_PRESSURE_SYS",
        ...win(3650),
      });
      expect(chartMonth(daily!.rows)).toEqual([112.5]);
    });
  });

  // v1.37.29 — the tier keys off the ACTUAL data span, not the requested
  // window width.
  describe("span refinement", () => {
    it("serves DAY rows for four months of data on an All request", async () => {
      aggregate.mockResolvedValueOnce(
        spanOf("2026-02-03T00:00:00.000Z", "2026-05-28T00:00:00.000Z"),
      );
      findMany.mockResolvedValueOnce([
        dayRow("2026-02-03", "MANUAL", 1, 80),
        dayRow("2026-05-28", "MANUAL", 1, 81),
      ]);
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });
      expect(result?.granularity).toBe("DAY");
      expect(queryRaw).not.toHaveBeenCalled();
      expect(result?.rows[0].measuredAt).toBe("2026-02-03T12:00:00.000Z");
    });

    it("serves WEEK buckets for a span between one and two years", async () => {
      aggregate.mockResolvedValueOnce(
        spanOf("2025-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"),
      );
      queryRaw.mockResolvedValueOnce([
        folded("2024-12-30T00:00:00.000Z", [["2025-01-01", 80]]),
      ]);
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });
      expect(result?.granularity).toBe("WEEK");
      expect(sqlOf(queryRaw.mock.calls[0])).toContain("'week'");
    });
  });

  // The chart names a row by the date its `measuredAt` falls on in the
  // person's zone and folds it into that week or month. A bucket stamped at
  // UTC midnight read as the day before west of UTC, so every month of the
  // "All" range sat one month early there.
  describe("row stamp", () => {
    const ZONES = [
      "Pacific/Pago_Pago",
      "America/Los_Angeles",
      "UTC",
      "Europe/Berlin",
      "Pacific/Auckland",
      "Pacific/Kiritimati",
    ];

    it("puts each month in its own month in every zone", async () => {
      aggregate.mockResolvedValueOnce(
        spanOf("2023-01-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"),
      );
      queryRaw.mockResolvedValueOnce([
        folded("2026-01-01T00:00:00.000Z", [["2026-01-01", 80]]),
        folded("2026-02-01T00:00:00.000Z", [["2026-02-01", 81]]),
        folded("2026-03-01T00:00:00.000Z", [["2026-03-01", 82]]),
      ]);
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });
      expect(result?.granularity).toBe("MONTH");
      for (const timeZone of ZONES) {
        const months = bucketTimeSeries(
          result!.rows.map((row) => ({
            timestamp: new Date(row.measuredAt),
            values: { v: row.value },
          })),
          { bucket: "month", timeZone },
        ).points.map((p) => new Date(p.timestamp).toISOString().slice(0, 7));
        expect(months, timeZone).toEqual(["2026-01", "2026-02", "2026-03"]);
      }
    });

    it("puts each week in its own ISO week in every zone", async () => {
      aggregate.mockResolvedValueOnce(
        spanOf("2025-01-01T00:00:00.000Z", "2026-05-01T00:00:00.000Z"),
      );
      queryRaw.mockResolvedValueOnce([
        folded("2025-12-29T00:00:00.000Z", [["2025-12-29", 80]]),
        folded("2026-01-05T00:00:00.000Z", [["2026-01-05", 81]]),
      ]);
      const result = await readTieredRollupSeries({
        userId: "u",
        type: "WEIGHT",
        ...win(3650),
      });
      expect(result?.granularity).toBe("WEEK");
      for (const timeZone of ZONES) {
        const weeks = bucketTimeSeries(
          result!.rows.map((row) => ({
            timestamp: new Date(row.measuredAt),
            values: { v: row.value },
          })),
          { bucket: "week", timeZone },
        ).points.map((p) => new Date(p.timestamp).toISOString().slice(0, 10));
        expect(weeks, timeZone).toEqual(["2025-12-29", "2026-01-05"]);
      }
    });
  });
});

// v1.37.29 — the server tier ladder and the client caption ladder
// (`pickBucket`) are DIFFERENT functions with different thresholds, and
// their divergence is exactly what shipped monthly means under a
// "weekly average" chip. The invariant that keeps the caption honest is
// directional: for any data span, the tier the server serves is never
// COARSER than the bucket the client captions — the client may fold
// finer rows up to its caption, but it cannot split coarser ones.
describe("server tier vs client caption ladder", () => {
  const SERVER_COARSENESS = { DAY: 0, WEEK: 1, MONTH: 2, YEAR: 3 } as const;
  const CLIENT_COARSENESS = { day: 0, week: 1, month: 2 } as const;

  it("never serves coarser than the client captions, for every span up to ten years", () => {
    for (let span = 1; span <= 3650; span++) {
      const server = pickRollupGranularityForWindow(span);
      const client = pickBucket(span);
      expect(
        SERVER_COARSENESS[server],
        `span ${span}d: server ${server} vs client caption ${client}`,
      ).toBeLessThanOrEqual(CLIENT_COARSENESS[client]);
    }
  });
});

describe("aggregateWmyBuckets, one weight per day", () => {
  // A week of seven days and a week of two, both read at their own mean. With
  // one weight per day the longer week counts for its seven days, not for its
  // readings.
  const week = (
    days: number,
    count: number,
    mean: number,
  ): Parameters<typeof aggregateWmyBuckets>[0][number] => ({
    bucketStart: new Date("2026-05-04T00:00:00.000Z"),
    count,
    days,
    mean,
    sd: null,
    slope: null,
    r2: null,
    sumValue: null,
    minValue: mean - 5,
    maxValue: mean + 5,
  });

  it("weighs a bucket by its readings by default", () => {
    const result = aggregateWmyBuckets([week(7, 3000, 60), week(2, 1000, 90)]);
    expect(result.mean).toBeCloseTo((3000 * 60 + 1000 * 90) / 4000, 9);
  });

  it("weighs a bucket by the days it holds when asked", () => {
    const result = aggregateWmyBuckets(
      [week(7, 3000, 60), week(2, 1000, 90)],
      "day",
    );
    expect(result.mean).toBeCloseTo((7 * 60 + 2 * 90) / 9, 9);
    expect(result.count).toBe(4000);
  });

  it("treats a row with no day count as one day", () => {
    const row = { ...week(1, 10, 70), days: undefined };
    expect(aggregateWmyBuckets([row], "day").mean).toBe(70);
  });
});
