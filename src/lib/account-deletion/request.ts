/**
 * Asking for an account to be deleted: the one path the account's own
 * deletion (`DELETE /api/settings/account`) and an admin's deletion of
 * another account (`DELETE /api/admin/users/{id}`) both take.
 *
 * With a grace window (`ACCOUNT_DELETION_GRACE_DAYS`) the account is locked:
 * every credential is revoked at once, the record stays exactly as it is, and
 * the purge job erases it when the window ends; an admin can undo it until
 * then. With the window at 0 it is erased here, in the same transaction.
 *
 * The Guardian invariant (an account may not leave a managed profile without
 * a Guardian) and the admin roster (the last admin who can sign in stays) are
 * decided inside the transaction, under their locks, and refuse by throwing
 * `LastManagedGuardianError` or `LastAdminError`.
 */
import type { Prisma } from "@/generated/prisma/client";
import { kickOffhostPurge } from "@/lib/jobs/offhost-purge";
import { deleteGuardianAccountWithLifecycle } from "@/lib/managed-profiles/lifecycle";
import { assertAnotherAdminStays } from "@/lib/auth/admin-roster";
import {
  accountDeletionGraceDays,
  accountDeletionPurgeAt,
} from "@/lib/account-deletion/grace";
import {
  eraseAccount,
  lockAccountForDeletion,
} from "@/lib/account-deletion/lifecycle";

type Tx = Prisma.TransactionClient;

export async function requestAccountDeletion(input: {
  userId: string;
  /** Whether the account being deleted is an admin (the roster check). */
  targetIsAdmin: boolean;
  /** Who asked: the account itself, or the admin acting on it. */
  requestedById: string;
  /**
   * Runs first inside the transaction, before anything is written: the place
   * for a refusal that must be decided under the same locks (throw), and for
   * the audit rows, which then cannot outlive a refusal.
   */
  inTransaction: (tx: Tx, purgeAt: Date | null) => Promise<void>;
}): Promise<{ purgeAt: Date | null }> {
  const requestedAt = new Date();
  const purgeAt = accountDeletionPurgeAt(
    requestedAt,
    accountDeletionGraceDays(),
  );

  await deleteGuardianAccountWithLifecycle(
    input.userId,
    async (tx) => {
      // Checked again under the roster lock: two admins deleting at the same
      // moment must not each count the other.
      if (input.targetIsAdmin) await assertAnotherAdminStays(tx, input.userId);
      await input.inTransaction(tx, purgeAt);

      if (purgeAt) {
        // Locked, not erased: credentials revoked in this transaction, the
        // record untouched until the purge job reaches `purgeAt`.
        await lockAccountForDeletion(tx, {
          userId: input.userId,
          requestedById: input.requestedById,
          requestedAt,
          purgeAt,
        });
        return;
      }

      // No window: erase now, inside the same record lifecycle transaction so
      // a refusal leaves every account state intact (sessions, the account's
      // audit history — GDPR Art. 17 — the off-host purge request, then the
      // row with everything cascading from it).
      await eraseAccount(tx, input.userId, "account_deleted");
    },
    { erasing: purgeAt === null },
  );

  if (!purgeAt) await kickOffhostPurge();
  return { purgeAt };
}
