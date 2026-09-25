/**
 * Backup restores as a background job.
 *
 * A restore used to run inside `POST /api/admin/backups/[id]/restore`. On an
 * account of 1.25 million readings that request took about a minute and a
 * half, and a reverse proxy that cuts a request at 60 s (nginx's default)
 * showed the operator an error for a restore that went on to finish on the
 * server. So the request now does only what is quick: it checks the stored copy
 * opens, admits one job for the account (`admitBackupRestore`) and answers 202.
 * This queue runs the restore (`restoreBackup`, unchanged in what it checks and
 * writes) and records its progress and its outcome on the job's row, which
 * `GET /api/admin/backups/restores/{id}` reads back.
 *
 * What stays true from the synchronous restore:
 *
 *   - Every check still happens before the first delete, and the replacement
 *     is still one transaction. A job that fails before the commit leaves the
 *     account as it was. After the commit only the rollup rebuild remains,
 *     and a job that fails there says the data was restored
 *     (`failed_after_commit`).
 *   - While it runs, the account keeps reading its current data: nothing the
 *     transaction writes is visible to anyone until it commits. Other writes
 *     to the account are not refused, exactly as before. A new row (a reading
 *     that arrives mid-restore) is written at once and stays next to the
 *     restored ones. A write that updates or deletes a row the restore has
 *     already deleted waits on that row's lock until the restore commits or
 *     rolls back, and then finds the row gone or back.
 *
 * What the job adds:
 *
 *   - One restore per account at a time. The job table's partial unique index
 *     refuses a second queued or running row for the same account, and the
 *     route answers that with 409.
 *   - A time budget. The job's expiry is two hours; `restoreBackup` refuses,
 *     before deleting anything, a file whose transaction limit would run past
 *     three quarters of it (`jobDeadline`), the same share the other long
 *     passes stop at. pg-boss does not retry the job (`retryLimit: 0`): a
 *     restore that failed on its checks fails the same way again.
 *   - Resuming after a restart. The job writes a heartbeat every few seconds.
 *     A worker that stops mid-restore rolls the transaction back with it, and
 *     the boot sweep finds the row whose heartbeat went stale and queues it
 *     again from the start. A job is started at most
 *     {@link BACKUP_RESTORE_MAX_ATTEMPTS} times, so an interrupted restore is
 *     restarted once; the second interruption fails it. A job whose
 *     transaction had already committed (`committedAt`) is never restarted:
 *     a second run would delete what the account gained since. The stored
 *     copy it reads is the
 *     `DataBackup` row, which stays where it is whatever happens, so no retry
 *     ever needs the file again.
 */
import { createHash } from "node:crypto";

import type { Job, PgBoss } from "pg-boss";
import { z } from "zod/v4";

import { invalidateUserData } from "@/lib/cache/invalidate";
import { prisma, toJson } from "@/lib/db";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDeadline } from "@/lib/jobs/job-budget";
import { reportJobProgress } from "@/lib/jobs/job-observer";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import { annotate } from "@/lib/logging/context";
import { isP2002 } from "@/lib/prisma-errors";
import {
  restoreBackup,
  RESTORE_SECTION_STEPS,
  type RestoreFailureCode,
  type RestorePhase,
  type RestoreProgress,
} from "@/lib/export/restore-backup";

export const BACKUP_RESTORE_QUEUE = "backup-restore";

/** Stable code of the 409 a second restore of the same account gets. */
export const BACKUP_RESTORE_ACTIVE_CODE = "backup.restore.active";

/**
 * Two hours. The restore of 1.25 million readings took a minute and a half;
 * the limit is sized so a record many times that still fits, while a job whose
 * worker died does not keep its pg-boss row active for longer than an operator
 * would wait.
 */
export const BACKUP_RESTORE_EXPIRE_SECONDS = 2 * 60 * 60;

export const BACKUP_RESTORE_SEND_OPTIONS = {
  retryLimit: 0,
  expireInSeconds: BACKUP_RESTORE_EXPIRE_SECONDS,
} as const;

/** How often a running job writes its progress and heartbeat. */
export const BACKUP_RESTORE_PROGRESS_WRITE_MS = 2_000;

/** A running job whose heartbeat is older than this has lost its worker. */
export const BACKUP_RESTORE_STALE_AFTER_MS = 2 * 60_000;

/** A queued job nobody picked up in this long is reported as not started. */
export const BACKUP_RESTORE_UNCLAIMED_AFTER_MS = 60 * 60_000;

/** Starts a job may have before an interrupted one is failed, not re-queued. */
export const BACKUP_RESTORE_MAX_ATTEMPTS = 2;

/** Finished jobs older than this are deleted when the account restores again. */
export const BACKUP_RESTORE_RETENTION_DAYS = 30;

export type BackupRestorePayload = { restoreJobId: string } | { sweep: true };

export type BackupRestoreStatus = "queued" | "running" | "succeeded" | "failed";

/** Every reason a job can end in `failed`, as a stable code. */
export type BackupRestoreFailureCode =
  RestoreFailureCode | "not_started" | "enqueue_failed" | "failed_after_commit";

export interface BackupRestoreFailure {
  code: BackupRestoreFailureCode;
  message: string;
  /** The sections a file's manifest names and it does not carry. */
  sections?: string[];
}

const failureSchema = z.object({
  code: z.string(),
  message: z.string(),
  sections: z.array(z.string()).optional(),
});

const progressSchema = z.object({
  measurementsChecked: z.number().int().nonnegative(),
  measurementsTotal: z.number().int().nonnegative().nullable(),
  measurementsWritten: z.number().int().nonnegative(),
  sectionsDone: z.number().int().nonnegative(),
  sectionsTotal: z.number().int().nonnegative(),
});

const resultSchema = z.object({
  summary: z.record(z.string(), z.unknown()),
  skipped: z.object({
    links: z.number().int(),
    catalogueKeys: z.array(
      z.object({
        catalogue: z.string(),
        key: z.string(),
        links: z.number().int(),
      }),
    ),
  }),
  cleared: z.record(z.string(), z.number()),
});

export type BackupRestoreResult = z.infer<typeof resultSchema>;

/** What the status routes answer with. Counts and codes, never content. */
export interface BackupRestoreJobView {
  id: string;
  userId: string;
  username: string | null;
  backupId: string;
  restoreInstanceSettings: boolean;
  status: BackupRestoreStatus;
  phase: RestorePhase | null;
  progress: RestoreProgress | null;
  result: BackupRestoreResult | null;
  failure: BackupRestoreFailure | null;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

const PHASES: readonly RestorePhase[] = [
  "validating",
  "clearing",
  "measurements",
  "sections",
  "rebuilding",
];
const STATUSES: readonly BackupRestoreStatus[] = [
  "queued",
  "running",
  "succeeded",
  "failed",
];

/**
 * A failure code as a job fact. Job facts are lower-case words joined by
 * underscores (`job-outcome.ts`), and two of the restore's codes are the
 * dotted envelope codes the console branches on.
 */
export function jobFactCode(code: BackupRestoreFailureCode): string {
  return code.replace(/\./g, "_");
}

/** SHA-256 of a stored copy, to tell whether it changed while a job waited. */
export function backupDigest(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

const viewSelect = {
  id: true,
  userId: true,
  backupId: true,
  restoreInstanceSettings: true,
  status: true,
  phase: true,
  progress: true,
  result: true,
  failure: true,
  attempts: true,
  createdAt: true,
  startedAt: true,
  completedAt: true,
  user: { select: { username: true } },
} as const;

type ViewRow = {
  id: string;
  userId: string;
  backupId: string;
  restoreInstanceSettings: boolean;
  status: string;
  phase: string | null;
  progress: unknown;
  result: unknown;
  failure: unknown;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  user: { username: string } | null;
};

function toView(row: ViewRow): BackupRestoreJobView {
  const status = (STATUSES as readonly string[]).includes(row.status)
    ? (row.status as BackupRestoreStatus)
    : "failed";
  const phase =
    row.phase && (PHASES as readonly string[]).includes(row.phase)
      ? (row.phase as RestorePhase)
      : null;
  const progress = progressSchema.safeParse(row.progress);
  const result = resultSchema.safeParse(row.result);
  const failure = failureSchema.safeParse(row.failure);
  return {
    id: row.id,
    userId: row.userId,
    username: row.user?.username ?? null,
    backupId: row.backupId,
    restoreInstanceSettings: row.restoreInstanceSettings,
    status,
    phase: status === "running" ? phase : null,
    progress: progress.success ? progress.data : null,
    result: result.success ? result.data : null,
    failure: failure.success
      ? (failure.data as BackupRestoreFailure)
      : status === "failed"
        ? { code: "unexpected", message: "The restore failed." }
        : null,
    attempts: row.attempts,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

/** One job, for the status route. Null when the id is unknown. */
export async function readBackupRestoreJob(
  id: string,
): Promise<BackupRestoreJobView | null> {
  const row = await prisma.backupRestoreJob.findUnique({
    where: { id },
    select: viewSelect,
  });
  return row ? toView(row) : null;
}

/**
 * The jobs the console shows: every queued or running one, and the finished
 * ones of the last day, newest first. What a reload of the page needs to pick
 * up a restore it was watching, and to show how the last one ended.
 */
export async function listRecentBackupRestoreJobs(
  now: Date = new Date(),
): Promise<BackupRestoreJobView[]> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const rows = await prisma.backupRestoreJob.findMany({
    where: {
      OR: [
        { status: { in: ["queued", "running"] } },
        { createdAt: { gte: since } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: viewSelect,
  });
  return rows.map(toView);
}

function failureJson(failure: BackupRestoreFailure) {
  return toJson({
    code: failure.code,
    message: failure.message,
    ...(failure.sections ? { sections: failure.sections } : {}),
  });
}

const INTERRUPTED: BackupRestoreFailure = {
  code: "interrupted",
  message:
    "The restore stopped when the server restarted and was rolled back. Nothing was changed, and the backup is kept: start the restore again. If it stops again, the server likely ran out of memory.",
};

/**
 * A job that stopped after its transaction committed. The account holds the
 * restored data, so saying "nothing was changed" would be false, and running
 * the restore again would delete whatever the account gained since. What did
 * not finish is the rebuild of the chart tiers, which the nightly and boot
 * passes rebuild on their own.
 */
const FAILED_AFTER_COMMIT: BackupRestoreFailure = {
  code: "failed_after_commit",
  message:
    "The data was restored, but a step after it did not finish, so charts and summaries may take until the next nightly run to catch up. The restore is not run again, so nothing written since is lost.",
};

const NOT_STARTED: BackupRestoreFailure = {
  code: "not_started",
  message:
    "The background worker did not pick the restore up. Nothing was changed. Check that the worker is running, then start the restore again.",
};

/**
 * Fail the account's jobs that can no longer finish, so they stop holding the
 * one-per-account slot: a running job whose worker is gone, and a queued job
 * nobody picked up. Also deletes finished jobs past retention.
 */
async function releaseAbandonedJobs(userId: string, now: Date): Promise<void> {
  const staleBefore = new Date(now.getTime() - BACKUP_RESTORE_STALE_AFTER_MS);
  const unclaimedBefore = new Date(
    now.getTime() - BACKUP_RESTORE_UNCLAIMED_AFTER_MS,
  );
  const stale = {
    userId,
    status: "running",
    OR: [{ heartbeatAt: { lt: staleBefore } }, { heartbeatAt: null }],
  };
  // Committed first: those changed the account and are closed as such.
  const afterCommit = await prisma.backupRestoreJob.updateMany({
    where: { ...stale, committedAt: { not: null } },
    data: {
      status: "failed",
      phase: null,
      failure: failureJson(FAILED_AFTER_COMMIT),
      completedAt: now,
    },
  });
  if (afterCommit.count > 0) invalidateUserData(userId);
  await prisma.backupRestoreJob.updateMany({
    where: { ...stale, committedAt: null },
    data: {
      status: "failed",
      phase: null,
      failure: failureJson(INTERRUPTED),
      completedAt: now,
    },
  });
  await prisma.backupRestoreJob.updateMany({
    where: { userId, status: "queued", createdAt: { lt: unclaimedBefore } },
    data: {
      status: "failed",
      failure: failureJson(NOT_STARTED),
      completedAt: now,
    },
  });
  await prisma.backupRestoreJob.deleteMany({
    where: {
      userId,
      status: { in: ["succeeded", "failed"] },
      createdAt: {
        lt: new Date(
          now.getTime() - BACKUP_RESTORE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
    },
  });
}

export type BackupRestoreAdmission =
  | { admitted: true; jobId: string }
  | { admitted: false; reason: "active"; activeJobId: string | null }
  | { admitted: false; reason: "enqueue_failed"; jobId: string };

/**
 * Admit one restore of `backupId` over `userId`'s record and queue it.
 *
 * The partial unique index decides whether another restore of the account is
 * already queued or running, so two requests arriving together cannot both
 * pass a check and both insert.
 */
export async function admitBackupRestore(input: {
  userId: string;
  actorUserId: string;
  backupId: string;
  backupDigest: string;
  restoreInstanceSettings: boolean;
  boss?: PgBoss | null;
}): Promise<BackupRestoreAdmission> {
  const now = new Date();
  await releaseAbandonedJobs(input.userId, now);

  let jobId: string;
  try {
    const created = await prisma.backupRestoreJob.create({
      data: {
        userId: input.userId,
        actorUserId: input.actorUserId,
        backupId: input.backupId,
        backupDigest: input.backupDigest,
        restoreInstanceSettings: input.restoreInstanceSettings,
        status: "queued",
      },
      select: { id: true },
    });
    jobId = created.id;
  } catch (err) {
    if (!isP2002(err)) throw err;
    const active = await prisma.backupRestoreJob.findFirst({
      where: { userId: input.userId, status: { in: ["queued", "running"] } },
      select: { id: true },
    });
    return {
      admitted: false,
      reason: "active",
      activeJobId: active?.id ?? null,
    };
  }

  const boss = input.boss === undefined ? getGlobalBoss() : input.boss;
  try {
    if (!boss) throw new Error("worker unavailable");
    const bossJobId = await boss.send(
      BACKUP_RESTORE_QUEUE,
      { restoreJobId: jobId } satisfies BackupRestorePayload,
      BACKUP_RESTORE_SEND_OPTIONS,
    );
    if (!bossJobId) throw new Error("queue rejected job");
    await prisma.backupRestoreJob.update({
      where: { id: jobId },
      data: { pgBossJobId: bossJobId },
    });
    return { admitted: true, jobId };
  } catch {
    // Written but never queued: fail it here, or it holds the account's slot
    // until the unclaimed window runs out.
    await prisma.backupRestoreJob.update({
      where: { id: jobId },
      data: {
        status: "failed",
        failure: failureJson({
          code: "enqueue_failed",
          message:
            "The restore could not be handed to the background worker. Nothing was changed. Check that the worker is running, then start the restore again.",
        }),
        completedAt: new Date(),
      },
    });
    return { admitted: false, reason: "enqueue_failed", jobId };
  }
}

/**
 * Run one queued restore job to its end. Exported for the tests, which drive
 * the queue without a pg-boss worker.
 */
export async function runBackupRestoreJob(
  restoreJobId: string,
  options: { deadline?: number } = {},
): Promise<JobOutcome> {
  const row = await prisma.backupRestoreJob.findUnique({
    where: { id: restoreJobId },
  });
  if (!row || row.status !== "queued") {
    // Already taken by another delivery, finished, or failed by the admission
    // check while it waited. There is nothing for this delivery to do.
    return jobDone({ restore_claimed: false });
  }
  const startedAt = new Date();
  const claimed = await prisma.backupRestoreJob.updateMany({
    where: { id: row.id, status: "queued" },
    data: {
      status: "running",
      phase: "validating",
      attempts: { increment: 1 },
      heartbeatAt: startedAt,
      startedAt: row.startedAt ?? startedAt,
    },
  });
  if (claimed.count === 0) return jobDone({ restore_claimed: false });
  annotate({
    meta: {
      restore_job_id: row.id,
      restore_owner_id: row.userId,
      restore_attempt: row.attempts + 1,
    },
  });

  let phase: RestorePhase = "validating";
  let progress: RestoreProgress = {
    measurementsChecked: 0,
    measurementsTotal: null,
    measurementsWritten: 0,
    sectionsDone: 0,
    sectionsTotal: RESTORE_SECTION_STEPS.length,
  };
  let writing: Promise<unknown> | null = null;
  const writeProgress = () => {
    if (writing) return;
    writing = prisma.backupRestoreJob
      .updateMany({
        where: { id: row.id, status: "running" },
        data: { phase, progress: toJson(progress), heartbeatAt: new Date() },
      })
      .catch(() => undefined)
      .finally(() => {
        writing = null;
      });
  };
  // A timer, not only the progress callback: a single long statement (the
  // delete of a million readings) reports nothing for a while, and the
  // heartbeat must not go stale while it runs.
  const timer = setInterval(writeProgress, BACKUP_RESTORE_PROGRESS_WRITE_MS);
  timer.unref?.();

  // Set once the transaction has committed (see `onCommitted` below).
  let committed = false;
  const finish = async (
    status: "succeeded" | "failed",
    data: { result?: BackupRestoreResult; failure?: BackupRestoreFailure },
  ) => {
    clearInterval(timer);
    if (writing) await writing;
    const completedAt = new Date();
    await prisma.backupRestoreJob.updateMany({
      where: { id: row.id, status: "running" },
      data: {
        status,
        phase: null,
        progress: toJson(progress),
        ...(data.result ? { result: toJson(data.result) } : {}),
        ...(data.failure ? { failure: failureJson(data.failure) } : {}),
        heartbeatAt: completedAt,
        completedAt,
      },
    });
  };

  try {
    const backup = await prisma.dataBackup.findUnique({
      where: { id: row.backupId },
      select: { id: true, userId: true, data: true },
    });
    if (!backup || backup.userId !== row.userId) {
      await finish("failed", {
        failure: {
          code: "backup_not_found",
          message:
            "The backup was deleted before the restore could read it. Nothing was changed.",
        },
      });
      return jobDone({ refused: "backup_not_found" });
    }
    if (backupDigest(backup.data) !== row.backupDigest) {
      await finish("failed", {
        failure: {
          code: "backup_changed",
          message:
            "The backup was replaced by a newer copy while the restore waited. Nothing was changed. Check the new copy, then start the restore again.",
        },
      });
      return jobDone({ refused: "backup_changed" });
    }

    const outcome = await restoreBackup({
      backup,
      actorUserId: row.actorUserId,
      ipAddress: null,
      restoreInstanceSettings: row.restoreInstanceSettings,
      deadline: options.deadline,
      onCommitted: async () => {
        committed = true;
        const committedAt = new Date();
        await prisma.backupRestoreJob.updateMany({
          where: { id: row.id, status: "running" },
          data: { committedAt, phase: "rebuilding", heartbeatAt: committedAt },
        });
      },
      progress: (nextPhase, nextProgress) => {
        const phaseChanged = nextPhase !== phase;
        phase = nextPhase;
        progress = nextProgress;
        reportJobProgress({
          phase,
          measurements_written: progress.measurementsWritten,
          sections_done: progress.sectionsDone,
        });
        if (phaseChanged) writeProgress();
      },
    });

    if (outcome.ok) {
      const { summary, skipped, cleared } = outcome.response;
      await finish("succeeded", {
        result: {
          summary: { ...summary },
          skipped,
          cleared,
        },
      });
      return jobDone({
        restore_measurements: Number(summary.measurements ?? 0),
        restore_skipped_links: skipped.links,
      });
    }

    const sections = Array.isArray(outcome.meta?.sections)
      ? (outcome.meta.sections as unknown[]).map(String)
      : undefined;
    await finish("failed", {
      failure: {
        code: outcome.code,
        message: outcome.message,
        ...(sections ? { sections } : {}),
      },
    });
    // A file refused by its checks is the operator's to fix and fails the
    // same way on every try; the job did what it was asked. A transaction
    // that could not be written is a fault, and is reported as one.
    return outcome.status >= 500 && outcome.code === "transaction_failed"
      ? jobFailed("restore_transaction_failed")
      : jobDone({ refused: jobFactCode(outcome.code) });
  } catch (err) {
    // After the commit the data is restored and only a step after it
    // failed, which the message has to say.
    await finish("failed", {
      failure: committed
        ? FAILED_AFTER_COMMIT
        : {
            code: "unexpected",
            message:
              "The restore stopped on an unexpected error and was rolled back. Nothing was changed, and the backup is kept. The server log names the error.",
          },
    }).catch(() => undefined);
    if (committed) invalidateUserData(row.userId);
    throw err;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Re-queue the restores a stopped worker left running, or fail them once they
 * have been started {@link BACKUP_RESTORE_MAX_ATTEMPTS} times. The restore is
 * one transaction, so a job whose worker died was rolled back with it and
 * starts again from the beginning; there is no half-written account to finish.
 */
export async function sweepInterruptedRestores(
  boss: PgBoss | null = getGlobalBoss(),
  now: Date = new Date(),
): Promise<{ requeued: number; failed: number }> {
  const staleBefore = new Date(now.getTime() - BACKUP_RESTORE_STALE_AFTER_MS);
  const rows = await prisma.backupRestoreJob.findMany({
    where: {
      status: "running",
      OR: [{ heartbeatAt: { lt: staleBefore } }, { heartbeatAt: null }],
    },
    select: {
      id: true,
      userId: true,
      attempts: true,
      pgBossJobId: true,
      heartbeatAt: true,
      committedAt: true,
    },
  });
  let requeued = 0;
  let failed = 0;
  for (const row of rows) {
    // The delivery the dead worker held stays active in pg-boss until its
    // expiry and would then read as a timed-out job. It is superseded.
    if (boss && row.pgBossJobId) {
      await boss
        .complete(BACKUP_RESTORE_QUEUE, row.pgBossJobId, { superseded: true })
        .catch(() => undefined);
    }
    const guard = {
      id: row.id,
      status: "running",
      heartbeatAt: row.heartbeatAt,
    };
    // Committed: the account already holds the restored data. Running the
    // restore again would delete what it gained since, so it is closed.
    if (row.committedAt) {
      const done = await prisma.backupRestoreJob.updateMany({
        where: guard,
        data: {
          status: "failed",
          phase: null,
          failure: failureJson(FAILED_AFTER_COMMIT),
          completedAt: now,
        },
      });
      if (done.count > 0) invalidateUserData(row.userId);
      failed += done.count;
      continue;
    }
    if (!boss || row.attempts >= BACKUP_RESTORE_MAX_ATTEMPTS) {
      const done = await prisma.backupRestoreJob.updateMany({
        where: guard,
        data: {
          status: "failed",
          phase: null,
          failure: failureJson(INTERRUPTED),
          completedAt: now,
        },
      });
      failed += done.count;
      continue;
    }
    const reset = await prisma.backupRestoreJob.updateMany({
      where: guard,
      data: { status: "queued", phase: null, progress: toJson({}) },
    });
    if (reset.count === 0) continue;
    try {
      const bossJobId = await boss.send(
        BACKUP_RESTORE_QUEUE,
        { restoreJobId: row.id } satisfies BackupRestorePayload,
        BACKUP_RESTORE_SEND_OPTIONS,
      );
      if (!bossJobId) throw new Error("queue rejected job");
      await prisma.backupRestoreJob.update({
        where: { id: row.id },
        data: { pgBossJobId: bossJobId },
      });
      requeued += 1;
    } catch {
      await prisma.backupRestoreJob.updateMany({
        where: { id: row.id, status: "queued" },
        data: {
          status: "failed",
          failure: failureJson(INTERRUPTED),
          completedAt: now,
        },
      });
      failed += 1;
    }
  }
  return { requeued, failed };
}

/**
 * Queue the sweep for after a stopped worker's heartbeat has gone stale. Sent
 * at worker boot: a job the previous process was running still has a fresh
 * heartbeat at that moment, and would otherwise be taken for a live one.
 */
export async function enqueueBackupRestoreSweepAtBoot(
  boss: PgBoss,
): Promise<void> {
  try {
    await boss.send(
      BACKUP_RESTORE_QUEUE,
      { sweep: true } satisfies BackupRestorePayload,
      { startAfter: Math.ceil(BACKUP_RESTORE_STALE_AFTER_MS / 1000) + 15 },
    );
  } catch {
    // The admission check fails an abandoned job the next time the account
    // is restored, so a missed sweep costs a retry, not a stuck account.
  }
}

/** The queue's handler. */
export async function handleBackupRestore(
  jobs: Job<BackupRestorePayload>[],
): Promise<JobOutcome> {
  // pg-boss hands this queue one job at a time (no batch size is set), and a
  // single job's own facts are what its row in pg-boss should keep. A batch
  // reports the first failure, or how many it ran.
  let failure: JobOutcome | null = null;
  let last: JobOutcome = jobDone({ jobs: 0 });
  for (const job of jobs) {
    const outcome = await withBackgroundEvent(
      "job.backup_restore",
      async () => {
        if (!("sweep" in job.data)) {
          return runBackupRestoreJob(job.data.restoreJobId, {
            deadline: jobDeadline(job),
          });
        }
        const swept = await sweepInterruptedRestores();
        return jobDone({
          restore_requeued: swept.requeued,
          restore_failed: swept.failed,
        });
      },
    );
    last = outcome;
    if (!outcome.ok && failure === null) failure = outcome;
  }
  if (jobs.length === 1) return last;
  return failure ?? jobDone({ jobs: jobs.length });
}

/**
 * Evict the restored account's server caches in the process serving the
 * console.
 *
 * The job evicts them in the worker's process when the restore commits. In a
 * deployment that runs the worker apart from the web server
 * (`HEALTHLOG_PROCESS_TYPE=web` beside an `app-worker`), those are different
 * processes, and the web process would keep serving the account's pre-restore
 * dashboard until its caches aged out. The first time this process reports a
 * finished restore, it evicts them itself. Once per job per process; a second
 * eviction would only cost the next reader a cache miss.
 */
const evictedRestoreJobs = new Set<string>();

export function evictAfterRestore(job: BackupRestoreJobView): void {
  if (job.status !== "succeeded" && job.status !== "failed") return;
  if (evictedRestoreJobs.has(job.id)) return;
  evictedRestoreJobs.add(job.id);
  // A failed restore after its commit (`failed_after_commit`) changed the data
  // too; any other failure changed nothing, and evicting costs one cache miss.
  if (
    job.status === "succeeded" ||
    job.failure?.code === "failed_after_commit"
  ) {
    invalidateUserData(job.userId);
  }
}
