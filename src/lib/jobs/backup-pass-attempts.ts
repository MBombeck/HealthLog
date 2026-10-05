/**
 * Where each account stands in a backup pass that walks every account, so a
 * pass the process died under is noticed and does not die the same way again.
 *
 * Why. Both backup passes walk the accounts one after another in one job.
 * When an account's record kills the process (the container runs out of
 * memory), the job is left `active`, and its retry walks the accounts in the
 * same order: the weekly pass takes the oldest copy first, which is the very
 * account that never got a new one, and the off-host pass walks by id. The
 * same account kills the retry, and every account after it goes without a
 * copy for as long as that account stays too large.
 *
 * What this does. The pass writes `startedAt` before it starts an account and
 * `finishedAt` once it is past it, whatever the outcome it caught. A start
 * newer than the finish is an attempt that never came back: the next pass
 * takes that account last, after everybody else has their copy, and the admin
 * backups page names it. Every write and read here is best effort: the marker
 * is bookkeeping about a backup, and must never be the reason one fails.
 *
 * Last only once. A pass that regularly stops on its time budget never reaches
 * the end of its list, so an account kept last for as long as its attempt
 * stays open would never be attempted again, and would never get a copy. An
 * interrupted account is therefore held back only until a later run has
 * started on another account (`accountsToTakeLast`): from then on it takes its
 * ordinary place again. If it kills the process again, its new attempt is the
 * newest one and it goes last once more. So a crash loop costs the other
 * accounts at most every second run, and the account itself is attempted at
 * least every second run.
 */
import type { PrismaClient } from "@/generated/prisma/client";

/** The pass's queue name, which is also the marker's key. */
export type BackupPass = "data-backup" | "data-backup-offhost";

type Db = Pick<PrismaClient, "backupPassAttempt">;

export async function markBackupAttemptStarted(
  prisma: Db,
  pass: BackupPass,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    await prisma.backupPassAttempt.upsert({
      where: { userId_pass: { userId, pass } },
      update: { startedAt: at },
      create: { userId, pass, startedAt: at },
    });
  } catch {
    // Bookkeeping only; an account deleted meanwhile has no row to write.
  }
}

export async function markBackupAttemptFinished(
  prisma: Db,
  pass: BackupPass,
  userId: string,
  at: Date = new Date(),
): Promise<void> {
  try {
    await prisma.backupPassAttempt.updateMany({
      where: { userId, pass },
      data: { finishedAt: at },
    });
  } catch {
    // Bookkeeping only.
  }
}

/**
 * The accounts whose last attempt in `pass` started and never finished, with
 * when it started. Empty when the table cannot be read.
 */
export async function readInterruptedBackupAttempts(
  prisma: Db,
  pass: BackupPass,
): Promise<Map<string, Date>> {
  try {
    const rows = await prisma.backupPassAttempt.findMany({
      where: { pass },
      select: { userId: true, startedAt: true, finishedAt: true },
    });
    return new Map(
      rows
        .filter(
          (row) => row.finishedAt === null || row.finishedAt < row.startedAt,
        )
        .map((row) => [row.userId, row.startedAt]),
    );
  } catch {
    return new Map();
  }
}

/**
 * The interrupted accounts a pass should take last: those whose interrupted
 * attempt is still the newest attempt of the pass, i.e. no later run has
 * started on another account since. Rows are one per account. Pure, so the
 * rule can be tested apart from the database.
 */
export function heldBackAccounts(
  rows: ReadonlyArray<{
    userId: string;
    startedAt: Date;
    finishedAt: Date | null;
  }>,
): Map<string, Date> {
  const out = new Map<string, Date>();
  for (const row of rows) {
    const open = row.finishedAt === null || row.finishedAt < row.startedAt;
    if (!open) continue;
    const passedOver = rows.some(
      (other) => other.userId !== row.userId && other.startedAt > row.startedAt,
    );
    if (!passedOver) out.set(row.userId, row.startedAt);
  }
  return out;
}

/**
 * What a pass orders by: the interrupted accounts it takes last
 * (`heldBackAccounts`). Empty when the table cannot be read.
 */
export async function readAccountsToTakeLast(
  prisma: Db,
  pass: BackupPass,
): Promise<Map<string, Date>> {
  try {
    const rows = await prisma.backupPassAttempt.findMany({
      where: { pass },
      select: { userId: true, startedAt: true, finishedAt: true },
    });
    return heldBackAccounts(rows);
  } catch {
    return new Map();
  }
}

/**
 * `accounts` in their order, with every held-back one moved behind the
 * rest; among those, the one interrupted longest ago first.
 */
export function orderInterruptedLast<T extends { id: string }>(
  accounts: readonly T[],
  interrupted: ReadonlyMap<string, Date>,
): T[] {
  const clean = accounts.filter((account) => !interrupted.has(account.id));
  const last = accounts
    .filter((account) => interrupted.has(account.id))
    .sort(
      (a, b) =>
        interrupted.get(a.id)!.getTime() - interrupted.get(b.id)!.getTime(),
    );
  return [...clean, ...last];
}

/** What the admin backups page shows about one pass while it runs or after. */
export interface BackupPassActivity {
  /** When the run in progress started; null when none is running. */
  runningSince: string | null;
  /**
   * Accounts whose last attempt started and never finished, oldest first.
   * The account the run in progress is on right now is not among them.
   */
  interrupted: Array<{ userId: string; username: string; startedAt: string }>;
}

export async function readBackupPassActivity(
  prisma: Db & Pick<PrismaClient, "user">,
  pass: BackupPass,
  runningSince: string | null,
): Promise<BackupPassActivity> {
  const attempts = await readInterruptedBackupAttempts(prisma, pass);
  const since = runningSince === null ? null : new Date(runningSince);
  // An attempt the run in progress started is the account it is on now.
  const stuck = [...attempts].filter(
    ([, startedAt]) => since === null || startedAt < since,
  );
  if (stuck.length === 0) return { runningSince, interrupted: [] };
  const names = new Map(
    (
      await prisma.user.findMany({
        where: { id: { in: stuck.map(([userId]) => userId) } },
        select: { id: true, username: true },
      })
    ).map((user) => [user.id, user.username]),
  );
  return {
    runningSince,
    interrupted: stuck
      .filter(([userId]) => names.has(userId))
      .sort(([, a], [, b]) => a.getTime() - b.getTime())
      .map(([userId, startedAt]) => ({
        userId,
        username: names.get(userId)!,
        startedAt: startedAt.toISOString(),
      })),
  };
}
