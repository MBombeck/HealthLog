/**
 * v1.28.x — pg-boss queue + boot-time self-converging backfill for newly
 * connected Strava accounts. Modelled on the WHOOP / Fitbit backfill: a
 * discovery query enqueues one job per connection that has NOT yet been
 * backfilled, and the pass is idempotent across reboots (the predicate
 * `strava_backfill_completed_at IS NULL` drops a connection once its backfill
 * finishes).
 *
 * Unlike WHOOP/Fitbit (which carry the marker on a dedicated connection table),
 * Strava rides `User` columns like Oura/Polar, so the marker is
 * `User.stravaBackfillCompletedAt`.
 *
 * The queue name MUST be registered in `allQueues` in
 * `register-integration-sync.ts` or pg-boss never provisions it and the boot
 * enqueue silently never drains (the v1.4.37 dead-queue class).
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { integrationBackfillSourceOptions } from "@/lib/jobs/integration-backfill-admission";
import { syncUserStrava } from "@/lib/strava/sync";

export const STRAVA_BACKFILL_QUEUE = "strava-backfill";

/**
 * Serial concurrency — a backfill walks the account's activity history and is
 * rate-bounded by Strava's 200-req / 15-min cap; concurrency-1 keeps it from
 * crowding the request pool, matching `WHOOP_BACKFILL_CONCURRENCY`.
 */
export const STRAVA_BACKFILL_CONCURRENCY = 1;

export interface StravaBackfillPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user backfill handler. Runs a full-history sync for one account and
 * stamps `stravaBackfillCompletedAt` so the discovery query drops it.
 * Idempotent: the `(userId, source, externalId)` workout upsert is key-stable,
 * so a re-run (e.g. a reboot mid-walk) overwrites rather than duplicating.
 */
export async function runStravaBackfillForUser(
  userId: string,
): Promise<{ imported: number }> {
  const imported = await syncUserStrava(userId, { fullSync: true });

  await prisma.user.update({
    where: { id: userId },
    data: { stravaBackfillCompletedAt: new Date() },
  });

  annotate({
    action: {
      name: "strava.backfill.complete",
      details: { imported },
    },
  });
  return { imported };
}

/**
 * Boot-time discovery. Finds every Strava connection not yet backfilled
 * (a stored access token + `strava_backfill_completed_at IS NULL`) and enqueues
 * one backfill job per account.
 *
 * Idempotent across reboots: once a connection's backfill completes,
 * `stravaBackfillCompletedAt` is set and the predicate drops it. pg-boss
 * `singletonKey` coalesces duplicate sends so a fast restart while a job is
 * queued doesn't double up.
 *
 * Best-effort: errors come back through the result value so the worker boot
 * never fails because of a backfill miss.
 */
export async function enqueueBootTimeStravaBackfill(
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
    const connections = await prisma.user.findMany({
      where: {
        stravaAccessTokenEncrypted: { not: null },
        stravaBackfillCompletedAt: null,
      },
      select: { id: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { id: userId } of connections) {
      const payload: StravaBackfillPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        STRAVA_BACKFILL_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `strava-backfill|${userId}`,
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
