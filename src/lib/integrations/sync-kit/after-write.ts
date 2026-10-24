/**
 * The one step after a provider sync or import writes measurements.
 *
 * Every provider used to end its write with its own hand-written tail: fold
 * the touched rollup days, drop the status cards of the touched types, mark
 * the read caches stale, emit the data arrivals. The copies drifted (one
 * skipped the status cards, one marked every cached block stale, one never
 * marked anything), and each imported the whole insight generator to reach
 * the invalidation it needed. `afterProviderWrite` is that tail, in one fixed
 * order:
 *
 *   1. the freshly inserted rows go out on the data-arrival spine
 *      (fire and forget);
 *   2. the touched `(type, day)` buckets are refolded, the read caches are
 *      marked stale back to the earliest touched reading (older closed blocks
 *      survive), and the status cards of the touched types are re-warmed
 *      (`afterMeasurementMutation`, shared with the interactive routes);
 *   3. where the provider asks for it, the dashboard snapshot is evicted.
 *
 * Every leg is best effort: a populator hiccup never fails the sync. The
 * result says whether the fold failed, for the providers whose cycle verdict
 * counts it.
 *
 * A full-history backfill defers the per-day fold and refolds the whole
 * touched range once at the end (`afterProviderBackfill`).
 */
import type { MeasurementType } from "@/generated/prisma/client";
import {
  emitInsertedMeasurementArrivals,
  type InsertedMeasurementArrivalRow,
} from "@/lib/arrivals/measurement-emit";
import {
  invalidateUserDashboardSnapshot,
  invalidateUserMeasurements,
} from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/status-invalidation";
import { getEvent } from "@/lib/logging/context";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import {
  collapseToTypeDayKeys,
  recomputeUserRollups,
} from "@/lib/rollups/measurement-rollups";

type ArrivalSource = Parameters<typeof emitInsertedMeasurementArrivals>[2];

export interface TouchedReading {
  type: MeasurementType;
  measuredAt: Date;
}

export interface ProviderWrite {
  userId: string;
  /** The provider, as the warn lines name it (`withings`, `google-health`). */
  provider: string;
  /** Every reading the write created, changed or displaced. */
  touched: readonly TouchedReading[];
  /** Rows freshly inserted, for the arrival spine; omitted when none go out. */
  arrivals?: {
    rows: InsertedMeasurementArrivalRow[];
    source: ArrivalSource;
  };
  /**
   * Re-warm the touched status cards now. A provider that writes in chunks
   * and invalidates once at the end passes false and calls
   * `invalidateProviderStatus` itself.
   */
  invalidateStatus?: boolean;
  /** Evict the dashboard snapshot as well (a sync with no client mutation). */
  evictDashboard?: boolean;
}

export async function afterProviderWrite(
  write: ProviderWrite,
): Promise<{ rollupFailed: boolean }> {
  const { userId, provider, touched } = write;
  if (write.arrivals) {
    void emitInsertedMeasurementArrivals(
      userId,
      write.arrivals.rows,
      write.arrivals.source,
    ).catch(() => {});
  }
  const { rollupFailed } = await afterMeasurementMutation(
    userId,
    [...touched],
    {
      source: "sync",
      label: provider,
      invalidateStatus: write.invalidateStatus,
    },
  );
  if (rollupFailed) {
    getEvent()?.addWarning(
      `${provider}: rollup recompute failed for ${userId}`,
    );
  }
  if (write.evictDashboard && touched.length > 0) {
    invalidateUserDashboardSnapshot(userId);
  }
  return { rollupFailed };
}

/** Re-warm the status cards of `types` after a sync (fire and forget). */
export function invalidateProviderStatus(
  userId: string,
  provider: string,
  types: Iterable<MeasurementType>,
): void {
  const list = [...new Set(types)];
  if (list.length === 0) return;
  void invalidateStatusInsightsForTypes(userId, list, {
    source: "sync",
  }).catch((err) => {
    getEvent()?.addWarning(
      `${provider}: status-insight invalidate failed for ${userId}: ${err}`,
    );
  });
}

/**
 * The end of a full-history backfill: refold the whole touched range once
 * (from the first touched day to the end of the last), mark the read caches
 * stale back to the first touched day, then re-warm the touched status cards.
 * Throws when the fold fails, for the caller to count.
 *
 * The caches are marked even when the fold fails: the rows changed either
 * way, and a cached analytics body built before the backfill would otherwise
 * be served until its TTL ran out. That is the same order and the same
 * posture as the per-write tail (`afterMeasurementMutation`).
 */
export async function afterProviderBackfill(input: {
  userId: string;
  provider: string;
  /** The deferred `(type, day)` keys the backfill's writes collected. */
  keys: readonly TouchedReading[];
}): Promise<void> {
  const days = collapseToTypeDayKeys([...input.keys]);
  if (days.length === 0) return;
  const types = Array.from(new Set(days.map((key) => key.type)));
  const sorted = days
    .map((key) => key.measuredAt.getTime())
    .sort((a, b) => a - b);
  const from = new Date(sorted[0]!);
  // The keys are UTC day starts; the end is past the last touched day so the
  // aggregator's `< to` bound covers it.
  const to = new Date(sorted[sorted.length - 1]! + 24 * 60 * 60 * 1000);
  try {
    await recomputeUserRollups(input.userId, { types, from, to });
  } finally {
    invalidateUserMeasurements(input.userId, { touchedFrom: from });
  }
  invalidateProviderStatus(input.userId, input.provider, types);
}
