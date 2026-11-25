/**
 * The numbers the tiered context hands the AI: window statistics, the
 * peak / trough envelope and its ranking, the band windows, the options that
 * skip bands, and the live fallback's statements. `tiered-context.test.ts`
 * covers band routing and the local-day fold of the raw band.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RollupGranularity } from "@/generated/prisma/client";

const mocks = vi.hoisted(() => ({
  readRollupBuckets: vi.fn(),
  ensureUserRollupsFresh: vi.fn(),
  measurementFindMany: vi.fn(),
  queryRaw: vi.fn(),
}));

vi.mock("@/lib/measurements/day-aggregates", async () => ({
  readDayAggregates: (
    await import("@/lib/measurements/__tests__/fake-day-aggregates")
  ).fakeReadDayAggregates,
}));

vi.mock("../measurement-rollups", () => ({
  readRollupBuckets: mocks.readRollupBuckets,
  ensureUserRollupsFresh: mocks.ensureUserRollupsFresh,
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: mocks.measurementFindMany },
    $queryRaw: mocks.queryRaw,
  },
}));

import { buildTieredSeries } from "../tiered-context";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 19);
const BERLIN = "Europe/Berlin";

function bucket(
  bucketStart: string,
  mean: number,
  min: number,
  max: number,
  count = 5,
  slope: number | null = null,
) {
  return {
    bucketStart: new Date(bucketStart),
    count,
    mean,
    minValue: min,
    maxValue: max,
    sd: null,
    slope,
    r2: null,
    computedAt: new Date(bucketStart),
  };
}

/** Serve `rows` for one granularity and nothing for the others. */
function serve(byGranularity: Partial<Record<RollupGranularity, unknown[]>>) {
  mocks.readRollupBuckets.mockImplementation(
    async (_u: string, _t: string, g: RollupGranularity) =>
      byGranularity[g] ?? [],
  );
}

/** A flat baseline of `n` buckets at `mean` with a tight envelope. */
function flat(n: number, mean: number, startDay = 1) {
  return Array.from({ length: n }, (_, i) =>
    bucket(
      new Date(Date.UTC(2025, 0, startDay + i * 7)).toISOString(),
      mean,
      mean - 1,
      mean + 1,
    ),
  );
}

beforeEach(() => {
  mocks.ensureUserRollupsFresh.mockResolvedValue({ recomputed: false });
  mocks.measurementFindMany.mockResolvedValue([]);
  mocks.readRollupBuckets.mockResolvedValue([]);
  mocks.queryRaw.mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("window statistics", () => {
  it("averages the bucket means, weights n by readings and skips empty buckets", async () => {
    serve({
      MONTH: [
        bucket("2025-09-01T00:00:00.000Z", 10, 9, 11, 2),
        bucket("2025-10-01T00:00:00.000Z", 20, 19, 21, 3),
        bucket("2025-11-01T00:00:00.000Z", 999, 999, 999, 0),
      ],
    });
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    // Population SD of [10, 20] is 5.
    expect(s.windowStats).toEqual({ mean: 15, sd: 5, n: 5 });
  });

  it("has a mean but no spread for a single bucket", async () => {
    serve({ YEAR: [bucket("2024-01-01T00:00:00.000Z", 80.456, 70, 90, 12)] });
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(s.windowStats).toEqual({ mean: 80.46, sd: null, n: 12 });
    expect(s.anomalies).toEqual([]);
  });

  it("is empty when no band has a bucket", async () => {
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(s.windowStats).toEqual({ mean: null, sd: null, n: 0 });
  });

  it("spans the day, week, month and year bands together", async () => {
    serve({
      DAY: [bucket("2026-05-25T00:00:00.000Z", 10, 10, 10, 1)],
      WEEK: [bucket("2026-04-06T00:00:00.000Z", 20, 20, 20, 1)],
      MONTH: [bucket("2025-12-01T00:00:00.000Z", 30, 30, 30, 1)],
      YEAR: [bucket("2024-01-01T00:00:00.000Z", 40, 40, 40, 1)],
    });
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(s.windowStats.mean).toBe(25);
    expect(s.windowStats.n).toBe(4);
  });
});

describe("the anomaly envelope", () => {
  it("scores nothing when every bucket mean is the same", async () => {
    serve({
      MONTH: [
        ...flat(8, 100),
        bucket("2025-12-01T00:00:00.000Z", 100, 60, 101),
      ],
    });
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    // A flat history has no spread, so nothing is scored however far one
    // reading strays: a zero spread would make every distance infinite.
    expect(s.windowStats.sd).toBe(0);
    expect(s.anomalies).toEqual([]);
  });

  it("scores peaks and troughs against the window mean and spread", async () => {
    // Twelve buckets whose means alternate 90 / 110: mean 100, population
    // sd 10. Five of them carry an extreme in their envelope.
    const extremes: Record<number, { min?: number; max?: number }> = {
      6: { max: 125 }, // +2.5 sd
      7: { min: 70 }, // -3 sd
      8: { max: 120 }, // +2.0 sd, on the threshold
      9: { min: 80 }, // -2.0 sd, on the threshold
      10: { max: 119 }, // +1.9 sd, below it
    };
    const rows = Array.from({ length: 12 }, (_, i) => {
      const mean = i % 2 ? 110 : 90;
      return bucket(
        new Date(Date.UTC(2025, i, 1)).toISOString(),
        mean,
        extremes[i]?.min ?? mean - 1,
        extremes[i]?.max ?? mean + 1,
      );
    });
    serve({ MONTH: rows });
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(s.windowStats).toMatchObject({ mean: 100, sd: 10 });
    expect(s.anomalies).toEqual([
      {
        band: "month",
        date: "2025-08-01T00:00:00.000Z",
        kind: "trough",
        value: 70,
        deltaSd: -3,
      },
      {
        band: "month",
        date: "2025-07-01T00:00:00.000Z",
        kind: "peak",
        value: 125,
        deltaSd: 2.5,
      },
      {
        band: "month",
        date: "2025-09-01T00:00:00.000Z",
        kind: "peak",
        value: 120,
        deltaSd: 2,
      },
      {
        band: "month",
        date: "2025-10-01T00:00:00.000Z",
        kind: "trough",
        value: 80,
        deltaSd: -2,
      },
    ]);
  });

  it("needs at least three readings behind a bucket, and three are enough", async () => {
    const base = Array.from({ length: 6 }, (_, i) =>
      bucket(
        new Date(Date.UTC(2025, i, 1)).toISOString(),
        i % 2 ? 110 : 90,
        i % 2 ? 110 : 90,
        i % 2 ? 110 : 90,
      ),
    );
    serve({
      MONTH: [
        ...base,
        bucket("2025-07-01T00:00:00.000Z", 100, 100, 150, 3),
        bucket("2025-08-01T00:00:00.000Z", 100, 100, 150, 2),
      ],
    });
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(s.anomalies.map((a) => a.date)).toEqual([
      "2025-07-01T00:00:00.000Z",
    ]);
  });

  it("labels each anomaly with the band it came from", async () => {
    const spread = (start: string, i: number) =>
      bucket(start, i % 2 ? 110 : 90, i % 2 ? 110 : 90, i % 2 ? 110 : 90);
    serve({
      DAY: [
        spread("2026-05-21T00:00:00.000Z", 0),
        bucket("2026-05-22T00:00:00.000Z", 100, 100, 140),
      ],
      WEEK: [
        spread("2026-04-06T00:00:00.000Z", 1),
        bucket("2026-04-13T00:00:00.000Z", 100, 55, 100),
      ],
      MONTH: [
        spread("2025-11-01T00:00:00.000Z", 0),
        bucket("2025-12-01T00:00:00.000Z", 100, 100, 145),
      ],
      YEAR: [
        spread("2023-01-01T00:00:00.000Z", 1),
        bucket("2024-01-01T00:00:00.000Z", 100, 50, 100),
      ],
    });
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(
      s.anomalies.map((a) => `${a.band} ${a.kind} ${a.value}`).sort(),
    ).toEqual([
      "day peak 140",
      "month peak 145",
      "week trough 55",
      "year trough 50",
    ]);
  });

  it("keeps the five largest by default and honours a smaller cap", async () => {
    const base = Array.from({ length: 6 }, (_, i) =>
      bucket(
        new Date(Date.UTC(2024, i, 1)).toISOString(),
        i % 2 ? 110 : 90,
        i % 2 ? 110 : 90,
        i % 2 ? 110 : 90,
      ),
    );
    // Seven peaks of rising size; mean stays 100, sd 10 only approximately,
    // so compare the ranking, not the scores.
    const peaks = [130, 160, 140, 170, 150, 135, 180].map((max, i) =>
      bucket(new Date(Date.UTC(2025, i, 1)).toISOString(), 100, 100, max),
    );
    serve({ MONTH: [...base, ...peaks] });

    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(s.anomalies.map((a) => a.value)).toEqual([180, 170, 160, 150, 140]);

    const capped = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: BERLIN,
      maxAnomalies: 2,
    });
    expect(capped.anomalies.map((a) => a.value)).toEqual([180, 170]);
  });
});

describe("band windows and options", () => {
  it("reads each band over its own days-ago window with the caller's priorities", async () => {
    const prio = { WEIGHT: ["MANUAL"] };
    await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: BERLIN,
      userPriorityJson: prio,
    });
    const windows = mocks.readRollupBuckets.mock.calls.map(
      ([u, t, g, from, to, p]) => ({
        u,
        t,
        g,
        fromDaysAgo: (NOW - (from as Date).getTime()) / DAY_MS,
        toDaysAgo: (NOW - (to as Date).getTime()) / DAY_MS,
        p,
      }),
    );
    expect(windows).toEqual([
      {
        u: "u1",
        t: "WEIGHT",
        g: "DAY",
        fromDaysAgo: 30,
        toDaysAgo: 14,
        p: prio,
      },
      {
        u: "u1",
        t: "WEIGHT",
        g: "WEEK",
        fromDaysAgo: 90,
        toDaysAgo: 30,
        p: prio,
      },
      {
        u: "u1",
        t: "WEIGHT",
        g: "MONTH",
        fromDaysAgo: 365,
        toDaysAgo: 90,
        p: prio,
      },
      {
        u: "u1",
        t: "WEIGHT",
        g: "YEAR",
        fromDaysAgo: 1825,
        toDaysAgo: 365,
        p: prio,
      },
    ]);
  });

  it("refreshes the rollups first unless told the caller already did", async () => {
    await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(mocks.ensureUserRollupsFresh).toHaveBeenCalledWith("u1");

    mocks.ensureUserRollupsFresh.mockClear();
    await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: BERLIN,
      skipEnsureFresh: true,
    });
    expect(mocks.ensureUserRollupsFresh).not.toHaveBeenCalled();
  });

  it("reads only the month and year bands when coarseOnly is set", async () => {
    mocks.measurementFindMany.mockResolvedValue([
      { value: 80, measuredAt: new Date(NOW - 2 * DAY_MS) },
    ]);
    const s = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: BERLIN,
      coarseOnly: true,
    });
    expect(mocks.readRollupBuckets.mock.calls.map((c) => c[2])).toEqual([
      "MONTH",
      "YEAR",
    ]);
    expect(mocks.measurementFindMany).not.toHaveBeenCalled();
    expect(s.recentDaily).toEqual([]);
    expect(s.dayBand).toEqual([]);
    expect(s.weekBand).toEqual([]);
  });

  it("skips only the raw band when skipRecentDaily is set", async () => {
    mocks.measurementFindMany.mockResolvedValue([
      { value: 80, measuredAt: new Date(NOW - 2 * DAY_MS) },
    ]);
    const s = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: BERLIN,
      skipRecentDaily: true,
    });
    expect(s.recentDaily).toEqual([]);
    expect(mocks.readRollupBuckets.mock.calls.map((c) => c[2])).toEqual([
      "DAY",
      "WEEK",
      "MONTH",
      "YEAR",
    ]);
  });

  it("hands each bucket over rounded, with its slope", async () => {
    serve({
      WEEK: [
        bucket("2026-04-06T00:00:00.000Z", 80.456, 79.994, 81.005, 7, 0.25),
      ],
    });
    const s = await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(s.weekBand).toEqual([
      {
        bucketStart: "2026-04-06T00:00:00.000Z",
        mean: 80.46,
        min: 79.99,
        max: 81.01,
        count: 7,
        slope: 0.25,
      },
    ]);
    expect(s.type).toBe("WEIGHT");
  });
});

/** The template text and bound values of one `$queryRaw` call. */
function rawCall(i: number): { text: string; values: unknown[] } {
  const [strings, ...values] = mocks.queryRaw.mock.calls[i];
  return { text: (strings as string[]).join("?"), values };
}

describe("live band fallback", () => {
  it("aggregates an empty band live, truncating to the band's unit", async () => {
    await buildTieredSeries("u1", "WEIGHT", { now: NOW, tz: BERLIN });
    expect(mocks.queryRaw).toHaveBeenCalledTimes(4);
    const units = mocks.queryRaw.mock.calls.map((_, i) => rawCall(i).values[0]);
    expect(units).toEqual(["day", "week", "month", "year"]);
    const year = rawCall(3);
    expect(year.text).toContain(
      'date_trunc(?, m."measured_at") AS bucket_start',
    );
    expect(year.text).not.toContain("AT TIME ZONE");
    expect(year.text).toContain("STDDEV_POP");
    expect(year.values).toEqual([
      "year",
      "u1",
      "WEIGHT",
      new Date(NOW - 1825 * DAY_MS),
      new Date(NOW - 365 * DAY_MS),
    ]);
  });

  it("keys the day band on the local calendar for a far-from-UTC user", async () => {
    await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Pacific/Auckland",
    });
    const day = rawCall(0);
    expect(day.text).toContain(
      `(m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ?`,
    );
    expect(day.values.slice(0, 2)).toEqual(["day", "Pacific/Auckland"]);
    // The coarser bands stay on the UTC frame.
    expect(rawCall(1).text).not.toContain("AT TIME ZONE");
  });

  it("shapes live rows like rollup buckets", async () => {
    mocks.queryRaw.mockResolvedValue([
      {
        bucket_start: "2025-02-01T00:00:00.000Z",
        count: "12",
        mean: "81.234",
        min_value: "79",
        max_value: "84.5",
        sd: "1.5",
      },
    ]);
    const s = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: BERLIN,
      skipRecentDaily: true,
    });
    expect(s.monthBand).toEqual([
      {
        bucketStart: "2025-02-01T00:00:00.000Z",
        mean: 81.23,
        min: 79,
        max: 84.5,
        count: 12,
        slope: null,
      },
    ]);
  });

  it("degrades an unreadable band to empty instead of failing the context", async () => {
    mocks.queryRaw.mockRejectedValue(new Error("statement timeout"));
    const s = await buildTieredSeries("u1", "WEIGHT", {
      now: NOW,
      tz: "Pacific/Auckland",
    });
    expect(s.dayBand).toEqual([]);
    expect(s.yearBand).toEqual([]);
  });

  describe("for a type whose day is the mean of its hours (pulse)", () => {
    it("aggregates the band over day-weighted rows in the band's unit", async () => {
      mocks.queryRaw.mockResolvedValue([
        {
          bucket_start: new Date("2025-02-01T00:00:00.000Z"),
          count: 300,
          mean: 64.444,
          min_value: 48,
          max_value: 150,
          sd: 9,
        },
      ]);
      const s = await buildTieredSeries("u1", "PULSE", {
        now: NOW,
        tz: BERLIN,
        skipRecentDaily: true,
      });
      expect(mocks.queryRaw).toHaveBeenCalledTimes(4);
      const month = rawCall(2);
      expect(month.text).toContain("WITH src AS");
      expect(month.text).toContain('GROUP BY 1, m."type"');
      // The bucket expression travels as a fragment bound to the band unit.
      const fragment = month.values[4] as { sql: string; values: unknown[] };
      expect(fragment.sql).toContain("date_trunc(");
      expect(fragment.values).toEqual(["month"]);
      expect(month.values.slice(0, 4)).toEqual([
        "u1",
        "PULSE",
        new Date(NOW - 365 * DAY_MS),
        new Date(NOW - 90 * DAY_MS),
      ]);
      expect(s.monthBand).toEqual([
        {
          bucketStart: "2025-02-01T00:00:00.000Z",
          mean: 64.44,
          min: 48,
          max: 150,
          count: 300,
          slope: null,
        },
      ]);
    });

    it("cuts hours and days in the user's zone when far from UTC", async () => {
      await buildTieredSeries("u1", "PULSE", {
        now: NOW,
        tz: "Pacific/Auckland",
        skipRecentDaily: true,
      });
      const fragment = rawCall(0).values[4] as {
        sql: string;
        values: unknown[];
      };
      expect(fragment.sql).toContain("AT TIME ZONE 'UTC') AT TIME ZONE");
      expect(fragment.values).toEqual(["day", "Pacific/Auckland"]);
    });

    it("degrades to an empty band when the read fails", async () => {
      mocks.queryRaw.mockRejectedValue(new Error("boom"));
      const s = await buildTieredSeries("u1", "PULSE", {
        now: NOW,
        tz: BERLIN,
        skipRecentDaily: true,
      });
      expect(s.monthBand).toEqual([]);
      expect(s.windowStats.n).toBe(0);
    });
  });
});
