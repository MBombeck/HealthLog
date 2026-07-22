/**
 * v1.12.0 — pg-boss queue + boot-time self-converging backfill for newly
 * connected Fitbit / Google Health accounts. Modelled on the WHOOP backfill
 * (`src/lib/jobs/whoop-backfill.ts`): a discovery query enqueues one job per
 * connection that has NOT yet been backfilled, and the pass is idempotent
 * across reboots (the predicate `backfill_completed_at IS NULL` drops a
 * connection once its backfill finishes).
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder-worker.ts` or pg-boss never provisions it and the boot
 * enqueue silently never drains (the v1.4.37 dead-queue class).
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { integrationBackfillSourceOptions } from "@/lib/jobs/integration-backfill-admission";
import { syncUserFitbit } from "@/lib/fitbit/sync";

export const FITBIT_BACKFILL_QUEUE = "fitbit-backfill";

/**
 * Serial concurrency — a backfill walks years of history for one account and is
 * rate-bounded by Google's per-app quota; concurrency-1 keeps it from crowding
 * the request pool, matching `WHOOP_BACKFILL_CONCURRENCY`.
 */
export const FITBIT_BACKFILL_CONCURRENCY = 1;

export interface FitbitBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user backfill handler. Runs a full-history sync for one account and stamps
 * `backfillCompletedAt` so the discovery query drops it. Idempotent: the
 * per-resource upserts are key-stable, so a re-run (e.g. a reboot mid-walk)
 * overwrites rather than duplicating. Mirrors `runWhoopBackfillForUser`.
 */
export async function runFitbitBackfillForUser(
  userId: string,
): Promise<{ imported: number }> {
  const imported = await syncUserFitbit(userId, { fullSync: true });

  await prisma.fitbitConnection.update({
    where: { userId },
    data: { backfillCompletedAt: new Date() },
  });

  annotate({
    action: {
      name: "fitbit.backfill.complete",
      details: { imported },
    },
  });
  return { imported };
}

/**
 * Boot-time discovery. Finds every Fitbit connection not yet backfilled
 * (`backfill_completed_at IS NULL`) and enqueues one backfill job per account.
 *
 * Idempotent across reboots: once a connection's backfill completes,
 * `backfillCompletedAt` is set and the predicate drops it from the discovery
 * set. pg-boss `singletonKey` coalesces duplicate sends so a fast restart while
 * a job is queued doesn't double up.
 *
 * Best-effort: errors are returned through the result value so the worker boot
 * never fails because of a backfill miss.
 */
export async function enqueueBootTimeFitbitBackfill(
  startAfterSeconds: number = 0,
): Promise<{
  enqueued: number;
  skipped: number;
  error: string | null;
}> {
  const boss = getGlobalBoss();
  if (!boss) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const connections = await prisma.fitbitConnection.findMany({
      where: { backfillCompletedAt: null },
      select: { userId: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of connections) {
      const payload: FitbitBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        FITBIT_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `fitbit-backfill|${userId}`,
          startAfterSeconds,
        ),
      );
      if (jobId) {
        enqueued += 1;
      } else {
        skipped += 1;
      }
    }
    return { enqueued, skipped, error: null };
  } catch (err) {
    return {
      enqueued: 0,
      skipped: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
