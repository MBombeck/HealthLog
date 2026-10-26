/**
 * The end of the deletion grace window.
 *
 * Hourly, this erases every account whose window has ended
 * (`User.deletionPurgeAt`) exactly as the immediate deletion did before v1.46
 * (`eraseAccount`): the row goes, everything it owns cascades, and the
 * off-host purge request commits with it and is kicked at once. It also
 * deletes the copies data wipes took (`PRE_WIPE_<ms>`) whose window has
 * ended. The off-host purge a wipe asked for needs nothing from here: its
 * request carries the same date (`notBefore`) and the off-host purge job
 * picks it up once that has passed.
 *
 * Each account is decided again inside its own transaction, under the row
 * lock the admin's undo takes, so an undo that lands while this runs either
 * wins (the account is no longer pending and is skipped) or loses (the
 * account is already gone and the undo answers 404). The Guardian invariant
 * is decided again too: a Guardian whose last co-Guardian left during the
 * window would leave a managed profile nobody can reach, so that erasure is
 * refused, the account stays locked and pending, the run reports it, and
 * every admin is told once through the localized admin notification.
 *
 * One account never holds up the others. An erasure that throws (a record
 * too large for the transaction's time limit, a lock a restore holds) is
 * caught, counted, reported through the worker error path and to the admins
 * once, and the run goes on with the next account. Every account the run
 * starts is marked (`backup_pass_attempts`, pass `account-deletion-purge`)
 * and the mark is closed only when the account is erased or no longer due,
 * so an account that failed or was refused is taken after every other due
 * account in the following runs, the longest-waiting first. The run stops
 * starting accounts once its time budget is spent; the sweep of expired
 * pre-wipe copies and the off-host kick run whatever happened before them.
 */
import type { Job } from "pg-boss";

import { prisma } from "@/lib/db";
import {
  markBackupAttemptFinished,
  markBackupAttemptStarted,
  orderInterruptedLast,
  readInterruptedBackupAttempts,
} from "@/lib/jobs/backup-pass-attempts";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { kickOffhostPurge } from "@/lib/jobs/offhost-purge";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  ACCOUNT_DELETION_TRANSACTION_OPTIONS,
  deleteGuardianAccountWithLifecycle,
  LastManagedGuardianError,
  withManagedProfileLock,
} from "@/lib/managed-profiles/lifecycle";
import {
  eraseAccount,
  lockPendingAccount,
} from "@/lib/account-deletion/lifecycle";
import { preWipeCopyCutoff } from "@/lib/account-deletion/grace";
import { activeAccount } from "@/lib/account-deletion/active-account";
import { auditLog } from "@/lib/auth/audit";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import { PRE_WIPE_BACKUP_TYPE_PREFIX } from "@/lib/account-deletion/pre-wipe-type";
import { ACCOUNT_DELETION_PURGE_QUEUE } from "./account-deletion-purge-queue";

/**
 * Due accounts one run reads. The run erases as many as its time budget
 * allows; the next run takes the rest.
 */
const ACCOUNTS_PER_RUN = 200;

/** The attempt ledger's key for this job. */
const PASS = ACCOUNT_DELETION_PURGE_QUEUE;

interface AccountDeletionPurgeReport {
  due: number;
  purged: number;
  /** Erasures refused by the Guardian invariant; the accounts stay pending. */
  refused: number;
  /** Erasures that threw; the accounts stay pending and are tried again. */
  failed: number;
  /** The first error of the failed erasures, for the worker error report. */
  firstFailure: unknown;
  /** Due accounts the run left for the next one when its budget ran out. */
  deferred: number;
  preWipeCopiesDeleted: number;
}

/** Thrown inside an erasure transaction to roll it back without erasing. */
class NoLongerDue extends Error {
  constructor() {
    super("account is no longer pending deletion or not yet due");
    this.name = "NoLongerDue";
  }
}

function isDue(
  state: { pending: boolean; purgeAt: Date | null } | null,
  now: Date,
): boolean {
  return (
    state !== null &&
    state.pending &&
    (state.purgeAt === null || state.purgeAt <= now)
  );
}

/** Erase one account whose window ended. False when it no longer was due. */
async function purgeAccount(
  userId: string,
  managedProfile: boolean,
  now: Date,
): Promise<boolean> {
  try {
    if (managedProfile) {
      // A managed profile is erased on its own lock, as its deletion was
      // decided; it guards no Guardian invariant of its own.
      await prisma.$transaction(
        (tx) =>
          withManagedProfileLock(tx, userId, async () => {
            if (!isDue(await lockPendingAccount(tx, userId), now)) {
              throw new NoLongerDue();
            }
            await eraseAccount(tx, userId, "managed_profile_deleted");
          }),
        ACCOUNT_DELETION_TRANSACTION_OPTIONS,
      );
    } else {
      await deleteGuardianAccountWithLifecycle(
        userId,
        async (tx) => {
          if (!isDue(await lockPendingAccount(tx, userId), now)) {
            throw new NoLongerDue();
          }
          await eraseAccount(tx, userId, "account_deleted");
        },
        { erasing: true },
      );
    }
    return true;
  } catch (error) {
    if (error instanceof NoLongerDue) return false;
    throw error;
  }
}

/**
 * Delete the `PRE_WIPE_<ms>` copies whose window has ended, except one an
 * unfinished restore is reading: that restore is the window being used.
 */
async function deleteExpiredPreWipeCopies(now: Date): Promise<number> {
  // account-deletion: restore jobs, not accounts.
  const active = await prisma.backupRestoreJob.findMany({
    where: { status: { in: ["queued", "running"] } },
    select: { backupId: true },
  });
  // account-deletion: the purge's own sweep; a copy's window ends whatever its account's state.
  const { count } = await prisma.dataBackup.deleteMany({
    where: {
      type: { startsWith: PRE_WIPE_BACKUP_TYPE_PREFIX },
      createdAt: { lt: preWipeCopyCutoff(now) },
      id: { notIn: active.map((job) => job.backupId) },
    },
  });
  return count;
}

/**
 * Why an erasure did not happen, the audit action that marks it as already
 * reported, and the notice the admins get.
 */
const NOT_ERASED = {
  last_managed_guardian: {
    action: "user.account.deletion_refused",
    messageKey: "notifications.admin.accountErasureRefusedBody",
  },
  erasure_failed: {
    action: "user.account.erasure_failed",
    messageKey: "notifications.admin.accountErasureFailedBody",
  },
} as const;

/**
 * Tell every admin, once, that an account whose window ended could not be
 * erased, and why. The run retries the account every hour; the audit row on
 * the account (one action per reason, newer than the deletion request) is
 * what keeps the second hour from repeating the message. A deletion undone
 * and asked for again is a new request and is reported afresh.
 */
async function notifyAdminsOfUnerasedAccount(
  accountId: string,
  reason: keyof typeof NOT_ERASED,
): Promise<void> {
  const { action, messageKey } = NOT_ERASED[reason];
  const account = await prisma.user.findUnique({
    where: { id: accountId },
    select: { username: true, deletionRequestedAt: true },
  });
  if (!account?.deletionRequestedAt) return;
  const reported = await prisma.auditLog.count({
    where: {
      userId: accountId,
      action,
      createdAt: { gte: account.deletionRequestedAt },
    },
  });
  if (reported > 0) return;
  await auditLog(action, {
    userId: accountId,
    actorUserId: null,
    details: { reason },
  });
  const admins = await prisma.user.findMany({
    where: activeAccount({ role: "ADMIN" }),
    select: { id: true },
  });
  for (const admin of admins) {
    await dispatchLocalisedNotification({
      userId: admin.id,
      titleKey: "notifications.admin.accountErasureRefusedTitle",
      messageKey,
      params: { username: account.username },
      metadata: { source: "account-deletion-purge", url: "/admin/users" },
    });
  }
}

/** A notice that could not be sent must not stop the run. */
async function notifyQuietly(
  accountId: string,
  reason: keyof typeof NOT_ERASED,
): Promise<void> {
  try {
    await notifyAdminsOfUnerasedAccount(accountId, reason);
  } catch (err) {
    await reportWorkerError(ACCOUNT_DELETION_PURGE_QUEUE, err);
  }
}

export async function processDueAccountDeletions(
  now: Date = new Date(),
  options: { shouldStop?: () => boolean } = {},
): Promise<AccountDeletionPurgeReport> {
  const shouldStop = options.shouldStop ?? (() => false);
  const report: AccountDeletionPurgeReport = {
    due: 0,
    purged: 0,
    refused: 0,
    failed: 0,
    firstFailure: null,
    deferred: 0,
    preWipeCopiesDeleted: 0,
  };
  try {
    // account-deletion: the purge's own query: exactly the accounts pending deletion.
    const due = await prisma.user.findMany({
      where: {
        deletionRequestedAt: { not: null },
        OR: [{ deletionPurgeAt: null }, { deletionPurgeAt: { lte: now } }],
      },
      select: { id: true, managedProfileAt: true },
      orderBy: [{ deletionPurgeAt: "asc" }, { id: "asc" }],
      take: ACCOUNTS_PER_RUN,
    });
    report.due = due.length;
    // An account whose last erasure failed, was refused or was cut off goes
    // behind every other due account.
    const ordered = orderInterruptedLast(
      due,
      await readInterruptedBackupAttempts(prisma, PASS),
    );
    for (const [index, account] of ordered.entries()) {
      if (shouldStop()) {
        report.deferred = ordered.length - index;
        break;
      }
      await markBackupAttemptStarted(prisma, PASS, account.id);
      try {
        if (
          await purgeAccount(account.id, account.managedProfileAt !== null, now)
        ) {
          report.purged++;
        }
        // Erased (the mark went with the account) or no longer due.
        await markBackupAttemptFinished(prisma, PASS, account.id);
      } catch (error) {
        if (error instanceof LastManagedGuardianError) {
          report.refused++;
          await notifyQuietly(account.id, "last_managed_guardian");
        } else {
          report.failed++;
          report.firstFailure ??= error;
          await notifyQuietly(account.id, "erasure_failed");
        }
      }
    }
  } finally {
    // The window of a pre-wipe copy ends whatever happened to the accounts.
    report.preWipeCopiesDeleted = await deleteExpiredPreWipeCopies(now);
    // The off-host copies of every erased account, now rather than at the
    // nightly slot. The requests committed with the erasures.
    if (report.purged > 0) await kickOffhostPurge();
  }
  return report;
}

export async function handleAccountDeletionPurge(
  jobs: Job<object>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.account_deletion_purge", async (evt) => {
    try {
      const report = await processDueAccountDeletions(new Date(), {
        shouldStop: jobBudget(jobs),
      });
      evt.addMeta("account_deletions_due", report.due);
      evt.addMeta("account_deletions_purged", report.purged);
      evt.addMeta("account_deletions_refused", report.refused);
      evt.addMeta("account_deletions_failed", report.failed);
      evt.addMeta("account_deletions_deferred", report.deferred);
      evt.addMeta("pre_wipe_copies_deleted", report.preWipeCopiesDeleted);
      if (report.failed > 0) {
        const cause =
          report.firstFailure instanceof Error
            ? report.firstFailure.message
            : String(report.firstFailure);
        await reportWorkerError(
          ACCOUNT_DELETION_PURGE_QUEUE,
          new Error(
            `${report.failed} account erasure(s) failed and will be tried again next hour, after the other due accounts. The accounts stay locked and pending. First error: ${cause}`,
          ),
        );
      }
      if (report.refused > 0) {
        await reportWorkerError(
          ACCOUNT_DELETION_PURGE_QUEUE,
          new Error(
            `${report.refused} account deletion(s) could not complete: the account is the last active Guardian of a managed profile. The account stays locked and pending; add another Guardian to the profile or delete the profile, or undo the deletion in the admin users list.`,
          ),
        );
      }
      return jobDone({
        account_deletions_due: report.due,
        account_deletions_purged: report.purged,
        account_deletions_refused: report.refused,
        account_deletions_failed: report.failed,
        account_deletions_deferred: report.deferred,
        pre_wipe_copies_deleted: report.preWipeCopiesDeleted,
      });
    } catch (err) {
      evt.addWarning(`account-deletion-purge failed: ${err}`);
      await reportWorkerError(ACCOUNT_DELETION_PURGE_QUEUE, err);
      return jobFailed("account deletion purge failed", err);
    }
  });
}
