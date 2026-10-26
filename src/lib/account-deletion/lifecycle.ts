/**
 * The three steps of an account deletion with a grace window: lock, undo,
 * erase.
 *
 * - `lockAccountForDeletion` runs inside the transaction that asked for the
 *   deletion. It stamps the window on the account and revokes every
 *   credential the account holds, so nothing signs in, refreshes or reads
 *   through a token from the moment the deletion commits. The record itself,
 *   its stored copies and its off-host objects are left exactly as they are.
 * - `cancelAccountDeletion` is the admin's undo. It clears the stamp and
 *   nothing else: the record was never touched, so there is nothing to put
 *   back. Credentials stay revoked; the person signs in again.
 * - `eraseAccount` is what the deletion did immediately before v1.46, now run
 *   by the purge job when the window ends (and still run at once when
 *   `ACCOUNT_DELETION_GRACE_DAYS=0`). The off-host purge request commits with
 *   the erasure, as it always did.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { auditLog } from "@/lib/auth/audit";
import { credentialRevocations } from "@/lib/auth/credential-revocations";
import { remainingGuardianWhere } from "@/lib/managed-profiles/guardian-where";
import {
  requestOffhostPurge,
  type OffhostPurgeReason,
} from "@/lib/jobs/offhost-purge";

type Tx = Prisma.TransactionClient;

type AccountErasureReason = Extract<
  OffhostPurgeReason,
  "account_deleted" | "managed_profile_deleted"
>;

/**
 * Lock `userId` for deletion: stamp when it was asked for, when it is
 * erased and by whom, and revoke every credential. Call it with the
 * transaction that decided the deletion may happen.
 */
export async function lockAccountForDeletion(
  tx: Tx,
  input: {
    userId: string;
    requestedById: string;
    requestedAt: Date;
    purgeAt: Date;
  },
): Promise<void> {
  await tx.user.update({
    where: { id: input.userId },
    data: {
      deletionRequestedAt: input.requestedAt,
      deletionPurgeAt: input.purgeAt,
      deletionRequestedById: input.requestedById,
    },
    select: { id: true },
  });
  for (const revoke of credentialRevocations(tx, input.userId)) {
    await revoke;
  }
  // A handover link is a credential for the profile it hands over: claimed
  // during the window, it would give someone an account that is locked at
  // once and erased when the window ends. The links this account minted for
  // a profile it guards go too: nothing acts on its behalf from now on.
  await tx.managedProfileHandover.updateMany({
    where: {
      OR: [{ profileId: input.userId }, { createdById: input.userId }],
      usedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: input.requestedAt },
  });
}

/**
 * Erase `userId` for good: what an account deletion did before the grace
 * window, unchanged. The account's own audit history goes with it when the
 * account deleted itself (AuditLog rows only `SetNull` on the cascade and
 * would keep IP addresses and sign-in places attached to nobody); a managed
 * profile's history is kept as it always was, attributed to the Guardians
 * who acted on it.
 */
export async function eraseAccount(
  tx: Tx,
  userId: string,
  reason: AccountErasureReason,
): Promise<void> {
  if (reason === "account_deleted") {
    await tx.session.deleteMany({ where: { userId } });
    await tx.auditLog.deleteMany({ where: { userId } });
  }
  // The nightly off-host copies go with the account. The request commits
  // with the deletion; the purge job deletes the objects.
  await requestOffhostPurge(tx, userId, reason);
  // Every other row the account owns goes through `onDelete: Cascade`.
  await tx.user.delete({ where: { id: userId } });
}

/**
 * Hold the account row for the rest of the transaction and answer whether it
 * is still pending deletion and due by `now`. The undo takes the same row
 * lock, so an undo and a purge of one account are ordered, never interleaved.
 */
export async function lockPendingAccount(
  tx: Tx,
  userId: string,
): Promise<{
  pending: boolean;
  purgeAt: Date | null;
  managedProfile: boolean;
} | null> {
  const rows = await tx.$queryRaw<
    Array<{
      deletion_requested_at: Date | null;
      deletion_purge_at: Date | null;
      managed_profile_at: Date | null;
    }>
  >`SELECT "deletion_requested_at", "deletion_purge_at", "managed_profile_at"
      FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
  const row = rows[0];
  if (!row) return null;
  return {
    pending: row.deletion_requested_at !== null,
    purgeAt: row.deletion_purge_at,
    managedProfile: row.managed_profile_at !== null,
  };
}

type CancelDeletionOutcome =
  "cancelled" | "not_found" | "not_pending" | "no_guardian";

/**
 * Undo a pending deletion. Audit-logged twice: once for the admin who undid
 * it, once on the account itself so its own activity shows what happened.
 *
 * A managed profile comes back only to a Guardian: one whose own account is
 * not pending deletion. Its Guardians may have left during the window (the
 * last-Guardian rule no longer counts a profile pending deletion), and a
 * profile nobody can reach is not something to give back.
 */
export async function cancelAccountDeletion(input: {
  userId: string;
  adminId: string;
  ipAddress?: string | null;
}): Promise<CancelDeletionOutcome> {
  return prisma.$transaction(async (tx) => {
    // The record lock first (the key `withManagedProfileLock` takes), then
    // the row, in the order the purge takes them, so a Guardian leaving and
    // this undo are ordered too.
    await tx.$queryRaw`
      SELECT 1 AS locked
      FROM pg_advisory_xact_lock(hashtextextended(${`managed-profile:${input.userId}`}, 0))
    `;
    const state = await lockPendingAccount(tx, input.userId);
    if (!state) return "not_found";
    if (!state.pending) return "not_pending";
    if (state.managedProfile) {
      const guardians = await tx.accountGrant.count({
        where: {
          grantorId: input.userId,
          ...remainingGuardianWhere(new Date()),
        },
      });
      if (guardians === 0) return "no_guardian";
    }
    await tx.user.update({
      where: { id: input.userId },
      data: {
        deletionRequestedAt: null,
        deletionPurgeAt: null,
        deletionRequestedById: null,
      },
      select: { id: true },
    });
    await auditLog("admin.user.deletion.undo", {
      userId: input.adminId,
      ipAddress: input.ipAddress ?? null,
      details: {
        targetUserId: input.userId,
        purgeAt: state.purgeAt?.toISOString() ?? null,
      },
      client: tx,
    });
    await auditLog("user.account.deletion_cancelled", {
      userId: input.userId,
      actorUserId: input.adminId,
      client: tx,
    });
    return "cancelled";
  });
}
