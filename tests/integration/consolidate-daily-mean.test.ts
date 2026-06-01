/**
 * v1.7.0 — real-Postgres integration coverage for
 * `consolidateDailyMean()`. Mirrors the consolidate-legacy-steps
 * fixture: the testcontainer is hot before this file loads, so the
 * body truncates + seeds + consolidates.
 *
 * Pins the contracts the unit mocks can't:
 *   - per-sample mean-type rows collapse into one daily MEAN row;
 *   - the originals are SOFT-deleted (tombstoned, not gone);
 *   - manual / Withings (non-APPLE_HEALTH) rows are NOT touched;
 *   - PULSE per-sample rows are NEVER drained (kept raw for
 *     correlation/scatter);
 *   - the pass is idempotent (second run = no-op).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { consolidateDailyMean } from "@/lib/measurements/consolidate-daily-mean";

const TEST_USER_ID = "user-mean-consolidation";
const SPEED_STATS_ID = "stats:HKQuantityTypeIdentifierWalkingSpeed:2026-05-16";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "mean-consolidation",
      email: "mean-consolidation@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("consolidateDailyMean (real Postgres)", () => {
  it("collapses per-sample rows into one daily MEAN and soft-deletes the originals", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "WALKING_SPEED",
          value: 1.0,
          unit: "m/s",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-speed-1",
        },
        {
          userId: TEST_USER_ID,
          type: "WALKING_SPEED",
          value: 1.4,
          unit: "m/s",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T14:00:00.000Z"),
          externalId: "hk-speed-2",
        },
        {
          userId: TEST_USER_ID,
          type: "WALKING_SPEED",
          value: 1.2,
          unit: "m/s",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T20:00:00.000Z"),
          externalId: "hk-speed-3",
        },
      ],
    });

    const summary = await consolidateDailyMean(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });

    expect(summary.totals.daysConsolidated).toBe(1);
    expect(summary.totals.perSampleRowsSoftDeleted).toBe(3);
    expect(summary.totals.dailyRowsUpserted).toBe(1);

    const live = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "WALKING_SPEED", deletedAt: null },
    });
    expect(live).toHaveLength(1);
    // MEAN of (1.0, 1.4, 1.2) = 1.2 — NOT the sum (3.6).
    expect(live[0].value).toBeCloseTo(1.2, 6);
    expect(live[0].externalId).toBe(SPEED_STATS_ID);

    const tombstoned = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "WALKING_SPEED",
        deletedAt: { not: null },
      },
    });
    expect(tombstoned).toHaveLength(3);
  });

  it("leaves manual / Withings (non-APPLE_HEALTH) rows untouched", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "RESPIRATORY_RATE",
          value: 14,
          unit: "breaths/min",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-rr-1",
        },
        {
          userId: TEST_USER_ID,
          type: "RESPIRATORY_RATE",
          value: 16,
          unit: "breaths/min",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T09:00:00.000Z"),
          externalId: "hk-rr-2",
        },
        {
          userId: TEST_USER_ID,
          type: "RESPIRATORY_RATE",
          value: 18,
          unit: "breaths/min",
          source: "MANUAL",
          measuredAt: new Date("2026-05-16T10:00:00.000Z"),
          externalId: null,
        },
      ],
    });

    await consolidateDailyMean(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });

    // The MANUAL row stays live + untouched.
    const manualLive = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "RESPIRATORY_RATE",
        source: "MANUAL",
        deletedAt: null,
      },
    });
    expect(manualLive).toHaveLength(1);
    expect(manualLive[0].value).toBe(18);

    // The two APPLE_HEALTH samples collapsed to one daily MEAN (15).
    const hkLive = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "RESPIRATORY_RATE",
        source: "APPLE_HEALTH",
        deletedAt: null,
      },
    });
    expect(hkLive).toHaveLength(1);
    expect(hkLive[0].value).toBeCloseTo(15, 6);
  });

  it("never drains PULSE (kept raw for correlation/scatter)", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 60,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-pulse-1",
        },
        {
          userId: TEST_USER_ID,
          type: "PULSE",
          value: 80,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T09:00:00.000Z"),
          externalId: "hk-pulse-2",
        },
      ],
    });

    const summary = await consolidateDailyMean(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });
    expect(summary.totals.daysConsolidated).toBe(0);

    // Both raw PULSE rows survive — none tombstoned, none collapsed.
    const live = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "PULSE", deletedAt: null },
    });
    expect(live).toHaveLength(2);
  });

  it("is idempotent — a second run is a no-op", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "AUDIO_EXPOSURE_ENV",
          value: 60,
          unit: "dBA",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-env-1",
        },
        {
          userId: TEST_USER_ID,
          type: "AUDIO_EXPOSURE_ENV",
          value: 80,
          unit: "dBA",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T18:00:00.000Z"),
          externalId: "hk-env-2",
        },
      ],
    });

    const first = await consolidateDailyMean(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });
    expect(first.totals.daysConsolidated).toBe(1);
    expect(first.totals.perSampleRowsSoftDeleted).toBe(2);

    const second = await consolidateDailyMean(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });
    expect(second.totals.daysConsolidated).toBe(0);
    expect(second.totals.perSampleRowsSoftDeleted).toBe(0);

    const live = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "AUDIO_EXPOSURE_ENV",
        deletedAt: null,
      },
    });
    expect(live).toHaveLength(1);
    // MEAN of (60, 80) = 70.
    expect(live[0].value).toBeCloseTo(70, 6);
  });
});
