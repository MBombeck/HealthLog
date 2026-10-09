/**
 * v1.42 — the folds take complete local days only, a re-fold recomputes from
 * every sample of the window, and the one-time repair puts right the means an
 * older release folded from part of their day. Against Postgres.
 *
 *   - Mean consolidation and the dense hourly fold, run on two nights over a
 *     day the old `now - threshold` cut split, store the mean of the whole
 *     day / hour, for Apple Health and Health Connect alike.
 *   - A re-fold of a window that already has a `stats:` row takes the mean
 *     over the live rows AND the fold's own tombstones.
 *   - The `folded_window` guard refuses a sample only when its local day lies
 *     before the aligned boundary and a live `stats:` row covers it, the
 *     latter also after a timezone change.
 *   - A person's deletion inside a half-folded day is class B.
 *   - The repair corrects a partial mean from the tombstones, leaves a correct
 *     one untouched, resumes, and is idempotent; the purge waits for it.
 *   - The restore keys the live `stats:` ids by source.
 */
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";

vi.mock("next/headers", async () => {
  const { cookieJar, headerJar } = await import("./mock-next-headers");
  return {
    headers: vi.fn(async () => ({
      get: (name: string) => headerJar.get(name.toLowerCase()) ?? null,
    })),
    cookies: vi.fn(async () => ({
      get: (name: string) => {
        const value = cookieJar.get(name);
        return value ? { name, value } : undefined;
      },
      set: (name: string, value: string) => {
        cookieJar.set(name, value);
      },
      delete: (name: string) => {
        cookieJar.delete(name);
      },
    })),
  };
});
vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const WS_HK = "HKQuantityTypeIdentifierWalkingSpeed";
const HRV_HK = "HKQuantityTypeIdentifierHeartRateVariabilitySDNN";
const HR_HK = "HKQuantityTypeIdentifierHeartRate";

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

async function account(id: string, timezone = "UTC", signIn = false) {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      role: "ADMIN",
      timezone,
    },
  });
  if (signIn) {
    const session = await prisma.session.create({
      data: { userId: id, expiresAt: new Date(Date.now() + 3_600_000) },
    });
    cookieJar.set("healthlog_session", session.id);
  }
}

function at(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}

async function live(userId: string, type: string, externalId: string) {
  return getPrismaClient().measurement.findFirst({
    where: { userId, type: type as never, externalId, deletedAt: null },
    select: { id: true, value: true, updatedAt: true },
  });
}

describe("folds take complete local days", () => {
  it("mean consolidation over two nights stores the whole day's mean", async () => {
    const prisma = getPrismaClient();
    await account("mean-two-nights");
    await prisma.measurement.createMany({
      data: (
        [
          ["08:00", 1],
          ["10:00", 1],
          ["20:00", 2],
          ["22:00", 2],
        ] as const
      ).map(([hm, value], i) => ({
        userId: "mean-two-nights",
        type: "WALKING_SPEED" as const,
        value,
        unit: "m/s",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(`2026-05-16T${hm}:00.000Z`),
        externalId: `uuid-ws-${i}`,
      })),
    });
    const { consolidateDailyMean } =
      await import("@/lib/measurements/consolidate-daily-mean");

    at("2026-05-18T03:00:00.000Z");
    await consolidateDailyMean(prisma, {
      userId: "mean-two-nights",
      cutoffHours: 36,
      log: () => {},
    });
    at("2026-05-19T03:00:00.000Z");
    await consolidateDailyMean(prisma, {
      userId: "mean-two-nights",
      cutoffHours: 36,
      log: () => {},
    });

    const row = await live(
      "mean-two-nights",
      "WALKING_SPEED",
      `stats:${WS_HK}:2026-05-16`,
    );
    expect(row?.value).toBeCloseTo(1.5, 9);
  });

  it("the dense fold over two nights stores the whole hour's mean (Apple Health and Health Connect)", async () => {
    const prisma = getPrismaClient();
    await account("dense-two-nights");
    for (const source of ["APPLE_HEALTH", "HEALTH_CONNECT"] as const) {
      await prisma.measurement.createMany({
        data: (
          [
            ["10:05", 40],
            ["10:10", 40],
            ["10:50", 80],
            ["10:55", 80],
          ] as const
        ).map(([hm, value], i) => ({
          userId: "dense-two-nights",
          type: "HEART_RATE_VARIABILITY" as const,
          value,
          unit: "ms",
          source,
          measuredAt: new Date(`2026-01-10T${hm}:00.000Z`),
          externalId: `${source}-hrv-${i}`,
        })),
      });
    }
    const { runDenseIntradayRetention } =
      await import("@/lib/measurements/dense-intraday-retention");

    at("2026-04-10T10:30:00.000Z");
    await runDenseIntradayRetention(prisma, {
      userId: "dense-two-nights",
      log: () => {},
    });
    at("2026-04-11T10:30:00.000Z");
    await runDenseIntradayRetention(prisma, {
      userId: "dense-two-nights",
      log: () => {},
    });

    const rows = await prisma.measurement.findMany({
      where: {
        userId: "dense-two-nights",
        type: "HEART_RATE_VARIABILITY",
        deletedAt: null,
      },
      select: { source: true, externalId: true, value: true },
      orderBy: { source: "asc" },
    });
    expect(rows).toEqual([
      {
        source: "APPLE_HEALTH",
        externalId: `stats:${HRV_HK}:2026-01-10T10`,
        value: 60,
      },
      {
        source: "HEALTH_CONNECT",
        externalId: `stats:${HRV_HK}:2026-01-10T10`,
        value: 60,
      },
    ]);
  });

  it("a re-fold of a day an older release folded in part takes the mean over live rows and its tombstones", async () => {
    const prisma = getPrismaClient();
    await account("refold");
    // What the old cut left behind: the morning folded into a daily row and
    // soft-deleted, the evening still raw.
    await prisma.measurement.create({
      data: {
        userId: "refold",
        type: "WALKING_SPEED",
        value: 1,
        unit: "m/s",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-16T12:00:00.000Z"),
        externalId: `stats:${WS_HK}:2026-05-16`,
      },
    });
    await prisma.measurement.createMany({
      data: [
        ["08:00", 1, true],
        ["10:00", 1, true],
        ["20:00", 2, false],
        ["22:00", 2, false],
      ].map(([hm, value, folded], i) => ({
        userId: "refold",
        type: "WALKING_SPEED" as const,
        value: value as number,
        unit: "m/s",
        source: "APPLE_HEALTH" as const,
        measuredAt: new Date(`2026-05-16T${hm}:00.000Z`),
        externalId: `uuid-refold-${i}`,
        deletedAt: folded ? new Date("2026-05-18T03:00:00.000Z") : null,
      })),
    });
    const { consolidateDailyMean } =
      await import("@/lib/measurements/consolidate-daily-mean");
    at("2026-05-19T03:00:00.000Z");
    await consolidateDailyMean(prisma, {
      userId: "refold",
      cutoffHours: 36,
      log: () => {},
    });
    const row = await live(
      "refold",
      "WALKING_SPEED",
      `stats:${WS_HK}:2026-05-16`,
    );
    expect(row?.value).toBeCloseTo(1.5, 9);
    expect(
      await prisma.measurement.count({
        where: { userId: "refold", deletedAt: null },
      }),
    ).toBe(1);
  });
});

describe("folded_window", () => {
  it("accepts a late sample of a day the fold has not finished, refuses one of a finished day", async () => {
    const prisma = getPrismaClient();
    await account("guard");
    for (const day of ["2026-05-15", "2026-05-16"]) {
      await prisma.measurement.create({
        data: {
          userId: "guard",
          type: "WALKING_SPEED",
          value: 1,
          unit: "m/s",
          source: "APPLE_HEALTH",
          measuredAt: new Date(`${day}T12:00:00.000Z`),
          externalId: `stats:${WS_HK}:${day}`,
        },
      });
    }
    const { findFoldedWindowDuplicates } =
      await import("@/lib/measurements/folded-window");
    const found = await findFoldedWindowDuplicates(
      prisma,
      "guard",
      [
        // 37 hours old: its day is not over before the boundary.
        {
          type: "WALKING_SPEED",
          source: "APPLE_HEALTH",
          externalId: "uuid-late",
          measuredAt: new Date("2026-05-16T21:00:00.000Z"),
        },
        {
          type: "WALKING_SPEED",
          source: "APPLE_HEALTH",
          externalId: "uuid-old",
          measuredAt: new Date("2026-05-15T21:00:00.000Z"),
        },
      ],
      { now: new Date("2026-05-18T10:00:00.000Z") },
    );
    expect([...found]).toEqual([1]);
  });

  it("refuses an old sample after a timezone change (day and hour grain)", async () => {
    const prisma = getPrismaClient();
    // Folded while the account was in Los Angeles / Kolkata; now in Tokyo /
    // UTC.
    await account("tz-day", "Asia/Tokyo");
    await prisma.measurement.create({
      data: {
        userId: "tz-day",
        type: "WALKING_SPEED",
        value: 1,
        unit: "m/s",
        source: "APPLE_HEALTH",
        // LA local noon of 2026-03-10.
        measuredAt: new Date("2026-03-10T19:00:00.000Z"),
        externalId: `stats:${WS_HK}:2026-03-10`,
      },
    });
    await account("tz-hour", "UTC");
    await prisma.measurement.create({
      data: {
        userId: "tz-hour",
        type: "PULSE",
        value: 60,
        unit: "bpm",
        source: "APPLE_HEALTH",
        // Kolkata 10:30 local of 2026-01-10 (UTC+5:30).
        measuredAt: new Date("2026-01-10T05:00:00.000Z"),
        externalId: `stats:${HR_HK}:2026-01-10T10`,
      },
    });
    const { findFoldedWindowDuplicates } =
      await import("@/lib/measurements/folded-window");
    const day = await findFoldedWindowDuplicates(
      prisma,
      "tz-day",
      [
        {
          type: "WALKING_SPEED",
          source: "APPLE_HEALTH",
          externalId: "uuid-la-evening",
          // 23:00 in LA on 2026-03-10, 2026-03-11 in Tokyo.
          measuredAt: new Date("2026-03-11T06:00:00.000Z"),
        },
      ],
      { now: new Date("2026-03-20T00:00:00.000Z") },
    );
    expect([...day]).toEqual([0]);
    const hour = await findFoldedWindowDuplicates(
      prisma,
      "tz-hour",
      [
        {
          type: "PULSE",
          source: "APPLE_HEALTH",
          externalId: "uuid-kolkata",
          // 10:50 in Kolkata, 05:20 UTC: hour 05 in the new zone.
          measuredAt: new Date("2026-01-10T05:20:00.000Z"),
        },
      ],
      { now: new Date("2026-06-01T00:00:00.000Z") },
    );
    expect([...hour]).toEqual([0]);
  });

  it("classes a person's deletion inside a half-folded day as B", async () => {
    const prisma = getPrismaClient();
    await account("half-folded");
    await prisma.measurement.create({
      data: {
        userId: "half-folded",
        type: "WALKING_SPEED",
        value: 1,
        unit: "m/s",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-05-16T12:00:00.000Z"),
        externalId: `stats:${WS_HK}:2026-05-16`,
      },
    });
    const { findCompactionTombstones } =
      await import("@/lib/measurements/folded-window");
    const found = await findCompactionTombstones(prisma, "half-folded", "UTC", [
      {
        type: "WALKING_SPEED",
        source: "APPLE_HEALTH",
        externalId: "uuid-deleted-by-person",
        measuredAt: new Date("2026-05-16T20:00:00.000Z"),
        // 38 hours later: past the grace, but the day was not over yet.
        deletedAt: new Date("2026-05-18T10:00:00.000Z"),
      },
      {
        type: "WALKING_SPEED",
        source: "APPLE_HEALTH",
        externalId: "uuid-folded",
        measuredAt: new Date("2026-05-16T08:00:00.000Z"),
        deletedAt: new Date("2026-05-19T03:00:00.000Z"),
      },
    ]);
    expect([...found]).toEqual([1]);
  });
});

/** The instant the repair tests read the horizon against. */
const REPAIR_NOW = "2026-10-08T12:00:00.000Z";

/** The prod shape: a mean an old two-run fold left, and its tombstones. */
async function seedPartialFolds(userId: string) {
  const prisma = getPrismaClient();
  const run1 = new Date("2026-09-20T03:00:00.000Z");
  const run2 = new Date("2026-09-21T03:00:00.000Z");
  await prisma.measurement.createMany({
    data: [
      // Wrong: the mean of the evening alone.
      {
        id: `${userId}-ws-wrong`,
        userId,
        type: "WALKING_SPEED",
        value: 2,
        unit: "m/s",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-09-18T12:00:00.000Z"),
        externalId: `stats:${WS_HK}:2026-09-18`,
      },
      // Right already: one run took the whole day.
      {
        id: `${userId}-ws-right`,
        userId,
        type: "WALKING_SPEED",
        value: 3,
        unit: "m/s",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-09-17T12:00:00.000Z"),
        externalId: `stats:${WS_HK}:2026-09-17`,
      },
      // Wrong: the boundary hour holds the later half only.
      {
        id: `${userId}-hrv-wrong`,
        userId,
        type: "HEART_RATE_VARIABILITY",
        value: 80,
        unit: "ms",
        source: "APPLE_HEALTH",
        measuredAt: new Date("2026-06-20T10:30:00.000Z"),
        externalId: `stats:${HRV_HK}:2026-06-20T10`,
      },
    ],
  });
  const tomb = (
    id: string,
    type: "WALKING_SPEED" | "HEART_RATE_VARIABILITY",
    value: number,
    iso: string,
    deletedAt: Date,
    syncVersion = 1,
  ) => ({
    id: `${userId}-${id}`,
    userId,
    type,
    value,
    unit: type === "WALKING_SPEED" ? "m/s" : "ms",
    source: "APPLE_HEALTH" as const,
    measuredAt: new Date(iso),
    externalId: `uuid-${userId}-${id}`,
    deletedAt,
    syncVersion,
  });
  await prisma.measurement.createMany({
    data: [
      tomb("ws1", "WALKING_SPEED", 1, "2026-09-18T08:00:00.000Z", run1),
      tomb("ws2", "WALKING_SPEED", 1, "2026-09-18T10:00:00.000Z", run1),
      tomb("ws3", "WALKING_SPEED", 2, "2026-09-18T20:00:00.000Z", run2),
      tomb("ws4", "WALKING_SPEED", 2, "2026-09-18T22:00:00.000Z", run2),
      // A person deleted this one the morning after: not part of the mean.
      // Younger than the fold threshold when deleted, so never a fold's.
      tomb(
        "ws5",
        "WALKING_SPEED",
        9,
        "2026-09-18T23:00:00.000Z",
        new Date("2026-09-19T08:00:00.000Z"),
        2,
      ),
      tomb("ok1", "WALKING_SPEED", 3, "2026-09-17T08:00:00.000Z", run1),
      tomb("ok2", "WALKING_SPEED", 3, "2026-09-17T20:00:00.000Z", run1),
      tomb(
        "hrv1",
        "HEART_RATE_VARIABILITY",
        40,
        "2026-06-20T10:05:00.000Z",
        new Date("2026-09-18T10:30:00.000Z"),
      ),
      tomb(
        "hrv2",
        "HEART_RATE_VARIABILITY",
        40,
        "2026-06-20T10:10:00.000Z",
        new Date("2026-09-18T10:30:00.000Z"),
      ),
      tomb(
        "hrv3",
        "HEART_RATE_VARIABILITY",
        80,
        "2026-06-20T10:50:00.000Z",
        new Date("2026-09-19T10:30:00.000Z"),
      ),
      tomb(
        "hrv4",
        "HEART_RATE_VARIABILITY",
        80,
        "2026-06-20T10:55:00.000Z",
        new Date("2026-09-19T10:30:00.000Z"),
      ),
    ],
  });
}

describe("fold repair", () => {
  it("corrects a partial mean from the tombstones, leaves a correct one alone, and is idempotent", async () => {
    // Inside the horizon of every seeded window.
    at(REPAIR_NOW);
    const prisma = getPrismaClient();
    await account("repair");
    await seedPartialFolds("repair");
    const rightBefore = await live(
      "repair",
      "WALKING_SPEED",
      `stats:${WS_HK}:2026-09-17`,
    );
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");

    const first = await repairFoldedMeans(prisma, "repair");
    expect(first.status).toBe("completed");
    // The right day was folded in one run and is not even recomputed.
    expect(first.byType.WALKING_SPEED).toEqual({
      windowsChecked: 1,
      windowsCorrected: 1,
      restingCorrected: 0,
      windowsSkippedBeyondHorizon: 0,
      windowsLeftAmbiguous: 0,
      samplesAbsorbed: 0,
    });
    expect(first.byType.HEART_RATE_VARIABILITY).toEqual({
      windowsChecked: 1,
      windowsCorrected: 1,
      restingCorrected: 0,
      windowsSkippedBeyondHorizon: 0,
      windowsLeftAmbiguous: 0,
      samplesAbsorbed: 0,
    });
    expect(
      (await live("repair", "WALKING_SPEED", `stats:${WS_HK}:2026-09-18`))
        ?.value,
    ).toBeCloseTo(1.5, 9);
    expect(
      (
        await live(
          "repair",
          "HEART_RATE_VARIABILITY",
          `stats:${HRV_HK}:2026-06-20T10`,
        )
      )?.value,
    ).toBe(60);
    const rightAfter = await live(
      "repair",
      "WALKING_SPEED",
      `stats:${WS_HK}:2026-09-17`,
    );
    expect(rightAfter).toEqual(rightBefore);

    const again = await repairFoldedMeans(prisma, "repair");
    expect(
      Object.values(again.byType).reduce(
        (sum, c) => sum + c.windowsCorrected,
        0,
      ),
    ).toBe(0);
  });

  it("stops between days and resumes where it stopped", async () => {
    // Inside the horizon of every seeded window.
    at(REPAIR_NOW);
    const prisma = getPrismaClient();
    await account("repair-resume");
    await seedPartialFolds("repair-resume");
    const { repairFoldedMeans } =
      await import("@/lib/jobs/measurement-fold-repair");
    let calls = 0;
    const stopped = await repairFoldedMeans(prisma, "repair-resume", {
      shouldStop: () => ++calls > 1,
    });
    expect(stopped.status).toBe("stopped");
    expect(stopped.resume).toBeDefined();
    const rest = await repairFoldedMeans(prisma, "repair-resume", {
      resume: stopped.resume,
    });
    expect(rest.status).toBe("completed");
    expect(
      (
        await live(
          "repair-resume",
          "WALKING_SPEED",
          `stats:${WS_HK}:2026-09-18`,
        )
      )?.value,
    ).toBeCloseTo(1.5, 9);
    expect(
      (
        await live(
          "repair-resume",
          "HEART_RATE_VARIABILITY",
          `stats:${HRV_HK}:2026-06-20T10`,
        )
      )?.value,
    ).toBe(60);
  });

  it("the handler marks the account and the purge refuses before it", async () => {
    // Inside the horizon of every seeded window.
    at(REPAIR_NOW);
    const prisma = getPrismaClient();
    await account("gate");
    await seedPartialFolds("gate");
    const {
      purgeCompactionTombstones,
      enqueueBootTimeCompactionTombstonePurge,
    } = await import("@/lib/jobs/compaction-tombstone-purge");

    const before = await purgeCompactionTombstones(prisma, { pauseMs: 0 });
    expect(before.deleted).toBe(0);
    expect(before.awaitingRepairAccounts).toBe(1);
    expect(
      await prisma.measurement.count({
        where: { userId: "gate", deletedAt: { not: null } },
      }),
    ).toBe(11);

    const send = vi.fn().mockResolvedValue("job-id");
    const { setGlobalBoss } = await import("@/lib/jobs/boss-instance");
    setGlobalBoss({ send } as never);
    expect(await enqueueBootTimeCompactionTombstonePurge(prisma)).toEqual({
      enqueued: false,
    });

    const { handleMeasurementFoldRepair } =
      await import("@/lib/jobs/measurement-fold-repair");
    await handleMeasurementFoldRepair(
      [
        {
          id: "run-1",
          data: { userId: "gate" },
          expireInSeconds: 900,
        } as never,
      ],
      prisma,
    );
    expect(
      await prisma.measurementFoldRepair.findUnique({
        where: { userId: "gate" },
      }),
    ).not.toBeNull();
    // Finishing the account queued a purge run.
    expect(send).toHaveBeenCalledWith(
      "compaction-tombstone-purge",
      expect.anything(),
      expect.anything(),
    );
    expect(await enqueueBootTimeCompactionTombstonePurge(prisma)).toEqual({
      enqueued: true,
    });
    setGlobalBoss(null);

    const after = await purgeCompactionTombstones(prisma, { pauseMs: 0 });
    expect(after.awaitingRepairAccounts).toBe(0);
    expect(after.deleted).toBeGreaterThan(0);
  });
});

describe("restore", () => {
  it("keys the live stats ids by source: a Health Connect deletion under an Apple Health hour comes back", async () => {
    const prisma = getPrismaClient();
    await account("restore-src", "UTC", true);
    const hourId = `stats:${HR_HK}:2026-01-10T10`;
    await prisma.measurement.createMany({
      data: [
        {
          id: "restore-src-ah-hourly",
          userId: "restore-src",
          type: "PULSE",
          value: 60,
          unit: "bpm",
          source: "APPLE_HEALTH",
          measuredAt: new Date("2026-01-10T10:30:00.000Z"),
          externalId: hourId,
        },
        {
          id: "restore-src-hc-deleted",
          userId: "restore-src",
          type: "PULSE",
          value: 70,
          unit: "bpm",
          source: "HEALTH_CONNECT",
          measuredAt: new Date("2026-01-10T10:20:00.000Z"),
          externalId: "hc:deleted",
          deletedAt: new Date(Date.now() - 2 * 86_400_000),
          syncVersion: 2,
        },
      ],
    });
    // The repair finished before the file was exported, so the restore drops
    // compaction tombstones; this one is not one.
    await prisma.measurementFoldRepair.create({
      data: {
        userId: "restore-src",
        completedAt: new Date(Date.now() - 86_400_000),
      },
    });
    const { storeBackupBlob } = await import("@/lib/export/store-backup-blob");
    const { streamFullBackupJson } =
      await import("@/lib/export/full-backup-stream");
    const { id: backupId } = await storeBackupBlob(
      prisma,
      { userId: "restore-src", type: "WEEKLY_AUTO" },
      (write) =>
        streamFullBackupJson(prisma, "restore-src", write, {
          purpose: "disaster-recovery",
        }),
    );
    const { POST } = await import("./restore-job-driver");
    const res = await POST(
      new Request(`http://localhost/api/admin/backups/${backupId}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ confirm: "RESTORE" }),
      }) as never,
      { params: Promise.resolve({ id: backupId }) },
    );
    expect(res.status).toBe(200);
    const ids = (
      await prisma.measurement.findMany({
        where: { userId: "restore-src" },
        select: { id: true },
      })
    ).map((row) => row.id);
    expect(ids).toContain("restore-src-hc-deleted");
  }, 120_000);
});
