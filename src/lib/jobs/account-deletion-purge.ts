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
 */
import type { Job } from "pg-boss";

import { prisma } from "@/lib/db";
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

/** Accounts one run erases; the next run takes the rest. */
const ACCOUNTS_PER_RUN = 50;

interface AccountDeletionPurgeReport {
  due: number;
  purged: number;
  /** Erasures refused by the Guardian invariant; the accounts stay pending. */
  refused: number;
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
  const { count } = await prisma.dataBackup.deleteMany({
    where: {
      type: { startsWith: PRE_WIPE_BACKUP_TYPE_PREFIX },
      createdAt: { lt: preWipeCopyCutoff(now) },
      id: { notIn: active.map((job) => job.backupId) },
    },
  });
  return count;
}

/** The audit action that marks a refused erasure as already reported. */
const REFUSED_ERASURE_ACTION = "user.account.deletion_refused";

/**
 * Tell every admin, once, that an account whose window ended could not be
 * erased, and why. The run retries the account every hour; the audit row on
 * the account (`user.account.deletion_refused`, newer than the deletion
 * request) is what keeps the second hour from repeating the message. A
 * deletion undone and asked for again is a new request and is reported
 * afresh.
 */
async function notifyAdminsOfRefusedErasure(accountId: string): Promise<void> {
  const account = await prisma.user.findUnique({
    where: { id: accountId },
    select: { username: true, deletionRequestedAt: true },
  });
  if (!account?.deletionRequestedAt) return;
  const reported = await prisma.auditLog.count({
    where: {
      userId: accountId,
      action: REFUSED_ERASURE_ACTION,
      createdAt: { gte: account.deletionRequestedAt },
    },
  });
  if (reported > 0) return;
  await auditLog(REFUSED_ERASURE_ACTION, {
    userId: accountId,
    actorUserId: null,
    details: { reason: "last_managed_guardian" },
  });
  const admins = await prisma.user.findMany({
    where: activeAccount({ role: "ADMIN" }),
    select: { id: true },
  });
  for (const admin of admins) {
    await dispatchLocalisedNotification({
      userId: admin.id,
      titleKey: "notifications.admin.accountErasureRefusedTitle",
      messageKey: "notifications.admin.accountErasureRefusedBody",
      params: { username: account.username },
      metadata: { source: "account-deletion-purge", url: "/admin/users" },
    });
  }
}

export async function processDueAccountDeletions(
  now: Date = new Date(),
): Promise<AccountDeletionPurgeReport> {
  // account-deletion: the purge's own query: exactly the accounts pending deletion.
  const due = await prisma.user.findMany({
    where: {
      deletionRequestedAt: { not: null },
      OR: [{ deletionPurgeAt: null }, { deletionPurgeAt: { lte: now } }],
    },
    select: { id: true, managedProfileAt: true },
    orderBy: { deletionPurgeAt: "asc" },
    take: ACCOUNTS_PER_RUN,
  });

  const report: AccountDeletionPurgeReport = {
    due: due.length,
    purged: 0,
    refused: 0,
    preWipeCopiesDeleted: 0,
  };
  for (const account of due) {
    try {
      if (
        await purgeAccount(account.id, account.managedProfileAt !== null, now)
      ) {
        report.purged++;
      }
    } catch (error) {
      if (!(error instanceof LastManagedGuardianError)) throw error;
      report.refused++;
      await notifyAdminsOfRefusedErasure(account.id);
    }
  }
  report.preWipeCopiesDeleted = await deleteExpiredPreWipeCopies(now);

  // The off-host copies of every erased account, now rather than at the
  // nightly slot. The requests committed with the erasures.
  if (report.purged > 0) await kickOffhostPurge();
  return report;
}

export async function handleAccountDeletionPurge(
  jobs: Job<object>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.account_deletion_purge", async (evt) => {
    try {
      const report = await processDueAccountDeletions();
      evt.addMeta("account_deletions_due", report.due);
      evt.addMeta("account_deletions_purged", report.purged);
      evt.addMeta("account_deletions_refused", report.refused);
      evt.addMeta("pre_wipe_copies_deleted", report.preWipeCopiesDeleted);
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
        pre_wipe_copies_deleted: report.preWipeCopiesDeleted,
      });
    } catch (err) {
      evt.addWarning(`account-deletion-purge failed: ${err}`);
      await reportWorkerError(ACCOUNT_DELETION_PURGE_QUEUE, err);
      return jobFailed("account deletion purge failed", err);
    }
  });
}
