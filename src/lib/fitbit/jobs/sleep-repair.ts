/**
 * pg-boss queue + boot-time one-shot sleep duplicate repair for Fitbit
 * connections. Modelled on the Google Health sleep repair
 * (`src/lib/jobs/google-health-sleep-repair.ts`) and the self-converging
 * backfill: a discovery query enqueues one job per connection not yet repaired,
 * and the pass is idempotent across reboots (the predicate
 * `sleep_repaired_at IS NULL` drops a connection once its repair finishes).
 *
 * Why: the earlier Fitbit sleep externalId carried a positional segment index
 * and the stage label, so every re-score of a night minted fresh keys, stranded
 * the previous scoring's rows, and over-counted the night total. The fix
 * (`replaceStaleFitbitSleep` plus the stable segment-start key) makes any
 * RE-READ night self-heal, and the incremental 24 h overlap heals recent nights
 * — but historical nights keep their duplicates until re-read. This job forces
 * one bounded sleep-history re-read per connection so the replace-by-window
 * collapses each night once.
 *
 * BOUNDED WALK: unlike the Google repair (whose API pages the whole history),
 * the classic Fitbit sleep endpoint caps each request at 30 days and the
 * per-user budget is tight, so the repair passes an explicit
 * `start = now − FITBIT_BACKFILL_DAYS` — the same 365-day horizon the backfill
 * documents as the recovery limit, about a dozen requests per account. Nights
 * older than that keep their old keys and any duplicates already recorded; they
 * can no longer accrue new ones, because Fitbit does not re-score year-old
 * nights. The explicit `start` is REQUIRED: `syncUserSleep`'s own default is
 * only 30 days.
 *
 * Watermark-safe by construction: `syncUserSleep` never reads or stamps
 * `lastSyncedAt` — `markSynced` is owned by the orchestrator (`syncUserFitbit`),
 * which this job does not call.
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
  FITBIT_BACKFILL_DAYS,
  FITBIT_TOKEN_HARD_FAIL,
  runWithFitbitHardFailLedger,
} from "@/lib/fitbit/sync-core";
import { syncUserSleep } from "@/lib/fitbit/sync-sleep";
import { isFitbitRetired } from "@/lib/fitbit/retirement";
import { FITBIT_SLEEP_REPAIR_QUEUE } from "./queues";
import { OWNED_BY_ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";

export interface FitbitSleepRepairPayload {
  userId: string;
  enqueuedAt: string;
}

/**
 * Per-user repair handler. Re-reads the bounded sleep history for one account —
 * `replaceStaleFitbitSleep` collapses each night's leftovers in the write path
 * and the natural-key rescue re-keys the survivors — then stamps
 * `sleepRepairedAt` so the discovery query drops it. Idempotent: the per-segment
 * upserts are key-stable and the replace-by-window clears stale copies, so a
 * re-run (e.g. a reboot mid-walk) converges rather than duplicating. Does NOT
 * move `lastSyncedAt`.
 *
 * Verdict-gated: `syncUserSleep` swallows fetch/write hard failures into the
 * ambient hard-fail ledger (returning a count either way), so the repair runs it
 * inside its own ledger scope — the same mechanism `syncUserFitbit` uses for its
 * cycle verdict — and stamps `sleepRepairedAt` ONLY on a clean run. A hard
 * fetch/write failure THROWS so pg-boss retries; a dead token (parked
 * connection, missing credentials, failed refresh) is NOT clean but does not
 * throw — retrying a dead grant burns the retry budget on the same no-op. It
 * returns WITHOUT stamping instead: the boot discovery re-enqueues the account
 * on the next boot, and the stamp lands after a reconnect.
 */
export async function runFitbitSleepRepairForUser(
  userId: string,
): Promise<{ imported: number; removed: number }> {
  // Nothing left to re-read once the Web API is gone; no stamp either.
  if (isFitbitRetired()) {
    annotate({
      action: {
        name: "fitbit.sleepRepair.skipped_retired",
        details: { imported: 0, removed: 0 },
      },
    });
    return { imported: 0, removed: 0 };
  }
  if (await isReauthRequired(userId, "fitbit")) {
    annotate({
      action: {
        name: "fitbit.sleepRepair.skipped_reauth",
        details: { imported: 0, removed: 0 },
      },
    });
    return { imported: 0, removed: 0 };
  }

  const start = new Date(
    Date.now() - FITBIT_BACKFILL_DAYS * 24 * 60 * 60 * 1000,
  );

  const {
    result: imported,
    failures,
    sleepRemoved: removed,
  } = await runWithFitbitHardFailLedger(() =>
    syncUserSleep(userId, { start, deferRollup: false }),
  );

  if (failures.length > 0) {
    if (failures.every((f) => f === FITBIT_TOKEN_HARD_FAIL)) {
      // Dead token: nothing was fetched, so nothing to retry until the user
      // reconnects. No stamp — the next boot's discovery picks it back up.
      annotate({
        action: {
          name: "fitbit.sleepRepair.skipped_token",
          details: { imported, removed },
        },
      });
      return { imported, removed };
    }
    throw new Error(
      `fitbit sleep repair incomplete for user ${userId} (${failures.join(", ")}) — marker not stamped`,
    );
  }

  await prisma.fitbitConnection.update({
    where: { userId },
    data: { sleepRepairedAt: new Date() },
  });

  annotate({
    action: {
      name: "fitbit.sleepRepair.complete",
      details: { imported, removed },
    },
  });
  return { imported, removed };
}

/**
 * Boot-time discovery. Finds every Fitbit connection not yet repaired
 * (`sleep_repaired_at IS NULL`) and enqueues one repair job per account.
 *
 * Idempotent across reboots: once a connection's repair completes,
 * `sleepRepairedAt` is set and the predicate drops it from the discovery set.
 * pg-boss `singletonKey` coalesces duplicate sends so a fast restart while a job
 * is queued doesn't double up.
 *
 * Best-effort: errors are returned through the result value so the worker boot
 * never fails because of a repair miss.
 */
export async function enqueueBootTimeFitbitSleepRepair(
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
      where: { sleepRepairedAt: null, ...OWNED_BY_ACTIVE_ACCOUNT },
      select: { userId: true },
    });

    if (connections.length === 0) {
      return { enqueued: 0, skipped: 0, error: null };
    }

    let enqueued = 0;
    let skipped = 0;
    for (const { userId } of connections) {
      const payload: FitbitSleepRepairPayload = {
        userId,
        enqueuedAt: new Date().toISOString(),
      };
      const jobId = await boss.send(
        FITBIT_SLEEP_REPAIR_QUEUE,
        payload,
        integrationBackfillSourceOptions(
          `fitbit-sleep-repair|${userId}`,
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
