/**
 * What a queued restore says it waits for, read from a real pg-boss.
 *
 * A restore never runs beside a backup pass or another large job: the heavy
 * lane puts its delivery back in the queue for a minute at a time
 * (`deferLaneJobs`). Its own row says `queued` throughout, and the console
 * used to say only that it starts "as soon as the background worker picks it
 * up", which read as a stuck worker while a backup ran. The status read now
 * asks the queue: a delivery that went back, and the heavy job that holds
 * the lane.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PgBoss } from "pg-boss";

import { prisma } from "@/lib/db";
import { readBackupRestoreJob } from "@/lib/jobs/backup-restore-view";
import { BACKUP_RESTORE_QUEUE } from "@/lib/jobs/backup-restore-queue";
import { restoreWaits } from "@/lib/jobs/backup-restore-wait";
import { deferLaneJobs } from "@/lib/jobs/heavy-lane";

import { makeUser } from "../kit/factories";
import { truncateAllTables } from "./setup";

let boss: PgBoss;

const QUEUES = [BACKUP_RESTORE_QUEUE, "data-backup", "rollup-full-backfill"];

beforeAll(async () => {
  await truncateAllTables(prisma);
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  await boss.start();
  for (const queue of QUEUES) await boss.createQueue(queue);
}, 120_000);

afterAll(async () => {
  for (const queue of QUEUES) await boss.deleteAllJobs(queue);
  await boss?.stop({ graceful: false });
  await truncateAllTables(prisma);
});

/** A restore delivery the lane has put back, as `heavyLane` leaves it. */
async function deferredRestore(): Promise<string> {
  const id = await boss.send(BACKUP_RESTORE_QUEUE, { restoreJobId: "r" });
  const [fetched] = await boss.fetch(BACKUP_RESTORE_QUEUE);
  expect(fetched?.id).toBe(id);
  expect((await deferLaneJobs(BACKUP_RESTORE_QUEUE, [fetched!])).deferred).toBe(
    1,
  );
  return id!;
}

/** A job of `queue` running, so it holds the lane. */
async function running(queue: string): Promise<string> {
  const id = await boss.send(queue, {});
  const [fetched] = await boss.fetch(queue);
  expect(fetched?.id).toBe(id);
  return id!;
}

describe("restoreWaits", () => {
  it("names the backup when a backup pass holds the lane", async () => {
    const restore = await deferredRestore();
    const backup = await running("data-backup");
    expect(await restoreWaits([restore])).toEqual(
      new Map([[restore, "backup"]]),
    );
    await boss.complete("data-backup", backup);

    // Another large job holding it is named as one.
    const fold = await running("rollup-full-backfill");
    expect((await restoreWaits([restore])).get(restore)).toBe("busy");
    await boss.complete("rollup-full-backfill", fold);

    // Put back with nothing running (the memory guard, or a holder that has
    // just finished): still a wait for room, not for the worker.
    expect((await restoreWaits([restore])).get(restore)).toBe("busy");
    await boss.deleteJob(BACKUP_RESTORE_QUEUE, restore);
  });

  it("says nothing about a delivery that only waits for the worker", async () => {
    const queued = await boss.send(BACKUP_RESTORE_QUEUE, { restoreJobId: "q" });
    const backup = await running("data-backup");
    expect(await restoreWaits([queued!])).toEqual(new Map());
    await boss.complete("data-backup", backup);
    await boss.deleteJob(BACKUP_RESTORE_QUEUE, queued!);
  });

  it("reaches the status read of the job behind the delivery", async () => {
    const owner = await makeUser({});
    const restore = await deferredRestore();
    const job = await prisma.backupRestoreJob.create({
      data: {
        userId: owner.id,
        actorUserId: owner.id,
        backupId: "backup-1",
        backupDigest: "digest",
        status: "queued",
        pgBossJobId: restore,
      },
    });
    const backup = await running("data-backup");
    expect((await readBackupRestoreJob(job.id))?.waiting).toBe("backup");
    await boss.complete("data-backup", backup);

    // A job that is no longer queued waits for nothing, whatever its last
    // delivery says.
    await prisma.backupRestoreJob.update({
      where: { id: job.id },
      data: { status: "running" },
    });
    expect((await readBackupRestoreJob(job.id))?.waiting).toBeNull();
    await boss.deleteJob(BACKUP_RESTORE_QUEUE, restore);
  });
});
