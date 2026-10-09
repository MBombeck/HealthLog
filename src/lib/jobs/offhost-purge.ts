/**
 * Off-host copies leave the bucket with the account.
 *
 * The nightly job writes `<YYYY-MM-DD>/user-<id>.json.enc` for every account,
 * and until v1.39.3 nothing ever removed one: deleting an account, or wiping
 * its data, took the rows in this database and left every nightly copy of the
 * record in the operator's bucket for as long as its lifecycle rule kept them,
 * or forever where no rule was set. A confirmation that says "permanently
 * delete" has to mean the off-host copies too.
 *
 * How. The deletion writes an `OffhostPurgeRequest` in its own transaction, so
 * the request exists exactly when the deletion committed. This job then lists
 * the bucket once, deletes every object of every pending account, and removes
 * the request when nothing of the account is left. A request the bucket
 * refuses (a credential without DeleteObject, an outage) stays, counts its
 * attempts and keeps the bucket's answer, which the admin off-host card shows;
 * the job runs again every night and after every nightly upload, so a late
 * copy the upload wrote for an account deleted while it ran is caught too.
 *
 * A wiped account keeps its request until a nightly run has walked it since
 * the wipe. The upload that was in flight when the data went reads the
 * request to know its copy is from before the wipe; removing the request on
 * the first purge let that copy land afterwards and stay. Until then each
 * purge removes only the copies dated up to the wipe's day, so the copy of
 * what the account holds after the wipe is left alone.
 *
 * The admin wipe of every account writes no request, on purpose: it is the
 * operator clearing their own host, the bucket is theirs, and its copies are
 * the documented way back from a wipe pressed by mistake. The health-check
 * probes and anything else in the bucket that is not an account object is
 * never touched.
 */
import type { Job } from "pg-boss";

import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { auditLog } from "@/lib/auth/audit";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import {
  getS3Client,
  loadOffhostConfig,
  offhostBackupConfigured,
  type S3Like,
} from "@/lib/jobs/offhost-backup";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { getWorkerPrisma } from "@/lib/jobs/reminder/shared";
import { withBackgroundEvent } from "@/lib/logging/background";
import { logCaught } from "@/lib/logging/signal";

export const OFFHOST_PURGE_QUEUE = "offhost-backup-purge";
/** 03:40, after the nightly upload (02:30) has had its hour. */
export const OFFHOST_PURGE_CRON = "40 3 * * *";

export type OffhostPurgeReason =
  "account_deleted" | "data_wiped" | "managed_profile_deleted";

/** An account object: `<date>/user-<id>.json.enc`. */
const ACCOUNT_OBJECT = /^\d{4}-\d{2}-\d{2}\/user-(.+)\.json\.enc$/;

/** Requests one run works through; the next run takes the rest. */
const REQUESTS_PER_RUN = 200;

/** Deletes one run may issue, so a huge bucket cannot run the job forever. */
const MAX_DELETES_PER_RUN = 50_000;

type Db = Pick<Prisma.TransactionClient, "offhostPurgeRequest">;

type PurgeDb = Pick<
  PrismaClient,
  "offhostPurgeRequest" | "offhostBackupState" | "user"
>;

/**
 * Record that `subjectId`'s off-host copies have to go. Call it with the
 * transaction that deletes the account or wipes its data, so the request and
 * the deletion commit together. A host without off-host backup configured has
 * nothing in any bucket this could reach, and records nothing.
 */
export async function requestOffhostPurge(
  db: Db,
  subjectId: string,
  reason: OffhostPurgeReason,
): Promise<boolean> {
  if (!offhostBackupConfigured()) return false;
  await db.offhostPurgeRequest.create({
    data: { subjectId, reason },
    select: { id: true },
  });
  return true;
}

/**
 * Wake the purge job now rather than at its nightly slot. Best effort: the
 * request row is what guarantees the purge, and the cron picks it up if the
 * queue is not reachable from here.
 */
export async function kickOffhostPurge(): Promise<void> {
  try {
    await getGlobalBoss()?.send(
      OFFHOST_PURGE_QUEUE,
      {},
      {
        singletonKey: OFFHOST_PURGE_QUEUE,
        retryLimit: 3,
        retryDelay: 300,
      },
    );
  } catch (err) {
    logCaught("backup.offhost_purge.kick_failed", err);
    // The cron is the backstop.
  }
}

export interface OffhostPurgeReport {
  pending: number;
  completed: number;
  failed: number;
  /** Wipe requests kept until a nightly run has walked the account since. */
  awaitingRun: number;
  objectsDeleted: number;
}

function trimError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Work through the pending requests: list the bucket once, delete every
 * object of every pending subject, remove each request whose objects are all
 * gone. Answers what it did.
 */
export async function processOffhostPurges(
  prisma: PurgeDb,
  s3Override?: S3Like,
): Promise<OffhostPurgeReport> {
  const requests = await prisma.offhostPurgeRequest.findMany({
    orderBy: { requestedAt: "asc" },
    take: REQUESTS_PER_RUN,
  });
  const report: OffhostPurgeReport = {
    pending: requests.length,
    completed: 0,
    failed: 0,
    awaitingRun: 0,
    objectsDeleted: 0,
  };
  if (requests.length === 0) return report;

  const cfg = loadOffhostConfig();
  if (!cfg) {
    // Configuration removed after the requests were written: leave them, an
    // operator who puts it back gets the purge.
    return report;
  }

  const now = new Date();
  const markFailed = async (ids: string[], err: unknown) => {
    await prisma.offhostPurgeRequest.updateMany({
      where: { id: { in: ids } },
      data: {
        attempts: { increment: 1 },
        lastAttemptAt: now,
        lastFailure: trimError(err),
      },
    });
    report.failed += ids.length;
  };

  let objects: Array<{ key: string }>;
  let s3: S3Like;
  try {
    s3 = s3Override ?? (await getS3Client(cfg));
    objects = await s3.listObjects("");
  } catch (err) {
    await markFailed(
      requests.map((r) => r.id),
      err,
    );
    return report;
  }

  const subjects = new Set(requests.map((r) => r.subjectId));
  const [liveUsers, ledger] = await Promise.all([
    prisma.user.findMany({
      where: { id: { in: [...subjects] } },
      select: { id: true },
    }),
    prisma.offhostBackupState.findMany({
      where: { userId: { in: [...subjects] } },
      select: { userId: true, lastAttemptAt: true },
    }),
  ]);
  const live = new Set(liveUsers.map((u) => u.id));
  const lastWalked = new Map(ledger.map((r) => [r.userId, r.lastAttemptAt]));

  // A wipe of an account that still exists: its request stays until a
  // nightly run has walked the account since, because the upload in flight
  // at the wipe reads the request to throw its pre-wipe copy away.
  const awaitsRun = (request: (typeof requests)[number]) =>
    request.reason === "data_wiped" &&
    live.has(request.subjectId) &&
    !(
      (lastWalked.get(request.subjectId)?.getTime() ?? 0) >=
      request.requestedAt.getTime()
    );

  // Where every request of a subject is a wipe of a live account, only the
  // copies dated up to the latest wipe's day go; a copy from a later night
  // holds what the account has recorded since, and stays. An account that is
  // gone loses every copy.
  const lastDayToDelete = new Map<string, string | null>();
  for (const request of requests) {
    const subject = request.subjectId;
    const day =
      request.reason === "data_wiped" && live.has(subject)
        ? // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: matches the UTC dates in the off-host object keys
          request.requestedAt.toISOString().slice(0, 10)
        : null;
    const prior = lastDayToDelete.get(subject);
    if (prior === undefined) lastDayToDelete.set(subject, day);
    else if (prior !== null) {
      lastDayToDelete.set(subject, day === null || day > prior ? day : prior);
    }
  }

  const bySubject = new Map<string, string[]>();
  for (const { key } of objects) {
    const match = ACCOUNT_OBJECT.exec(key);
    if (!match) continue;
    const subject = match[1];
    if (!subjects.has(subject)) continue;
    const lastDay = lastDayToDelete.get(subject);
    if (lastDay && key.slice(0, 10) > lastDay) continue;
    const list = bySubject.get(subject) ?? [];
    list.push(key);
    bySubject.set(subject, list);
  }

  // One subject at a time, so a refusal part-way fails only the subjects it
  // reached, and a request is removed only when its own objects are gone.
  const failedSubjects = new Map<string, unknown>();
  let deletes = 0;
  for (const [subject, keys] of bySubject) {
    for (const key of keys) {
      if (deletes >= MAX_DELETES_PER_RUN) {
        failedSubjects.set(
          subject,
          new Error("Deletion budget for one run reached; continues next run"),
        );
        break;
      }
      try {
        await s3.deleteObject(key);
        deletes++;
        report.objectsDeleted++;
      } catch (err) {
        failedSubjects.set(subject, err);
        break;
      }
    }
  }

  for (const request of requests) {
    const failure = failedSubjects.get(request.subjectId);
    if (failure) {
      await markFailed([request.id], failure);
      continue;
    }
    const deleted = bySubject.get(request.subjectId)?.length ?? 0;
    // A wipe that already waited a pass had its copies removed, and its
    // receipt written, on that pass.
    const alreadyReceipted =
      request.lastAttemptAt !== null && request.lastFailure === null;
    if (awaitsRun(request)) {
      // Its copies up to the wipe are gone; what is left is the wait for
      // the next run. Marked so the admin card stops counting it as copies
      // still in the bucket.
      await prisma.offhostPurgeRequest.updateMany({
        where: { id: { in: [request.id] } },
        data: { lastAttemptAt: now, lastFailure: null },
      });
      report.awaitingRun++;
    } else {
      await prisma.offhostPurgeRequest.delete({ where: { id: request.id } });
      report.completed++;
    }
    if (alreadyReceipted && deleted === 0) continue;
    // The account a deleted subject named is gone, and so is its audit
    // history; the receipt names the reason and the count, not the account.
    // A wiped account still exists and keeps the receipt as its own.
    const accountRemains =
      request.reason === "data_wiped" && live.has(request.subjectId);
    await auditLog("offhost.backup.purged", {
      userId: accountRemains ? request.subjectId : null,
      actorUserId: null,
      details: {
        reason: request.reason,
        objectsDeleted: deleted,
        attempts: request.attempts + 1,
      },
    });
  }
  return report;
}

export async function handleOffhostPurge(
  jobs: Job<object>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.offhost_purge", async (evt) => {
    try {
      const report = await processOffhostPurges(getWorkerPrisma());
      evt.addMeta("offhost_purge_pending", report.pending);
      evt.addMeta("offhost_purge_completed", report.completed);
      evt.addMeta("offhost_purge_failed", report.failed);
      evt.addMeta("offhost_purge_awaiting_run", report.awaitingRun);
      evt.addMeta("offhost_purge_objects_deleted", report.objectsDeleted);
      if (report.failed > 0) {
        await reportWorkerError(
          OFFHOST_PURGE_QUEUE,
          new Error(
            `${report.failed} off-host deletion request(s) could not be completed; they stay pending and are retried nightly. Check that the bucket credential allows DeleteObject.`,
          ),
        );
      }
      return jobDone({
        offhost_purge_pending: report.pending,
        offhost_purge_completed: report.completed,
        offhost_purge_failed: report.failed,
        offhost_purge_awaiting_run: report.awaitingRun,
        offhost_purge_objects_deleted: report.objectsDeleted,
      });
    } catch (err) {
      evt.addWarning(`offhost-purge failed: ${err}`);
      await reportWorkerError(OFFHOST_PURGE_QUEUE, err);
      return jobFailed("offhost purge failed", err);
    }
  });
}
