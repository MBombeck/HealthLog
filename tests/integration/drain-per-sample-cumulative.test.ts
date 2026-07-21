/**
 * v1.4.30 — real-Postgres integration coverage for
 * `drainPerSampleCumulative()`. Mirrors the
 * `measurements-aggregate-daily` fixture: the testcontainer is hot
 * before this file loads, so the body just truncates + seeds + drains.
 *
 * The drain logic operates against `prisma.$transaction` with an upsert
 * inside; mocking that surface would re-introduce the v1.4.29 lesson
 * (mocks hide real-SQL behaviour). The container test pins the
 * idempotent-re-run contract end-to-end.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { drainPerSampleCumulative } from "@/lib/measurements/drain-per-sample-cumulative";

const TEST_USER_ID = "user-drain-cumulative";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "drain-cumulative",
      email: "drain-cumulative@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("drainPerSampleCumulative (real Postgres)", () => {
  it("collapses three per-sample step rows on the same day into one daily row", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 1200,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-uuid-1",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 3400,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T14:00:00.000Z"),
          externalId: "hk-uuid-2",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 800,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T20:00:00.000Z"),
          externalId: "hk-uuid-3",
        },
      ],
    });

    const summary = await drainPerSampleCumulative(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });

    expect(summary.dryRun).toBe(false);
    expect(summary.totals.bucketsCollapsed).toBe(1);
    expect(summary.totals.perSampleRowsDeleted).toBe(3);
    expect(summary.totals.dailyRowsUpserted).toBe(1);

    const remaining = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        source: "APPLE_HEALTH",
      },
      orderBy: { measuredAt: "asc" },
    });

    expect(remaining).toHaveLength(1);
    expect(remaining[0].value).toBe(5400);
    expect(remaining[0].externalId).toBe(
      "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
    );
    // 12:00 Berlin during DST = 10:00 UTC.
    expect(remaining[0].measuredAt.toISOString()).toBe(
      "2026-05-16T10:00:00.000Z",
    );
    expect(remaining[0]).toMatchObject({
      aggregationProvenance: "LEGACY_UNKNOWN",
      syncVersion: 1,
    });
  });

  it("is idempotent — a second run after a successful drain is a no-op", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 1200,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-uuid-1",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 800,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T14:00:00.000Z"),
          externalId: "hk-uuid-2",
        },
      ],
    });

    await drainPerSampleCumulative(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });
    const second = await drainPerSampleCumulative(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });

    expect(second.totals.bucketsCollapsed).toBe(0);
    expect(second.totals.perSampleRowsDeleted).toBe(0);
    expect(second.totals.dailyRowsUpserted).toBe(0);
  });

  it("dry-run reports the plan without touching the DB", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "FLIGHTS_CLIMBED",
          value: 5,
          unit: "flights",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-flights-1",
        },
        {
          userId: TEST_USER_ID,
          type: "FLIGHTS_CLIMBED",
          value: 3,
          unit: "flights",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T14:00:00.000Z"),
          externalId: "hk-flights-2",
        },
      ],
    });

    const summary = await drainPerSampleCumulative(prisma, {
      userId: TEST_USER_ID,
      dryRun: true,
      log: () => {},
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.totals.bucketsCollapsed).toBe(1);
    expect(summary.buckets[0].sumValue).toBe(8);
    expect(summary.buckets[0].externalId).toBe(
      "stats:HKQuantityTypeIdentifierFlightsClimbed:2026-05-16",
    );

    // DB unchanged.
    const remaining = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "FLIGHTS_CLIMBED" },
    });
    expect(remaining).toHaveLength(2);
  });

  it("ignores spot metrics (PULSE) — only cumulative types collapse", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 64,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-pulse-1",
        },
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 72,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T14:00:00.000Z"),
          externalId: "hk-pulse-2",
        },
      ],
    });

    const summary = await drainPerSampleCumulative(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });

    expect(summary.totals.bucketsCollapsed).toBe(0);

    const remaining = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "PULSE" },
    });
    expect(remaining).toHaveLength(2);
  });

  it.each(["HEALTHKIT_STATISTICS", "EXPORT_XML_SOURCE_MAX"] as const)(
    "drains source rows without mutating an authoritative %s total",
    async (aggregationProvenance) => {
      const prisma = getPrismaClient();
      await prisma.measurement.createMany({
        data: [
          {
            userId: TEST_USER_ID,
            type: "ACTIVITY_STEPS",
            value: 5_400,
            unit: "steps",
            source: "APPLE_HEALTH",
            measuredAt: new Date("2026-05-16T10:00:00.000Z"),
            externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
            aggregationProvenance,
          },
          {
            userId: TEST_USER_ID,
            type: "ACTIVITY_STEPS",
            value: 500,
            unit: "steps",
            source: "APPLE_HEALTH",
            measuredAt: new Date("2026-05-16T20:00:00.000Z"),
            externalId: `late-${aggregationProvenance}`,
          },
        ],
      });

      await drainPerSampleCumulative(prisma, {
        userId: TEST_USER_ID,
        log: () => {},
      });

      const remaining = await prisma.measurement.findMany({
        where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS" },
      });
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toMatchObject({
        value: 5_400,
        aggregationProvenance,
        syncVersion: 1,
      });
    },
  );

  it("keeps legacy late-increment semantics and bumps syncVersion", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 5_400,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T10:00:00.000Z"),
          externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
          aggregationProvenance: "LEGACY_UNKNOWN",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 500,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T20:00:00.000Z"),
          externalId: "late-legacy",
        },
      ],
    });

    await drainPerSampleCumulative(prisma, {
      userId: TEST_USER_ID,
      log: () => {},
    });

    const remaining = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS" },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      value: 5_900,
      aggregationProvenance: "LEGACY_UNKNOWN",
      syncVersion: 2,
    });
  });

  it("skips rows already in stats:... shape (re-running after an earlier drain)", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        value: 5400,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-16T10:00:00.000Z"),
        externalId: "stats:HKQuantityTypeIdentifierStepCount:2026-05-16",
      },
    });

    const summary = await drainPerSampleCumulative(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });

    expect(summary.totals.bucketsCollapsed).toBe(0);
    const remaining = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS" },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].value).toBe(5400);
  });
});
