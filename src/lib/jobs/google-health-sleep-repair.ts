/**
 * v1.28.x — pg-boss queue + boot-time one-shot sleep duplicate repair for
 * Google Health connections. Modelled on the self-converging backfill
 * (`src/lib/jobs/google-health-backfill.ts`): a discovery query enqueues one
 * job per connection not yet repaired, and the pass is idempotent across
 * reboots (the predicate `sleep_repaired_at IS NULL` drops a connection once
 * its repair finishes).
 *
 * Why: the pre-v1.28.18 volatile sleep externalId minted parallel duplicate
 * rows every time Google re-scored a night, over-counting the night total.
 * The fix (`replaceStaleGoogleHealthSleep`) makes any RE-READ night self-heal,
 * and the incremental 24 h overlap heals recent nights — but historical nights
 * keep their duplicates until re-read. This job forces one full sleep-history
 * re-read per connection so the replace-by-window collapses every night once.
 *
 * Watermark-safe by construction: `syncUserSleep` never reads or stamps
 * `lastSyncedAt` — `markSynced` is owned by the orchestrator
 * (`syncUserGoogleHealth`), which this job does not call. Passing no `start`
 * makes the resource fetch full-history (undefined = no lower bound).
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
import {
  GOOGLE_HEALTH_INTEGRATION_KEY,
  GOOGLE_HEALTH_TOKEN_HARD_FAIL,
  runWithGoogleHealthHardFailLedger,
} from "@/lib/google-health/sync-core";
import { syncUserSleep } from "@/lib/google-health/sync-sleep";

export const GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE = "google-health-sleep-repair";

/**
 * Serial concurrency — a repair walks the full sleep history for one account
 * and is rate-bounded by Google's per-app quota; concurrency-1 keeps it from
 * crowding the request pool, matching `GOOGLE_HEALTH_BACKFILL_CONCURRENCY`.
 */
export const GOOGLE_HEALTH_SLEEP_REPAIR_CONCURRENCY = 1;

export interface GoogleHealthSleepRepairPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user repair handler. Runs a full sleep-history re-sync for one account —
 * no `start`, so the fetch walks the whole history and
 * `replaceStaleGoogleHealthSleep` collapses each night's duplicates in the
 * write path — then stamps `sleepRepairedAt` so the discovery query drops it.
 * Idempotent: the per-segment upserts are key-stable and the replace-by-window
 * clears stale copies, so a re-run (e.g. a reboot mid-walk) converges rather
 * than duplicating. Does NOT move `lastSyncedAt`.
 *
 * Verdict-gated: `syncUserSleep` swallows fetch/write hard failures into the
 * ambient hard-fail ledger (returning a count either way), so the repair runs
 * it inside its own ledger scope — the same mechanism `syncUserGoogleHealth`
 * uses for its cycle verdict — and stamps `sleepRepairedAt` ONLY on a clean
 * run. A hard fetch/write failure THROWS so pg-boss retries; a dead token
 * (parked connection, missing credentials, failed refresh) is NOT clean but
 * does not throw — retrying a dead grant burns the retry budget on the same
 * no-op. It returns WITHOUT stamping instead: the boot discovery re-enqueues
 * the account on the next boot, and the stamp lands after a reconnect.
 */
export async function runGoogleHealthSleepRepairForUser(
  userId: string,
): Promise<{ imported: number }> {
  if (await isReauthRequired(userId, GOOGLE_HEALTH_INTEGRATION_KEY)) {
    annotate({
      action: {
        name: "googleHealth.sleepRepair.skipped_reauth",
        details: { imported: 0 },
      },
    });
    return { imported: 0 };
  }

  const { result: imported, failures } =
    await runWithGoogleHealthHardFailLedger(() =>
      syncUserSleep(userId, { deferRollup: false }),
    );

  if (failures.length > 0) {
    if (failures.every((f) => f === GOOGLE_HEALTH_TOKEN_HARD_FAIL)) {
      // Dead token: nothing was fetched, so nothing to retry until the user
      // reconnects. No stamp — the next boot's discovery picks it back up.
      annotate({
        action: {
          name: "googleHealth.sleepRepair.skipped_token",
          details: { imported },
        },
      });
      return { imported };
    }
    throw new Error(
      `google-health sleep repair incomplete for user ${userId} (${failures.join(", ")}) — marker not stamped`,
    );
  }

  await prisma.googleHealthConnection.update({
    where: { userId },
    data: { sleepRepairedAt: new Date() },
  });

  annotate({
    action: {
      name: "googleHealth.sleepRepair.complete",
      details: { imported },
    },
  });
  return { imported };
}

/**
 * Boot-time discovery. Finds every Google Health connection not yet repaired
 * (`sleep_repaired_at IS NULL`) and enqueues one repair job per account.
 *
 * Idempotent across reboots: once a connection's repair completes,
 * `sleepRepairedAt` is set and the predicate drops it from the discovery set.
 * pg-boss `singletonKey` coalesces duplicate sends so a fast restart while a
 * job is queued doesn't double up.
 *
 * Best-effort: errors are returned through the result value so the worker boot
 * never fails because of a repair miss.
 */
export async function enqueueBootTimeGoogleHealthSleepRepair(
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
      where: { sleepRepairedAt: null },
      select: { userId: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of connections) {
      const payload: GoogleHealthSleepRepairPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `google-health-sleep-repair|${userId}`,
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
