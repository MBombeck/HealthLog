/**
 * v1.20.1 perf — the comparison-snapshot builder must bound its per-type
 * measurement read instead of scanning a user's entire history. v1.28.46
 * perf — it now computes the two means it actually reads (avg30 + one
 * baseline mean) as DB-side AVG aggregates over the exact windows, instead
 * of pulling every raw row into JS and averaging there. The snapshot only
 * feeds summarize()'s avg30 / avg30LastMonth / avg30LastYear, and only two
 * of those are read per call.
 *
 * These tests pin:
 *   - non-sleep types compute via `measurement.aggregate({ _avg })`, never a
 *     raw row read, over the exact half-open windows summarize() uses,
 *   - SLEEP_DURATION stays on the raw ~400-day findMany path (per-night
 *     reconstruction cannot be a bare SQL AVG),
 *   - OUTPUT-EQUIVALENCE: the aggregate path produces byte-identical
 *     currentAvg / baselineAvg / delta / deltaPercent to the previous
 *     raw-findMany-then-summarize() implementation, for a fixture dataset.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { summarize, type DataPoint } from "@/lib/analytics/trends";

const findUnique = vi.fn();
const measurementFindMany = vi.fn();
const measurementAggregate = vi.fn();
const queryRaw = vi.fn();

vi.mock("@/lib/db", () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
    measurement: {
      findMany: (...a: unknown[]) => measurementFindMany(...a),
      aggregate: (...a: unknown[]) => measurementAggregate(...a),
    },
    $queryRaw: (...a: unknown[]) => queryRaw(...a),
  },
}));
// SLEEP_DURATION branch helpers — most tests never exercise the sleep
// reconstruction maths, but the builder imports these unconditionally.
vi.mock("@/lib/tz/resolver", () => ({
  resolveUserTimezone: vi.fn(async () => "Europe/Berlin"),
}));
vi.mock("@/lib/rollups/measurement-read", () => ({
  loadUserSourcePriority: vi.fn(async () => []),
}));

import { buildComparisonSnapshotForUser } from "../comprehensive-generate";

const DAY = 86_400_000;

/**
 * Faithful in-memory stand-in for Postgres `AVG(value)` over a measured-at
 * window: same half-open bounds Prisma would translate, same sum/count as the
 * DB. Returns null on an empty slice (matching `_avg.value === null`).
 */
function avgWindow(
  rows: { measuredAt: Date; value: number }[],
  bounds: { gt?: Date; gte?: Date; lte?: Date; lt?: Date },
): number | null {
  const slice = rows.filter((r) => {
    const t = r.measuredAt.getTime();
    if (bounds.gt && !(t > bounds.gt.getTime())) return false;
    if (bounds.gte && !(t >= bounds.gte.getTime())) return false;
    if (bounds.lte && !(t <= bounds.lte.getTime())) return false;
    if (bounds.lt && !(t < bounds.lt.getTime())) return false;
    return true;
  });
  if (slice.length === 0) return null;
  return slice.reduce((s, r) => s + r.value, 0) / slice.length;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Comparison toggle ON → the builder runs its per-type reads. The baseline
  // value drives which prior-period mean the snapshot reports.
  findUnique.mockResolvedValue({
    dashboardWidgetsJson: {
      version: 1,
      widgets: [],
      comparisonBaseline: "lastYear",
    },
  });
  // No sleep rows by default; the raw findMany path only serves SLEEP_DURATION.
  measurementFindMany.mockResolvedValue([]);
  // No measurements by default; individual tests override per call.
  measurementAggregate.mockResolvedValue({ _avg: { value: null } });
  // Pulse reads its day-weighted window mean through one raw query per window.
  queryRaw.mockResolvedValue([]);
});

describe("buildComparisonSnapshotForUser — aggregate windows", () => {
  it("computes non-sleep means via aggregate with the exact half-open windows", async () => {
    findUnique.mockResolvedValue({
      dashboardWidgetsJson: {
        version: 1,
        widgets: [],
        comparisonBaseline: "lastMonth",
      },
    });
    const before = Date.now();
    await buildComparisonSnapshotForUser("u1");
    const after = Date.now();

    // Every non-sleep type issues exactly two aggregate reads (current +
    // baseline). None issues a raw non-sleep findMany.
    expect(measurementAggregate).toHaveBeenCalled();
    const currentCalls: { gt: Date }[] = [];
    const baselineCalls: { gt: Date; lte: Date }[] = [];
    for (const call of measurementAggregate.mock.calls) {
      const where = (call[0] as { where: Record<string, unknown> }).where;
      expect(where).toMatchObject({ userId: "u1", deletedAt: null });
      const measuredAt = where.measuredAt as {
        gt: Date;
        lte?: Date;
      };
      expect(measuredAt.gt).toBeInstanceOf(Date);
      if (measuredAt.lte)
        baselineCalls.push(measuredAt as { gt: Date; lte: Date });
      else currentCalls.push(measuredAt as { gt: Date });
    }
    // current window: measuredAt > now - 30d (no upper bound).
    for (const w of currentCalls) {
      const gtMs = w.gt.getTime();
      expect(gtMs).toBeGreaterThanOrEqual(before - 30 * DAY);
      expect(gtMs).toBeLessThanOrEqual(after - 30 * DAY);
    }
    // lastMonth baseline window: (now - 60d, now - 30d].
    for (const w of baselineCalls) {
      const gtMs = w.gt.getTime();
      const lteMs = w.lte.getTime();
      expect(gtMs).toBeGreaterThanOrEqual(before - 60 * DAY);
      expect(gtMs).toBeLessThanOrEqual(after - 60 * DAY);
      expect(lteMs).toBeGreaterThanOrEqual(before - 30 * DAY);
      expect(lteMs).toBeLessThanOrEqual(after - 30 * DAY);
    }
    // Five non-sleep, non-pulse types × 2 windows = 10 aggregate reads; no raw
    // non-sleep read. Pulse reads its day-weighted mean instead (below).
    expect(currentCalls.length).toBe(5);
    expect(baselineCalls.length).toBe(5);
  });

  it("reads SLEEP_DURATION through the raw ~400-day findMany, never aggregate", async () => {
    await buildComparisonSnapshotForUser("u1");
    // Exactly one findMany — the SLEEP_DURATION branch — and it carries a
    // ~400-day measuredAt.gte floor.
    expect(measurementFindMany).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const where = (
      measurementFindMany.mock.calls[0][0] as {
        where: { type: string; measuredAt: { gte: Date } };
      }
    ).where;
    expect(where.type).toBe("SLEEP_DURATION");
    const ageDays = (now - where.measuredAt.gte.getTime()) / DAY;
    expect(ageDays).toBeGreaterThanOrEqual(395);
  });

  it("baseline=lastYear uses the [365, 395)-day window (measuredAt > now-395d && <= now-365d)", async () => {
    const before = Date.now();
    await buildComparisonSnapshotForUser("u1"); // default baseline = lastYear
    const after = Date.now();
    const baselineCalls = measurementAggregate.mock.calls
      .map(
        (c) =>
          (c[0] as { where: { measuredAt: { gt: Date; lte?: Date } } }).where
            .measuredAt,
      )
      .filter((m): m is { gt: Date; lte: Date } => m.lte != null);
    expect(baselineCalls.length).toBe(5);
    for (const w of baselineCalls) {
      const gtMs = w.gt.getTime();
      const lteMs = w.lte.getTime();
      expect(gtMs).toBeGreaterThanOrEqual(before - 395 * DAY);
      expect(gtMs).toBeLessThanOrEqual(after - 395 * DAY);
      expect(lteMs).toBeGreaterThanOrEqual(before - 365 * DAY);
      expect(lteMs).toBeLessThanOrEqual(after - 365 * DAY);
    }
  });
});

describe("buildComparisonSnapshotForUser — pulse", () => {
  // A pulse window average is the mean of its days, each the mean of its
  // hours' means, so a workout's dense readings do not decide the delta. A
  // bare AVG cannot express it, so pulse never goes through the aggregate.
  it("reads pulse through the day-weighted query, never the reading AVG", async () => {
    queryRaw
      .mockResolvedValueOnce([{ mean: 64 }])
      .mockResolvedValueOnce([{ mean: 60 }]);
    const snapshot = await buildComparisonSnapshotForUser("u1");
    const pulseAggregates = measurementAggregate.mock.calls.filter(
      (c) => (c[0] as { where: { type: string } }).where.type === "PULSE",
    );
    expect(pulseAggregates).toHaveLength(0);
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(queryRaw.mock.calls[0])).toContain("day_weight");
    const pulse = snapshot!.metrics.find((m) => m.type === "pulse");
    expect(pulse).toMatchObject({ unit: "bpm" });
    expect([pulse!.currentAvg, pulse!.baselineAvg].sort()).toEqual([60, 64]);
  });
});

describe("buildComparisonSnapshotForUser — output-equivalence to the raw-average path", () => {
  it("emits identical metrics to findMany-then-summarize() for a fixture (lastMonth)", async () => {
    findUnique.mockResolvedValue({
      dashboardWidgetsJson: {
        version: 1,
        widgets: [],
        comparisonBaseline: "lastMonth",
      },
    });
    const now = Date.now();
    // A WEIGHT fixture with several rows spread across the current [0,30),
    // lastMonth [30,60), and out-of-window regions — the kind of skew where a
    // wrong window boundary or rounding step would diverge.
    const weightRows: { measuredAt: Date; value: number }[] = [
      { measuredAt: new Date(now - 2 * DAY), value: 80.4 },
      { measuredAt: new Date(now - 9 * DAY), value: 81.1 },
      { measuredAt: new Date(now - 21 * DAY), value: 79.9 },
      { measuredAt: new Date(now - 33 * DAY), value: 84.2 },
      { measuredAt: new Date(now - 48 * DAY), value: 83.3 },
      { measuredAt: new Date(now - 59 * DAY), value: 85.0 },
      // out-of-window (older than lastMonth) — must not influence either mean.
      { measuredAt: new Date(now - 120 * DAY), value: 99.0 },
    ];

    // The aggregate mock is the "database": it applies the builder's window
    // and averages the fixture rows.
    measurementAggregate.mockImplementation(
      async (args: {
        where: { type: string; measuredAt: { gt?: Date; lte?: Date } };
      }) => {
        if (args.where.type !== "WEIGHT") return { _avg: { value: null } };
        return {
          _avg: { value: avgWindow(weightRows, args.where.measuredAt) },
        };
      },
    );

    const snapshot = await buildComparisonSnapshotForUser("u1");
    const weight = snapshot!.metrics.find((m) => m.type === "weight");
    expect(weight).toBeDefined();

    // Reference: the PREVIOUS implementation — read the whole 400-day window
    // then summarize() in JS.
    const points: DataPoint[] = weightRows
      .filter((r) => r.measuredAt.getTime() >= now - 400 * DAY)
      .map((r) => ({ date: r.measuredAt, value: r.value }));
    const summary = summarize(points);
    const expectedCurrent = summary.avg30 ?? null;
    const expectedBaseline = summary.avg30LastMonth ?? null;
    const expectedDelta =
      expectedCurrent !== null && expectedBaseline !== null
        ? Math.round((expectedCurrent - expectedBaseline) * 100) / 100
        : null;
    const expectedDeltaPercent =
      expectedDelta !== null &&
      expectedBaseline !== null &&
      expectedBaseline !== 0
        ? Math.round((expectedDelta / Math.abs(expectedBaseline)) * 100 * 10) /
          10
        : null;

    expect(weight!.currentAvg).toBe(expectedCurrent);
    expect(weight!.baselineAvg).toBe(expectedBaseline);
    expect(weight!.delta).toBe(expectedDelta);
    expect(weight!.deltaPercent).toBe(expectedDeltaPercent);
  });

  it("drops a metric with no data in either window (parity with the old filter)", async () => {
    // Default aggregate mock returns null for every window → every non-sleep
    // metric is null/null and filtered out; sleep has no rows too.
    const snapshot = await buildComparisonSnapshotForUser("u1");
    expect(snapshot).not.toBeNull();
    expect(snapshot!.metrics).toEqual([]);
  });

  it("returns null without reading measurements when the comparison toggle is off", async () => {
    findUnique.mockResolvedValue({
      dashboardWidgetsJson: {
        version: 1,
        widgets: [],
        comparisonBaseline: "none",
      },
    });
    const snapshot = await buildComparisonSnapshotForUser("u1");
    expect(snapshot).toBeNull();
    expect(measurementAggregate).not.toHaveBeenCalled();
    expect(measurementFindMany).not.toHaveBeenCalled();
  });

  it("states weight in the reader's mass unit and labels sleep in minutes", async () => {
    findUnique.mockResolvedValue({
      dashboardWidgetsJson: {
        version: 1,
        widgets: [],
        comparisonBaseline: "lastMonth",
      },
      unitPreference: "imperial",
    });
    measurementAggregate.mockImplementation(
      async (args: { where: { type: string; measuredAt: { lte?: Date } } }) =>
        args.where.type === "WEIGHT"
          ? { _avg: { value: args.where.measuredAt.lte ? 82 : 80 } }
          : { _avg: { value: null } },
    );
    // Seven-hour nights, stored in minutes.
    measurementFindMany.mockResolvedValue(
      Array.from({ length: 5 }, (_, i) => ({
        measuredAt: new Date(Date.now() - (i + 2) * DAY),
        value: 420,
        sleepStage: null,
        source: "APPLE_HEALTH",
        deviceType: null,
      })),
    );
    const snapshot = await buildComparisonSnapshotForUser("u1");
    const sleep = snapshot!.metrics.find((m) => m.type === "sleep");
    expect(sleep).toMatchObject({ unit: "min", currentAvg: 420 });
    const weight = snapshot!.metrics.find((m) => m.type === "weight");
    expect(weight).toMatchObject({
      unit: "lb",
      currentAvg: 176.4,
      baselineAvg: 180.8,
      delta: -4.4,
      deltaPercent: -2.4,
    });
  });
});
