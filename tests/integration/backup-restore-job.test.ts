/**
 * A backup restore runs as a background job, end to end.
 *
 * The restore of a large account outlived a reverse proxy's 60-second request
 * limit, so the operator saw an error for a restore that went on to finish.
 * The request now answers 202 with a job id, the `backup-restore` queue runs
 * the restore, and `GET /api/admin/backups/restores/{id}` reports it. Pinned
 * here against a real Postgres:
 *
 *   1. upload → 202 → the job queued → run → the status route says succeeded,
 *      with the counts, and the rows are back;
 *   2. a copy that cannot be decrypted is refused in the request itself, and
 *      no job is created;
 *   3. a restore that fails part-way ends `failed` with a reason, and the
 *      account is exactly as it was (the transaction rolled back);
 *   4. a second restore of the same account while one is queued answers 409,
 *      and two requests racing each other admit exactly one;
 *   5. a job whose worker stopped is queued again by the sweep and then
 *      finishes; after the second interruption it fails instead of looping;
 *      the listing a reloaded page reads shows the job while it runs;
 *   6. a copy replaced while the job waited is not restored in its place;
 *   7. a file whose transaction would outlast the job's budget is refused
 *      before anything is deleted.
 *
 * Mutation checks (each run once, each turned the named case red):
 *   - drop the partial unique index from migration 0347: case 4's race admits
 *     two jobs;
 *   - skip the digest comparison in `runBackupRestoreJob`: case 6 restores the
 *     replaced copy;
 *   - remove the deadline check in `restoreBackup`: case 7 deletes the rows;
 *   - drop the attempts cap in `sweepInterruptedRestores`: case 5's third
 *     interruption is queued again.
 */
import type { PgBoss } from "pg-boss";
import { gzipSync } from "node:zlib";

import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.ENCRYPTION_KEY ??=
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

import { encrypt } from "@/lib/crypto";
import { setGlobalBoss } from "@/lib/jobs/boss-instance";
import { runJob } from "@/lib/jobs/run-job";
import {
  BACKUP_RESTORE_MAX_ATTEMPTS,
  BACKUP_RESTORE_QUEUE,
  handleBackupRestore,
  readBackupRestoreJob,
  runBackupRestoreJob,
  sweepInterruptedRestores,
} from "@/lib/jobs/backup-restore";
import { backupPayloadSchema } from "@/lib/validations/backup";

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

/** A queue that records what it is sent and what it is told is finished. */
function recordingBoss() {
  const sent: Array<{ queue: string; data: unknown }> = [];
  const completed: string[] = [];
  let next = 0;
  const boss = {
    send: vi.fn(async (queue: string, data: unknown) => {
      sent.push({ queue, data });
      next += 1;
      return `boss-${next}`;
    }),
    complete: vi.fn(async (_queue: string, id: string) => {
      completed.push(id);
      return {};
    }),
  } as unknown as PgBoss;
  return { boss, sent, completed };
}

let queue: ReturnType<typeof recordingBoss>;

beforeEach(async () => {
  await truncateAllTables(getPrismaClient());
  cookieJar.clear();
  headerJar.clear();
  queue = recordingBoss();
  setGlobalBoss(queue.boss);
});

async function seedAdmin(username = "restore-job-admin") {
  const prisma = getPrismaClient();
  const admin = await prisma.user.create({
    data: { username, email: `${username}@example.test`, role: "ADMIN" },
  });
  const session = await prisma.session.create({
    data: { userId: admin.id, expiresAt: new Date(Date.now() + 600_000) },
  });
  cookieJar.set("healthlog_session", session.id);
  return admin;
}

function payloadFor(userId: string, measurementIds: string[]) {
  return backupPayloadSchema.parse({
    schemaVersion: "2",
    exportedAt: "2026-09-20T00:00:00.000Z",
    userId,
    measurements: measurementIds.map((id, i) => ({
      id,
      type: "PULSE",
      value: 60 + i,
      unit: "bpm",
      measuredAt: new Date(Date.UTC(2026, 8, 1, 7, i)).toISOString(),
      source: "MANUAL",
    })),
  });
}

async function storeBackup(userId: string, measurementIds: string[]) {
  return getPrismaClient().dataBackup.create({
    data: {
      userId,
      type: `MANUAL_UPLOAD_${Date.now()}_${Math.random()}`,
      data: encrypt(JSON.stringify(payloadFor(userId, measurementIds))),
    },
  });
}

async function seedMeasurements(userId: string, ids: string[]) {
  await getPrismaClient().measurement.createMany({
    data: ids.map((id, i) => ({
      id,
      userId,
      type: "WEIGHT" as const,
      value: 80 + i,
      unit: "kg",
      measuredAt: new Date(Date.UTC(2026, 7, 1, 7, i)),
    })),
  });
}

async function requestRestore(backupId: string, key?: string) {
  const { POST } = await import("@/app/api/admin/backups/[id]/restore/route");
  return POST(
    new Request(`http://localhost/api/admin/backups/${backupId}/restore`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(key ? { "idempotency-key": key } : {}),
      },
      body: JSON.stringify({ confirm: "RESTORE" }),
    }) as never,
    { params: Promise.resolve({ id: backupId }) },
  );
}

async function readStatus(jobId: string) {
  const { GET } =
    await import("@/app/api/admin/backups/restores/[jobId]/route");
  const res = await GET(
    new Request(
      `http://localhost/api/admin/backups/restores/${jobId}`,
    ) as never,
    { params: Promise.resolve({ jobId }) },
  );
  return res;
}

async function listStatus() {
  const { GET } = await import("@/app/api/admin/backups/restores/route");
  // The listing handler declares no parameters; `apiHandler` reads the
  // request defensively, so calling it bare is what a GET without a body is.
  const res = await GET();
  return (await res.json()) as {
    data: { jobs: Array<{ id: string; status: string }> };
  };
}

async function measurementIdsOf(userId: string) {
  const rows = await getPrismaClient().measurement.findMany({
    where: { userId },
    orderBy: { id: "asc" },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

describe("backup restore as a background job", () => {
  it("upload → 202 → queued → run → succeeded, and the rows are back", async () => {
    const admin = await seedAdmin();
    await seedMeasurements(admin.id, ["live-1", "live-2"]);

    const file = Buffer.from(
      JSON.stringify(payloadFor(admin.id, ["m-a", "m-b", "m-c"])),
    );
    const { POST: upload } =
      await import("@/app/api/admin/backups/upload/route");
    const uploaded = await upload(
      new Request("http://localhost/api/admin/backups/upload", {
        method: "POST",
        headers: { "content-type": "application/gzip" },
        body: gzipSync(file),
      }) as never,
    );
    expect(uploaded.status).toBe(201);
    const { data: stored } = (await uploaded.json()) as {
      data: { id: string };
    };

    const queued = await requestRestore(stored.id);
    expect(queued.status).toBe(202);
    const { data } = (await queued.json()) as {
      data: { jobId: string; status: string; statusUrl: string };
    };
    expect(data.status).toBe("queued");
    expect(data.statusUrl).toBe(`/api/admin/backups/restores/${data.jobId}`);
    // The request queued the job and changed nothing yet.
    expect(queue.sent).toEqual([
      { queue: BACKUP_RESTORE_QUEUE, data: { restoreJobId: data.jobId } },
    ]);
    expect(await measurementIdsOf(admin.id)).toEqual(["live-1", "live-2"]);
    const waiting = (await (await readStatus(data.jobId)).json()) as {
      data: { status: string };
    };
    expect(waiting.data.status).toBe("queued");

    // Through the same wrapper the worker binds, so the outcome pg-boss
    // persists is validated too, not only the handler's return value.
    const persisted = await runJob(
      BACKUP_RESTORE_QUEUE,
      handleBackupRestore,
    )([
      {
        id: "boss-1",
        name: BACKUP_RESTORE_QUEUE,
        data: { restoreJobId: data.jobId },
        expireInSeconds: 7200,
        signal: new AbortController().signal,
      } as never,
    ]);
    expect(persisted).toEqual({
      ok: true,
      did: { restore_measurements: 3, restore_skipped_links: 0 },
    });

    const finished = await readStatus(data.jobId);
    expect(finished.status).toBe(200);
    const body = (await finished.json()) as {
      data: {
        status: string;
        phase: string | null;
        attempts: number;
        progress: { measurementsWritten: number; measurementsTotal: number };
        result: {
          summary: { measurements: number };
          cleared: { measurements: number };
        };
        failure: unknown;
      };
    };
    expect(body.data.status).toBe("succeeded");
    expect(body.data.phase).toBeNull();
    expect(body.data.attempts).toBe(1);
    expect(body.data.failure).toBeNull();
    expect(body.data.result.summary.measurements).toBe(3);
    expect(body.data.result.cleared.measurements).toBe(2);
    expect(body.data.progress.measurementsTotal).toBe(3);
    expect(body.data.progress.measurementsWritten).toBe(3);
    expect(await measurementIdsOf(admin.id)).toEqual(["m-a", "m-b", "m-c"]);

    // The trail says who queued it and that it ran.
    const actions = (
      await getPrismaClient().auditLog.findMany({
        where: { userId: admin.id },
        select: { action: true },
      })
    ).map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "admin.backups.restore.queued",
        "admin.backups.restore.start",
        "admin.backups.restore",
      ]),
    );
  });

  it("refuses a copy that cannot be decrypted in the request, and queues nothing", async () => {
    const admin = await seedAdmin();
    const backup = await getPrismaClient().dataBackup.create({
      data: {
        userId: admin.id,
        type: "MANUAL_UPLOAD_1",
        data: "v1:not-a-real-ciphertext",
      },
    });

    const res = await requestRestore(backup.id);
    expect(res.status).toBe(422);
    const body = (await res.json()) as { meta?: { errorCode?: string } };
    expect(body.meta?.errorCode).toBe("backup.payload.undecryptable");
    expect(queue.sent).toEqual([]);
    expect(await getPrismaClient().backupRestoreJob.count()).toBe(0);
  });

  it("a restore that fails part-way ends failed with a reason, and nothing changed", async () => {
    const admin = await seedAdmin();
    await seedMeasurements(admin.id, ["live-1"]);
    // Another account already owns this id, so the insert fails AFTER the
    // restore deleted the owner's rows, inside the transaction.
    const other = await getPrismaClient().user.create({
      data: { username: "someone-else", email: "else@example.test" },
    });
    await seedMeasurements(other.id, ["taken"]);
    const backup = await storeBackup(admin.id, ["m-a", "taken"]);

    const queued = await requestRestore(backup.id);
    expect(queued.status).toBe(202);
    const { data } = (await queued.json()) as { data: { jobId: string } };
    const outcome = await runBackupRestoreJob(data.jobId);
    // A transaction that could not be written is a fault the operator's job
    // card should show, not a quiet success.
    expect(outcome.ok).toBe(false);

    const job = await readBackupRestoreJob(data.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure?.code).toBe("transaction_failed");
    expect(job?.failure?.message).toContain("Nothing was changed");
    expect(await measurementIdsOf(admin.id)).toEqual(["live-1"]);
    expect(await measurementIdsOf(other.id)).toEqual(["taken"]);
    // The staged copy stays, so a retry needs no new upload.
    expect(
      await getPrismaClient().dataBackup.findUnique({
        where: { id: backup.id },
      }),
    ).not.toBeNull();
  });

  it("refuses a second restore of the same account while one is queued", async () => {
    const admin = await seedAdmin();
    const first = await storeBackup(admin.id, ["m-a"]);
    const second = await storeBackup(admin.id, ["m-b"]);

    const accepted = await requestRestore(first.id);
    expect(accepted.status).toBe(202);
    const { data } = (await accepted.json()) as { data: { jobId: string } };

    const refused = await requestRestore(second.id);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      meta?: { errorCode?: string; jobId?: string };
    };
    expect(body.meta?.errorCode).toBe("backup.restore.active");
    expect(body.meta?.jobId).toBe(data.jobId);

    // Once it has finished, the account can be restored again.
    await runBackupRestoreJob(data.jobId);
    expect((await requestRestore(second.id)).status).toBe(202);
  });

  it("two requests racing for one account admit exactly one", async () => {
    const admin = await seedAdmin();
    const first = await storeBackup(admin.id, ["m-a"]);
    const second = await storeBackup(admin.id, ["m-b"]);

    const statuses = (
      await Promise.all([
        requestRestore(first.id, "race-a"),
        requestRestore(second.id, "race-b"),
      ])
    )
      .map((res) => res.status)
      .sort();
    expect(statuses).toEqual([202, 409]);
    expect(
      await getPrismaClient().backupRestoreJob.count({
        where: { status: { in: ["queued", "running"] } },
      }),
    ).toBe(1);
  });

  it("picks up a restore a stopped worker left running, and stops after the second time", async () => {
    const admin = await seedAdmin();
    await seedMeasurements(admin.id, ["live-1"]);
    const backup = await storeBackup(admin.id, ["m-a", "m-b"]);
    const prisma = getPrismaClient();

    const queued = await requestRestore(backup.id);
    const { data } = (await queued.json()) as { data: { jobId: string } };

    // What a worker that died mid-restore leaves behind: the row says running,
    // its heartbeat stopped minutes ago, the transaction rolled back with the
    // process, so the account is untouched.
    const stale = new Date(Date.now() - 10 * 60_000);
    await prisma.backupRestoreJob.update({
      where: { id: data.jobId },
      data: {
        status: "running",
        phase: "measurements",
        attempts: 1,
        heartbeatAt: stale,
        startedAt: stale,
      },
    });

    // A page reloaded now finds the job and keeps polling it.
    expect((await listStatus()).data.jobs).toEqual([
      expect.objectContaining({ id: data.jobId, status: "running" }),
    ]);

    const swept = await sweepInterruptedRestores(queue.boss);
    expect(swept).toEqual({ requeued: 1, failed: 0 });
    // The delivery the dead worker held is finished, not left to time out.
    expect(queue.completed).toEqual(["boss-1"]);
    expect(queue.sent.at(-1)).toEqual({
      queue: BACKUP_RESTORE_QUEUE,
      data: { restoreJobId: data.jobId },
    });
    expect((await readBackupRestoreJob(data.jobId))?.status).toBe("queued");

    await runBackupRestoreJob(data.jobId);
    const resumed = await readBackupRestoreJob(data.jobId);
    expect(resumed?.status).toBe("succeeded");
    expect(resumed?.attempts).toBe(2);
    expect(await measurementIdsOf(admin.id)).toEqual(["m-a", "m-b"]);

    // A job that has already been started the maximum number of times fails
    // instead of being queued a third time.
    const again = await requestRestore(backup.id);
    const { data: next } = (await again.json()) as { data: { jobId: string } };
    await prisma.backupRestoreJob.update({
      where: { id: next.jobId },
      data: {
        status: "running",
        attempts: BACKUP_RESTORE_MAX_ATTEMPTS,
        heartbeatAt: stale,
      },
    });
    expect(await sweepInterruptedRestores(queue.boss)).toEqual({
      requeued: 0,
      failed: 1,
    });
    const gaveUp = await readBackupRestoreJob(next.jobId);
    expect(gaveUp?.status).toBe("failed");
    expect(gaveUp?.failure?.code).toBe("interrupted");
  });

  it("never runs a committed restore again when its worker stopped in the rebuild", async () => {
    const admin = await seedAdmin();
    const backup = await storeBackup(admin.id, ["m-a", "m-b"]);
    const prisma = getPrismaClient();

    // Run the restore for real, so the commit marker is written by the code
    // that writes it, then put the row back the way a worker that died in the
    // rollup rebuild leaves it: running, phase rebuilding, heartbeat stale.
    const queued = await requestRestore(backup.id);
    const { data } = (await queued.json()) as { data: { jobId: string } };
    await runBackupRestoreJob(data.jobId);
    const committed = await prisma.backupRestoreJob.findUniqueOrThrow({
      where: { id: data.jobId },
    });
    expect(committed.committedAt).not.toBeNull();
    const stale = new Date(Date.now() - 10 * 60_000);
    await prisma.backupRestoreJob.update({
      where: { id: data.jobId },
      data: {
        status: "running",
        phase: "rebuilding",
        heartbeatAt: stale,
        completedAt: null,
        result: undefined,
      },
    });
    // A reading the person logged after the restore committed.
    await seedMeasurements(admin.id, ["after-commit"]);

    expect(await sweepInterruptedRestores(queue.boss)).toEqual({
      requeued: 0,
      failed: 1,
    });
    const job = await readBackupRestoreJob(data.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure?.code).toBe("failed_after_commit");
    expect(job?.failure?.message).not.toContain("Nothing was changed");
    // Not queued again, so the reading from after the commit survives.
    expect(
      queue.sent.filter(
        (entry) =>
          (entry.data as { restoreJobId?: string }).restoreJobId === data.jobId,
      ),
    ).toHaveLength(1);
    expect(await measurementIdsOf(admin.id)).toEqual([
      "after-commit",
      "m-a",
      "m-b",
    ]);
  });

  it("the admission check closes a committed stale job as restored, not rolled back", async () => {
    const admin = await seedAdmin();
    const backup = await storeBackup(admin.id, ["m-a"]);
    const prisma = getPrismaClient();
    const queued = await requestRestore(backup.id);
    const { data } = (await queued.json()) as { data: { jobId: string } };
    const stale = new Date(Date.now() - 10 * 60_000);
    await prisma.backupRestoreJob.update({
      where: { id: data.jobId },
      data: {
        status: "running",
        phase: "rebuilding",
        attempts: 1,
        heartbeatAt: stale,
        committedAt: stale,
      },
    });

    expect((await requestRestore(backup.id)).status).toBe(202);
    const job = await readBackupRestoreJob(data.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure?.code).toBe("failed_after_commit");
  });

  it("dates a medication from a file without a creation date by its earliest dose", async () => {
    const admin = await seedAdmin();
    const prisma = getPrismaClient();
    // A portable file from before v1.39.1: no medication createdAt.
    const payload = backupPayloadSchema.parse({
      schemaVersion: "1",
      exportedAt: "2026-09-20T00:00:00.000Z",
      userId: admin.id,
      medications: [{ name: "Ramipril", dose: "5mg", schedules: [] }],
      intakeEvents: [
        {
          medication: "Ramipril",
          scheduledFor: "2025-03-10T08:00:00.000Z",
          takenAt: "2025-03-10T08:04:00.000Z",
        },
        {
          medication: "Ramipril",
          scheduledFor: "2025-03-09T08:00:00.000Z",
          autoMissed: true,
        },
      ],
    });
    const backup = await prisma.dataBackup.create({
      data: {
        userId: admin.id,
        type: "MANUAL_UPLOAD_OLD_PORTABLE",
        data: encrypt(JSON.stringify(payload)),
      },
    });
    const queued = await requestRestore(backup.id);
    const { data } = (await queued.json()) as { data: { jobId: string } };
    await runBackupRestoreJob(data.jobId);
    expect((await readBackupRestoreJob(data.jobId))?.status).toBe("succeeded");

    const medication = await prisma.medication.findFirstOrThrow({
      where: { userId: admin.id },
    });
    // Not the restore time: the dose history reads this as the day the
    // medication began, and every miss before it would vanish.
    expect(medication.createdAt.toISOString()).toBe("2025-03-09T08:00:00.000Z");
  });

  it("a live job's heartbeat keeps it out of the sweep", async () => {
    const admin = await seedAdmin();
    const backup = await storeBackup(admin.id, ["m-a"]);
    const queued = await requestRestore(backup.id);
    const { data } = (await queued.json()) as { data: { jobId: string } };
    await getPrismaClient().backupRestoreJob.update({
      where: { id: data.jobId },
      data: { status: "running", attempts: 1, heartbeatAt: new Date() },
    });

    expect(await sweepInterruptedRestores(queue.boss)).toEqual({
      requeued: 0,
      failed: 0,
    });
    expect((await readBackupRestoreJob(data.jobId))?.status).toBe("running");
    // And a second request for the account is still refused while it runs.
    expect((await requestRestore(backup.id)).status).toBe(409);
  });

  it("does not restore a copy that was replaced while the job waited", async () => {
    const admin = await seedAdmin();
    await seedMeasurements(admin.id, ["live-1"]);
    const backup = await storeBackup(admin.id, ["m-a"]);
    const queued = await requestRestore(backup.id);
    const { data } = (await queued.json()) as { data: { jobId: string } };

    // The weekly job overwrites its row in place.
    await getPrismaClient().dataBackup.update({
      where: { id: backup.id },
      data: {
        data: encrypt(JSON.stringify(payloadFor(admin.id, ["m-newer"]))),
      },
    });

    const persisted = await runJob(
      BACKUP_RESTORE_QUEUE,
      handleBackupRestore,
    )([
      {
        id: "boss-1",
        name: BACKUP_RESTORE_QUEUE,
        data: { restoreJobId: data.jobId },
        expireInSeconds: 7200,
        signal: new AbortController().signal,
      } as never,
    ]);
    // A refusal is the job doing what it was asked, not a crash.
    expect(persisted).toEqual({ ok: true, did: { refused: "backup_changed" } });
    const job = await readBackupRestoreJob(data.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure?.code).toBe("backup_changed");
    expect(await measurementIdsOf(admin.id)).toEqual(["live-1"]);
  });

  it("refuses, before deleting anything, a file that would outlast the job's budget", async () => {
    const admin = await seedAdmin();
    await seedMeasurements(admin.id, ["live-1"]);
    const backup = await storeBackup(admin.id, ["m-a"]);
    const queued = await requestRestore(backup.id);
    const { data } = (await queued.json()) as { data: { jobId: string } };

    // A deadline one minute out: shorter than the transaction's own
    // two-minute floor, so the restore cannot promise to finish in time.
    await runBackupRestoreJob(data.jobId, { deadline: Date.now() + 60_000 });
    const job = await readBackupRestoreJob(data.jobId);
    expect(job?.status).toBe("failed");
    expect(job?.failure?.code).toBe("time_budget");
    expect(await measurementIdsOf(admin.id)).toEqual(["live-1"]);
  });
});
