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
import { isReauthRequired } from "@/lib/integrations/status";
import {
  backfillVerdict,
  withPageWalkLedger,
} from "@/lib/integrations/page-walk";
import { syncUserFitbit } from "@/lib/fitbit/sync";
import { isFitbitRetired } from "@/lib/fitbit/retirement";
import { FITBIT_BACKFILL_QUEUE } from "./queues";
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";

export interface FitbitBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user backfill handler. Runs a full-history sync for one account and stamps
 * `backfillCompletedAt` ONLY on a clean run, so the discovery query drops it.
 * Idempotent: the per-resource upserts are key-stable, so a re-run (e.g. a
 * reboot mid-walk) overwrites rather than duplicating. Mirrors
 * `runWhoopBackfillForUser` (whose identical unconditional-stamp bug is fixed
 * separately — this is the template for that port).
 *
 * Verdict-gated (`backfillVerdict`, `integrations/page-walk.ts`): a partial
 * hard failure (one collection 400ing, a write failing, a dead token) THROWS
 * so pg-boss retries the job — stamping the marker over a partial walk would
 * freeze the history gap in forever and the configured `retryLimit` would be
 * dead code. A collection whose walk reached its page ceiling leaves the
 * marker unset WITHOUT a retry: nothing failed, and boot discovery offers the
 * account again. A connection parked at `error_reauth` is NOT clean either,
 * but throwing against a dead grant would just burn the retry budget on the
 * same no-op: return WITHOUT stamping — the boot discovery re-enqueues the
 * account on the next boot, and the stamp lands once the user reconnects and
 * a clean walk completes.
 */
export async function runFitbitBackfillForUser(
  userId: string,
): Promise<{ imported: number }> {
  // A job queued before the turndown: the history it would walk is gone with
  // the API. Returns without stamping, so the marker never claims a walk.
  if (isFitbitRetired()) {
    annotate({
      action: {
        name: "fitbit.backfill.skipped_retired",
        details: { imported: 0 },
      },
    });
    return { imported: 0 };
  }
  if (await isReauthRequired(userId, "fitbit")) {
    annotate({
      action: {
        name: "fitbit.backfill.skipped_reauth",
        details: { imported: 0 },
      },
    });
    return { imported: 0 };
  }

  const {
    result: { imported, failed },
    truncated,
  } = await withPageWalkLedger(() =>
    syncUserFitbit(userId, { fullSync: true }),
  );
  const verdict = backfillVerdict({ failed, truncated });

  if (verdict === "incomplete") {
    // A collection longer than its walk may read in one run: the history is
    // not complete, but nothing failed, so no retry. Boot discovery offers
    // the account again while the marker stays unset.
    annotate({
      action: {
        name: "fitbit.backfill.truncated",
        details: { imported, collections: truncated.join(",") },
      },
    });
    return { imported };
  }

  if (verdict === "retry") {
    // Surface through the pg-boss retry path (retryLimit 3, backoff, set by
    // `integrationBackfillSourceOptions`). If the failure parked the connection
    // at error_reauth meanwhile, the next attempt takes the reauth return above
    // instead of failing again.
    throw new Error(
      `fitbit backfill incomplete for user ${userId} — marker not stamped`,
    );
  }

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
  if (!boss || isFitbitRetired()) {
    return { enqueued: 0, skipped: 0, error: null };
  }

  try {
    const connections = await prisma.fitbitConnection.findMany({
      where: { backfillCompletedAt: null, ...OWNED_BY_ACTIVE_ACCOUNT },
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
