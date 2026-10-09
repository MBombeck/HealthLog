/**
 * v1.42 — which tombstones a stored mean may be recomputed from, and when a
 * pass may recompute at all. Against Postgres.
 *
 *   - A window one fold run took whole is never recomputed, even when one of
 *     its samples had been raised in place before the fold took it.
 *   - In a window folded in two runs, a raised sample a run took counts as a
 *     leftover through the run's shared deletion instant, and a tombstone of
 *     fold age that may be a person's deletion leaves the window as stored.
 *   - Once the repair has been through an account, the folds' re-fold of a
 *     stored day or hour leaves it as stored, and the compaction purge waits
 *     for the fold lock before it deletes.
 *   - The repair, the daily-mean consolidation and the dense fold wait for
 *     the fold lock longer than Prisma's default transaction timeout.
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
/** Inside the daily horizon. */
const DAY = "2026-09-18";
/** The nights an older release folded `DAY` on, in two runs. */
const RUN1 = "2026-09-20T03:00:00.000Z";
const RUN2 = "2026-09-21T03:00:00.000Z";
/** Inside the hourly horizon, before the dense raw window. */
const HOUR_DAY = "2026-06-20";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});

afterEach(() => {
  vi.useRealTimers();
});

async function account(id: string, repaired = false) {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: { id, username: id, email: `${id}@example.test`, timezone: "UTC" },
  });
  if (repaired) {
    await prisma.measurementFoldRepair.create({
      data: { userId: id, completedAt: new Date("2026-10-01T00:00:00.000Z") },
    });
  }
}

async function liveValue(userId: string, externalId: string) {
  const row = await getPrismaClient().measurement.findFirst({
    where: { userId, externalId, deletedAt: null },
    select: { value: true },
  });
  return row?.value;
}

async function liveSampleCount(userId: string) {
  return getPrismaClient().measurement.count({
    where: {
      userId,
      deletedAt: null,
      NOT: { externalId: { startsWith: "stats:" } },
    },
  });
}

type Row = {
  id: string;
  value: number;
  at: string;
  deletedAt?: string;
  syncVersion?: number;
};

/** A stored daily walking-speed mean for `DAY` and its samples. */
async function seedDay(userId: string, stored: number, samples: Row[]) {
  await getPrismaClient().measurement.createMany({
    data: [
      {
        id: `${userId}-mean`,
        userId,
        type: "WALKING_SPEED",
        value: stored,
        unit: "m/s",
        source: "APPLE_HEALTH",
        measuredAt: new Date(`${DAY}T12:00:00.000Z`),
        externalId: `stats:${WS_HK}:${DAY}`,
      },
      ...samples.map((row) => ({
        id: `${userId}-${row.id}`,
        userId,
        type: "WALKING_SPEED" as const,
        value: row.value,
        unit: "m/s",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(`${DAY}T${row.at}:00.000Z`),
        externalId: `uuid-${userId}-${row.id}`,
        deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
        syncVersion: row.syncVersion ?? 1,
      })),
    ],
  });
}

/** A stored HRV mean for hour 10 of `HOUR_DAY` and its samples. */
async function seedHour(userId: string, stored: number, samples: Row[]) {
  await getPrismaClient().measurement.createMany({
    data: [
      {
        id: `${userId}-hour`,
        userId,
        type: "HEART_RATE_VARIABILITY",
        value: stored,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: new Date(`${HOUR_DAY}T10:30:00.000Z`),
        externalId: `stats:${HRV_HK}:${HOUR_DAY}T10`,
      },
      ...samples.map((row) => ({
        id: `${userId}-${row.id}`,
        userId,
        type: "HEART_RATE_VARIABILITY" as const,
        value: row.value,
        unit: "ms",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(`${HOUR_DAY}T${row.at}:00.000Z`),
        externalId: `uuid-${userId}-${row.id}`,
        deletedAt: row.deletedAt ? new Date(row.deletedAt) : null,
        syncVersion: row.syncVersion ?? 1,
      })),
    ],
  });
}

/** The day an old release split: stored is the evening's mean, 2. */
const SPLIT_DAY: Row[] = [
  { id: "t1", value: 1, at: "08:00", deletedAt: RUN1 },
  { id: "t2", value: 1, at: "10:00", deletedAt: RUN1 },
  { id: "t3", value: 2, at: "20:00", deletedAt: RUN2 },
  { id: "t4", value: 2, at: "22:00", deletedAt: RUN2 },
];

/**
 * Hold the fold lock of `userIds` in a transaction of its own until the
 * returned release is called.
 */
async function holdFoldLocks(userIds: string[]) {
  const { holdAccountFoldLock } = await import("@/lib/export/restore-lock");
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const holder = getPrismaClient().$transaction(
    async (tx) => {
      for (const userId of userIds) await holdAccountFoldLock(tx, userId);
      acquired();
      await released;
    },
    { timeout: 60_000 },
  );
  await held;
  return async () => {
    release();
    await holder;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("fold leftovers: which tombstones count", () => {
  it("leaves a day one run took whole alone, though a raised sample is among its tombstones", async () => {
    const prisma = getPrismaClient();
    await account("one-run");
    // One run took all four; the 3 had been raised in place before. Stored is
    // their mean, right: (1 + 1 + 2 + 3) / 4.
    await seedDay("one-run", 1.75, [
      { id: "a", value: 1, at: "08:00", deletedAt: RUN1 },
      { id: "b", value: 1, at: "10:00", deletedAt: RUN1 },
      { id: "c", value: 2, at: "20:00", deletedAt: RUN1 },
      { id: "d", value: 3, at: "22:00", deletedAt: RUN1, syncVersion: 2 },
    ]);
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");

    const result = await repairFoldedMeans(prisma, "one-run");
    expect(result.byType.WALKING_SPEED?.windowsChecked ?? 0).toBe(0);
    expect(result.byType.WALKING_SPEED?.windowsCorrected ?? 0).toBe(0);
    expect(await liveValue("one-run", `stats:${WS_HK}:${DAY}`)).toBe(1.75);
  });

  it("counts a raised sample a run took through the run's deletion instant", async () => {
    const prisma = getPrismaClient();
    await account("raised");
    // Run 2 took a raised 5 with the evening: the whole day is
    // (1 + 1 + 2 + 2 + 5) / 5 = 2.2. Stored is run 2's mean, 3.
    await seedDay("raised", 3, [
      ...SPLIT_DAY,
      { id: "t5", value: 5, at: "23:00", deletedAt: RUN2, syncVersion: 3 },
    ]);
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");

    const result = await repairFoldedMeans(prisma, "raised");
    expect(result.byType.WALKING_SPEED).toMatchObject({
      windowsChecked: 1,
      windowsCorrected: 1,
      windowsLeftAmbiguous: 0,
    });
    expect(await liveValue("raised", `stats:${WS_HK}:${DAY}`)).toBeCloseTo(
      2.2,
      9,
    );
  });

  it("leaves a split day as stored when a tombstone of fold age may be a person's deletion", async () => {
    const prisma = getPrismaClient();
    await account("ambiguous");
    // A raised sample deleted between the runs, at an instant no fold run
    // used: a person's deletion, or a raised sample a run took alone. Which
    // one decides the mean, so the day stays as it is.
    await seedDay("ambiguous", 2, [
      ...SPLIT_DAY,
      {
        id: "p",
        value: 9,
        at: "23:00",
        deletedAt: "2026-09-20T18:00:00.000Z",
        syncVersion: 2,
      },
    ]);
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");

    const result = await repairFoldedMeans(prisma, "ambiguous");
    expect(result.byType.WALKING_SPEED).toMatchObject({
      windowsChecked: 0,
      windowsCorrected: 0,
      windowsLeftAmbiguous: 1,
    });
    expect(await liveValue("ambiguous", `stats:${WS_HK}:${DAY}`)).toBe(2);
  });

  it("leaves an hour one run took whole alone, though a raised sample is among its tombstones", async () => {
    const prisma = getPrismaClient();
    await account("one-run-hour");
    const run = "2026-09-19T10:30:00.000Z";
    await seedHour("one-run-hour", 55, [
      { id: "a", value: 40, at: "10:05", deletedAt: run },
      { id: "b", value: 40, at: "10:10", deletedAt: run },
      { id: "c", value: 80, at: "10:50", deletedAt: run },
      { id: "d", value: 60, at: "10:55", deletedAt: run, syncVersion: 2 },
    ]);
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");

    await repairFoldedMeans(prisma, "one-run-hour");
    expect(
      await liveValue("one-run-hour", `stats:${HRV_HK}:${HOUR_DAY}T10`),
    ).toBe(55);
  });
});

describe("after the repair", () => {
  it("the daily-mean consolidation leaves a stored day and its late sample as they are", async () => {
    const prisma = getPrismaClient();
    await account("refold-day", true);
    await seedDay("refold-day", 2, [
      ...SPLIT_DAY,
      { id: "late", value: 2, at: "23:30" },
    ]);
    const { consolidateDailyMean } =
      await import("@/lib/measurements/consolidate-daily-mean");

    const summary = await consolidateDailyMean(prisma, {
      userId: "refold-day",
      cutoffHours: 36,
      log: () => {},
    });
    expect(summary.totals.daysLeftAsStored).toBe(1);
    expect(await liveValue("refold-day", `stats:${WS_HK}:${DAY}`)).toBe(2);
    expect(await liveSampleCount("refold-day")).toBe(1);
  });

  it("the dense fold leaves a stored hour and its late sample as they are", async () => {
    const prisma = getPrismaClient();
    await account("refold-hour", true);
    await seedHour("refold-hour", 80, [
      { id: "a", value: 40, at: "10:05", deletedAt: "2026-09-18T10:30:00Z" },
      { id: "b", value: 40, at: "10:10", deletedAt: "2026-09-18T10:30:00Z" },
      { id: "c", value: 80, at: "10:50", deletedAt: "2026-09-19T10:30:00Z" },
      { id: "d", value: 80, at: "10:55", deletedAt: "2026-09-19T10:30:00Z" },
      { id: "late", value: 100, at: "10:58" },
    ]);
    const { runDenseIntradayRetention } =
      await import("@/lib/measurements/dense-intraday-retention");

    const summary = await runDenseIntradayRetention(prisma, {
      userId: "refold-hour",
      log: () => {},
    });
    expect(summary.totals.hoursLeftAsStored).toBe(1);
    expect(
      await liveValue("refold-hour", `stats:${HRV_HK}:${HOUR_DAY}T10`),
    ).toBe(80);
    expect(await liveSampleCount("refold-hour")).toBe(1);
  });

  it("the compaction purge waits for the fold lock before it deletes", async () => {
    const prisma = getPrismaClient();
    await account("purge-lock", true);
    // A class-A tombstone: its day was complete when the fold deleted it, and
    // the day's mean is live.
    await prisma.measurement.createMany({
      data: [
        {
          userId: "purge-lock",
          type: "WALKING_SPEED",
          value: 1,
          unit: "m/s",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-09-10T12:00:00.000Z"),
          externalId: `stats:${WS_HK}:2026-09-10`,
        },
        {
          id: "purge-lock-a",
          userId: "purge-lock",
          type: "WALKING_SPEED",
          value: 1,
          unit: "m/s",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-09-10T08:00:00.000Z"),
          externalId: "uuid-purge-lock-a",
          deletedAt: new Date("2026-09-13T03:00:00.000Z"),
        },
      ],
    });
    const { purgeCompactionTombstones } =
      await import("@/lib/jobs/compaction-tombstone-purge");

    const release = await holdFoldLocks(["purge-lock"]);
    const purge = purgeCompactionTombstones(prisma, { pauseMs: 0 });
    await sleep(1_000);
    const whileHeld = await prisma.measurement.count({
      where: { id: "purge-lock-a" },
    });
    await release();
    const outcome = await purge;
    expect(whileHeld).toBe(1);
    expect(outcome.deleted).toBe(1);
    expect(
      await prisma.measurement.count({ where: { id: "purge-lock-a" } }),
    ).toBe(0);
  });
});

describe("the fold lock wait", () => {
  it("outlasts Prisma's default transaction timeout in the repair and both folds", async () => {
    const prisma = getPrismaClient();
    await account("wait-repair");
    await seedDay("wait-repair", 2, SPLIT_DAY);
    await account("wait-mean");
    await prisma.measurement.createMany({
      data: [1, 2].map((value, i) => ({
        userId: "wait-mean",
        type: "WALKING_SPEED" as const,
        value,
        unit: "m/s",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(`2026-10-01T0${i + 8}:00:00.000Z`),
        externalId: `uuid-wait-mean-${i}`,
      })),
    });
    await account("wait-dense");
    await prisma.measurement.createMany({
      data: [40, 80].map((value, i) => ({
        userId: "wait-dense",
        type: "HEART_RATE_VARIABILITY" as const,
        value,
        unit: "ms",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(`${HOUR_DAY}T10:${i + 10}:00.000Z`),
        externalId: `uuid-wait-dense-${i}`,
      })),
    });
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");
    const { consolidateDailyMean } =
      await import("@/lib/measurements/consolidate-daily-mean");
    const { runDenseIntradayRetention } =
      await import("@/lib/measurements/dense-intraday-retention");

    const release = await holdFoldLocks([
      "wait-repair",
      "wait-mean",
      "wait-dense",
    ]);
    const work = Promise.allSettled([
      repairFoldedMeans(prisma, "wait-repair"),
      consolidateDailyMean(prisma, {
        userId: "wait-mean",
        cutoffHours: 36,
        log: () => {},
      }),
      runDenseIntradayRetention(prisma, {
        userId: "wait-dense",
        log: () => {},
      }),
    ]);
    // Past the five seconds an interactive transaction gets by default.
    await sleep(6_500);
    await release();
    const [repair, mean, dense] = await work;

    expect(repair.status).toBe("fulfilled");
    expect(mean.status).toBe("fulfilled");
    expect(dense.status).toBe("fulfilled");
    expect(await liveValue("wait-repair", `stats:${WS_HK}:${DAY}`)).toBe(1.5);
    expect(await liveValue("wait-mean", `stats:${WS_HK}:2026-10-01`)).toBe(1.5);
    expect(
      await liveValue("wait-dense", `stats:${HRV_HK}:${HOUR_DAY}T10`),
    ).toBe(60);
  });
});
