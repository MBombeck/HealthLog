/**
 * The one definition of "an account background work may act for".
 *
 * An account pending deletion (`User.deletionRequestedAt` set) is locked: its
 * owner cannot sign in, and nothing may act on their behalf while the grace
 * window runs. No reminder, no digest, no Coach nudge, no provider sync, no
 * weekly or off-host copy, no rollup or derived score — the record is frozen
 * exactly as it was when deletion was asked for, so an undo gives back the
 * record as it was and the purge erases nothing that was produced after the
 * person said goodbye.
 *
 * Every cross-account enumeration in background work filters with one of the
 * forms below (the constants, or the `activeAccount` / `ownedByActiveAccount`
 * wrappers around an existing `where`) (or, for a scan of a table too large to join per row, drops the
 * pending accounts from its result with `dropPendingDeletion`), and `src/__tests__/account-deletion-enumeration-guard.test.ts`
 * fails on an enumeration that does not. Two chokepoints catch what a missed
 * enumeration would still reach: the notification dispatcher refuses delivery
 * for a pending account, and the AI capability loader refuses model work for
 * one.
 */
import { Prisma } from "@/generated/prisma/client";

/** `where` on `User`: the account is not pending deletion. */
export const ACTIVE_ACCOUNT = {
  deletionRequestedAt: null,
} as const satisfies Prisma.UserWhereInput;

/**
 * `where` on a model that belongs to an account through a `user` relation:
 * that account is not pending deletion.
 */
export const OWNED_BY_ACTIVE_ACCOUNT = {
  user: ACTIVE_ACCOUNT,
} as const;

/** `where` on `User`, narrowed to accounts not pending deletion. */
export function activeAccount<T extends object>(where: T) {
  return { ...where, ...ACTIVE_ACCOUNT };
}

/**
 * `where` on a model owned through a `user` relation, narrowed to owners not
 * pending deletion. A `user` filter the caller already has is kept and
 * narrowed, not replaced.
 */
export function ownedByActiveAccount<T extends object>(
  where: T & { user?: object },
) {
  return { ...where, user: { ...where.user, ...ACTIVE_ACCOUNT } };
}

/**
 * Raw SQL: the account behind `column` (a `users.id` value, such as
 * `"user_id"` or `u."id"`) is not pending deletion. `column` is a fixed
 * identifier written at the call site, never input.
 */
export function activeAccountSql(column: string): Prisma.Sql {
  if (!/^(?:[a-z_]+\.)?"?[a-z_]+"?$/i.test(column)) {
    throw new Error(`activeAccountSql: not a column reference: ${column}`);
  }
  return Prisma.raw(
    `NOT EXISTS (SELECT 1 FROM "users" "pending_deletion" WHERE "pending_deletion"."id" = ${column} AND "pending_deletion"."deletion_requested_at" IS NOT NULL)`,
  );
}

/**
 * `where` on a table too large to join `users` into row by row
 * (`measurements`, `workouts`): its owner is none of the few accounts pending
 * deletion, as `userId NOT IN (…)`. Unlike `dropPendingDeletion` it filters
 * before a `take`, so a pending account does not use a slot of a capped scan.
 */
export async function excludePendingOwners(db: {
  user: {
    findMany(args: {
      where: { deletionRequestedAt: { not: null } };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
}): Promise<{ userId?: { notIn: string[] } }> {
  const pending = await db.user.findMany({
    where: { deletionRequestedAt: { not: null } },
    select: { id: true },
  });
  return pending.length === 0
    ? {}
    : { userId: { notIn: pending.map((row) => row.id) } };
}

/**
 * Drop the accounts pending deletion from the result of a scan over a table
 * too large to join `users` into row by row (`measurements`): the scan keeps
 * its plan, and the few pending accounts are read once and taken out.
 */
export async function dropPendingDeletion<T>(
  db: {
    user: {
      findMany(args: {
        where: { deletionRequestedAt: { not: null } };
        select: { id: true };
      }): Promise<Array<{ id: string }>>;
    };
  },
  rows: readonly T[],
  accountOf: (row: T) => string,
): Promise<T[]> {
  if (rows.length === 0) return [];
  const pending = await db.user.findMany({
    where: { deletionRequestedAt: { not: null } },
    select: { id: true },
  });
  if (pending.length === 0) return [...rows];
  const drop = new Set(pending.map((row) => row.id));
  return rows.filter((row) => !drop.has(accountOf(row)));
}
