/** Fitbit sync orchestration and bounded cohort polling. */
import pLimit from "p-limit";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { prisma } from "@/lib/db";
import { isReauthRequired, recordSyncSuccess } from "@/lib/integrations/status";
import { annotate, getEvent } from "@/lib/logging/context";
import { afterProviderBackfill } from "@/lib/integrations/sync-kit/after-write";
import { syncUserActivity } from "./sync-activity";
import {
  hardFailStorage,
  incrementalStart,
  markSynced,
  rollupDeferStorage,
  softSkipStorage,
} from "./sync-core";
import type {
  FitbitResourceSyncOptions,
  HardFailTracker,
  RollupDeferTracker,
  SoftSkipTracker,
} from "./sync-core";
import { syncUserMetrics } from "./sync-metrics";
import { syncUserSleep } from "./sync-sleep";
import { syncUserWorkout } from "./sync-workout";
import { isFitbitRetired } from "./retirement";

/**
 * Full per-user sync across every Fitbit resource. Drives the hourly poll
 * catch-all, the manual `/api/fitbit/sync` trigger, and the boot-time backfill
 * (`fullSync: true`). Poll-only — there is no Fitbit webhook at launch (Pub/Sub
 * deferred), so there is no per-resource webhook enqueue path.
 *
 * Parks immediately when the connection is at `error_reauth` (the user must
 * reconnect first) — returns 0, matching the WHOOP / Withings no-op contract.
 *
 * Resources: health-metrics (W3), daily-cumulative activity, per-stage sleep,
 * and exercise workouts (W5). Each runs independently so a per-resource 403
 * (a Restricted bundle the user did not grant) soft-skips only that resource.
 *
 * WATERMARK: the incremental `[start, end]` window is snapshotted ONCE here
 * (from the single `lastSyncedAt` read + a single `now` at the top of the cycle)
 * and threaded to every resource, and `markSynced` is stamped ONCE at the end. A
 * per-resource read+stamp would let the first resource move `lastSyncedAt` to
 * now() so later resources only see the last overlap window — silently dropping
 * the gap after an outage longer than the overlap. The full/backfill path passes
 * `fullSync: true`, which widens `start` back to the bounded backfill horizon.
 */
export async function syncUserFitbit(
  userId: string,
  opts: { fullSync?: boolean } = {},
): Promise<{ imported: number; failed: boolean }> {
  // The Web API is gone (`./retirement`): nothing to fetch, nothing to stamp.
  // Neither a success (it would paint the connection green) nor a failure (it
  // would ask for a reconnect that cannot help).
  if (isFitbitRetired()) {
    annotate({ action: { name: "fitbit.sync.retired" } });
    return { imported: 0, failed: false };
  }
  if (await isReauthRequired(userId, "fitbit")) {
    getEvent()?.addWarning(
      `fitbit sync skipped for ${userId}: parked at error_reauth`,
    );
    return { imported: 0, failed: true };
  }

  // Snapshot the incremental window ONCE for the whole cycle. Every resource
  // sees the same `[start, end]`; no resource re-reads `lastSyncedAt` mid-cycle.
  // A full/backfill run widens `start` back to the bounded backfill horizon.
  const connection = await prisma.fitbitConnection.findUnique({
    where: { userId },
    select: { lastSyncedAt: true },
  });
  if (!connection) return { imported: 0, failed: true };
  const end = new Date();
  const start = incrementalStart(connection.lastSyncedAt, {
    fullSync: opts.fullSync,
    now: end,
  });
  const resourceOpts: FitbitResourceSyncOptions = {
    fullSync: opts.fullSync,
    start,
    end,
    // A backfill walks years of daily summaries — defer the per-(type,day)
    // rollup hook on every write and run ONE range-recompute at the end of the
    // cycle. The hourly incremental keeps the inline hook (small touched set).
    deferRollup: opts.fullSync === true,
  };

  const resources = [
    syncUserMetrics,
    syncUserActivity,
    syncUserSleep,
    syncUserWorkout,
  ];

  const tracker: SoftSkipTracker = { count: 0 };
  const deferTracker: RollupDeferTracker = { keys: new Map() };
  const hardFailTracker: HardFailTracker = { failures: [] };
  let total = 0;
  let anyFailed = false;
  await softSkipStorage.run(tracker, async () => {
    await hardFailStorage.run(hardFailTracker, async () => {
      await rollupDeferStorage.run(deferTracker, async () => {
        for (const fn of resources) {
          try {
            total += await fn(userId, resourceOpts);
          } catch (err) {
            anyFailed = true;
            getEvent()?.addWarning(
              `fitbit ${fn.name} failed for ${userId}: ${err}`,
            );
          }
        }
      });
    });
  });
  // A collection that hard-failed inside a resource (recorded on the ledger by
  // `handleCollectionFetchError` without aborting its siblings) still fails the
  // cycle: partial error, no watermark stamp.
  if (hardFailTracker.failures.length > 0) anyFailed = true;

  // On a `fullSync` backfill the per-write inline rollup hook was deferred; the
  // accumulated touched type-days collapse into ONE range-recompute spanning the
  // touched days. One pass replaces the thousands of per-(type,day) round-trips a
  // deep backfill would otherwise pay (each = an aggregate SELECT + rollup upsert
  // + 3 queue sends). Best-effort: a populator hiccup never fails the backfill.
  if (opts.fullSync && deferTracker.keys.size > 0) {
    try {
      await afterProviderBackfill({
        userId,
        provider: "fitbit",
        keys: Array.from(deferTracker.keys.values()),
      });
    } catch (err) {
      getEvent()?.addWarning(
        `fitbit: backfill rollup recompute failed for ${userId}: ${err}`,
      );
    }
  }

  // A genuine grant-revoke 403s EVERY collection: each resource soft-skips
  // (returns 0, records no failure), so `anyFailed` stays false and `total` is
  // 0 — yet the connection is dead until the token-refresh path next catches the
  // 401. Don't stamp success when the whole cycle was soft-skipped and nothing
  // imported; leave the status as-is so the "looks-healthy" window closes. A
  // partial cycle (some rows imported, or at least one resource that did not
  // soft-skip) stamps success as normal.
  const allSoftSkipped = tracker.count >= resources.length && total === 0;
  const failed = anyFailed || allSoftSkipped;

  if (!failed) {
    // Stamp the watermark ONCE for the whole cycle, only on a non-degenerate
    // run. Every resource already saw the snapshot `start`, so stamping now()
    // here can't shrink a later resource's window.
    await markSynced(userId);
    await recordSyncSuccess(userId, "fitbit");
  }

  // Background-sync posture: mark the analytics cells stale (never hard-evict
  // from a poll) and sweep the workouts cache so the imported rows reach the
  // cached readers. Fires on a partial failure too — rows that DID land must
  // not stay invisible for the rest of the TTL window.
  if (total > 0) {
    invalidateUserMeasurements(userId);
  }

  annotate({
    action: { name: "fitbit.sync", details: { imported: total, failed } },
  });
  return { imported: total, failed };
}

/**
 * Bounded fan-out width for the hourly Fitbit cohort poll. The cron tick carries
 * no `userId`, so the worker resolves every connection and hands the cohort here.
 * A small pool (rather than a strict serial loop) means one slow Fitbit response
 * can't stall the whole cohort, while the cap keeps the burst of per-user
 * resource fetches + rollup writes from crowding the worker's DB pool.
 *
 * Tuned to 2 for the classic Web API: each per-user cycle issues ~a dozen
 * date-range requests against a tight 150 req/h-per-user budget, so a narrower
 * pool keeps the concurrent outbound burst (and the DB-write tail behind it)
 * modest. The per-user budget is independent, so the cap is about worker
 * pressure, not the API ceiling — but 2 keeps both comfortable.
 */
export const FITBIT_POLL_CONCURRENCY = 2;

/**
 * Run a Fitbit hourly-poll cohort with bounded concurrency + per-user error
 * isolation. Each user's `syncUserFitbit` runs inside the pool; a single user's
 * failure (or a slow Google response) is captured through `onUserError` and never
 * aborts the rest of the pass. Returns the per-cohort totals for the wide-event
 * envelope. Extracted from the worker handler so the concurrency contract is unit
 * testable without exporting worker internals.
 */
export async function runFitbitPollCohort(
  userIds: string[],
  opts: {
    concurrency?: number;
    sync?: (userId: string) => Promise<number>;
    onUserError?: (userId: string, err: unknown) => void;
    /** v1.18.1 — invoked after a user's sync lands `imported` measurements,
     *  so the worker can fire the eventful Vorsorge satisfaction enqueue
     *  without the fitbit lib reaching into the job layer. */
    onUserSynced?: (userId: string, imported: number) => void;
  } = {},
): Promise<{ usersSynced: number; measurementsImported: number }> {
  const sync =
    opts.sync ??
    ((userId: string) => syncUserFitbit(userId).then((r) => r.imported));
  const limit = pLimit(opts.concurrency ?? FITBIT_POLL_CONCURRENCY);

  let usersSynced = 0;
  let measurementsImported = 0;
  await Promise.all(
    userIds.map((userId) =>
      limit(async () => {
        try {
          // Read the accumulators AFTER the await resolves. A compound
          // assignment (`x += await f()`) captures the left value BEFORE the
          // await and would lose increments under overlapping pool tasks.
          const n = await sync(userId);
          measurementsImported = measurementsImported + n;
          usersSynced = usersSynced + 1;
          opts.onUserSynced?.(userId, n);
        } catch (err) {
          opts.onUserError?.(userId, err);
        }
      }),
    ),
  );

  return { usersSynced, measurementsImported };
}
