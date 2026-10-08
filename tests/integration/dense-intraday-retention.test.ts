/**
 * v1.10.2 — real-Postgres integration coverage for
 * `runDenseIntradayRetention()`. v1.28.31 — hourly fold grain.
 *
 * The mocked unit tests could not surface the v1.10.0.2 P2002
 * fold-coexistence bug class: the fold mints canonical `stats:` rows at
 * deterministic instants, but a row may ALREADY sit on the
 * `(userId, type, measuredAt, source, sleepStage)` unique index from
 * another path, or already carry the target externalId on
 * `(userId, type, source, externalId)`. This file seeds those colliding
 * shapes against a live Postgres and asserts the hourly fold coexists /
 * adopts, retires a pre-hourly daily row atomically, stays idempotent,
 * and preserves the dense-tier scope.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { runDenseIntradayRetention } from "@/lib/measurements/dense-intraday-retention";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";

const TEST_USER_ID = "user-dense-retention";
const TZ = "Europe/Berlin";
const DAY_KEY = "2026-05-01";
// The canonical local-noon instant the PRE-hourly fold wrote for the day.
const CANONICAL = canonicalDailyTimestamp(DAY_KEY, TZ);
const HRV_HK = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
const HRV_DAILY_STATS_ID = `stats:${HRV_HK}:${DAY_KEY}`;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "dense-retention",
      email: "dense-retention@example.test",
      timezone: TZ,
    },
  });
});

describe("runDenseIntradayRetention (real Postgres)", () => {
  it("folds out-of-window HRV per-sample rows into hourly MEANs and deletes them", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 40,
          unit: "ms",
          source: "APPLE_HEALTH",
          // Berlin UTC+2 → local hour 10.
          measuredAt: new Date("2026-05-01T08:00:00.000Z"),
          externalId: "hk-hrv-1",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 60,
          unit: "ms",
          source: "APPLE_HEALTH",
          // Same local hour 10 — folds into the SAME hourly mean.
          measuredAt: new Date("2026-05-01T08:40:00.000Z"),
          externalId: "hk-hrv-2",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 70,
          unit: "ms",
          source: "APPLE_HEALTH",
          // Local hour 11 — its own hourly row.
          measuredAt: new Date("2026-05-01T09:10:00.000Z"),
          externalId: "hk-hrv-3",
        },
      ],
    });

    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });

    expect(summary.totals.daysConsolidated).toBe(1);
    expect(summary.totals.perSampleRowsSoftDeleted).toBe(3);
    expect(summary.totals.hourlyRowsUpserted).toBe(2);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
    });
    expect(live).toHaveLength(2);
    // Hour 10: MEAN of (40, 60) = 50, anchored at local 10:30 (08:30Z).
    expect(live[0].externalId).toBe(`stats:${HRV_HK}:${DAY_KEY}T10`);
    expect(live[0].value).toBeCloseTo(50, 6);
    expect(live[0].measuredAt.toISOString()).toBe("2026-05-01T08:30:00.000Z");
    // Hour 11: its own value, anchored at local 11:30 (09:30Z).
    expect(live[1].externalId).toBe(`stats:${HRV_HK}:${DAY_KEY}T11`);
    expect(live[1].value).toBeCloseTo(70, 6);
    expect(live[1].measuredAt.toISOString()).toBe("2026-05-01T09:30:00.000Z");
    // v1.42 — the raw rows are gone, not tombstoned.
    expect(
      await prisma.measurement.count({
        where: { userId: TEST_USER_ID, type: "HEART_RATE_VARIABILITY" },
      }),
    ).toBe(2);
  });

  it("retires a pre-hourly DAILY stats row in the same pass (late-sync path, no P2002, no double count)", async () => {
    const prisma = getPrismaClient();
    // A pre-v1.28.31 fold already collapsed this day to the daily grain:
    // the canonical daily row sits at local-noon with the daily stats id.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 999, // stale daily mean — superseded by the hourly rows
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: CANONICAL,
        externalId: HRV_DAILY_STATS_ID,
      },
    });
    // Late-synced raw samples arrive for the already-folded day.
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 40,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T06:00:00.000Z"),
          externalId: "hk-hrv-1",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 60,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T18:00:00.000Z"),
          externalId: "hk-hrv-2",
        },
      ],
    });

    // Must not throw P2002.
    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(1);
    expect(summary.totals.dailyRowsRetired).toBe(1);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
      orderBy: { measuredAt: "asc" },
    });
    // ONLY the hourly rows are live — the daily row is tombstoned in the
    // same transaction, so an AVG-over-live-rows reader never double-counts.
    expect(live).toHaveLength(2);
    expect(live.map((r) => r.externalId)).toEqual([
      `stats:${HRV_HK}:${DAY_KEY}T08`,
      `stats:${HRV_HK}:${DAY_KEY}T20`,
    ]);
    expect(live.map((r) => r.value)).toEqual([40, 60]);

    const daily = await prisma.measurement.findFirst({
      where: { userId: TEST_USER_ID, externalId: HRV_DAILY_STATS_ID },
    });
    expect(daily?.deletedAt).not.toBeNull();
  });

  it("adopts a row already carrying the target hourly stats externalId (VECTOR 1, no P2002)", async () => {
    const prisma = getPrismaClient();
    // A prior hourly fold already minted the hour-08 row at its anchor.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 999, // stale — refreshed by the re-fold
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-01T06:30:00.000Z"), // local 08:30
        externalId: `stats:${HRV_HK}:${DAY_KEY}T08`,
      },
    });
    // A late raw sample lands in the same local hour.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 40,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-01T06:10:00.000Z"),
        externalId: "hk-hrv-late",
      },
    });

    // The sample the prior fold took for that hour, soft-deleted by it.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        value: 20,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-01T06:05:00.000Z"),
        externalId: "hk-hrv-early",
        deletedAt: new Date("2026-05-03T00:00:00.000Z"),
      },
    });

    // Must not throw P2002 — the fold adopts the existing hourly row.
    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(1);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    expect(live[0].externalId).toBe(`stats:${HRV_HK}:${DAY_KEY}T08`);
    // Refreshed to the mean over every sample of the hour, the prior fold's
    // tombstone included, never to the late sample alone.
    expect(live[0].value).toBeCloseTo(30, 6);
    expect(live[0].measuredAt.toISOString()).toBe("2026-05-01T06:30:00.000Z");
  });

  it("does not tombstone a per-sample row that happens to fall on an hourly anchor", async () => {
    const prisma = getPrismaClient();
    // One per-sample row sits exactly on the local-10:30 anchor instant;
    // it must become the adopted hourly row, not get soft-deleted.
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 50,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T08:30:00.000Z"), // local 10:30
          externalId: "hk-hrv-anchor",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 70,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T08:00:00.000Z"), // same local hour
          externalId: "hk-hrv-sibling",
        },
      ],
    });

    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(1);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    expect(live[0].measuredAt.toISOString()).toBe("2026-05-01T08:30:00.000Z");
    // MEAN of (50, 70) = 60 — the adopted row carries the hour's mean.
    expect(live[0].value).toBeCloseTo(60, 6);
    expect(live[0].externalId).toBe(`stats:${HRV_HK}:${DAY_KEY}T10`);
  });

  it("is idempotent — a second run is a no-op and the values stay correct", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 60,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T06:00:00.000Z"),
          externalId: "hk-pulse-1",
        },
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 80,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-01T18:00:00.000Z"),
          externalId: "hk-pulse-2",
        },
      ],
    });

    const first = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(first.totals.daysConsolidated).toBe(1);
    expect(first.totals.perSampleRowsSoftDeleted).toBe(2);
    expect(first.totals.hourlyRowsUpserted).toBe(2);

    // Second run must converge to zero work and never collide on the
    // hourly rows it minted on the first pass (the `stats:` prefix keeps
    // them out of the scan).
    const second = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      retentionDays: 0,
      log: () => {},
    });
    expect(second.totals.daysConsolidated).toBe(0);
    expect(second.totals.perSampleRowsSoftDeleted).toBe(0);
    expect(second.totals.hourlyRowsUpserted).toBe(0);

    const live = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "PULSE", deletedAt: null },
      orderBy: { measuredAt: "asc" },
    });
    expect(live).toHaveLength(2);
    // Each hour keeps its own mean (60 and 80) — never a blended 70.
    expect(live.map((r) => r.value)).toEqual([60, 80]);
  });

  it("keeps in-window per-sample rows raw (retention bound)", async () => {
    const prisma = getPrismaClient();
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // 2 days ago
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 45,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: recent,
          externalId: "hk-hrv-recent-1",
        },
        {
          userId: TEST_USER_ID,
          type: "HEART_RATE_VARIABILITY",
          value: 55,
          unit: "ms",
          source: "APPLE_HEALTH",
          measuredAt: new Date(recent.getTime() + 60 * 60 * 1000),
          externalId: "hk-hrv-recent-2",
        },
      ],
    });

    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      // Default 90-day window — both rows are inside it.
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(0);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
    });
    // Both raw samples survive — the intra-day shape is preserved.
    expect(live).toHaveLength(2);
  });

  it("folds Health Connect raw heart rate past the window into its own hourly rows, beside Apple Health's", async () => {
    const prisma = getPrismaClient();
    // Berlin UTC+2 on 1 May: 08:xx UTC is local hour 10 — far past 90 days.
    const at = (minute: number) =>
      new Date(`2026-05-01T08:${String(minute).padStart(2, "0")}:00.000Z`);
    await prisma.measurement.createMany({
      data: [
        ...[60, 70, 80].map((value, i) => ({
          userId: TEST_USER_ID,
          type: "PULSE" as const,
          value,
          unit: "bpm",
          source: "HEALTH_CONNECT" as const,
          measuredAt: at(i * 10 + 1),
          externalId: `hc:00000000-0000-0000-0000-00000000000a:${i}`,
        })),
        {
          userId: TEST_USER_ID,
          type: "PULSE" as const,
          value: 100,
          unit: "bpm",
          source: "APPLE_HEALTH" as const,
          measuredAt: at(5),
          externalId: "hk-pulse-1",
        },
      ],
    });

    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      // The default 90-day window: the samples are well past it.
      log: () => {},
    });
    expect(summary.totals.perSampleRowsSoftDeleted).toBe(4);

    const rows = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "PULSE" },
      orderBy: { source: "asc" },
    });
    // Raw rows of both sources are gone outright, not tombstoned.
    expect(rows.every((row) => row.externalId?.startsWith("stats:"))).toBe(
      true,
    );
    expect(rows.every((row) => row.deletedAt === null)).toBe(true);
    const id = "stats:HKQuantityTypeIdentifierHeartRate:2026-05-01T10";
    // One mean per source: the two sources never share a row.
    expect(rows.map((row) => [row.source, row.externalId, row.value])).toEqual([
      ["APPLE_HEALTH", id, 100],
      ["HEALTH_CONNECT", id, 70],
    ]);

    // A second run finds nothing left to fold.
    const again = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      log: () => {},
    });
    expect(again.totals.daysConsolidated).toBe(0);
  });

  it("keeps Health Connect raw heart rate inside the window raw", async () => {
    const prisma = getPrismaClient();
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "PULSE",
        value: 64,
        unit: "bpm",
        source: "HEALTH_CONNECT",
        measuredAt: recent,
        externalId: "hc:00000000-0000-0000-0000-00000000000b:1",
      },
    });
    const summary = await runDenseIntradayRetention(prisma, {
      userId: TEST_USER_ID,
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(0);
    expect(
      await prisma.measurement.count({
        where: { userId: TEST_USER_ID, source: "HEALTH_CONNECT" },
      }),
    ).toBe(1);
  });
});
