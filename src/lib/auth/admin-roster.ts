/**
 * The rule that an instance keeps an admin who can sign in.
 *
 * Two changes can take the last one away: an admin demoted, and an admin
 * deleting their own account. Both count the other admins who are not pending
 * deletion (one pending deletion cannot sign in and is erased when the window
 * ends) under one transaction-scoped lock, so two of them at the same moment
 * cannot each count the other and leave nobody.
 */
import type { Prisma } from "@/generated/prisma/client";
import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";

/** Thrown inside the transaction to roll the change back. */
export class LastAdminError extends Error {
  constructor() {
    super("the instance would be left without an admin who can sign in");
    this.name = "LastAdminError";
  }
}

/**
 * Hold the admin roster for the rest of `tx`, then throw `LastAdminError`
 * unless an admin other than `leavingId` stays, not pending deletion.
 */
export async function assertAnotherAdminStays(
  tx: Prisma.TransactionClient,
  leavingId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtextextended('admin-roster', 0))
  `;
  const others = await tx.user.count({
    where: { role: "ADMIN", id: { not: leavingId }, ...ACTIVE_ACCOUNT },
  });
  if (others === 0) throw new LastAdminError();
}
