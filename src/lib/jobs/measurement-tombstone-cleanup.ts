/**
 * Daily prune for soft-deleted rows across the sync domains (v1.7.0):
 * `measurements`, `mood_entries`, and `medication_intake_events`.
 *
 * The user-facing DELETE routes on all three domains soft-delete (set
 * `deletedAt`) so the `/api/sync/changes` delta feed can surface deletions
 * as tombstones to paired clients that were offline at delete time. A
 * tombstone only needs to outlive the device's refresh-token lifetime plus
 * a margin: a device offline longer than that has lost its refresh token
 * and re-pairs with a full backfill (not an incremental delta), so it
 * never relies on the tombstone. Past the retention horizon the row is
 * hard-deleted to reclaim storage; the `/api/sync/changes` route emits
 * `cursorExpired` for any cursor that predates the same horizon so a
 * long-offline client re-inits cleanly rather than silently missing the
 * pruned deletion.
 *
 * Retention is keyed to `TOMBSTONE_RETENTION_DAYS`
 * (`NATIVE_REFRESH_TOKEN_DAYS` + margin) so it moves automatically if the
 * refresh-token lifetime changes — the two never drift.
 */
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { TOMBSTONE_RETENTION_DAYS } from "@/lib/auth/native-client";
import {
  AccountRestoreInProgressError,
  holdAccountAgainstRestore,
} from "@/lib/export/restore-lock";
import {
  PURGE_BATCH_SIZE,
  PURGE_MAX_BATCHES,
  type PurgeOutcome,
} from "@/lib/jobs/purge-batch";

const DAY_MS = 86_400_000;

function tombstoneCutoff(now: Date): Date {
  return new Date(now.getTime() - TOMBSTONE_RETENTION_DAYS * DAY_MS);
}

/** A purge run, plus the accounts it left for the next run. */
export interface TombstonePurgeOutcome extends PurgeOutcome {
  /**
   * Accounts whose tombstones were left in place because a restore of the
   * account was running. The next night purges them.
   */
  deferredAccounts: number;
  /** The accounts behind `deferredAccounts`, for a per-account run report. */
  deferredUserIds: string[];
}

type TombstoneRow = { id: string; userId: string };

export interface TombstonePurgeOptions {
  prisma: PrismaClient;
  /** Up to `take` expired tombstones, none of them owned by `skipUserIds`. */
  findRows: (take: number, skipUserIds: string[]) => Promise<TombstoneRow[]>;
  /**
   * Remove exactly those ids of `userId` inside `tx`; returns the rows
   * removed. Runs after the restore lock, so a caller that needs a further
   * per-account lock takes it here.
   */
  deleteIds: (
    tx: Prisma.TransactionClient,
    ids: string[],
    userId: string,
  ) => Promise<number>;
  batchSize?: number;
  maxBatches?: number;
  /**
   * Awaited between two batches. The compaction-tombstone backlog purge uses
   * it to pause, so a run of forty batches does not hold the disk and the WAL
   * at full rate for its whole length.
   */
  betweenBatches?: () => Promise<void>;
  /**
   * Ends the walk before the next batch when it returns `true`; the outcome
   * then reports `drained: false`, exactly like a run that hit the batch cap.
   */
  shouldStop?: () => boolean;
}

/**
 * Walk the expired tombstones in bounded batches, deleting each batch one
 * account at a time under the account's restore lock.
 *
 * A restore clears every row of the account, tombstones included, in one
 * long transaction. The purge used to delete a batch spanning accounts in one
 * statement, so on an account under restore it waited on the restore's row
 * locks, for as long as the restore ran and well past `statement_timeout`,
 * or, holding some of the account's rows while the restore held others,
 * deadlocked with it. So each account's share of a batch is deleted in a
 * transaction that first takes the restore lock in shared mode, the way the
 * consolidation passes do (`restore-lock.ts`). An account under restore is
 * refused at once, dropped from the rest of the run, and purged the next
 * night, when its tombstones are whatever the restore left.
 *
 * Still one delete statement per account per batch, never one per row.
 */
export async function purgeTombstonesByAccount({
  prisma,
  findRows,
  deleteIds,
  batchSize = PURGE_BATCH_SIZE,
  maxBatches = PURGE_MAX_BATCHES,
  betweenBatches,
  shouldStop,
}: TombstonePurgeOptions): Promise<TombstonePurgeOutcome> {
  let deleted = 0;
  const deferred = new Set<string>();
  const outcome = (drained: boolean): TombstonePurgeOutcome => ({
    deleted,
    drained,
    deferredAccounts: deferred.size,
    deferredUserIds: [...deferred],
  });

  for (let batch = 0; batch < maxBatches; batch++) {
    if (batch > 0) {
      if (shouldStop?.()) return outcome(false);
      await betweenBatches?.();
    }
    const rows = await findRows(batchSize, [...deferred]);
    if (rows.length === 0) return outcome(true);

    const byAccount = new Map<string, string[]>();
    for (const row of rows) {
      const ids = byAccount.get(row.userId);
      if (ids) ids.push(row.id);
      else byAccount.set(row.userId, [row.id]);
    }
    for (const [userId, ids] of byAccount) {
      try {
        deleted += await prisma.$transaction(
          async (tx) => {
            await holdAccountAgainstRestore(tx, userId);
            return deleteIds(tx, ids, userId);
          },
          // A full batch of one account is one statement over thousands of
          // rows; the interactive default of five seconds is too tight for
          // it on a slow disk. The connection's statement_timeout bounds it.
          { timeout: 60_000 },
        );
      } catch (err) {
        if (!(err instanceof AccountRestoreInProgressError)) throw err;
        deferred.add(userId);
      }
    }

    // A short batch means the predicate is exhausted, the deferred accounts
    // aside; asking again would cost a round-trip to learn nothing.
    if (rows.length < batchSize) return outcome(true);
  }

  return outcome(false);
}

/** The retention predicate, minus the accounts a run has deferred. */
function expiredTombstones(cutoff: Date, skipUserIds: string[]) {
  return {
    deletedAt: { not: null, lt: cutoff },
    ...(skipUserIds.length > 0 ? { userId: { notIn: skipUserIds } } : {}),
  };
}

/**
 * Hard-delete soft-deleted measurement rows whose `deletedAt` is older than
 * the retention horizon.
 *
 * Batched. Until v1.33.0 this was one unbounded `deleteMany` over a predicate
 * that no index supported, which meant a backlog large enough to exceed the
 * 60-second `statement_timeout` could never be drained: the statement aborted,
 * the transaction rolled back, and the next night ran the identical statement
 * against the same rows. `measurements` is the densest table in the schema and
 * a bulk source delete can tombstone a six-figure row count in one action, so
 * this is the one most likely to have been stuck. Migration 0276 adds the
 * partial index the predicate needs.
 */
export async function cleanupExpiredMeasurementTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<TombstonePurgeOutcome> {
  const cutoff = tombstoneCutoff(now);
  return purgeTombstonesByAccount({
    prisma,
    findRows: (take, skipUserIds) =>
      prisma.measurement.findMany({
        where: expiredTombstones(cutoff, skipUserIds),
        select: { id: true, userId: true },
        take,
      }),
    deleteIds: async (tx, ids) =>
      (await tx.measurement.deleteMany({ where: { id: { in: ids } } })).count,
  });
}

/** Hard-delete soft-deleted mood-entry rows past the retention horizon. */
export async function cleanupExpiredMoodTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<TombstonePurgeOutcome> {
  const cutoff = tombstoneCutoff(now);
  return purgeTombstonesByAccount({
    prisma,
    findRows: (take, skipUserIds) =>
      prisma.moodEntry.findMany({
        where: expiredTombstones(cutoff, skipUserIds),
        select: { id: true, userId: true },
        take,
      }),
    deleteIds: async (tx, ids) =>
      (await tx.moodEntry.deleteMany({ where: { id: { in: ids } } })).count,
  });
}

/**
 * Hard-delete soft-deleted medication-intake-event rows past the retention
 * horizon.
 */
export async function cleanupExpiredIntakeTombstones(
  prisma: PrismaClient,
  now: Date = new Date(),
): Promise<TombstonePurgeOutcome> {
  const cutoff = tombstoneCutoff(now);
  return purgeTombstonesByAccount({
    prisma,
    findRows: (take, skipUserIds) =>
      prisma.medicationIntakeEvent.findMany({
        where: expiredTombstones(cutoff, skipUserIds),
        select: { id: true, userId: true },
        take,
      }),
    deleteIds: async (tx, ids) =>
      (
        await tx.medicationIntakeEvent.deleteMany({
          where: { id: { in: ids } },
        })
      ).count,
  });
}
