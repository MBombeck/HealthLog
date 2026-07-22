/**
 * WHOOP sync orchestrator.
 *
 * Shared token, cursor, upsert, status, and failure helpers live in
 * `sync-core.ts`. Resource leaves depend only on that core; this parent owns
 * the static leaf graph and the full per-user sequencing policy.
 */
import { getEvent } from "@/lib/logging/context";
import { isReauthRequired, recordSyncSuccess } from "@/lib/integrations/status";
import { syncUserRecovery } from "./sync-recovery";
import { syncUserSleep } from "./sync-sleep";
import { syncUserCycle } from "./sync-cycle";
import { syncUserWorkout } from "./sync-workout";
import { syncUserBody } from "./sync-body";
import { runWithWhoopSoftSkipTracking } from "./sync-core";

/**
 * Full per-user sync across every WHOOP resource. Webhook-driven syncs enqueue
 * a single per-resource job; this drives the hourly poll catch-all and the
 * manual `/api/whoop/sync` trigger.
 *
 * Parks immediately when the connection is at `error_reauth` (the user must
 * reconnect first) — returns 0, matching the Withings no-op contract.
 */
export async function syncUserWhoop(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<number> {
  if (await isReauthRequired(userId, "whoop")) {
    getEvent()?.addWarning(
      `whoop sync skipped for ${userId}: parked at error_reauth`,
    );
    return 0;
  }

  const resources = [
    syncUserRecovery,
    syncUserSleep,
    syncUserCycle,
    syncUserWorkout,
    syncUserBody,
  ];

  let anyFailed = false;
  const { result: total, softSkipCount } = await runWithWhoopSoftSkipTracking(
    async () => {
      let imported = 0;
      for (const fn of resources) {
        try {
          imported += await fn(userId, opts);
        } catch (err) {
          anyFailed = true;
          getEvent()?.addWarning(
            `whoop ${fn.name} failed for ${userId}: ${err}`,
          );
        }
      }
      return imported;
    },
  );

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
  return total;
}
