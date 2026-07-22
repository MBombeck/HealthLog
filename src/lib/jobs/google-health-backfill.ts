/**
 * v1.26.0 — pg-boss queue + boot-time self-converging backfill for newly
 * connected Google Health accounts. Modelled on the Fitbit / WHOOP backfill
 * (`src/lib/jobs/fitbit-backfill.ts`): a discovery query enqueues one job per
 * connection that has NOT yet been backfilled, and the pass is idempotent
 * across reboots (the predicate `backfill_completed_at IS NULL` drops a
 * connection once its backfill finishes).
 *
 * The queue name MUST be registered in `allQueues` in
 * `src/lib/jobs/reminder/register-integration-sync.ts` or pg-boss never
 * provisions it and the boot enqueue silently never drains (the v1.4.37
 * dead-queue class).
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { integrationBackfillSourceOptions } from "@/lib/jobs/integration-backfill-admission";
import { isReauthRequired } from "@/lib/integrations/status";
import { GOOGLE_HEALTH_INTEGRATION_KEY } from "@/lib/google-health/sync-core";
import { syncUserGoogleHealth } from "@/lib/google-health/sync";

export const GOOGLE_HEALTH_BACKFILL_QUEUE = "google-health-backfill";

/**
 * Serial concurrency — a backfill walks years of history for one account and is
 * rate-bounded by Google's per-app quota; concurrency-1 keeps it from crowding
 * the request pool, matching `FITBIT_BACKFILL_CONCURRENCY`.
 */
export const GOOGLE_HEALTH_BACKFILL_CONCURRENCY = 1;

export interface GoogleHealthBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user backfill handler. Runs a full-history sync for one account and
 * stamps `backfillCompletedAt` ONLY on a clean run, so the discovery query
 * drops it. Idempotent: the per-resource upserts are key-stable, so a re-run
 * (e.g. a reboot mid-walk) overwrites rather than duplicating. Mirrors
 * `runFitbitBackfillForUser`.
 *
 * Verdict-gated: a partial hard failure (one collection 400ing, a write
 * failing) THROWS so pg-boss retries the job — stamping the marker over a
 * partial walk would freeze the gap in forever. A connection parked at
 * `error_reauth` is NOT clean either, but throwing against a dead grant would
 * just burn the retry budget on the same no-op: return WITHOUT stamping — the
 * boot discovery re-enqueues the account on the next boot, and the stamp lands
 * once the user reconnects and a clean walk completes.
 */
export async function runGoogleHealthBackfillForUser(
  userId: string,
): Promise<{ imported: number }> {
  if (await isReauthRequired(userId, GOOGLE_HEALTH_INTEGRATION_KEY)) {
    annotate({
      action: {
        name: "google_health.backfill.skipped_reauth",
        details: { imported: 0 },
      },
    });
    return { imported: 0 };
  }

  const { imported, failed } = await syncUserGoogleHealth(userId, {
    fullSync: true,
  });

  if (failed) {
    // Surface through the pg-boss retry path (retryLimit 3, backoff). If the
    // failure parked the connection at error_reauth meanwhile, the next
    // attempt takes the reauth return above instead of failing again.
    throw new Error(
      `google-health backfill incomplete for user ${userId} — marker not stamped`,
    );
  }

  await prisma.googleHealthConnection.update({
    where: { userId },
    data: { backfillCompletedAt: new Date() },
  });

  annotate({
    action: {
      name: "google_health.backfill.complete",
      details: { imported },
    },
  });
  return { imported };
}

/**
 * Boot-time discovery. Finds every Google Health connection not yet backfilled
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
export async function enqueueBootTimeGoogleHealthBackfill(
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
    const connections = await prisma.googleHealthConnection.findMany({
      where: { backfillCompletedAt: null },
      select: { userId: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of connections) {
      const payload: GoogleHealthBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        GOOGLE_HEALTH_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `google-health-backfill|${userId}`,
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
