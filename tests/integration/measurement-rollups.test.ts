/**
 * v1.5.0 — integration coverage for the persistent measurement-
 * rollup populator.
 *
 * Runs against the testcontainer Postgres so the real `STDDEV_POP` /
 * `REGR_SLOPE` / `REGR_R2` functions and the `date_trunc` semantics
 * are exercised end-to-end. Three contracts are pinned:
 *
 *   1. **Synchronous DAY recompute on write hook.** Calling
 *      `recomputeBucketsForMeasurement` after a measurement insert
 *      writes a `MeasurementRollup` row with the right
 *      `count / mean / min / max / sd` shape.
 *
 *   2. **Backfill cardinality.** `recomputeUserRollups` over a
 *      synthetic 3-user × 4-type × 50-row fixture produces the
 *      expected (user × type × granularity × bucket) cardinality
 *      with no duplicate rows.
 *
 *   3. **Re-aggregated DataSummary matches live SQL.** A populated
 *      rollup-DAY series re-aggregated through `aggregateBuckets`
 *      returns `count / min / max / mean` byte-identical to a
 *      parallel live `$queryRaw` over the same rows. Establishes
 *      the byte-shape parity contract before the v1.5.1 read-path
 *      swap.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import {
  recomputeBucketsForMeasurement,
  recomputeUserRollups,
  ALL_GRANULARITIES,
} from "@/lib/measurements/rollups";
import { aggregateBuckets } from "@/lib/measurements/rollup-read";
import { buildComprehensiveAggregate } from "@/lib/insights/comprehensive-aggregator";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/jobs/boss-instance", () => ({
  getGlobalBoss: () => null, // no pg-boss in the test container
}));

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("measurement rollups — integration", () => {
  it("writes a DAY rollup row that matches the inserted measurements", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "rollup-day-user",
        email: "rollup-day-user@example.test",
        role: "USER",
      },
    });
    const measuredAt = new Date("2026-05-10T10:00:00.000Z");
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date("2026-05-10T07:00:00.000Z"),
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 82,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date("2026-05-10T15:00:00.000Z"),
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 84,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date("2026-05-10T22:00:00.000Z"),
        },
      ],
    });

    await recomputeBucketsForMeasurement(user.id, "WEIGHT", measuredAt);

    const dayRow = await prisma.measurementRollup.findFirst({
      where: { userId: user.id, type: "WEIGHT", granularity: "DAY" },
    });
    expect(dayRow).not.toBeNull();
    expect(dayRow!.count).toBe(3);
    expect(dayRow!.mean).toBeCloseTo(82, 5);
    expect(dayRow!.minValue).toBe(80);
    expect(dayRow!.maxValue).toBe(84);
    // STDDEV_POP across [80, 82, 84]: variance = (4+0+4)/3 ≈ 2.667;
    // SD = sqrt ≈ 1.633.
    expect(dayRow!.sd).toBeCloseTo(1.633, 2);
  });

  it("backfills with the expected (user × type × granularity × bucket) cardinality", async () => {
    const prisma = getPrismaClient();
    const userIds: string[] = [];
    const types = ["WEIGHT", "PULSE", "BLOOD_PRESSURE_SYS", "BLOOD_PRESSURE_DIA"] as const;

    // 3 users × 4 types × ~50 rows over ~7 weeks
    for (let u = 0; u < 3; u++) {
      const user = await prisma.user.create({
        data: {
          username: `rollup-backfill-user-${u}`,
          email: `rollup-backfill-${u}@example.test`,
          role: "USER",
        },
      });
      userIds.push(user.id);
      interface SeedRow {
        userId: string;
        type: (typeof types)[number];
        value: number;
        unit: string;
        source: "MANUAL";
        measuredAt: Date;
      }
      const rows: SeedRow[] = [];
      const baseMs = new Date("2026-03-01T08:00:00.000Z").getTime();
      for (const type of types) {
        for (let i = 0; i < 50; i++) {
          rows.push({
            userId: user.id,
            type,
            value: 80 + (i % 5),
            unit: type === "WEIGHT" ? "kg" : type === "PULSE" ? "bpm" : "mmHg",
            source: "MANUAL",
            measuredAt: new Date(baseMs + i * 24 * 60 * 60 * 1000),
          });
        }
      }
      await prisma.measurement.createMany({ data: rows });
    }

    for (const userId of userIds) {
      await recomputeUserRollups(userId, {
        granularities: ALL_GRANULARITIES,
      });
    }

    // 50 distinct days per (user, type) → 50 DAY rollups.
    const dayCount = await prisma.measurementRollup.count({
      where: { granularity: "DAY" },
    });
    expect(dayCount).toBe(3 * 4 * 50);

    // WEEK / MONTH / YEAR cardinalities should be > 0 and < dayCount.
    const weekCount = await prisma.measurementRollup.count({
      where: { granularity: "WEEK" },
    });
    const monthCount = await prisma.measurementRollup.count({
      where: { granularity: "MONTH" },
    });
    const yearCount = await prisma.measurementRollup.count({
      where: { granularity: "YEAR" },
    });
    expect(weekCount).toBeGreaterThan(0);
    expect(weekCount).toBeLessThan(dayCount);
    expect(monthCount).toBeGreaterThan(0);
    expect(monthCount).toBeLessThan(weekCount);
    expect(yearCount).toBeGreaterThan(0);
    expect(yearCount).toBeLessThanOrEqual(monthCount);

    // Re-running the backfill is idempotent — totals stay the same.
    for (const userId of userIds) {
      await recomputeUserRollups(userId, {
        granularities: ALL_GRANULARITIES,
      });
    }
    const dayCountAfter = await prisma.measurementRollup.count({
      where: { granularity: "DAY" },
    });
    expect(dayCountAfter).toBe(dayCount);
  });

  it("re-aggregated DAY buckets match live SQL for count / min / max / mean (byte-shape parity)", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "rollup-parity-user",
        email: "rollup-parity@example.test",
        role: "USER",
      },
    });

    // 14-day descending-weight fixture spread across multiple days
    // so the DAY rollup has > 1 buckets to aggregate.
    const baseTime = new Date("2026-05-01T08:00:00.000Z").getTime();
    const N = 28;
    const rows = Array.from({ length: N }, (_, i) => ({
      userId: user.id,
      type: "WEIGHT" as const,
      value: 80 + (i * 4) / (N - 1), // 80 → 84
      unit: "kg",
      source: "MANUAL" as const,
      measuredAt: new Date(baseTime + i * 12 * 60 * 60 * 1000), // 2/day
    }));
    await prisma.measurement.createMany({ data: rows });

    // Backfill rollups.
    await recomputeUserRollups(user.id, { granularities: ["DAY"] });

    const buckets = await prisma.measurementRollup.findMany({
      where: { userId: user.id, type: "WEIGHT", granularity: "DAY" },
      orderBy: { bucketStart: "asc" },
    });

    // Re-aggregate the DAY buckets through the rollup-read helper.
    const reAggregated = aggregateBuckets(
      buckets.map((b) => ({
        day: b.bucketStart,
        count: b.count,
        mean: b.mean,
        minValue: b.minValue,
        maxValue: b.maxValue,
      })),
    );

    // Compare against a parallel live $queryRaw — the source of truth
    // the v1.4.34.5 comprehensive aggregator uses.
    const live = await prisma.$queryRaw<
      Array<{
        count: bigint;
        min_value: number;
        max_value: number;
        mean_value: number;
      }>
    >`
      SELECT
        COUNT(*)                                AS count,
        MIN(m."value")::double precision         AS min_value,
        MAX(m."value")::double precision         AS max_value,
        AVG(m."value")::double precision         AS mean_value
      FROM measurements m
      WHERE m."user_id" = ${user.id}
        AND m."type" = 'WEIGHT'
    `;

    expect(reAggregated.count).toBe(Number(live[0].count));
    expect(reAggregated.min).toBeCloseTo(live[0].min_value, 5);
    expect(reAggregated.max).toBeCloseTo(live[0].max_value, 5);
    expect(reAggregated.mean).toBeCloseTo(live[0].mean_value, 5);
  });

  // ─── v1.4.35 read-swap parity ──────────────────────────────
  //
  // The aggregator + slim slice now source `count / min / max / mean`
  // from the DAY rollup buckets and fall back to live SQL when the
  // composed count disagrees with `COUNT(*)`. These tests pin the
  // happy path (rollup-derived equals live byte-for-byte) and the
  // post-write freshness path (a new measurement after a warm read
  // is reflected on the next call).

  it("comprehensive aggregator's count/min/max/mean matches live SQL byte-for-byte after warm rollup", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "rollup-readswap-user",
        email: "rollup-readswap@example.test",
        role: "USER",
      },
    });

    // 50 measurements across 30 days for WEIGHT and PULSE so both
    // type families exercise the per-type composition path. The
    // values are deliberately fractional so the round2 contract gets
    // a workout.
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const seedRows: Array<{
      userId: string;
      type: "WEIGHT" | "PULSE";
      value: number;
      unit: string;
      source: "MANUAL";
      measuredAt: Date;
    }> = [];
    for (let i = 0; i < 50; i++) {
      seedRows.push({
        userId: user.id,
        type: "WEIGHT",
        value: 80 + (i % 7) * 0.37,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(now - (29 - (i % 30)) * dayMs - i * 60 * 1000),
      });
      seedRows.push({
        userId: user.id,
        type: "PULSE",
        value: 60 + (i % 11) * 1.13,
        unit: "bpm",
        source: "MANUAL",
        measuredAt: new Date(now - (29 - (i % 30)) * dayMs - i * 90 * 1000),
      });
    }
    await prisma.measurement.createMany({ data: seedRows });

    // First call warms the rollup (ensureUserRollupsFresh fires the
    // DAY recompute since no buckets exist yet).
    const aggregate = await buildComprehensiveAggregate(user.id);

    // Parallel live aggregation over the same 90-day window. This is
    // the source of truth — the read-swap must produce the same
    // count/min/max/mean byte-for-byte.
    const ninetyDaysAgo = new Date(Date.now() - 90 * dayMs);
    const live = await prisma.$queryRaw<
      Array<{
        type: string;
        count: bigint;
        min_value: number;
        max_value: number;
        mean_value: number;
      }>
    >`
      SELECT
        m."type"::text                              AS type,
        COUNT(*)                                    AS count,
        MIN(m."value")::double precision            AS min_value,
        MAX(m."value")::double precision            AS max_value,
        AVG(m."value")::double precision            AS mean_value
      FROM measurements m
      WHERE m."user_id" = ${user.id}
        AND m."measured_at" >= ${ninetyDaysAgo}
      GROUP BY m."type"
    `;

    const round2 = (n: number) => Math.round(n * 100) / 100;

    expect(live.length).toBeGreaterThan(0);
    for (const liveRow of live) {
      const summary = aggregate.summaries[liveRow.type];
      expect(summary, `summary for ${liveRow.type}`).toBeDefined();
      expect(summary.count).toBe(Number(liveRow.count));
      expect(summary.min).toBe(round2(liveRow.min_value));
      expect(summary.max).toBe(round2(liveRow.max_value));
      // The composed weighted mean equals AVG(value) over the same
      // rows; both run through `round2`.
      expect(summary.mean).toBe(round2(liveRow.mean_value));
    }
  });

  it("dailyByType matches a parallel live SQL daily-mean aggregation", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "rollup-daily-user",
        email: "rollup-daily@example.test",
        role: "USER",
      },
    });

    const dayMs = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const rows: Array<{
      userId: string;
      type: "WEIGHT" | "BLOOD_PRESSURE_SYS" | "PULSE";
      value: number;
      unit: string;
      source: "MANUAL";
      measuredAt: Date;
    }> = [];
    // 3 readings per day for 20 days, three types.
    for (let day = 0; day < 20; day++) {
      const dayAnchor = now - day * dayMs;
      for (let k = 0; k < 3; k++) {
        rows.push({
          userId: user.id,
          type: "WEIGHT",
          value: 81 + day * 0.05 + k * 0.13,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date(dayAnchor - k * 60 * 60 * 1000),
        });
        rows.push({
          userId: user.id,
          type: "BLOOD_PRESSURE_SYS",
          value: 120 + day * 0.21 + k * 0.07,
          unit: "mmHg",
          source: "MANUAL",
          measuredAt: new Date(dayAnchor - k * 30 * 60 * 1000),
        });
        rows.push({
          userId: user.id,
          type: "PULSE",
          value: 65 + day * 0.07 + k * 0.19,
          unit: "bpm",
          source: "MANUAL",
          measuredAt: new Date(dayAnchor - k * 15 * 60 * 1000),
        });
      }
    }
    await prisma.measurement.createMany({ data: rows });

    const aggregate = await buildComprehensiveAggregate(user.id);

    // Parallel live aggregation — same shape the legacy SQL emitted.
    const ninetyDaysAgo = new Date(now - 90 * dayMs);
    const live = await prisma.$queryRaw<
      Array<{ type: string; day: string; mean_value: number }>
    >`
      SELECT
        m."type"::text AS type,
        TO_CHAR(date_trunc('day', m."measured_at"), 'YYYY-MM-DD') AS day,
        (ROUND((AVG(m."value"))::numeric, 2))::double precision AS mean_value
      FROM measurements m
      WHERE m."user_id" = ${user.id}
        AND m."measured_at" >= ${ninetyDaysAgo}
        AND m."type" IN ('WEIGHT', 'BLOOD_PRESSURE_SYS', 'PULSE')
      GROUP BY m."type", date_trunc('day', m."measured_at")
      ORDER BY m."type", day ASC
    `;

    const liveByType = new Map<string, Array<{ day: string; value: number }>>();
    for (const row of live) {
      const list = liveByType.get(row.type) ?? [];
      list.push({ day: row.day, value: Number(row.mean_value) });
      liveByType.set(row.type, list);
    }

    for (const [type, liveDaily] of liveByType.entries()) {
      const rollupDaily = aggregate.dailyByType[type];
      expect(rollupDaily, `dailyByType[${type}]`).toBeDefined();
      expect(rollupDaily!.length).toBe(liveDaily.length);
      for (let i = 0; i < liveDaily.length; i++) {
        expect(rollupDaily![i].day).toBe(liveDaily[i].day);
        // round2 of the bucket mean == ROUND(AVG, 2) of the same rows.
        expect(rollupDaily![i].value).toBeCloseTo(liveDaily[i].value, 5);
      }
    }
  });

  it("reflects a freshly written measurement on the next read after a warm cache", async () => {
    const prisma = getPrismaClient();
    const user = await prisma.user.create({
      data: {
        username: "rollup-freshness-user",
        email: "rollup-freshness@example.test",
        role: "USER",
      },
    });

    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    await prisma.measurement.createMany({
      data: [
        {
          userId: user.id,
          type: "WEIGHT",
          value: 80,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date(now - 5 * dayMs),
        },
        {
          userId: user.id,
          type: "WEIGHT",
          value: 81,
          unit: "kg",
          source: "MANUAL",
          measuredAt: new Date(now - 4 * dayMs),
        },
      ],
    });

    // Warm-up read populates the rollups via `ensureUserRollupsFresh`.
    const before = await buildComprehensiveAggregate(user.id);
    expect(before.summaries.WEIGHT.count).toBe(2);
    expect(before.summaries.WEIGHT.mean).toBe(80.5);

    // Insert a third row and synchronously refresh the DAY bucket the
    // way the write-path hooks do.
    const newMeasuredAt = new Date(now - 1 * dayMs);
    await prisma.measurement.create({
      data: {
        userId: user.id,
        type: "WEIGHT",
        value: 84,
        unit: "kg",
        source: "MANUAL",
        measuredAt: newMeasuredAt,
      },
    });
    await recomputeBucketsForMeasurement(user.id, "WEIGHT", newMeasuredAt);

    // Next read reflects the third measurement — the rollup-derived
    // count moves from 2 to 3 and the weighted mean tracks live SQL.
    const after = await buildComprehensiveAggregate(user.id);
    expect(after.summaries.WEIGHT.count).toBe(3);
    // Weighted mean across the 3 buckets (each count=1): (80+81+84)/3
    // = 81.6667 → round2 = 81.67.
    expect(after.summaries.WEIGHT.mean).toBe(81.67);
  });
});
