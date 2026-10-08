/**
 * v1.42 — a stored `stats:` mean is recomputed from its samples only where
 * those are provably all still in the table, and never from a fragment.
 * Against Postgres.
 *
 *   - The fold repair corrects a partial mean inside the tombstone horizon,
 *     takes the window's live samples into it, and leaves a day before the
 *     horizon exactly as it is, counting it as skipped. A second run corrects
 *     nothing.
 *   - The daily-mean consolidation and the dense hourly fold leave a stored
 *     day or hour before the horizon as it is, its live samples included, and
 *     still fold a day before the horizon that has no stored mean yet.
 *   - The repair and the consolidation over the same account, at the same
 *     time, end on the mean over every sample, and a repair after them
 *     corrects nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const WS_HK = "HKQuantityTypeIdentifierWalkingSpeed";
const HRV_HK = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";

/** The instant every test reads the horizon against. */
const NOW = "2026-10-08T12:00:00.000Z";
/** About 210 days back: before the daily horizon and the hourly one. */
const OLD_DAY = "2026-03-10";
/** Inside the daily horizon. */
const RECENT_DAY = "2026-09-18";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

async function account(id: string) {
  await getPrismaClient().user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      timezone: "UTC",
    },
  });
}

async function liveValue(userId: string, type: string, externalId: string) {
  const row = await getPrismaClient().measurement.findFirst({
    where: { userId, type: type as never, externalId, deletedAt: null },
    select: { value: true },
  });
  return row?.value;
}

async function liveSampleIds(userId: string, type: string) {
  const rows = await getPrismaClient().measurement.findMany({
    where: {
      userId,
      type: type as never,
      deletedAt: null,
      NOT: { externalId: { startsWith: "stats:" } },
    },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

type Sample = {
  id: string;
  type: "WALKING_SPEED" | "HEART_RATE_VARIABILITY";
  value: number;
  at: string;
  deletedAt?: string;
};

async function seed(userId: string, stats: Sample[], samples: Sample[]) {
  const prisma = getPrismaClient();
  await prisma.measurement.createMany({
    data: [
      ...stats.map((row) => ({
        id: `${userId}-${row.id}`,
        userId,
        type: row.type,
        value: row.value,
        unit: row.type === "WALKING_SPEED" ? "m/s" : "ms",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(row.at),
        externalId:
          row.type === "WALKING_SPEED"
            ? `stats:${WS_HK}:${row.at.slice(0, 10)}`
            : `stats:${HRV_HK}:${row.at.slice(0, 13)}`,
      })),
      ...samples.map((row) => ({
        id: `${userId}-${row.id}`,
        userId,
        type: row.type,
        value: row.value,
        unit: row.type === "WALKING_SPEED" ? "m/s" : "ms",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(row.at),
        externalId: `uuid-${userId}-${row.id}`,
        deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
        syncVersion: 1,
      })),
    ],
  });
}

/**
 * An old day whose mean was taken from its full day long ago (the samples'
 * tombstones are purged), and a fragment of it present now: two samples a
 * later re-upload put back and a fold took again in September, and one more
 * re-uploaded today. A mean over the fragment is 1; the stored mean is 3.
 */
async function seedOldDay(userId: string) {
  await seed(
    userId,
    [
      {
        id: "old-mean",
        type: "WALKING_SPEED",
        value: 3,
        at: `${OLD_DAY}T12:00:00.000Z`,
      },
    ],
    [
      {
        id: "old-t1",
        type: "WALKING_SPEED",
        value: 1,
        at: `${OLD_DAY}T08:00:00.000Z`,
        deletedAt: "2026-09-01T03:00:00.000Z",
      },
      {
        id: "old-t2",
        type: "WALKING_SPEED",
        value: 1,
        at: `${OLD_DAY}T09:00:00.000Z`,
        deletedAt: "2026-09-01T03:00:00.000Z",
      },
      {
        id: "old-live",
        type: "WALKING_SPEED",
        value: 1,
        at: `${OLD_DAY}T10:00:00.000Z`,
      },
    ],
  );
}

/**
 * A recent day an old release folded in two runs (stored: the evening only,
 * 2), plus one sample synced after the second run. Every sample is here: the
 * mean over all of them is (1 + 1 + 2 + 2 + 2) / 5 = 1.6.
 */
async function seedRecentDay(userId: string) {
  await seed(
    userId,
    [
      {
        id: "recent-mean",
        type: "WALKING_SPEED",
        value: 2,
        at: `${RECENT_DAY}T12:00:00.000Z`,
      },
    ],
    [
      {
        id: "recent-t1",
        type: "WALKING_SPEED",
        value: 1,
        at: `${RECENT_DAY}T08:00:00.000Z`,
        deletedAt: "2026-09-20T03:00:00.000Z",
      },
      {
        id: "recent-t2",
        type: "WALKING_SPEED",
        value: 1,
        at: `${RECENT_DAY}T10:00:00.000Z`,
        deletedAt: "2026-09-20T03:00:00.000Z",
      },
      {
        id: "recent-t3",
        type: "WALKING_SPEED",
        value: 2,
        at: `${RECENT_DAY}T20:00:00.000Z`,
        deletedAt: "2026-09-21T03:00:00.000Z",
      },
      {
        id: "recent-t4",
        type: "WALKING_SPEED",
        value: 2,
        at: `${RECENT_DAY}T22:00:00.000Z`,
        deletedAt: "2026-09-21T03:00:00.000Z",
      },
      {
        id: "recent-live",
        type: "WALKING_SPEED",
        value: 2,
        at: `${RECENT_DAY}T23:30:00.000Z`,
      },
    ],
  );
}

describe("fold repair horizon", () => {
  it("repairs inside the horizon, leaves an older day as it is, and a second run corrects nothing", async () => {
    const prisma = getPrismaClient();
    await account("horizon-repair");
    await seedOldDay("horizon-repair");
    await seedRecentDay("horizon-repair");
    const oldTombstonesBefore = await prisma.measurement.findMany({
      where: { userId: "horizon-repair", deletedAt: { not: null } },
      select: { id: true, deletedAt: true },
      orderBy: { id: "asc" },
    });
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");

    const first = await repairFoldedMeans(prisma, "horizon-repair");
    expect(first.status).toBe("completed");
    expect(first.byType.WALKING_SPEED).toEqual({
      windowsChecked: 1,
      windowsCorrected: 1,
      restingCorrected: 0,
      windowsSkippedBeyondHorizon: 1,
      samplesAbsorbed: 1,
    });
    expect(
      await liveValue(
        "horizon-repair",
        "WALKING_SPEED",
        `stats:${WS_HK}:${OLD_DAY}`,
      ),
    ).toBe(3);
    expect(
      await liveValue(
        "horizon-repair",
        "WALKING_SPEED",
        `stats:${WS_HK}:${RECENT_DAY}`,
      ),
    ).toBeCloseTo(1.6, 9);
    // The old day's live sample is still live; the recent one is a leftover.
    expect(await liveSampleIds("horizon-repair", "WALKING_SPEED")).toEqual([
      "horizon-repair-old-live",
    ]);
    const oldTombstonesAfter = await prisma.measurement.findMany({
      where: {
        userId: "horizon-repair",
        deletedAt: { not: null },
        id: { in: oldTombstonesBefore.map((row) => row.id) },
      },
      select: { id: true, deletedAt: true },
      orderBy: { id: "asc" },
    });
    expect(oldTombstonesAfter).toEqual(oldTombstonesBefore);

    const again = await repairFoldedMeans(prisma, "horizon-repair");
    expect(again.byType.WALKING_SPEED).toEqual({
      windowsChecked: 1,
      windowsCorrected: 0,
      restingCorrected: 0,
      windowsSkippedBeyondHorizon: 1,
      samplesAbsorbed: 0,
    });
    expect(
      await liveValue(
        "horizon-repair",
        "WALKING_SPEED",
        `stats:${WS_HK}:${RECENT_DAY}`,
      ),
    ).toBeCloseTo(1.6, 9);
  });

  it("leaves an hourly mean before the hourly horizon as it is", async () => {
    const prisma = getPrismaClient();
    await account("horizon-repair-hourly");
    await seed(
      "horizon-repair-hourly",
      [
        {
          id: "hour-mean",
          type: "HEART_RATE_VARIABILITY",
          value: 60,
          at: `${OLD_DAY}T10:30:00.000Z`,
        },
      ],
      [
        {
          id: "hour-t1",
          type: "HEART_RATE_VARIABILITY",
          value: 20,
          at: `${OLD_DAY}T10:05:00.000Z`,
          // Folded 90 days on, kept 75 more: purged by now in reality, here
          // the one survivor of a fragment.
          deletedAt: "2026-06-10T10:30:00.000Z",
        },
      ],
    );
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");

    const result = await repairFoldedMeans(prisma, "horizon-repair-hourly");
    expect(result.byType.HEART_RATE_VARIABILITY).toMatchObject({
      windowsChecked: 0,
      windowsCorrected: 0,
      windowsSkippedBeyondHorizon: 1,
    });
    expect(
      await liveValue(
        "horizon-repair-hourly",
        "HEART_RATE_VARIABILITY",
        `stats:${HRV_HK}:${OLD_DAY}T10`,
      ),
    ).toBe(60);
  });
});

describe("regular folds before the horizon", () => {
  it("the daily-mean consolidation keeps an old stored mean and its live sample, and folds an old day without one", async () => {
    const prisma = getPrismaClient();
    await account("horizon-mean");
    await seedOldDay("horizon-mean");
    // An old day nobody folded yet: no stored mean to protect.
    await seed(
      "horizon-mean",
      [],
      [
        {
          id: "new-a",
          type: "WALKING_SPEED",
          value: 1,
          at: "2026-03-12T08:00:00.000Z",
        },
        {
          id: "new-b",
          type: "WALKING_SPEED",
          value: 2,
          at: "2026-03-12T09:00:00.000Z",
        },
      ],
    );
    const { consolidateDailyMean } =
      await import("@/lib/measurements/consolidate-daily-mean");

    const summary = await consolidateDailyMean(prisma, {
      userId: "horizon-mean",
      cutoffHours: 36,
      log: () => {},
    });

    expect(summary.totals.daysLeftAsStored).toBe(1);
    expect(summary.totals.daysConsolidated).toBe(1);
    expect(
      await liveValue(
        "horizon-mean",
        "WALKING_SPEED",
        `stats:${WS_HK}:${OLD_DAY}`,
      ),
    ).toBe(3);
    expect(
      await liveValue(
        "horizon-mean",
        "WALKING_SPEED",
        `stats:${WS_HK}:2026-03-12`,
      ),
    ).toBeCloseTo(1.5, 9);
    expect(await liveSampleIds("horizon-mean", "WALKING_SPEED")).toEqual([
      "horizon-mean-old-live",
    ]);

    // The next night changes nothing either.
    const again = await consolidateDailyMean(prisma, {
      userId: "horizon-mean",
      cutoffHours: 36,
      log: () => {},
    });
    expect(again.totals.daysConsolidated).toBe(0);
    expect(
      await liveValue(
        "horizon-mean",
        "WALKING_SPEED",
        `stats:${WS_HK}:${OLD_DAY}`,
      ),
    ).toBe(3);
  });

  it("the dense hourly fold keeps an old stored hour and its live sample", async () => {
    const prisma = getPrismaClient();
    await account("horizon-dense");
    await seed(
      "horizon-dense",
      [
        {
          id: "hour-mean",
          type: "HEART_RATE_VARIABILITY",
          value: 60,
          at: `${OLD_DAY}T10:30:00.000Z`,
        },
      ],
      [
        {
          id: "hour-t1",
          type: "HEART_RATE_VARIABILITY",
          value: 20,
          at: `${OLD_DAY}T10:05:00.000Z`,
          deletedAt: "2026-06-10T10:30:00.000Z",
        },
        {
          id: "hour-live",
          type: "HEART_RATE_VARIABILITY",
          value: 20,
          at: `${OLD_DAY}T10:10:00.000Z`,
        },
        // Another hour of the same day, never folded: folds as usual.
        {
          id: "other-hour",
          type: "HEART_RATE_VARIABILITY",
          value: 50,
          at: `${OLD_DAY}T14:10:00.000Z`,
        },
      ],
    );
    const { runDenseIntradayRetention } =
      await import("@/lib/measurements/dense-intraday-retention");

    const summary = await runDenseIntradayRetention(prisma, {
      userId: "horizon-dense",
      log: () => {},
    });

    expect(summary.totals.hoursLeftAsStored).toBe(1);
    expect(
      await liveValue(
        "horizon-dense",
        "HEART_RATE_VARIABILITY",
        `stats:${HRV_HK}:${OLD_DAY}T10`,
      ),
    ).toBe(60);
    expect(
      await liveValue(
        "horizon-dense",
        "HEART_RATE_VARIABILITY",
        `stats:${HRV_HK}:${OLD_DAY}T14`,
      ),
    ).toBe(50);
    expect(
      await liveSampleIds("horizon-dense", "HEART_RATE_VARIABILITY"),
    ).toEqual(["horizon-dense-hour-live"]);
  });
});

describe("repair and consolidation together", () => {
  it("end on the mean over every sample, and a later repair corrects nothing", async () => {
    const prisma = getPrismaClient();
    await account("together");
    await seedRecentDay("together");
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");
    const { consolidateDailyMean } =
      await import("@/lib/measurements/consolidate-daily-mean");

    await Promise.all([
      repairFoldedMeans(prisma, "together"),
      consolidateDailyMean(prisma, {
        userId: "together",
        cutoffHours: 36,
        log: () => {},
      }),
    ]);
    expect(
      await liveValue(
        "together",
        "WALKING_SPEED",
        `stats:${WS_HK}:${RECENT_DAY}`,
      ),
    ).toBeCloseTo(1.6, 9);
    expect(await liveSampleIds("together", "WALKING_SPEED")).toEqual([]);

    const again = await repairFoldedMeans(prisma, "together");
    expect(again.byType.WALKING_SPEED?.windowsCorrected).toBe(0);
    expect(
      await liveValue(
        "together",
        "WALKING_SPEED",
        `stats:${WS_HK}:${RECENT_DAY}`,
      ),
    ).toBeCloseTo(1.6, 9);
  });

  it("a consolidation that ran first leaves the repair nothing to correct", async () => {
    const prisma = getPrismaClient();
    await account("fold-first");
    await seedRecentDay("fold-first");
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");
    const { consolidateDailyMean } =
      await import("@/lib/measurements/consolidate-daily-mean");

    await consolidateDailyMean(prisma, {
      userId: "fold-first",
      cutoffHours: 36,
      log: () => {},
    });
    expect(
      await liveValue(
        "fold-first",
        "WALKING_SPEED",
        `stats:${WS_HK}:${RECENT_DAY}`,
      ),
    ).toBeCloseTo(1.6, 9);

    const repair = await repairFoldedMeans(prisma, "fold-first");
    expect(repair.byType.WALKING_SPEED?.windowsCorrected).toBe(0);
    expect(
      await liveValue(
        "fold-first",
        "WALKING_SPEED",
        `stats:${WS_HK}:${RECENT_DAY}`,
      ),
    ).toBeCloseTo(1.6, 9);
  });
});
