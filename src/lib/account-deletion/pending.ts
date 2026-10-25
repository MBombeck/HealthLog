/**
 * Whether an account is pending deletion, asked where it has to be decided:
 * at every place that hands out a credential or acts for the account.
 */
import { prisma } from "@/lib/db";
import { AccountDeletionPendingError } from "@/lib/api-errors";
import type { Prisma } from "@/generated/prisma/client";

type UserReader = Pick<Prisma.TransactionClient, "user">;

interface PendingDeletion {
  requestedAt: Date;
  /** When the purge job erases the account. */
  purgeAt: Date | null;
}

/** The pending deletion of `userId`, or null when the account is not pending. */
export async function pendingDeletionOf(
  userId: string,
  db: UserReader = prisma,
): Promise<PendingDeletion | null> {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { deletionRequestedAt: true, deletionPurgeAt: true },
  });
  if (!row?.deletionRequestedAt) return null;
  return { requestedAt: row.deletionRequestedAt, purgeAt: row.deletionPurgeAt };
}

/**
 * Refuse a sign-in to an account pending deletion.
 *
 * Call it only after the credential was proved, never before: the refusal
 * says the account exists and is pending, which is not something to tell a
 * caller who has not shown they could sign in to it. Every primitive that
 * mints a sign-in (`createSession`, `issueApiToken`) calls it too, so a
 * surface that forgets is still refused; the explicit calls in the sign-in
 * routes are there to refuse before a second factor is asked for.
 */
export async function assertAccountNotPendingDeletion(
  userId: string,
  db: UserReader = prisma,
): Promise<void> {
  const pending = await pendingDeletionOf(userId, db);
  if (pending) throw new AccountDeletionPendingError(pending.purgeAt);
}

/**
 * The same refusal, from an account row the caller already holds, so a
 * sign-in route that loaded the whole row asks nothing twice.
 */
export function refuseIfPendingDeletion(account: {
  deletionRequestedAt?: Date | null;
  deletionPurgeAt?: Date | null;
}): void {
  if (account.deletionRequestedAt != null) {
    throw new AccountDeletionPendingError(account.deletionPurgeAt ?? null);
  }
}
