/**
 * The account lock a restore holds, and the shared side of it for the passes
 * that rewrite an account's readings in the background.
 *
 * A restore deletes every reading of the account in one statement, inside
 * one long transaction. The consolidation passes (step and mean
 * consolidation, the per-sample cumulative drain, the dense intraday
 * retention) fold a day at a time: each day's transaction updates or mints
 * the day's total and then soft-deletes or deletes the day's per-sample
 * rows. Both take row locks on the same readings, each in its own order, and
 * when the restore reached a day's samples before its total while a pass was
 * folding that day, each held what the other needed next. Postgres broke the
 * cycle by cancelling one of them (`40P01`, #1031), and on a freshly booted
 * instance, where the step consolidation runs over every account with legacy
 * rows, that was the restore.
 *
 * So the two are ordered by one advisory lock before either touches a row.
 * The restore takes it exclusively as the first act of its transaction
 * ({@link takeRestoreLock}); every day transaction of those passes takes it in
 * shared mode as its first act ({@link holdAccountAgainstRestore}). Passes
 * share the lock with each other, so nothing about how they run together
 * changes. A restore that starts while a day is being folded waits for that
 * one day to commit, milliseconds. A day that would start while a restore is
 * running does not wait for it, which could take many minutes: it is refused
 * with {@link AccountRestoreInProgressError}, and the pass leaves the account
 * for its next run, which reads the restored rows rather than the ones it had
 * scanned before the restore replaced them.
 */
import type { Prisma } from "@/generated/prisma/client";

type LockClient = Pick<Prisma.TransactionClient, "$queryRaw">;

/** The lock's key. One per account; the restore has always used this one. */
function restoreLockKey(userId: string): string {
  return `backup-restore:${userId}`;
}

/**
 * Take the account's restore lock exclusively, for the rest of the calling
 * transaction. Waits for any day transaction of a background pass to commit,
 * and for another restore of the same account to finish.
 */
export async function takeRestoreLock(
  tx: LockClient,
  userId: string,
): Promise<void> {
  // `pg_advisory_xact_lock` returns void, which the client cannot read as a
  // column; selecting from it yields a plain row.
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtext(${restoreLockKey(userId)}))
  `;
}

/** A restore of the account is running; the pass should leave it for now. */
export class AccountRestoreInProgressError extends Error {
  readonly userId: string;
  constructor(userId: string) {
    super("A restore of this account is running");
    this.name = "AccountRestoreInProgressError";
    this.userId = userId;
  }
}

/**
 * Hold the account against a restore for the rest of the calling
 * transaction: the shared side of {@link takeRestoreLock}. Call it before the
 * transaction's first read or write of the account's readings. Throws
 * {@link AccountRestoreInProgressError} at once when a restore holds the
 * lock, rather than waiting for it.
 */
export async function holdAccountAgainstRestore(
  tx: LockClient,
  userId: string,
): Promise<void> {
  const [row] = await tx.$queryRaw<Array<{ held: boolean }>>`
    SELECT pg_try_advisory_xact_lock_shared(hashtext(${restoreLockKey(userId)})) AS held
  `;
  if (!row?.held) throw new AccountRestoreInProgressError(userId);
}

/**
 * Transaction options for a day transaction that takes
 * {@link holdAccountFoldLock}. The wait for the lock runs inside the
 * transaction, so it counts against the interactive timeout, and Prisma's
 * default of five seconds would abort a day whenever the other pass holds the
 * lock a little longer (P2028). The other side holds it for one day's
 * transaction, itself bounded by this timeout, and every statement (the lock
 * wait included) by the connection's 60-second `statement_timeout`; two
 * minutes covers a full wait and the day's own work. `maxWait` bounds the
 * wait for a pool connection, as elsewhere in the repo.
 */
export const FOLD_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 120_000,
} as const;

/**
 * Serialise the passes that rewrite an account's `stats:` means from their
 * samples: the daily-mean consolidation, the dense hourly fold and the
 * one-time fold repair (`measurement-fold-repair.ts`). Each day transaction
 * of those passes takes it right after {@link holdAccountAgainstRestore}, and
 * reads the day's samples only after it has it, so two of them never compute
 * the same window from two different views of its samples, and never write
 * the same row at once. It waits rather than refusing: the other side holds
 * it for one day's transaction.
 *
 * The compaction-tombstone purge takes it too, for each account it deletes
 * from, so it never removes leftovers between a re-fold's reads
 * (`fold-constituents.ts`).
 *
 * The two-key form keeps it apart from the restore lock's single-key space.
 */
export async function holdAccountFoldLock(
  tx: LockClient,
  userId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT 1 AS locked
    FROM pg_advisory_xact_lock(hashtext('measurement-fold'), hashtext(${userId}))
  `;
}
