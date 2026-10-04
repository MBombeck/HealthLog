/**
 * Parity battery for the correlation-discovery rollup read-swap
 * (`fetchMeasurementDailySeriesTiered`).
 *
 * Every parity case seeds IDENTICAL fixtures through both paths: the raw
 * measurement rows the fallback path reads, and per-`(day, source)` DAY
 * rollup rows DERIVED from those same raw rows (count / mean / sumValue,
 * UTC-midnight `bucketStart` — the exact shape the rollup writer mints).
 * The resulting daily series must be equivalent. Fixtures are now-anchored
 * (never fixed calendar dates) so the suite cannot age out of a retention
 * or DST window.
 *
 * Watched-red record (each assertion family was broken on purpose, seen
 * failing with the site named, then restored green):
 *   - skewing `composeRollupDailyMeans` (`acc.sum += sum + 1`) → the
 *     spot-parity and multi-source parity tests failed on the composed
 *     values (57.75 vs 58.25, 81 vs 81.5);
 *   - inverting the `isNearUtc` gate in `fetchMeasurementDailySeriesTiered`
 *     → the far-from-UTC test failed on `rollupFindMany` being called and
 *     on UTC-keyed days where profile-tz keys were required;
 *   - removing the empty-window `rawTypes.push(type)` fallback → the
 *     fallback-on-miss test failed with an empty series;
 *   - removing the `isRollupSwapEligible` sleep/cumulative exclusion → the
 *     eligibility test failed on the rollup query's `type.in` list.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import type { MeasurementSource } from "@/generated/prisma/client";

const measurementFindMany = vi.fn();
const rollupFindMany = vi.fn();
const userFindUnique = vi.fn();
const queryRaw = vi.fn();
vi.mock("@/lib/db", () => ({
  prisma: {
    measurement: { findMany: (a: unknown) => measurementFindMany(a) },
    measurementRollup: { findMany: (a: unknown) => rollupFindMany(a) },
    user: { findUnique: (a: unknown) => userFindUnique(a) },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));

import {
  fetchMeasurementDailySeriesTiered,
  toDailyMeans,
} from "@/lib/insights/correlation-channel-series";

const DAY_MS = 24 * 60 * 60 * 1000;
const USER = "user-1";
const SINCE = () => new Date(Date.now() - 30 * DAY_MS);

/** Now-anchored instant: `daysAgo` days back, pinned to a UTC wall time. */
function at(daysAgo: number, hourUtc: number, minute = 0): Date {
  const d = new Date(Date.now() - daysAgo * DAY_MS);
  d.setUTCHours(hourUtc, minute, 0, 0);
  return d;
}

/** UTC calendar-date key of an instant — the DAY bucket's day key. */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface RawRow {
  type: string;
  value: number;
  measuredAt: Date;
  source: MeasurementSource;
  deviceType: string | null;
  sleepStage: string | null;
}

function raw(
  type: string,
  measuredAt: Date,
  value: number,
  source: MeasurementSource = "APPLE_HEALTH",
): RawRow {
  return {
    type,
    value,
    measuredAt,
    source,
    deviceType: null,
    sleepStage: null,
  };
}

/**
 * Derive the per-`(type, UTC day, source)` DAY rollup rows the writer
 * would mint from the given raw rows. `nullSumValueDays` simulates rows
 * that predate the `sum_value` column (the compose must fall back to
 * `mean·count`).
 */
function deriveDayRollups(
  rows: RawRow[],
  nullSumValueDays: string[] = [],
): Array<{
  type: string;
  bucketStart: Date;
  count: number;
  mean: number;
  sumValue: number | null;
}> {
  const groups = new Map<
    string,
    { type: string; day: string; source: string; values: number[] }
  >();
  for (const r of rows) {
    const day = utcDayKey(r.measuredAt);
    const key = `${r.type}|${day}|${r.source}`;
    const g = groups.get(key) ?? {
      type: r.type,
      day,
      source: r.source,
      values: [],
    };
    g.values.push(r.value);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const sum = g.values.reduce((s, v) => s + v, 0);
    return {
      type: g.type,
      bucketStart: new Date(`${g.day}T00:00:00.000Z`),
      count: g.values.length,
      mean: sum / g.values.length,
      sumValue: nullSumValueDays.includes(g.day) ? null : sum,
    };
  });
}

function mockCoverage(entries: Array<[string, boolean]>): void {
  queryRaw.mockResolvedValue(
    entries.map(([type, has]) => ({ type, has_buckets: has })),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  // `loadUserSourcePriority` reads the priority blob; null = default ladders.
  userFindUnique.mockResolvedValue({ sourcePriorityJson: null });
  measurementFindMany.mockResolvedValue([]);
  rollupFindMany.mockResolvedValue([]);
  queryRaw.mockResolvedValue([]);
});

describe("rollup ↔ raw parity — plain daily-mean type", () => {
  // Wall times sit mid-day, far from every local midnight band, so the
  // UTC bucket day and the Europe/Berlin profile day agree by construction.
  const rows = [
    raw("RESTING_HEART_RATE", at(10, 8), 55),
    raw("RESTING_HEART_RATE", at(10, 20), 61),
    raw("RESTING_HEART_RATE", at(9, 8), 58),
    raw("RESTING_HEART_RATE", at(5, 12), 60.5),
  ];

  it("serves the identical daily series from the DAY rollup tier (raw path not consulted)", async () => {
    mockCoverage([["RESTING_HEART_RATE", true]]);
    // One bucket rides the pre-`sum_value` shape to pin the mean·count fallback.
    rollupFindMany.mockResolvedValue(
      deriveDayRollups(rows, [utcDayKey(at(9, 8))]),
    );

    const viaRollup = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["RESTING_HEART_RATE"],
    );

    expect(viaRollup.rollupTypes).toEqual(["RESTING_HEART_RATE"]);
    expect(viaRollup.measurementsCapped).toBe(false);
    // Read-swap REPLACES the raw read — it must not run in parallel.
    expect(measurementFindMany).not.toHaveBeenCalled();

    mockCoverage([["RESTING_HEART_RATE", false]]);
    measurementFindMany.mockResolvedValue(rows);
    const viaRaw = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["RESTING_HEART_RATE"],
    );

    const rollupSeries = viaRollup.byType.get("RESTING_HEART_RATE")!;
    const rawSeries = viaRaw.byType.get("RESTING_HEART_RATE")!;
    expect(rollupSeries.map((p) => p.day)).toEqual(rawSeries.map((p) => p.day));
    rollupSeries.forEach((p, i) =>
      expect(p.value).toBeCloseTo(rawSeries[i].value, 10),
    );
    // Spot-check the multi-reading day collapses to the day MEAN.
    expect(
      rollupSeries.find((p) => p.day === utcDayKey(at(10, 8)))?.value,
    ).toBeCloseTo(58, 10);
    expect(rollupSeries).toHaveLength(3);
  });
});

describe("rollup ↔ raw parity — multi-source day (source collapse)", () => {
  const rows = [
    raw("WEIGHT", at(8, 7), 80.4, "APPLE_HEALTH"),
    raw("WEIGHT", at(8, 7, 5), 81.6, "WITHINGS"),
    raw("WEIGHT", at(6, 7), 80.0, "APPLE_HEALTH"),
  ];

  it("composes the ALL-source day mean, matching toDailyMeans — never a ladder-collapsed single source", async () => {
    mockCoverage([["WEIGHT", true]]);
    rollupFindMany.mockResolvedValue(deriveDayRollups(rows));
    const viaRollup = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["WEIGHT"],
    );

    mockCoverage([["WEIGHT", false]]);
    measurementFindMany.mockResolvedValue(rows);
    const viaRaw = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["WEIGHT"],
    );

    const rollupSeries = viaRollup.byType.get("WEIGHT")!;
    const rawSeries = viaRaw.byType.get("WEIGHT")!;
    expect(rollupSeries.map((p) => p.day)).toEqual(rawSeries.map((p) => p.day));
    rollupSeries.forEach((p, i) =>
      expect(p.value).toBeCloseTo(rawSeries[i].value, 10),
    );

    // The dual-source day is the MEAN across both sources' readings (81.0).
    // A ladder collapse would have returned one source's value (80.4 or
    // 81.6) — pin that it did not.
    const dualDay = rollupSeries.find((p) => p.day === utcDayKey(at(8, 7)))!;
    expect(dualDay.value).toBeCloseTo(81.0, 10);
    expect(dualDay.value).not.toBeCloseTo(80.4, 2);
    expect(dualDay.value).not.toBeCloseTo(81.6, 2);
  });
});

describe("pulse from the DAY rollup tier", () => {
  it("reads each source's stored DAY mean (the hourly-mean day), not its readings' sum over count", async () => {
    mockCoverage([["PULSE", true]]);
    // The stored DAY mean of pulse is the mean of the day's hours' means (90),
    // while its readings average 127.5. A second source on another day is
    // single-source and kept as is.
    rollupFindMany.mockResolvedValue([
      {
        type: "PULSE",
        bucketStart: new Date(`${utcDayKey(at(8, 7))}T00:00:00.000Z`),
        count: 8,
        mean: 90,
        sumValue: 1020,
      },
    ]);
    const result = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["PULSE"],
    );
    expect(result.rollupTypes).toEqual(["PULSE"]);
    expect(result.byType.get("PULSE")).toEqual([
      { day: utcDayKey(at(8, 7)), value: 90 },
    ]);
  });

  it("weighs each source's day once on a day two sources report", async () => {
    mockCoverage([["PULSE", true]]);
    const bucketStart = new Date(`${utcDayKey(at(8, 7))}T00:00:00.000Z`);
    rollupFindMany.mockResolvedValue([
      { type: "PULSE", bucketStart, count: 900, mean: 70, sumValue: 900 * 120 },
      { type: "PULSE", bucketStart, count: 3, mean: 60, sumValue: 180 },
    ]);
    const result = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["PULSE"],
    );
    expect(result.byType.get("PULSE")![0].value).toBeCloseTo(65, 10);
  });
});

describe("rollup ↔ raw parity — far-from-UTC profile timezone", () => {
  const savedTz = process.env.TZ;
  afterAll(() => {
    process.env.TZ = savedTz;
  });

  it("forces the raw path when UTC and profile-tz day keys diverge, preserving the tz-keyed series", async () => {
    // Process tz deliberately differs from BOTH UTC and the profile tz so
    // any accidental host-clock dependence would surface here.
    process.env.TZ = "America/Chicago";

    // 13:00 UTC is 01:00–02:00 the NEXT calendar day in Pacific/Auckland
    // (+12 NZST / +13 NZDT) — every fixture's UTC day key and profile-tz
    // day key differ.
    const rows = [
      raw("RESTING_HEART_RATE", at(9, 13), 52),
      raw("RESTING_HEART_RATE", at(7, 13), 56),
    ];
    // Coverage TRUE and buckets present: if the guard fails, the rollup
    // path would serve UTC-keyed days and this test names it.
    mockCoverage([["RESTING_HEART_RATE", true]]);
    rollupFindMany.mockResolvedValue(deriveDayRollups(rows));
    measurementFindMany.mockResolvedValue(rows);

    const result = await fetchMeasurementDailySeriesTiered(
      USER,
      "Pacific/Auckland",
      SINCE(),
      ["RESTING_HEART_RATE"],
    );

    expect(rollupFindMany).not.toHaveBeenCalled();
    expect(result.rollupTypes).toEqual([]);
    const series = result.byType.get("RESTING_HEART_RATE")!;
    // Byte-identical to the pure tz-keyed reduction the raw path pins.
    expect(series).toEqual(
      toDailyMeans(
        rows.map((r) => ({ value: r.value, at: r.measuredAt })),
        "Pacific/Auckland",
      ),
    );
    // And those keys are the profile-tz (next-day) dates, not the UTC dates.
    expect(series.map((p) => p.day)).toEqual([
      utcDayKey(new Date(at(9, 13).getTime() + DAY_MS)),
      utcDayKey(new Date(at(7, 13).getTime() + DAY_MS)),
    ]);
  });
});

describe("near-UTC midnight band — the documented attribution tolerance", () => {
  it("pins that a reading inside the offset band lands on the UTC day via rollups and the local day via raw", async () => {
    // 23:30 UTC is 01:30 the next Berlin day. Inside the ±3 h near-UTC
    // band the rollup swap accepts this single-day attribution shift (the
    // v1.4.38 W-A tolerance the correlations fast path documents); this
    // test pins the shift so it stays a decision, never drift.
    const reading = raw("RESTING_HEART_RATE", at(10, 23, 30), 60);

    mockCoverage([["RESTING_HEART_RATE", true]]);
    rollupFindMany.mockResolvedValue(deriveDayRollups([reading]));
    const viaRollup = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["RESTING_HEART_RATE"],
    );

    mockCoverage([["RESTING_HEART_RATE", false]]);
    measurementFindMany.mockResolvedValue([reading]);
    const viaRaw = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["RESTING_HEART_RATE"],
    );

    const utcDay = utcDayKey(reading.measuredAt);
    const berlinDay = utcDayKey(
      new Date(reading.measuredAt.getTime() + DAY_MS),
    );
    expect(viaRollup.byType.get("RESTING_HEART_RATE")).toEqual([
      { day: utcDay, value: 60 },
    ]);
    expect(viaRaw.byType.get("RESTING_HEART_RATE")).toEqual([
      { day: berlinDay, value: 60 },
    ]);
  });
});

describe("fallback-on-miss", () => {
  it("takes the raw path for a channel with no rollup coverage and produces the same series as before", async () => {
    const rows = [
      raw("BLOOD_GLUCOSE", at(4, 9), 95),
      raw("BLOOD_GLUCOSE", at(4, 15), 105),
    ];
    mockCoverage([["BLOOD_GLUCOSE", false]]);
    measurementFindMany.mockResolvedValue(rows);

    const result = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["BLOOD_GLUCOSE"],
    );

    expect(rollupFindMany).not.toHaveBeenCalled();
    expect(result.rollupTypes).toEqual([]);
    expect(result.byType.get("BLOOD_GLUCOSE")).toEqual(
      toDailyMeans(
        rows.map((r) => ({ value: r.value, at: r.measuredAt })),
        "Europe/Berlin",
      ),
    );
  });

  it("falls back per channel when coverage exists but the window's buckets are empty (backfill pending)", async () => {
    const rows = [raw("WEIGHT", at(3, 7), 79.5)];
    mockCoverage([["WEIGHT", true]]);
    rollupFindMany.mockResolvedValue([]); // covered, but nothing in-window
    measurementFindMany.mockResolvedValue(rows);

    const result = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["WEIGHT"],
    );

    expect(result.rollupTypes).toEqual([]);
    expect(result.byType.get("WEIGHT")).toEqual([
      { day: utcDayKey(at(3, 7)), value: 79.5 },
    ]);
  });
});

describe("structural eligibility", () => {
  it("keeps sleep and the cumulative types on the raw path even with full coverage", async () => {
    mockCoverage([
      ["SLEEP_DURATION", true],
      ["ACTIVITY_STEPS", true],
      ["TIME_IN_DAYLIGHT", true],
      ["WEIGHT", true],
    ]);
    const weightRows = [raw("WEIGHT", at(3, 7), 79.5)];
    rollupFindMany.mockResolvedValue(deriveDayRollups(weightRows));
    measurementFindMany.mockResolvedValue([]);

    const result = await fetchMeasurementDailySeriesTiered(
      USER,
      "Europe/Berlin",
      SINCE(),
      ["SLEEP_DURATION", "ACTIVITY_STEPS", "TIME_IN_DAYLIGHT", "WEIGHT"],
    );

    // The rollup query may only ever name the eligible spot type.
    expect(rollupFindMany).toHaveBeenCalledTimes(1);
    const rollupWhere = rollupFindMany.mock.calls[0][0] as {
      where: { type: { in: string[] } };
    };
    expect(rollupWhere.where.type.in).toEqual(["WEIGHT"]);
    expect(result.rollupTypes).toEqual(["WEIGHT"]);

    // The raw read carries exactly the three structurally-excluded types.
    const rawWhere = measurementFindMany.mock.calls[0][0] as {
      where: { type: { in: string[] } };
    };
    expect(rawWhere.where.type.in.sort()).toEqual([
      "ACTIVITY_STEPS",
      "SLEEP_DURATION",
      "TIME_IN_DAYLIGHT",
    ]);
  });
});
