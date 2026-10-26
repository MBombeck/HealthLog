/**
 * #1031 — a restore is not bounded by the per-request statement timeout.
 *
 * Every pooled connection starts with `statement_timeout` and
 * `idle_in_transaction_session_timeout` from `DATABASE_STATEMENT_TIMEOUT_MS`
 * (`src/lib/db.ts`, 60 s by default). A restore deletes the account's
 * readings in one statement, and on an account of 1.9 million readings on a
 * slow host that statement ran past 60 s, was cancelled, and the restore
 * rolled back in its clearing step with a message that named no cause.
 *
 * This file lowers the session limit to five seconds and makes the clearing
 * delete take six (a statement trigger that sleeps), which is the same
 * situation at a size a test can hold. The first test checks the limit
 * really cancels that delete outside the restore, so the second cannot pass
 * because nothing was slow. The restore then has to finish and give back
 * exactly the rows the backup holds.
 *
 * The third test makes the database refuse the clearing step with a
 * disk-full error and checks the job says so, and that nothing changed. The
 * last makes every write of chart buckets outlast the session limit and
 * checks the rebuild after the commit still lands every granularity.
 *
 * Mutation checks: remove the `set_config('statement_timeout', …)` call at
 * the top of the restore transaction and the restore test goes red with
 * `cause: "timeout"`; drop `statementTimeoutMs` from the restore's
 * `recomputeUserRollups` call and the rebuild test finds no buckets; write
 * every tombstone again and the restore test finds the expired ones back.
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

vi.hoisted(() => {
  // Read once, when `@/lib/db` builds its pool; hoisted above every import.
  process.env.DATABASE_STATEMENT_TIMEOUT_MS = "5000";
});

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/generated/prisma/client";
import { cookieJar, headerJar } from "./mock-next-headers";
import { getPrismaClient, truncateAllTables } from "./setup";
import { streamFullBackupJson } from "@/lib/export/full-backup-stream";
import { storeBackupBlob } from "@/lib/export/store-backup-blob";
import { RESTORE_FAILURE_CAUSE_MESSAGES } from "@/lib/export/restore-failure-cause";
import { readBackupRestoreJob } from "@/lib/jobs/backup-restore-view";

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

const COUNT = 600;

/**
 * A second pool without the lowered limit, for the suite's own housekeeping:
 * truncating every table between tests can take longer than five seconds on
 * a busy host, and it is not what this file measures.
 */
let setupClient: PrismaClient | null = null;
function housekeeping(): PrismaClient {
  setupClient ??= new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }),
  });
  return setupClient;
}

async function dropTrigger() {
  const prisma = housekeeping();
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS restore_test_clearing ON measurements`,
  );
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS restore_test_clearing()`,
  );
}

/** Run `body` on every DELETE statement against `measurements`. */
async function onMeasurementDelete(body: string) {
  const prisma = housekeeping();
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION restore_test_clearing() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN ${body} RETURN NULL; END $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER restore_test_clearing BEFORE DELETE ON measurements FOR EACH STATEMENT EXECUTE FUNCTION restore_test_clearing()`,
  );
}

beforeEach(async () => {
  await dropTrigger();
  await truncateAllTables(housekeeping());
  cookieJar.clear();
  headerJar.clear();
});

afterEach(async () => {
  await dropTrigger();
});

afterAll(async () => {
  await setupClient?.$disconnect();
});

async function seedAccountWithBackup() {
  const prisma = getPrismaClient();
  const user = await prisma.user.create({
    data: {
      username: "slow-host",
      email: "slow-host@example.test",
      role: "ADMIN",
    },
  });
  const session = await prisma.session.create({
    data: { userId: user.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  const start = Date.UTC(2024, 0, 1);
  await prisma.measurement.createMany({
    data: Array.from({ length: COUNT }, (_, i) => ({
      id: `m-${String(i).padStart(4, "0")}`,
      userId: user.id,
      type: "PULSE" as const,
      value: 50 + (i % 40),
      unit: "bpm",
      source: "APPLE_HEALTH" as const,
      measuredAt: new Date(start + i * 60_000),
      externalId: `hk-${i}`,
      // Most of them deleted, as after the nightly consolidation: half of
      // those yesterday, half long past the tombstone retention.
      deletedAt:
        i % 8 === 0
          ? null
          : i % 2 === 0
            ? new Date(start)
            : new Date(Date.now() - 86_400_000),
    })),
  });
  const { id } = await storeBackupBlob(
    prisma,
    { userId: user.id, type: "WEEKLY_AUTO" },
    (write) =>
      streamFullBackupJson(prisma, user.id, write, {
        purpose: "disaster-recovery",
      }),
  );
  const before = await measurementsOf(user.id);
  // Something for the restore to undo, without a DELETE.
  await prisma.measurement.updateMany({
    where: { userId: user.id },
    data: { value: 1 },
  });
  return { user, backupId: id, before };
}

async function measurementsOf(userId: string) {
  return getPrismaClient().measurement.findMany({
    where: { userId },
    orderBy: { id: "asc" },
  });
}

async function restore(id: string) {
  const { POST } = await import("./restore-job-driver");
  return POST(
    new Request(`http://localhost/api/admin/backups/${id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as never,
    { params: Promise.resolve({ id }) },
  );
}

async function lastJob(userId: string) {
  const row = await getPrismaClient().backupRestoreJob.findFirstOrThrow({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });
  return readBackupRestoreJob(row.id);
}

describe("restore under a short statement timeout (#1031)", () => {
  it("the session limit cancels the slow clearing delete outside a restore", async () => {
    const { user } = await seedAccountWithBackup();
    await onMeasurementDelete("PERFORM pg_sleep(6);");
    const prisma = getPrismaClient();
    const attempt = prisma.$transaction(async (tx) => {
      await tx.measurement.deleteMany({ where: { userId: user.id } });
      throw new Error("not cancelled");
    });
    await expect(attempt).rejects.toMatchObject({
      meta: { driverAdapterError: { cause: { originalCode: "57014" } } },
    });
  });

  it("a restore whose clearing delete outlasts the session limit still completes", async () => {
    const { user, backupId, before } = await seedAccountWithBackup();
    await onMeasurementDelete("PERFORM pg_sleep(6);");

    const res = await restore(backupId);
    const job = await lastJob(user.id);
    expect(job?.failure ?? null).toBeNull();
    expect(res.status).toBe(200);
    expect(job?.status).toBe("succeeded");
    // Every row comes back but the tombstones past retention, which the
    // nightly purge would remove anyway.
    const kept = before.filter(
      (m) => m.deletedAt === null || m.deletedAt.getTime() > Date.UTC(2025, 0),
    );
    expect(kept.some((m) => m.deletedAt !== null)).toBe(true);
    expect(kept.length).toBeLessThan(before.length);
    expect(await measurementsOf(user.id)).toEqual(kept);
  });

  it("a refused clearing step names its cause and changes nothing", async () => {
    const { user, backupId } = await seedAccountWithBackup();
    const changed = await measurementsOf(user.id);
    await onMeasurementDelete(
      "RAISE EXCEPTION 'restore test' USING ERRCODE = 'disk_full';",
    );

    const res = await restore(backupId);
    expect(res.status).toBe(500);
    const job = await lastJob(user.id);
    expect(job?.status).toBe("failed");
    expect(job?.failure).toEqual({
      code: "transaction_failed",
      cause: "storage",
      message: RESTORE_FAILURE_CAUSE_MESSAGES.storage,
    });
    expect(await measurementsOf(user.id)).toEqual(changed);

    const audit = await getPrismaClient().auditLog.findFirstOrThrow({
      where: { action: "admin.backups.restore.failed" },
      orderBy: { createdAt: "desc" },
    });
    expect(JSON.parse(audit.details ?? "{}")).toMatchObject({
      reason: "transaction_failed",
      cause: "storage",
      code: "53100",
    });
  });

  it("the chart rebuild after the commit outlasts the session limit too", async () => {
    const { user, backupId } = await seedAccountWithBackup();
    const prisma = housekeeping();
    // Every write of rollup buckets takes longer than the session limit.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION restore_test_slow_rollups() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(6); RETURN NULL; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER restore_test_slow_rollups BEFORE INSERT ON measurement_rollups FOR EACH STATEMENT EXECUTE FUNCTION restore_test_slow_rollups()`,
    );
    try {
      expect((await restore(backupId)).status).toBe(200);
      const buckets = await prisma.measurementRollup.groupBy({
        by: ["granularity"],
        where: { userId: user.id },
        _count: true,
      });
      expect(buckets.map((b) => b.granularity).sort()).toEqual([
        "DAY",
        "MONTH",
        "WEEK",
        "YEAR",
      ]);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS restore_test_slow_rollups ON measurement_rollups`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS restore_test_slow_rollups()`,
      );
    }
  }, 120_000);
});
