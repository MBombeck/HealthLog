/**
 * v1.5.6 — real-Postgres integration coverage for
 * `consolidateLegacySteps()`. Mirrors the
 * `drain-per-sample-cumulative` fixture: the testcontainer is hot
 * before this file loads, so the body truncates + seeds + consolidates.
 *
 * Pins the contracts the unit mocks can't:
 *   - legacy granular rows collapse into one daily total with the
 *     correct sum;
 *   - the originals are SOFT-deleted (tombstoned, not gone);
 *   - a day already holding a `stats:` total is not double-counted;
 *   - the discovery query is idempotent (second run = no-op).
 */
import { beforeEach, describe, expect, it } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";
import { consolidateLegacySteps } from "@/lib/measurements/consolidate-legacy-steps";

const TEST_USER_ID = "user-step-consolidation";
const STEP_TOTAL_ID = "stats:HKQuantityTypeIdentifierStepCount:2026-05-16";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  await getPrismaClient().user.create({
    data: {
      id: TEST_USER_ID,
      username: "step-consolidation",
      email: "step-consolidation@example.test",
      timezone: "Europe/Berlin",
    },
  });
});

describe("consolidateLegacySteps (real Postgres)", () => {
  it("collapses legacy granular step rows into one daily total and soft-deletes the originals", async () => {
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
          externalId: "hk-legacy-1",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 3400,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T14:00:00.000Z"),
          externalId: "hk-legacy-2",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 800,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T20:00:00.000Z"),
          externalId: "hk-legacy-3",
        },
      ],
    });

    const summary = await consolidateLegacySteps(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });

    expect(summary.totals.daysConsolidated).toBe(1);
    expect(summary.totals.legacyRowsSoftDeleted).toBe(3);
    expect(summary.totals.dailyRowsUpserted).toBe(1);
    expect(summary.totals.daysFoldedIntoExisting).toBe(0);

    // One live daily total carrying the canonical externalId + sum.
    const live = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS", deletedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].value).toBe(5400);
    expect(live[0].externalId).toBe(STEP_TOTAL_ID);

    // Originals are tombstoned, NOT gone — audit trail preserved.
    const tombstoned = await prisma.measurement.findMany({
      where: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        deletedAt: { not: null },
      },
    });
    expect(tombstoned).toHaveLength(3);
    expect(tombstoned.every((r) => r.externalId?.startsWith("hk-legacy-"))).toBe(
      true,
    );
  });

  it("does not double-count when a stats: daily total already exists for the day", async () => {
    const prisma = getPrismaClient();
    // Post-v1.5.0 daily total already written by iOS.
    await prisma.measurement.create({
      data: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        value: 9000,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-16T10:00:00.000Z"),
        externalId: STEP_TOTAL_ID,
      },
    });
    // Legacy granular rows for the same day.
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 1200,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T08:00:00.000Z"),
          externalId: "hk-legacy-a",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 800,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T20:00:00.000Z"),
          externalId: "hk-legacy-b",
        },
      ],
    });

    const summary = await consolidateLegacySteps(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });

    expect(summary.totals.daysConsolidated).toBe(1);
    expect(summary.totals.daysFoldedIntoExisting).toBe(1);
    // No new daily row minted — the existing total stands.
    expect(summary.totals.dailyRowsUpserted).toBe(0);
    expect(summary.totals.legacyRowsSoftDeleted).toBe(2);

    const live = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS", deletedAt: null },
    });
    expect(live).toHaveLength(1);
    // The existing total is untouched — NOT 9000 + 1200 + 800.
    expect(live[0].value).toBe(9000);
    expect(live[0].externalId).toBe(STEP_TOTAL_ID);

    // Both legacy rows tombstoned.
    const tombstoned = await prisma.measurement.count({
      where: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        deletedAt: { not: null },
      },
    });
    expect(tombstoned).toBe(2);
  });

  it("is idempotent — a second run is a no-op", async () => {
    const prisma = getPrismaClient();
    await prisma.measurement.createMany({
      data: [
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 2000,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T09:00:00.000Z"),
          externalId: "hk-legacy-x",
        },
        {
          userId: TEST_USER_ID,
          type: "ACTIVITY_STEPS",
          value: 3000,
          unit: "steps",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-05-16T18:00:00.000Z"),
          externalId: "hk-legacy-y",
        },
      ],
    });

    const first = await consolidateLegacySteps(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });
    expect(first.totals.daysConsolidated).toBe(1);
    expect(first.totals.legacyRowsSoftDeleted).toBe(2);

    const second = await consolidateLegacySteps(prisma, {
      userId: TEST_USER_ID,
      dryRun: false,
      log: () => {},
    });
    expect(second.totals.daysConsolidated).toBe(0);
    expect(second.totals.legacyRowsSoftDeleted).toBe(0);
    expect(second.totals.dailyRowsUpserted).toBe(0);

    // State is stable: one live total (5000), two tombstones.
    const live = await prisma.measurement.findMany({
      where: { userId: TEST_USER_ID, type: "ACTIVITY_STEPS", deletedAt: null },
    });
    expect(live).toHaveLength(1);
    expect(live[0].value).toBe(5000);
    const tombstoned = await prisma.measurement.count({
      where: {
        userId: TEST_USER_ID,
        type: "ACTIVITY_STEPS",
        deletedAt: { not: null },
      },
    });
    expect(tombstoned).toBe(2);
  });
});
