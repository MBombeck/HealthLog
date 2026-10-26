/**
 * v1.19.2 — `readDailySeries` long-range tier step-up.
 *
 * Pins that a window WIDER than the DAY bucket cap routes through the
 * tiered rollup reader (whole-history coverage, downsampled by tier)
 * instead of the DAY path that would `LIMIT`/`slice` to the cap and
 * silently drop the older history. Short / normal windows must NOT touch
 * the tiered reader, so the common case stays byte-identical with the
 * pre-v1.19.2 daily path (no perf regression).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  findFirst: vi.fn(),
  queryRaw: vi.fn(),
  readTieredRollupSeries: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    measurementRollup: { findMany: mocks.findMany },
    measurement: { findFirst: mocks.findFirst },
    $queryRaw: mocks.queryRaw,
  },
}));

vi.mock("@/lib/rollups/measurement-read-wmy", () => ({
  readTieredRollupSeries: mocks.readTieredRollupSeries,
}));

import { readDailySeries } from "../daily-series-read";

const DAY_MS = 86_400_000;

beforeEach(() => {
  mocks.findMany.mockReset();
  mocks.findFirst.mockReset();
  // No reading older than the rollups unless a case says so.
  mocks.findFirst.mockResolvedValue(null);
  mocks.queryRaw.mockReset();
  mocks.readTieredRollupSeries.mockReset();
  // The daily path folds live, one row per local day.
  mocks.queryRaw.mockResolvedValue(
    ["2026-06-01", "2026-06-02", "2026-06-03"].map((d, i) => ({
      type: "WEIGHT",
      bucket_start: new Date(`${d}T00:00:00.000Z`),
      avg: 80 + i,
      cnt: 1,
      min_value: 80 + i,
      max_value: 80 + i,
    })),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const TZ = "Europe/Berlin";

describe("readDailySeries — long-range tier step-up", () => {
  it("routes a multi-year window through the tiered reader and returns its whole-history rows", async () => {
    const to = new Date("2026-06-21T00:00:00.000Z");
    const from = new Date(to.getTime() - 3650 * DAY_MS);
    const tieredRows = [
      {
        type: "WEIGHT",
        value: 80,
        measuredAt: "2017-01-01T00:00:00.000Z",
        count: 12,
      },
      {
        type: "WEIGHT",
        value: 79,
        measuredAt: "2026-01-01T00:00:00.000Z",
        count: 12,
      },
    ];
    mocks.readTieredRollupSeries.mockResolvedValueOnce({
      granularity: "MONTH",
      rows: tieredRows,
      firstDay: new Date("2017-01-01T00:00:00.000Z"),
    });

    const result = await readDailySeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
      priorityJson: null,
      timeZone: TZ,
    });

    expect(mocks.readTieredRollupSeries).toHaveBeenCalledTimes(1);
    // v1.26.0 — the resolved `[from, to]` bounds are threaded so the
    // tier reads the REQUESTED window, not a trailing "to now" slice.
    expect(mocks.readTieredRollupSeries.mock.calls[0][0].from).toBe(from);
    expect(mocks.readTieredRollupSeries.mock.calls[0][0].to).toBe(to);
    // Whole-history coverage: the earliest 2017 bucket survives.
    expect(result[0].measuredAt).toBe("2017-01-01T00:00:00.000Z");
    expect(result).toHaveLength(2);
    // The daily path was NOT consulted for the long window.
    expect(mocks.queryRaw).not.toHaveBeenCalled();
  });

  it("folds the readings older than the rollups live and puts them first", async () => {
    const to = new Date("2026-06-03T12:00:00.000Z");
    const from = new Date(to.getTime() - 3650 * DAY_MS);
    mocks.readTieredRollupSeries.mockResolvedValueOnce({
      granularity: "MONTH",
      rows: [
        {
          type: "WEIGHT",
          value: 79,
          measuredAt: "2021-07-01T12:00:00.000Z",
          count: 30,
        },
      ],
      firstDay: new Date("2021-07-04T00:00:00.000Z"),
    });
    mocks.findFirst.mockResolvedValueOnce({ id: "older" });
    mocks.queryRaw.mockResolvedValueOnce([
      {
        type: "WEIGHT",
        bucket_start: new Date("2018-03-01T00:00:00.000Z"),
        avg: 84,
        cnt: 4,
        min_value: 83,
        max_value: 85,
      },
    ]);

    const result = await readDailySeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
      priorityJson: null,
      timeZone: TZ,
    });

    // The head reads before the first tier bucket (July 2021) only.
    expect(mocks.findFirst.mock.calls[0][0].where.measuredAt.lt).toEqual(
      new Date("2021-07-01T00:00:00.000Z"),
    );
    expect(result).toHaveLength(2);
    expect(result[0].value).toBe(84);
    expect(result[1].measuredAt).toBe("2021-07-01T12:00:00.000Z");
  });

  it("falls through to the daily path on a tiered coverage miss (no silent empty)", async () => {
    const to = new Date("2026-06-21T00:00:00.000Z");
    const from = new Date(to.getTime() - 3650 * DAY_MS);
    mocks.readTieredRollupSeries.mockResolvedValueOnce(null);

    const result = await readDailySeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
      priorityJson: null,
      timeZone: TZ,
    });

    expect(mocks.readTieredRollupSeries).toHaveBeenCalledTimes(1);
    expect(mocks.queryRaw).toHaveBeenCalled();
    expect(result).toHaveLength(3);
  });

  it("does NOT touch the tiered reader for a normal 90-day window", async () => {
    const to = new Date("2026-06-21T00:00:00.000Z");
    const from = new Date(to.getTime() - 90 * DAY_MS);

    const result = await readDailySeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
      priorityJson: null,
      timeZone: TZ,
    });

    expect(mocks.readTieredRollupSeries).not.toHaveBeenCalled();
    // The daily series never reads the UTC-day DAY rollup (#1026).
    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      type: "WEIGHT",
      value: 80,
      count: 1,
      minValue: 80,
      maxValue: 80,
    });
  });

  it("a tiered-reader throw on a long window falls through to the daily path", async () => {
    const to = new Date("2026-06-21T00:00:00.000Z");
    const from = new Date(to.getTime() - 3650 * DAY_MS);
    mocks.readTieredRollupSeries.mockRejectedValueOnce(new Error("deadlock"));

    const result = await readDailySeries({
      userId: "u",
      type: "WEIGHT",
      from,
      to,
      priorityJson: null,
      timeZone: TZ,
    });

    expect(mocks.queryRaw).toHaveBeenCalled();
    expect(result).toHaveLength(3);
  });
});
