/**
 * v1.42 — compaction tombstones, end to end against Postgres.
 *
 * The folds used to soft-delete the raw Apple Health samples they folded into
 * an hourly or daily `stats:` row ("class A"). Since v1.42:
 *   - the folds delete those rows outright;
 *   - a re-upload of such a sample is a `duplicate` with reason
 *     `folded_window` while a live `stats:` row covers its hour or day;
 *   - the backlog purge removes the class-A tombstones already in the table,
 *     in batches, one account at a time under the restore lock, and leaves
 *     every other tombstone ("class B") to the 75-day retention;
 *   - `/api/sync/changes` no longer reports class-A tombstones;
 *   - a restore does not write class-A tombstones back.
 * Plus the exact-duplicate prefilter (no transaction for a re-sent batch, and
 * two identical batches racing insert every row once), the live-type
 * discovery helper, and the PR-detection watermark.
 */
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();
/** An hour 120 days back, on the hour, in UTC (the accounts' zone). */
const OLD_HOUR = new Date(Math.floor((NOW - 120 * DAY) / HOUR) * HOUR);
const OLD_DAY = OLD_HOUR.toISOString().slice(0, 10);
const OLD_HH = OLD_HOUR.toISOString().slice(11, 13);
const HOURLY_ID = `stats:HKQuantityTypeIdentifierHeartRate:${OLD_DAY}T${OLD_HH}`;
const at = (minutes: number) => new Date(OLD_HOUR.getTime() + minutes * 60_000);

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
});

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

async function account(id: string, signIn = false) {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: {
      id,
      username: id,
      email: `${id}@example.test`,
      role: "ADMIN",
      timezone: "UTC",
    },
  });
  if (signIn) {
    const session = await prisma.session.create({
      data: { userId: id, expiresAt: new Date(NOW + HOUR) },
    });
    cookieJar.set("healthlog_session", session.id);
  }
}

/**
 * One account's mix: the live hourly row, five class-A tombstones under it,
 * and class-B rows the purge must leave alone.
 */
async function seedMix(userId: string, repaired = true) {
  const prisma = getPrismaClient();
  // The purge waits for the fold repair; these accounts have been through it.
  if (repaired) {
    await prisma.measurementFoldRepair.create({
      data: { userId, completedAt: new Date(NOW - HOUR) },
    });
  }
  const compactedAt = new Date(NOW - DAY);
  await prisma.measurement.create({
    data: {
      id: `${userId}-hourly`,
      userId,
      type: "PULSE",
      value: 62,
      unit: "bpm",
      source: "APPLE_HEALTH",
      measuredAt: at(30),
      externalId: HOURLY_ID,
    },
  });
  await prisma.measurement.createMany({
    data: Array.from({ length: 5 }, (_, i) => ({
      id: `${userId}-classA-${i}`,
      userId,
      type: "PULSE" as const,
      value: 60 + i,
      unit: "bpm",
      source: "APPLE_HEALTH" as const,
      measuredAt: at(1 + i),
      externalId: `uuid-${userId}-a-${i}`,
      deletedAt: compactedAt,
    })),
  });
  // A mean-type day folded into its daily row: class A too.
  const meanAt = new Date(NOW - 5 * DAY);
  const meanDay = meanAt.toISOString().slice(0, 10);
  await prisma.measurement.create({
    data: {
      id: `${userId}-daily-rr`,
      userId,
      type: "RESPIRATORY_RATE",
      value: 14,
      unit: "count/min",
      source: "APPLE_HEALTH",
      measuredAt: new Date(`${meanDay}T12:00:00.000Z`),
      externalId: `stats:HKQuantityTypeIdentifierRespiratoryRate:${meanDay}`,
    },
  });
  await prisma.measurement.create({
    data: {
      id: `${userId}-classA-rr`,
      userId,
      type: "RESPIRATORY_RATE",
      value: 15,
      unit: "count/min",
      source: "APPLE_HEALTH",
      measuredAt: meanAt,
      externalId: `uuid-${userId}-rr`,
      // Late enough that the whole local day was past the grace: a fold
      // only takes complete days.
      deletedAt: new Date(meanAt.getTime() + 3 * DAY),
    },
  });
  await prisma.measurement.createMany({
    data: [
      // A person deleted this sample the day after it was taken, before any
      // fold could have reached it: class B although the hour is covered.
      {
        id: `${userId}-classB-user`,
        userId,
        type: "PULSE",
        value: 99,
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: at(40),
        externalId: `uuid-${userId}-b-user`,
        deletedAt: new Date(at(40).getTime() + DAY),
      },
      // A dense day still at the pre-hourly daily grain: the one-shot
      // hourly rebuild reads these tombstones, so they stay.
      {
        id: `${userId}-daily-legacy`,
        userId,
        type: "PULSE",
        value: 61,
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: new Date(OLD_HOUR.getTime() - 3 * DAY + 12 * HOUR),
        externalId: `stats:HKQuantityTypeIdentifierHeartRate:${new Date(
          OLD_HOUR.getTime() - 3 * DAY,
        )
          .toISOString()
          .slice(0, 10)}`,
      },
      {
        id: `${userId}-classB-legacy`,
        userId,
        type: "PULSE",
        value: 61,
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: new Date(OLD_HOUR.getTime() - 3 * DAY + 10 * HOUR),
        externalId: `uuid-${userId}-b-legacy`,
        deletedAt: compactedAt,
      },
      // A hand-entered reading someone deleted.
      {
        id: `${userId}-classB-manual`,
        userId,
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        source: "MANUAL",
        measuredAt: new Date(NOW - 2 * DAY),
        deletedAt: new Date(NOW - DAY),
      },
      // A live raw sample.
      {
        id: `${userId}-live`,
        userId,
        type: "PULSE",
        value: 70,
        unit: "bpm",
        source: "APPLE_HEALTH",
        measuredAt: new Date(NOW - 2 * DAY),
        externalId: `uuid-${userId}-live`,
      },
    ],
  });
}

const CLASS_A = (userId: string) => [
  ...Array.from({ length: 5 }, (_, i) => `${userId}-classA-${i}`),
  `${userId}-classA-rr`,
];
const KEPT = (userId: string) => [
  `${userId}-hourly`,
  `${userId}-daily-rr`,
  `${userId}-classB-user`,
  `${userId}-daily-legacy`,
  `${userId}-classB-legacy`,
  `${userId}-classB-manual`,
  `${userId}-live`,
];

async function ids(userId: string): Promise<string[]> {
  const rows = await getPrismaClient().measurement.findMany({
    where: { userId },
    select: { id: true },
    orderBy: { id: "asc" },
  });
  return rows.map((row) => row.id);
}

describe("compaction-tombstone purge", () => {
  it("deletes class A in batches and leaves every class-B row", async () => {
    const prisma = getPrismaClient();
    await account("purge-a");
    await seedMix("purge-a");
    const { purgeCompactionTombstones } =
      await import("@/lib/jobs/compaction-tombstone-purge");

    const outcome = await purgeCompactionTombstones(prisma, {
      batchSize: 2,
      scanPageSize: 3,
      pauseMs: 0,
    });

    expect(outcome.deleted).toBe(6);
    expect(outcome.drained).toBe(true);
    expect(outcome.deferredAccounts).toBe(0);
    expect(await ids("purge-a")).toEqual([...KEPT("purge-a")].sort());

    // Idempotent: a second run finds nothing.
    const again = await purgeCompactionTombstones(prisma, { pauseMs: 0 });
    expect(again.deleted).toBe(0);
    expect(again.drained).toBe(true);
  });

  it("stops at the batch cap and says so; the next run resumes", async () => {
    const prisma = getPrismaClient();
    await account("purge-cap");
    await seedMix("purge-cap");
    const { purgeCompactionTombstones } =
      await import("@/lib/jobs/compaction-tombstone-purge");

    const first = await purgeCompactionTombstones(prisma, {
      batchSize: 2,
      maxBatches: 1,
      pauseMs: 0,
    });
    expect(first.deleted).toBe(2);
    expect(first.drained).toBe(false);

    const rest = await purgeCompactionTombstones(prisma, { pauseMs: 0 });
    expect(rest.deleted).toBe(4);
    expect(rest.drained).toBe(true);
  });

  it("skips an account under restore without waiting and purges the others", async () => {
    const prisma = getPrismaClient();
    await account("purge-restoring");
    await account("purge-other");
    await seedMix("purge-restoring");
    await seedMix("purge-other");
    const { takeRestoreLock } = await import("@/lib/export/restore-lock");
    const { purgeCompactionTombstones } =
      await import("@/lib/jobs/compaction-tombstone-purge");

    let holding!: () => void;
    const isHolding = new Promise<void>((resolve) => (holding = resolve));
    const restore = prisma
      .$transaction(
        async (tx) => {
          await takeRestoreLock(tx, "purge-restoring");
          holding();
          await new Promise((resolve) => setTimeout(resolve, 3_000));
          throw new Error("rolled back");
        },
        { timeout: 30_000 },
      )
      .catch(() => undefined);
    await isHolding;

    const started = Date.now();
    const outcome = await purgeCompactionTombstones(prisma, { pauseMs: 0 });
    expect(Date.now() - started).toBeLessThan(1_500);
    await restore;

    expect(outcome.deleted).toBe(6);
    expect(outcome.deferredAccounts).toBe(1);
    expect(outcome.deferredUserIds).toEqual(["purge-restoring"]);
    expect(await ids("purge-other")).toEqual([...KEPT("purge-other")].sort());
    for (const id of CLASS_A("purge-restoring")) {
      expect(await ids("purge-restoring")).toContain(id);
    }

    const next = await purgeCompactionTombstones(prisma, { pauseMs: 0 });
    expect(next.deleted).toBe(6);
    expect(await ids("purge-restoring")).toEqual(
      [...KEPT("purge-restoring")].sort(),
    );
  }, 60_000);
});

describe("compaction-tombstone purge before the fold repair", () => {
  it("leaves an account the repair has not finished alone", async () => {
    const prisma = getPrismaClient();
    await account("purge-unrepaired");
    await seedMix("purge-unrepaired", false);
    const { purgeCompactionTombstones } =
      await import("@/lib/jobs/compaction-tombstone-purge");
    const outcome = await purgeCompactionTombstones(prisma, { pauseMs: 0 });
    expect(outcome.deleted).toBe(0);
    expect(outcome.awaitingRepairAccounts).toBe(1);
    for (const id of CLASS_A("purge-unrepaired")) {
      expect(await ids("purge-unrepaired")).toContain(id);
    }
  });
});

describe("/api/sync/changes", () => {
  it("leaves compaction tombstones out and still reports a person's deletion", async () => {
    await account("feed", true);
    await seedMix("feed");
    const { GET } = await import("@/app/api/sync/changes/route");
    const tombstones: string[] = [];
    const upserts: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const query = cursor
        ? `?limit=3&cursor=${encodeURIComponent(cursor)}`
        : "?limit=3";
      const res = await GET(
        new NextRequest(`http://localhost/api/sync/changes${query}`),
      );
      expect(res.status).toBe(200);
      const page = (
        (await res.json()) as {
          data: {
            cursor: string;
            hasMore: boolean;
            changes: {
              measurements: {
                upserts: Array<{ id: string }>;
                tombstones: Array<{ id: string }>;
              };
            };
          };
        }
      ).data;
      tombstones.push(...page.changes.measurements.tombstones.map((t) => t.id));
      upserts.push(...page.changes.measurements.upserts.map((u) => u.id));
      cursor = page.cursor;
      if (!page.hasMore) break;
    }
    expect(tombstones.sort()).toEqual(
      ["feed-classB-legacy", "feed-classB-manual", "feed-classB-user"].sort(),
    );
    for (const id of CLASS_A("feed")) expect(tombstones).not.toContain(id);
    expect(upserts).toContain("feed-hourly");
  });
});

describe("restore", () => {
  it("does not write class-A tombstones back", async () => {
    const prisma = getPrismaClient();
    await account("restore-a", true);
    await seedMix("restore-a");
    const { storeBackupBlob } = await import("@/lib/export/store-backup-blob");
    const { streamFullBackupJson } =
      await import("@/lib/export/full-backup-stream");
    const { id: backupId } = await storeBackupBlob(
      prisma,
      { userId: "restore-a", type: "WEEKLY_AUTO" },
      (write) =>
        streamFullBackupJson(prisma, "restore-a", write, {
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

    const restored = await ids("restore-a");
    for (const id of CLASS_A("restore-a")) expect(restored).not.toContain(id);
    // The class-B tombstones inside the retention come back; the user
    // deletion from 119 days ago is past it and is skipped as before.
    expect(restored).toContain("restore-a-classB-manual");
    expect(restored).toContain("restore-a-classB-legacy");
    expect(restored).toContain("restore-a-hourly");
    expect(restored).toContain("restore-a-live");
  }, 120_000);

  it("writes class-A tombstones back from a file older than the fold repair, and runs the repair again", async () => {
    const prisma = getPrismaClient();
    await account("restore-old", true);
    await seedMix("restore-old", false);
    const { storeBackupBlob } = await import("@/lib/export/store-backup-blob");
    const { streamFullBackupJson } =
      await import("@/lib/export/full-backup-stream");
    const { id: backupId } = await storeBackupBlob(
      prisma,
      { userId: "restore-old", type: "WEEKLY_AUTO" },
      (write) =>
        streamFullBackupJson(prisma, "restore-old", write, {
          purpose: "disaster-recovery",
        }),
    );
    // The repair finished after the file was exported.
    await prisma.measurementFoldRepair.create({
      data: { userId: "restore-old", completedAt: new Date(Date.now() + 1) },
    });
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
    const restored = await ids("restore-old");
    for (const id of CLASS_A("restore-old")) expect(restored).toContain(id);
    expect(
      await prisma.measurementFoldRepair.findUnique({
        where: { userId: "restore-old" },
      }),
    ).toBeNull();
  }, 120_000);
});

type BatchBody = {
  data: {
    inserted: number;
    duplicates: number;
    entries: Array<{ index: number; status: string; reason?: string }>;
  };
};

function pulseEntry(externalId: string, when: Date, value = 60) {
  return {
    hkIdentifier: "HKQuantityTypeIdentifierHeartRate",
    value,
    unit: "count/min",
    startDate: when.toISOString(),
    endDate: when.toISOString(),
    externalId,
  };
}

async function postBatch(entries: unknown[]): Promise<BatchBody["data"]> {
  const { POST } = await import("@/app/api/measurements/batch/route");
  const res = await POST(
    new NextRequest("http://localhost/api/measurements/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as BatchBody).data;
}

describe("folds delete, and the folded_window guard holds the re-upload off", () => {
  it("dense retention removes the raw rows outright; re-sending one is a folded duplicate", async () => {
    const prisma = getPrismaClient();
    await account("fold-dense", true);
    const raws = Array.from({ length: 4 }, (_, i) =>
      pulseEntry(`uuid-fold-${i}`, at(5 + i * 10), 60 + i),
    );
    expect((await postBatch(raws)).inserted).toBe(4);

    const { runDenseIntradayRetention } =
      await import("@/lib/measurements/dense-intraday-retention");
    await runDenseIntradayRetention(prisma, {
      userId: "fold-dense",
      log: () => {},
    });

    const rows = await prisma.measurement.findMany({
      where: { userId: "fold-dense", type: "PULSE" },
      select: { externalId: true, deletedAt: true },
    });
    expect(rows).toEqual([{ externalId: HOURLY_ID, deletedAt: null }]);

    const again = await postBatch(raws);
    expect(again.entries.every((e) => e.reason === "folded_window")).toBe(true);
    expect(again.duplicates).toBe(4);
    expect(
      await prisma.measurement.count({
        where: { userId: "fold-dense", type: "PULSE" },
      }),
    ).toBe(1);
  });

  it("mean consolidation removes the raw rows outright", async () => {
    const prisma = getPrismaClient();
    await account("fold-mean", true);
    const when = new Date(NOW - 5 * DAY);
    await postBatch([
      {
        hkIdentifier: "HKQuantityTypeIdentifierRespiratoryRate",
        value: 14,
        unit: "count/min",
        startDate: when.toISOString(),
        endDate: when.toISOString(),
        externalId: "uuid-rr-1",
      },
    ]);
    const { consolidateDailyMean } =
      await import("@/lib/measurements/consolidate-daily-mean");
    await consolidateDailyMean(prisma, { userId: "fold-mean", log: () => {} });
    const rows = await prisma.measurement.findMany({
      where: { userId: "fold-mean", type: "RESPIRATORY_RATE" },
      select: { externalId: true, deletedAt: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].externalId).toMatch(/^stats:/);
    expect(rows[0].deletedAt).toBeNull();
  });
});

describe("exact-duplicate prefilter against Postgres", () => {
  it("answers a re-sent 500-entry batch without a transaction", async () => {
    const prisma = getPrismaClient();
    await account("prefilter", true);
    const entries = Array.from({ length: 500 }, (_, i) => ({
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value: 70 + (i % 10),
      unit: "kg",
      startDate: new Date(NOW - DAY - i * 60_000).toISOString(),
      endDate: new Date(NOW - DAY - i * 60_000).toISOString(),
      externalId: `uuid-weight-${i}`,
    }));
    expect((await postBatch(entries)).inserted).toBe(500);

    const spy = vi.spyOn(prisma, "$transaction");
    const again = await postBatch(entries);
    expect(again.duplicates).toBe(500);
    expect(again.entries.every((e) => e.status === "duplicate")).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("11: two identical batches racing insert every row exactly once", async () => {
    const prisma = getPrismaClient();
    await account("race", true);
    const entries = Array.from({ length: 50 }, (_, i) => ({
      hkIdentifier: "HKQuantityTypeIdentifierBodyMass",
      value: 70,
      unit: "kg",
      startDate: new Date(NOW - DAY - i * 60_000).toISOString(),
      endDate: new Date(NOW - DAY - i * 60_000).toISOString(),
      externalId: `uuid-race-${i}`,
    }));
    const [a, b] = await Promise.all([postBatch(entries), postBatch(entries)]);
    expect(a.inserted + b.inserted).toBe(50);
    expect(a.duplicates + b.duplicates).toBe(50);
    for (let i = 0; i < 50; i++) {
      expect([a.entries[i].status, b.entries[i].status].sort()).toEqual([
        "duplicate",
        "inserted",
      ]);
    }
    expect(await prisma.measurement.count({ where: { userId: "race" } })).toBe(
      50,
    );
  });
});

describe("listLiveMeasurementTypes", () => {
  it("answers what the GROUP BY answered, with and without filters", async () => {
    const prisma = getPrismaClient();
    await account("types");
    await seedMix("types");
    const { listLiveMeasurementTypes } =
      await import("@/lib/measurements/live-types");
    const grouped = async (where: Record<string, unknown>) =>
      (
        await prisma.measurement.groupBy({
          by: ["type"],
          where: { userId: "types", deletedAt: null, ...where },
          orderBy: { type: "asc" },
        })
      ).map((row) => row.type);

    expect(await listLiveMeasurementTypes("types")).toEqual(await grouped({}));
    expect(await listLiveMeasurementTypes("types")).toEqual([
      "PULSE",
      "RESPIRATORY_RATE",
    ]);
    expect(
      await listLiveMeasurementTypes("types", { source: "MANUAL" }),
    ).toEqual([]);
    expect(
      await listLiveMeasurementTypes("types", {
        types: ["RESPIRATORY_RATE", "WEIGHT"],
      }),
    ).toEqual(["RESPIRATORY_RATE"]);
    expect(await listLiveMeasurementTypes("types", { types: [] })).toEqual([]);
  });
});

describe("PR-detection watermark", () => {
  it("re-scans only accounts whose readings or workouts changed", async () => {
    const prisma = getPrismaClient();
    await account("pr-fresh");
    await account("pr-stale");
    await prisma.measurement.create({
      data: {
        userId: "pr-fresh",
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(NOW - DAY),
      },
    });
    await prisma.measurement.create({
      data: {
        userId: "pr-stale",
        type: "WEIGHT",
        value: 80,
        unit: "kg",
        measuredAt: new Date(NOW - DAY),
        updatedAt: new Date(NOW - 3 * HOUR),
      },
    });
    const { listPrDetectionFallbackUserIds } =
      await import("@/lib/jobs/pr-detection");
    expect(
      await listPrDetectionFallbackUserIds(prisma, new Date(NOW - 35 * 60_000)),
    ).toEqual(["pr-fresh"]);
    expect(
      await listPrDetectionFallbackUserIds(prisma, new Date(NOW - DAY)),
    ).toEqual(["pr-fresh", "pr-stale"]);
  });
});

describe("measurement maintenance", () => {
  it("vacuums and rebuilds every index, one at a time, largest first", async () => {
    await account("maint");
    await seedMix("maint");
    const { Client } = await import("pg");
    const { MAINTENANCE_SESSION_OPTIONS, runMeasurementMaintenance } =
      await import("@/lib/jobs/measurement-maintenance");
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      options: MAINTENANCE_SESSION_OPTIONS,
    });
    await client.connect();
    try {
      const { rows } = await client.query<{ setting: string }>(
        "SELECT current_setting('statement_timeout') AS setting",
      );
      expect(rows[0].setting).toBe("0");
      const summary = await runMeasurementMaintenance(client, {
        vacuum: true,
        reindex: true,
      });
      expect(summary.outcome).toBe("completed");
      expect(summary.steps[0]).toMatchObject({ step: "vacuum", ok: true });
      const rebuilt = summary.steps.filter((s) => s.step === "reindex");
      expect(rebuilt.length).toBeGreaterThan(5);
      expect(rebuilt.every((s) => s.ok)).toBe(true);
      expect(rebuilt.map((s) => s.target)).toContain(
        "measurements_live_covering_idx",
      );
      const sizes = rebuilt.map((s) => s.bytesBefore);
      expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
    } finally {
      await client.end();
    }
  }, 120_000);

  it("drops a leftover invalid copy before rebuilding", async () => {
    await account("maint-copy");
    const { Client } = await import("pg");
    const { MAINTENANCE_SESSION_OPTIONS, runMeasurementMaintenance } =
      await import("@/lib/jobs/measurement-maintenance");
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      options: MAINTENANCE_SESSION_OPTIONS,
    });
    await client.connect();
    try {
      // What an interrupted REINDEX CONCURRENTLY leaves: an index marked
      // invalid under the `_ccnew` name.
      await client.query(
        `CREATE INDEX "measurements_external_id_idx_ccnew" ON "measurements" ("external_id")`,
      );
      await client.query(
        `UPDATE pg_index SET indisvalid = false WHERE indexrelid = '"measurements_external_id_idx_ccnew"'::regclass`,
      );
      const summary = await runMeasurementMaintenance(client, {
        vacuum: false,
        reindex: true,
      });
      expect(summary.outcome).toBe("completed");
      expect(summary.steps[0]).toMatchObject({
        step: "drop_invalid",
        target: "measurements_external_id_idx_ccnew",
        ok: true,
      });
      const { rows } = await client.query(
        `SELECT 1 FROM pg_class WHERE relname = 'measurements_external_id_idx_ccnew'`,
      );
      expect(rows).toHaveLength(0);
    } finally {
      await client
        .query(`DROP INDEX IF EXISTS "measurements_external_id_idx_ccnew"`)
        .catch(() => {});
      await client.end();
    }
  }, 120_000);
});
