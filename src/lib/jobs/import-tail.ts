/**
 * The tail of a bulk export import (Apple Health, Health Connect), run once
 * the import is committed. The per-row write hooks are skipped while the
 * export streams in (a 100k-row import would otherwise pay 100k DAY
 * recomputes), so the three legs every other measurement write runs through
 * `afterMeasurementMutation` run here once, over what the import wrote:
 *
 *   1. the rollup table, refolded over the span of the rows written and never
 *      further back than the fold window every other path keeps to (buckets
 *      older than `ROLLUP_FOLD_WINDOW_MS` are by design never written, so
 *      reads there fall back to live SQL);
 *   2. the measurement read caches, marked stale back to the oldest sample
 *      written. An export carries years of history, and a closed block that a
 *      later sync leaves in place would otherwise keep serving the pre-import
 *      all-time values. An import that wrote no measurement (only workouts or
 *      ECGs) drops them all;
 *   3. the cached status assessments of the types written, narrated like a
 *      hand entry: an export is a file the person chose to import.
 *
 * A rollup miss rides out as a fact rather than a failed job: the import is
 * committed and its row already reads `done`, so failing here would report a
 * completed import as failed.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { invalidateStatusInsightsForTypes } from "@/lib/insights/status-invalidation";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { runDetached } from "@/lib/logging/detached";
import {
  recomputeUserRollups,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";

export async function afterBulkImport(
  userId: string,
  result: {
    measuredSpan: { from: string; to: string } | null;
    perType: Record<string, { inserted: number; updated: number }>;
  },
  label: string,
): Promise<{ rollupFailed: boolean }> {
  const span = result.measuredSpan;
  let rollupFailed = false;
  if (span) {
    try {
      const windowStart = new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS);
      const spanFrom = new Date(span.from);
      const from = spanFrom > windowStart ? spanFrom : windowStart;
      // `to` is exclusive in the aggregator: one millisecond past the newest.
      const to = new Date(new Date(span.to).getTime() + 1);
      if (to > from) await recomputeUserRollups(userId, { from, to });
    } catch (err) {
      rollupFailed = true;
      console.warn(
        `[${label}] Rollup recompute failed for user ${userId}`,
        err,
      );
    }
  }

  invalidateUserMeasurements(
    userId,
    span ? { touchedFrom: new Date(span.from) } : undefined,
  );

  const types = Object.entries(result.perType)
    .filter(([, stat]) => stat.inserted + stat.updated > 0)
    .map(([type]) => type as MeasurementType);
  if (types.length > 0) {
    // Registered so the test suite can await the detached handle.
    trackBackgroundTask(
      runDetached(() =>
        invalidateStatusInsightsForTypes(userId, types, {
          source: "manual",
        }),
      ).catch((err) => {
        console.warn(
          `[${label}] status-insight invalidate failed for user ${userId}`,
          err,
        );
      }),
    );
  }
  return { rollupFailed };
}
