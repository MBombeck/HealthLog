/**
 * Backlog purge of compaction tombstones (v1.42).
 *
 * The dense-intraday retention and the daily-mean consolidation used to
 * soft-delete the raw rows they folded into an hourly or daily `stats:` row.
 * Those tombstones ("class A") never reached a client as a meaningful
 * deletion; they held one thing, a re-upload of a folded sample, which the
 * `folded_window` ingest guard now does from the live `stats:` row. They made
 * up most of the `measurements` table and its indexes. Since v1.42 the folds
 * delete outright; this queue removes what they left behind before.
 *
 * Which tombstone is class A is decided by `findCompactionTombstones`
 * (`folded-window.ts`), the same classifier the sync feed and the restore use:
 * a soft-deleted raw Apple Health sample of a folded type, already past the
 * fold threshold when it was deleted, whose hour or day a live `stats:` row
 * covers. Everything else ("class B": a person's deletions, collision
 * retirements, a dense day still at the pre-hourly daily grain that the
 * one-shot rebuild reads) keeps the 75-day retention of
 * `measurement-tombstone-cleanup.ts` and is never touched here.
 *
 * Shape of a run:
 *   - The tombstones are walked in `(deleted_at, id)` order over the partial
 *     `measurements_tombstone_purge_idx`, narrowed to Apple Health rows of
 *     the folded types, and classified a page at a time with one lookup per
 *     account and page.
 *   - The class-A rows are deleted 5 000 at a time through
 *     `purgeTombstonesByAccount`: one transaction per account per batch,
 *     each starting with `holdAccountAgainstRestore`, so an account under
 *     restore is skipped for the rest of the run and picked up by the next.
 *   - A short pause separates two batches, and at most forty batches run per
 *     job, inside three quarters of the job's expiry.
 *   - The delete predicate is idempotent, so nothing records progress: a run
 *     that stopped early sends a follow-up a minute later, at most
 *     {@link MAX_CONTINUATIONS} in a row and only when it deleted something,
 *     and every boot queues one run.
 *   - Every run reports its outcome per account (`reportJobRun`) and its
 *     totals as job facts.
 *
 * Repair first. Some of these tombstones are the only remaining record of
 * samples whose day an older release folded in two runs, leaving a mean of
 * part of the day (`measurement-fold-repair.ts`). The purge therefore leaves
 * an account alone until the repair has been through it (a
 * `MeasurementFoldRepair` row), and the boot sends no run while no account
 * has one. The repair queues a run as it finishes an account.
 */
import { createHash } from "node:crypto";
import type { Job } from "pg-boss";

import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { reportJobRun, type JobRunCandidate } from "@/lib/jobs/job-run-report";
import { purgeTombstonesByAccount } from "@/lib/jobs/measurement-tombstone-cleanup";
import { PURGE_BATCH_SIZE, PURGE_MAX_BATCHES } from "@/lib/jobs/purge-batch";
import { withBackgroundEvent } from "@/lib/logging/background";
import { resolveUserTimezone } from "@/lib/measurements/consolidation-base";
import {
  FOLDED_TYPES,
  findCompactionTombstones,
} from "@/lib/measurements/folded-window";
import { prisma as defaultPrisma } from "@/lib/db";

export const COMPACTION_TOMBSTONE_PURGE_QUEUE = "compaction-tombstone-purge";

/** One key for every send, so a queued run absorbs a second boot's send. */
export const COMPACTION_TOMBSTONE_PURGE_SINGLETON_KEY =
  "compaction-tombstone-purge";

/** Follow-up runs one chain may send: forty runs of up to 200 000 rows. */
export const MAX_CONTINUATIONS = 40;

/** Delay before a follow-up run, in seconds. */
export const CONTINUATION_DELAY_SECONDS = 60;

/** Pause between two delete batches, in milliseconds. */
export const BATCH_PAUSE_MS = 150;

/** `continuation` is 0 (or absent) for the boot's run. */
export interface CompactionTombstonePurgePayload {
  continuation?: number;
}

export interface CompactionTombstonePurgeOutcome {
  deleted: number;
  /** False when the run stopped at the batch cap or its time budget. */
  drained: boolean;
  /** Accounts skipped for this run because a restore of them was running. */
  deferredAccounts: number;
  /** Tombstones of the folded types the run looked at. */
  scanned: number;
  /** The deferred accounts' ids. Never leaves the process unhashed. */
  deferredUserIds: string[];
  /** Accounts left alone because the fold repair has not finished them. */
  awaitingRepairAccounts: number;
  /** Their ids. Never leaves the process unhashed. */
  awaitingRepairUserIds: string[];
}

export interface PurgeCompactionTombstonesOptions {
  batchSize?: number;
  maxBatches?: number;
  /** Tombstones read per classification page. */
  scanPageSize?: number;
  pauseMs?: number;
  shouldStop?: () => boolean;
}

type ScannedRow = {
  id: string;
  userId: string;
  type: MeasurementType;
  externalId: string | null;
  measuredAt: Date;
  deletedAt: Date | null;
};

/**
 * Delete the class-A tombstones, in batches, one account at a time under the
 * restore lock. See the module comment for the shape of a run.
 */
export async function purgeCompactionTombstones(
  prisma: PrismaClient,
  options: PurgeCompactionTombstonesOptions = {},
): Promise<CompactionTombstonePurgeOutcome> {
  const scanPageSize = options.scanPageSize ?? PURGE_BATCH_SIZE;
  const pauseMs = options.pauseMs ?? BATCH_PAUSE_MS;
  const timezoneOf = new Map<string, string>();
  const repaired = new Map<string, boolean>();
  const awaitingRepair = new Set<string>();
  let scanned = 0;

  // The walk's position. Rows behind it are classified; the class-A ones wait
  // in `ready` until a batch takes them.
  let cursor: { deletedAt: Date; id: string } | null = null;
  let exhausted = false;
  let ready: Array<{ id: string; userId: string }> = [];

  async function timezoneFor(userIds: string[]): Promise<void> {
    const missing = userIds.filter((id) => !timezoneOf.has(id));
    if (missing.length === 0) return;
    const users = await prisma.user.findMany({
      where: { id: { in: missing } },
      select: { id: true, timezone: true },
    });
    for (const user of users) {
      timezoneOf.set(user.id, resolveUserTimezone(user.timezone));
    }
  }

  async function loadRepaired(userIds: string[]): Promise<void> {
    const missing = userIds.filter((id) => !repaired.has(id));
    if (missing.length === 0) return;
    const rows = await prisma.measurementFoldRepair.findMany({
      where: { userId: { in: missing } },
      select: { userId: true },
    });
    const done = new Set(rows.map((row) => row.userId));
    for (const id of missing) repaired.set(id, done.has(id));
  }

  async function classifyNextPage(skipUserIds: ReadonlySet<string>) {
    const page: ScannedRow[] = await prisma.measurement.findMany({
      where: {
        deletedAt: { not: null },
        source: "APPLE_HEALTH",
        type: { in: [...FOLDED_TYPES] },
        NOT: { externalId: { startsWith: "stats:" } },
        ...(cursor
          ? {
              OR: [
                { deletedAt: { gt: cursor.deletedAt } },
                { deletedAt: cursor.deletedAt, id: { gt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ deletedAt: "asc" }, { id: "asc" }],
      take: scanPageSize,
      select: {
        id: true,
        userId: true,
        type: true,
        externalId: true,
        measuredAt: true,
        deletedAt: true,
      },
    });
    scanned += page.length;
    if (page.length < scanPageSize) exhausted = true;
    const last = page[page.length - 1];
    if (last?.deletedAt) cursor = { deletedAt: last.deletedAt, id: last.id };

    const byAccount = new Map<string, ScannedRow[]>();
    for (const row of page) {
      if (skipUserIds.has(row.userId)) continue;
      const rows = byAccount.get(row.userId);
      if (rows) rows.push(row);
      else byAccount.set(row.userId, [row]);
    }
    await timezoneFor([...byAccount.keys()]);
    await loadRepaired([...byAccount.keys()]);
    for (const [userId, rows] of byAccount) {
      // The repair reads these tombstones; nothing goes before it has run.
      if (!repaired.get(userId)) {
        awaitingRepair.add(userId);
        continue;
      }
      const tz = timezoneOf.get(userId);
      // An account deleted since the page was read has nothing left to purge.
      if (!tz) continue;
      const classA = await findCompactionTombstones(
        prisma,
        userId,
        tz,
        rows.map((row) => ({
          type: row.type,
          source: "APPLE_HEALTH" as const,
          externalId: row.externalId,
          measuredAt: row.measuredAt,
          deletedAt: row.deletedAt,
        })),
      );
      for (const index of classA) ready.push({ id: rows[index].id, userId });
    }
  }

  const outcome = await purgeTombstonesByAccount({
    prisma,
    batchSize: options.batchSize ?? PURGE_BATCH_SIZE,
    maxBatches: options.maxBatches ?? PURGE_MAX_BATCHES,
    shouldStop: options.shouldStop,
    betweenBatches:
      pauseMs > 0
        ? () => new Promise((resolve) => setTimeout(resolve, pauseMs))
        : undefined,
    findRows: async (take, skipUserIds) => {
      const skip = new Set(skipUserIds);
      ready = ready.filter((row) => !skip.has(row.userId));
      while (ready.length < take && !exhausted) {
        if (options.shouldStop?.()) break;
        await classifyNextPage(skip);
      }
      return ready.splice(0, take);
    },
    deleteIds: async (tx, ids) => {
      // Re-checked at delete time: a row a restore wrote back, or one a
      // person resurrected since the scan, is not a tombstone any more.
      const result = await tx.measurement.deleteMany({
        where: {
          id: { in: ids },
          deletedAt: { not: null },
          source: "APPLE_HEALTH",
        },
      });
      return result.count;
    },
  });

  return {
    deleted: outcome.deleted,
    // A run the time budget stopped mid-scan has not seen every tombstone.
    drained: outcome.drained && exhausted,
    deferredAccounts: outcome.deferredAccounts,
    scanned,
    deferredUserIds: outcome.deferredUserIds,
    awaitingRepairAccounts: awaitingRepair.size,
    awaitingRepairUserIds: [...awaitingRepair],
  };
}

/** A stable, non-identifying key for one account in the run report. */
function accountKey(userId: string): string {
  return createHash("sha256").update(userId).digest("hex").slice(0, 12);
}

/**
 * One purge run. The run's totals go out as job facts and on the run's wide
 * event; the run report lists the accounts a restore made it skip, by hashed
 * key, so a deferral that repeats run after run is visible.
 */
export async function handleCompactionTombstonePurge(
  jobs: Job<CompactionTombstonePurgePayload>[],
  prisma: PrismaClient = defaultPrisma,
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  const continuation = Math.max(
    0,
    ...jobs.map((job) => job.data?.continuation ?? 0),
  );
  return withBackgroundEvent("job.compaction_tombstone_purge", async (evt) => {
    const startedAt = Date.now();
    const result = await purgeCompactionTombstones(prisma, { shouldStop });
    const candidates: JobRunCandidate[] = [
      ...result.deferredUserIds.map((userId): JobRunCandidate => ({
        key: accountKey(userId),
        outcome: "deferred",
        cause: "restore_in_progress",
      })),
      ...result.awaitingRepairUserIds.map((userId): JobRunCandidate => ({
        key: accountKey(userId),
        outcome: "skipped",
        cause: "awaiting_fold_repair",
      })),
    ];
    reportJobRun({
      queue: COMPACTION_TOMBSTONE_PURGE_QUEUE,
      runId: jobs[0]?.id ?? "unknown",
      candidates,
    });
    evt.addMeta("compaction_purge_deleted", result.deleted);
    evt.addMeta("compaction_purge_scanned", result.scanned);
    evt.addMeta("compaction_purge_drained", result.drained);
    evt.addMeta("compaction_purge_deferred_accounts", result.deferredAccounts);
    evt.addMeta("compaction_purge_continuation", continuation);
    evt.addMeta(
      "compaction_purge_awaiting_repair_accounts",
      result.awaitingRepairAccounts,
    );

    // A run that stopped with work left sends the next one, but only when it
    // made progress, so a run that cannot delete anything cannot loop.
    let continued = false;
    if (
      !result.drained &&
      result.deleted > 0 &&
      continuation < MAX_CONTINUATIONS
    ) {
      const boss = getGlobalBoss();
      if (boss) {
        await boss.send(
          COMPACTION_TOMBSTONE_PURGE_QUEUE,
          { continuation: continuation + 1 },
          {
            singletonKey: COMPACTION_TOMBSTONE_PURGE_SINGLETON_KEY,
            startAfter: CONTINUATION_DELAY_SECONDS,
            retryLimit: 0,
          },
        );
        continued = true;
      }
    } else if (!result.drained) {
      evt.addWarning(
        "compaction-tombstone-purge stopped with a backlog and sent no follow-up; the next boot resumes it",
      );
    }

    return jobDone({
      deleted: result.deleted,
      candidates_scanned: result.scanned,
      drained: result.drained,
      deferred_accounts: result.deferredAccounts,
      continuation,
      continued,
      duration_ms: Date.now() - startedAt,
    });
  });
}

/**
 * Queue one purge run when the worker boots. The run is self-limiting and
 * idempotent, so a boot that finds no backlog costs one cheap scan. While the
 * fold repair has finished no account, there is nothing the run may delete,
 * so none is sent; the repair sends one as it finishes an account.
 */
export async function enqueueBootTimeCompactionTombstonePurge(
  prisma: Pick<PrismaClient, "measurementFoldRepair"> = defaultPrisma,
): Promise<{
  enqueued: boolean;
}> {
  const boss = getGlobalBoss();
  if (!boss) return { enqueued: false };
  const anyRepaired = await prisma.measurementFoldRepair.findFirst({
    select: { userId: true },
  });
  if (!anyRepaired) return { enqueued: false };
  const id = await boss.send(
    COMPACTION_TOMBSTONE_PURGE_QUEUE,
    { continuation: 0 },
    {
      singletonKey: COMPACTION_TOMBSTONE_PURGE_SINGLETON_KEY,
      retryLimit: 0,
    },
  );
  return { enqueued: id !== null };
}
