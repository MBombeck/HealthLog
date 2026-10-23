/**
 * Shared post-mutation tail for every surface that creates, updates,
 * deletes, or restores `Measurement` rows.
 *
 * Two consumers hang off every measurement write and both were being
 * re-remembered by hand at each write surface (the documented two-ended
 * failure class):
 *
 *   1. the `(type, day)` rollup buckets the mutation dirtied — recomputed
 *      inline (DAY) + enqueued (WEEK/MONTH/YEAR) via
 *      `recomputeBucketsForKeys`. The recompute handles deletions
 *      inherently: a day left empty drops its rollup row.
 *   2. the cached per-metric status assessments — re-warmed via
 *      `invalidateStatusInsightsForTypes` (fire-and-forget).
 *   3. the measurement read caches (analytics, targets, derived, workouts),
 *      marked stale back to the earliest touched reading once the rollups
 *      are refolded. Without it a writer that relied on the tail alone (the
 *      CSV and JSON imports, the score engines, the WHOOP webhook, the Withings
 *      activity, sleep and ECG legs, the Oura history backfill) left
 *      every cached read, the closed history blocks above all, on the
 *      pre-write values until their TTL. A caller that invalidated already
 *      (an interactive write evicts) loses nothing: marking stale after an
 *      eviction only catches an entry rebuilt from the old rollups between
 *      the two.
 *
 * Both legs are best-effort: a populator hiccup never fails the user's
 * mutation. Callers collect the affected `(type, measuredAt)` pairs
 * (for deletes: BEFORE the destructive statement, while the rows are
 * still readable) and hand them here.
 */
import {
  collapseToTypeDayKeys,
  recomputeBucketsForKeys,
} from "@/lib/rollups/measurement-rollups";
import {
  invalidateStatusInsightsForTypes,
  type StatusIngestSource,
} from "@/lib/insights/status-invalidation";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { runDetached } from "@/lib/logging/detached";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { earliestMeasuredAt } from "@/lib/cache/closed-block";
import type { MeasurementType } from "@/generated/prisma/client";

export async function afterMeasurementMutation(
  userId: string,
  rows: Array<{ type: MeasurementType; measuredAt: Date }>,
  options: {
    /**
     * Where the rows came from: a hand entry (`manual`) or a device or
     * integration (`sync`). Decides how soon the status cards they dirty may
     * regenerate (`StatusIngestSource`).
     */
    source: StatusIngestSource;
    /** Log prefix identifying the calling surface in the warn lines. */
    label?: string;
    /**
     * Re-warm the status cards of the touched types. A caller that writes in
     * chunks and invalidates once at the end passes false.
     */
    invalidateStatus?: boolean;
  },
): Promise<{ rollupFailed: boolean }> {
  const label = options.label ?? "measurements";
  if (rows.length === 0) return { rollupFailed: false };

  // Collapse to the distinct `(type, day)` set BEFORE recomputing so a
  // 500-row batch fires at most one DAY recompute per touched bucket.
  const keys = collapseToTypeDayKeys(rows);
  let rollupFailed = false;
  try {
    await recomputeBucketsForKeys(userId, keys);
  } catch (err) {
    rollupFailed = true;
    console.warn(`[${label}] rollup recompute failed`, err);
  }
  invalidateUserMeasurements(userId, { touchedFrom: earliestMeasuredAt(rows) });

  // Status-insight re-warm is fire-and-forget — it must run even when
  // the rollup leg above failed, so the two legs never gate each other.
  const types = Array.from(new Set(keys.map((k) => k.type)));
  if (types.length > 0 && options.invalidateStatus !== false) {
    // Registered so the test suite can await it: the warn below is a console
    // write on a detached handle, and one that lands while a vitest worker is
    // closing its RPC channel fails the whole run. No-op outside test.
    trackBackgroundTask(
      runDetached(() =>
        invalidateStatusInsightsForTypes(userId, types, {
          source: options.source,
        }),
      ).catch((err) => {
        console.warn(`[${label}] status-insight invalidate failed`, err);
      }),
    );
  }
  return { rollupFailed };
}
