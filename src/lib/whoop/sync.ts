/**
 * WHOOP sync orchestrator.
 *
 * Shared token, cursor, upsert, status, and failure helpers live in
 * `sync-core.ts`. Resource leaves depend only on that core; this parent owns
 * the static leaf graph and the full per-user sequencing policy.
 */
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { noteBackfillFailure } from "@/lib/integrations/page-walk";
import { getEvent } from "@/lib/logging/context";
import {
  isReauthRequired,
  isSyncFailureRecorded,
  recordSyncSuccess,
} from "@/lib/integrations/status";
import { syncUserRecovery } from "./sync-recovery";
import { syncUserSleep } from "./sync-sleep";
import { syncUserCycle } from "./sync-cycle";
import { syncUserWorkout } from "./sync-workout";
import { syncUserBody } from "./sync-body";
import {
  hardFailStorage,
  recordWhoopSyncFailure,
  runWithWhoopSoftSkipTracking,
  type HardFailTracker,
} from "./sync-core";

/**
 * Full per-user sync across every WHOOP resource. Webhook-driven syncs enqueue
 * a single per-resource job; this drives the hourly poll catch-all and the
 * manual `/api/whoop/sync` trigger.
 *
 * Parks immediately when the connection is at `error_reauth` (the user must
 * reconnect first) — returns `{ imported: 0, failed: true }`, so the backfill
 * caller can gate its marker.
 */
export async function syncUserWhoop(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<{ imported: number; failed: boolean }> {
  if (await isReauthRequired(userId, "whoop")) {
    getEvent()?.addWarning(
      `whoop sync skipped for ${userId}: parked at error_reauth`,
    );
    return { imported: 0, failed: true };
  }

  const resources = [
    syncUserRecovery,
    syncUserSleep,
    syncUserCycle,
    syncUserWorkout,
    syncUserBody,
  ];

  let anyFailed = false;
  // Nest the hard-fail ledger inside the soft-skip tracker (manual nest, not a
  // combined wrapper) so a dead token noted by `getValidToken` — or a marked
  // fetch hard-fail — fails the verdict just like a thrown resource error.
  const hardFailTracker: HardFailTracker = { failures: [] };
  const { result: total, softSkipCount } = await runWithWhoopSoftSkipTracking(
    () =>
      hardFailStorage.run(hardFailTracker, async () => {
        let imported = 0;
        for (const fn of resources) {
          try {
            imported += await fn(userId, opts);
          } catch (err) {
            anyFailed = true;
            noteBackfillFailure(err);
            // WH-4: a write-path throw (`MeasurementReconciliationError` out of
            // `upsertWhoopMeasurements`) reaches no ledger otherwise — a
            // stale-green pill during a persistent write failure. Fetch
            // hard-fails already recorded + marked in `handleCollectionFetchError`,
            // so record only the UNMARKED escapes here (no double-record).
            if (!isSyncFailureRecorded(err)) {
              await recordWhoopSyncFailure(userId, err);
            }
            getEvent()?.addWarning(
              `whoop ${fn.name} failed for ${userId}: ${err}`,
            );
          }
        }
        return imported;
      }),
  );

  // A dead token / vanished connection notes the hard-fail ledger without
  // throwing (each leaf short-circuits `if (!tokenInfo) return 0`); fold that
  // into the verdict so an all-zeros dead-token cycle does not stamp success.
  anyFailed = anyFailed || hardFailTracker.failures.length > 0;

  // A genuine grant-revoke 403s EVERY collection: each resource soft-skips
  // (returns 0, records no failure), so `anyFailed` stays false and `total` is
  // 0 — yet the connection is dead until the token-refresh path next catches
  // the 401 (up to ~1 h later). Don't stamp success when the whole cycle was
  // soft-skipped and nothing imported; leave the status as-is so the
  // "looks-healthy" window closes. A partial cycle (some rows imported, or at
  // least one resource that did not soft-skip) stamps success as normal.
  const allSoftSkipped = softSkipCount >= resources.length && total === 0;

  if (!anyFailed && !allSoftSkipped) {
    await recordSyncSuccess(userId, "whoop");
  }

  // Background-sync posture: mark the analytics cells stale (never hard-evict
  // from a poll) and sweep the workouts cache so the imported rows reach the
  // cached readers. Fires on a partial failure too — rows that DID land must
  // not stay invisible for the rest of the TTL window. The per-resource
  // webhook/cron jobs run their own call in `runWhoopResourceSync`.
  if (total > 0) {
    invalidateUserMeasurements(userId);
  }

  return { imported: total, failed: anyFailed || allSoftSkipped };
}
