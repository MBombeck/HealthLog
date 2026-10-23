/**
 * #1031 — a restore and a consolidation pass over the same account must not
 * deadlock.
 *
 * Seen on a freshly booted instance: the restore's clearing step failed with
 * `40P01` while the boot-time step consolidation was folding the same
 * account. Each takes row locks on the account's readings in its own order.
 * A consolidation day first updates (or mints) the day's `stats:` total, then
 * soft-deletes the day's per-sample rows; the restore deletes every reading
 * of the account in one statement, in the order the table gives them. When
 * the restore reaches the day's samples before the total, each side holds
 * what the other one needs next.
 *
 * This file builds exactly that order, deterministically. The day's samples
 * are written before its (soft-deleted) total, so the restore's delete meets
 * them first, and a row trigger holds the consolidation for three seconds
 * right after it has locked the total. The restore is started while it waits.
 *
 * What must hold: both finish, neither is chosen as a deadlock victim, and
 * the account ends up as the backup says. Every writer of the consolidation
 * family now takes the restore's account lock in shared mode at the start of
 * its day transaction, and the restore takes it exclusively before its first
 * delete, so the two are ordered by that lock before either touches a row. A
 * consolidation that finds a restore running leaves the account for its next
 * run instead of waiting on it.
 *
 * Mutation check: remove the `holdAccountAgainstRestore` call from the step
 * consolidation's day transaction and the first test fails with the
 * consolidation rejected on `40P01`.
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

import { getPrismaClient, truncateAllTables } from "./setup";
import { acceptingBoss } from "./restore-job-driver";

vi.mock("@/lib/db-compat", () => ({
  ensureDbCompatibility: vi.fn().mockResolvedValue(undefined),
}));

const OWNER = "restore-deadlock-owner";
const DAY = "2026-01-10";
const TOTAL_ID = "deadlock-total";
const TOTAL_EXTERNAL_ID = `stats:HKQuantityTypeIdentifierStepCount:${DAY}`;

async function dropTrigger() {
  const prisma = getPrismaClient();
  await prisma.$executeRawUnsafe(
    `DROP TRIGGER IF EXISTS restore_deadlock_hold ON measurements`,
  );
  await prisma.$executeRawUnsafe(
    `DROP FUNCTION IF EXISTS restore_deadlock_hold()`,
  );
}

/** Hold the transaction that updates the day's total for three seconds. */
async function holdTheTotalsUpdate() {
  const prisma = getPrismaClient();
  await prisma.$executeRawUnsafe(
    `CREATE FUNCTION restore_deadlock_hold() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(3); RETURN NEW; END $$`,
  );
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER restore_deadlock_hold BEFORE UPDATE ON measurements FOR EACH ROW WHEN (OLD.id = '${TOTAL_ID}') EXECUTE FUNCTION restore_deadlock_hold()`,
  );
}

async function seedAccountWithBackup(): Promise<string> {
  const prisma = getPrismaClient();
  await prisma.user.create({
    data: { id: OWNER, username: OWNER, role: "ADMIN", timezone: "UTC" },
  });
  // The day's per-sample rows first, then its total, so a delete of the
  // account meets the samples first. All samples before noon, so an index
  // walk in time order meets them first too.
  for (const [i, hour] of [6, 8, 10].entries()) {
    await prisma.measurement.create({
      data: {
        id: `deadlock-sample-${i}`,
        userId: OWNER,
        type: "ACTIVITY_STEPS",
        value: 1000 + i,
        unit: "steps",
        source: "APPLE_HEALTH",
        measuredAt: new Date(
          `${DAY}T${String(hour).padStart(2, "0")}:00:00.000Z`,
        ),
        externalId: `hk-sample-${i}`,
      },
    });
  }
  // A total a previous pass minted and something since removed: the next
  // pass mints it again through the upsert's update branch, which locks it.
  await prisma.measurement.create({
    data: {
      id: TOTAL_ID,
      userId: OWNER,
      type: "ACTIVITY_STEPS",
      value: 1,
      unit: "steps",
      source: "MANUAL",
      measuredAt: new Date(`${DAY}T12:00:00.000Z`),
      externalId: TOTAL_EXTERNAL_ID,
      deletedAt: new Date(),
    },
  });
  const { storeBackupBlob } = await import("@/lib/export/store-backup-blob");
  const { streamFullBackupJson } =
    await import("@/lib/export/full-backup-stream");
  const { id } = await storeBackupBlob(
    prisma,
    { userId: OWNER, type: "WEEKLY_AUTO" },
    (write) =>
      streamFullBackupJson(prisma, OWNER, write, {
        purpose: "disaster-recovery",
      }),
  );
  return id;
}

async function startRestore(backupId: string) {
  const prisma = getPrismaClient();
  const jobs = await import("@/lib/jobs/backup-restore");
  const { storedBackupIdentity, STORED_BACKUP_SELECT } =
    await import("@/lib/export/stored-backup");
  const backup = await prisma.dataBackup.findUniqueOrThrow({
    where: { id: backupId },
    select: STORED_BACKUP_SELECT,
  });
  const admitted = await jobs.admitBackupRestore({
    userId: OWNER,
    actorUserId: OWNER,
    backupId,
    backupDigest: jobs.backupDigest(storedBackupIdentity(backup)),
    restoreInstanceSettings: false,
    boss: acceptingBoss,
  });
  if (!admitted.admitted) throw new Error("restore not admitted");
  return {
    jobId: admitted.jobId,
    done: jobs.runBackupRestoreJob(admitted.jobId),
  };
}

/** Wait until a backend sits in the trigger's sleep. */
async function untilHeldInTrigger() {
  const prisma = getPrismaClient();
  for (let i = 0; i < 100; i++) {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*) AS n FROM pg_stat_activity
       WHERE wait_event = 'PgSleep' AND datname = current_database()
    `;
    if (Number(rows[0]?.n ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("the consolidation never reached the day's total");
}

beforeEach(async () => {
  await dropTrigger();
  await truncateAllTables(getPrismaClient());
});

afterEach(async () => {
  await dropTrigger();
});

afterAll(async () => {
  await truncateAllTables(getPrismaClient());
});

describe("restore against a running consolidation (#1031)", () => {
  it("does not deadlock when the restore starts while a day is being folded", async () => {
    const prisma = getPrismaClient();
    const backupId = await seedAccountWithBackup();
    await holdTheTotalsUpdate();

    const { runStepConsolidationForUser } =
      await import("@/lib/jobs/step-consolidation");
    const consolidation = runStepConsolidationForUser(OWNER).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await untilHeldInTrigger();
    const restore = await startRestore(backupId);

    const [folded] = await Promise.all([consolidation, restore.done]);
    const { readBackupRestoreJob } =
      await import("@/lib/jobs/backup-restore-view");
    const job = await readBackupRestoreJob(restore.jobId);

    expect(
      folded.ok,
      `the consolidation failed: ${folded.ok ? "" : String((folded.error as Error)?.message ?? folded.error)}`,
    ).toBe(true);
    expect(job?.status, JSON.stringify(job?.failure)).toBe("succeeded");
    // The day was folded before the restore went ahead, and the restore then
    // put the account back exactly as the backup holds it.
    if (folded.ok) expect(folded.value.daysConsolidated).toBe(1);
    const rows = await prisma.measurement.findMany({
      where: { userId: OWNER },
      orderBy: { id: "asc" },
      select: { id: true, deletedAt: true },
    });
    expect(rows.map((row) => [row.id, row.deletedAt === null])).toEqual([
      ["deadlock-sample-0", true],
      ["deadlock-sample-1", true],
      ["deadlock-sample-2", true],
      [TOTAL_ID, false],
    ]);
  }, 60_000);

  it("leaves an account alone while its restore holds the lock", async () => {
    const prisma = getPrismaClient();
    await seedAccountWithBackup();
    const { holdAccountAgainstRestore, takeRestoreLock } =
      await import("@/lib/export/restore-lock");

    // A restore's transaction, standing in for the real one: the exclusive
    // account lock is all a consolidation can see of it.
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const restoreTx = prisma.$transaction(
      async (tx) => {
        await takeRestoreLock(tx, OWNER);
        locked();
        await released;
      },
      { timeout: 30_000 },
    );
    await isLocked;

    try {
      // Refused at once, rather than waiting on the restore.
      const started = Date.now();
      await expect(
        prisma.$transaction((tx) => holdAccountAgainstRestore(tx, OWNER)),
      ).rejects.toMatchObject({ name: "AccountRestoreInProgressError" });
      expect(Date.now() - started).toBeLessThan(2_000);

      // The pass leaves the account's rows as they are and says so.
      const { consolidateLegacySteps } =
        await import("@/lib/measurements/consolidate-legacy-steps");
      const summary = await consolidateLegacySteps(prisma, {
        userId: OWNER,
        log: () => {},
      });
      expect(summary.totals.daysConsolidated).toBe(0);
      expect(
        await prisma.measurement.count({
          where: { userId: OWNER, deletedAt: null },
        }),
      ).toBe(3);
    } finally {
      release();
      await restoreTx;
    }

    // Two passes of the family can still share the account.
    await prisma.$transaction(async (tx) => {
      await holdAccountAgainstRestore(tx, OWNER);
      await prisma.$transaction((other) =>
        holdAccountAgainstRestore(other, OWNER),
      );
    });
  }, 60_000);
});
