/**
 * What a batch reports once its rows are written: the audit row, the
 * operator's wide-event breakdowns, and the record-detection and reminder
 * jobs a written row starts.
 */
import { fireAndForget } from "@/lib/logging/fire-and-forget";
import { annotate } from "@/lib/logging/context";
import { auditLog } from "@/lib/auth/audit";
import { targetsAggregatedBucket } from "@/lib/measurements/apple-health-mapping";
import { enqueuePrDetection } from "@/lib/jobs/pr-detection";
import { enqueueReminderSatisfy } from "@/lib/jobs/reminder-satisfy";
import type { HealthKitRequestSyncTrigger } from "@/lib/integrations/healthkit-type-sync";

import type { BatchIngestEntry, EntryResult } from "./entries";

// Historical-backfill threshold for PR push suppression. A batch larger than
// this fires the detection job with `silent: true` so a multi-year Apple
// Health backfill writes records without spamming the user with hundreds of
// pushes. Tuned generously — a healthy daily-sync batch is typically well
// under 50 entries.
const PR_DETECTION_SILENT_THRESHOLD = 50;

/** The measurement-side tallies the report reads. */
export interface BatchTallies {
  insertedCount: number;
  updatedCount: number;
  unchangedStatsCount: number;
  duplicateCount: number;
  failedCount: number;
  crossSourceMergedCount: number;
  foldedWindowCount: number;
  setInsertedCount: number;
}

export type SkippedEntry = { index: number; reason: string };

/** The skipped entries, and how many tripped each reason. */
export function summariseSkips(results: EntryResult[]): {
  skipped: SkippedEntry[];
  skippedByReason: Record<string, number>;
} {
  const skipped = results
    .filter((r) => r.status === "skipped")
    .map((r) => ({ index: r.index, reason: r.reason ?? "unknown" }));

  // Per-reason skip breakdown (issue #585). The ingest annotation only ever
  // carried the total `skipped` count, so an operator investigating "why does
  // this account's uploaded data look sparser than expected" had no way to
  // see WHICH validation gate an entry tripped (malformed bucket id,
  // out-of-range value, unmappable identifier, …) without pulling raw rows.
  // Grouping by reason turns that into a one-glance wide-event field.
  const skippedByReason: Record<string, number> = {};
  for (const s of skipped) {
    skippedByReason[s.reason] = (skippedByReason[s.reason] ?? 0) + 1;
  }
  return { skipped, skippedByReason };
}

/** The audit row and the per-feature wide-event breakdowns. */
export async function reportBatchOutcome(args: {
  userId: string;
  ipAddress: string | null;
  entries: BatchIngestEntry[];
  results: EntryResult[];
  tallies: BatchTallies;
  skipped: SkippedEntry[];
}): Promise<void> {
  const { userId, ipAddress, entries, results, tallies, skipped } = args;
  await auditLog("measurement.batch.ingest", {
    userId,
    ipAddress,
    details: {
      processed: entries.length,
      inserted: tallies.insertedCount,
      updated: tallies.updatedCount + tallies.unchangedStatsCount,
      duplicates: tallies.duplicateCount,
      skipped: skipped.length,
      failed: tallies.failedCount,
    },
  });

  // Issue #213 — a dedicated wide-event annotation so an operator can grep
  // `measurement.batch.stats-overwrite` to see how often per-day cumulative
  // rows are getting re-posted (a healthy ingest flow). Only fires when at
  // least one row was overwritten so the baseline ingest trace is unchanged
  // for batches with no `stats:*` duplicates.
  if (tallies.updatedCount > 0) {
    annotate({
      action: { name: "measurement.batch.stats-overwrite" },
      meta: {
        updated: tallies.updatedCount,
        processed: entries.length,
      },
    });
  }

  // iOS #2 — a dedicated annotation for the MANUAL↔APPLE_HEALTH same-reading
  // collapse so an operator can grep `measurement.batch.cross-source-merge`
  // to confirm the standalone-pair mirror duplicate is being absorbed (a
  // healthy first-pair flow). Only fires when at least one row was merged so
  // the baseline ingest trace is unchanged for the common case.
  if (tallies.crossSourceMergedCount > 0) {
    annotate({
      action: { name: "measurement.batch.cross-source-merge" },
      meta: {
        merged: tallies.crossSourceMergedCount,
        processed: entries.length,
      },
    });
  }

  annotateHeartRateBuckets(entries, results);
}

/**
 * Issue #585 — a dedicated outcome breakdown for entries targeting the
 * go-forward aggregated 10-min heart-rate bucket prefix
 * (`stats:HKQuantityTypeIdentifierHeartRate:<10-min-Z>`). The intraday pulse
 * chart reads exactly these rows for a live-synced day; a report of "the
 * chart looks sparser after the ZIP import cutoff" is unanswerable from the
 * baseline ingest trace alone, since it never distinguished an HR-bucket
 * write from any other entry in the batch. Grepping
 * `measurement.batch.hr-bucket` shows, per sync, how many bucket entries the
 * client sent and what happened to each — confirming (or ruling out)
 * server-side rejection/dedup as the density-gap cause. Only fires when the
 * batch actually carried at least one HR-bucket entry so the baseline trace
 * is unchanged for every other sync.
 */
function annotateHeartRateBuckets(
  entries: BatchIngestEntry[],
  results: EntryResult[],
): void {
  let hrBucketInserted = 0;
  let hrBucketUpdated = 0;
  let hrBucketDuplicate = 0;
  let hrBucketSkipped = 0;
  let hrBucketFailed = 0;
  for (let index = 0; index < entries.length; index++) {
    if (!targetsAggregatedBucket(entries[index].externalId)) continue;
    switch (results[index]?.status) {
      case "inserted":
        hrBucketInserted++;
        break;
      case "updated":
        hrBucketUpdated++;
        break;
      case "duplicate":
        hrBucketDuplicate++;
        break;
      case "skipped":
        hrBucketSkipped++;
        break;
      case "failed":
        hrBucketFailed++;
        break;
    }
  }
  const hrBucketAttempted =
    hrBucketInserted +
    hrBucketUpdated +
    hrBucketDuplicate +
    hrBucketSkipped +
    hrBucketFailed;
  if (hrBucketAttempted > 0) {
    annotate({
      action: { name: "measurement.batch.hr-bucket" },
      meta: {
        attempted: hrBucketAttempted,
        inserted: hrBucketInserted,
        updated: hrBucketUpdated,
        duplicate: hrBucketDuplicate,
        skipped: hrBucketSkipped,
        failed: hrBucketFailed,
        processed: entries.length,
      },
    });
  }
}

/**
 * Kick off PR detection for this user when at least one row was written, so
 * a single off-day reading still gets evaluated; the warm-up gate inside the
 * detector decides whether it's a record. Suppress push notifications for
 * historical backfills above the silent threshold. Updated `stats:*` rows
 * also count — a per-day-total overwrite can flip the day's value past a
 * personal record.
 *
 * A batch of duplicates only does not enqueue. It changed nothing a record
 * or a reminder could read, and an anchor-reset backfill sends hundreds of
 * them, each of which used to queue a detection pass, a reminder sweep and
 * an audit row for no new reading.
 */
export async function enqueueRecordJobs(args: {
  userId: string;
  processed: number;
  tallies: Pick<BatchTallies, "insertedCount" | "updatedCount">;
}): Promise<void> {
  const { userId, processed, tallies } = args;
  if (!(tallies.insertedCount > 0 || tallies.updatedCount > 0)) return;
  const silent = processed > PR_DETECTION_SILENT_THRESHOLD;
  // Eventful Vorsorge satisfaction. A matching reading just landed; resolve
  // the user's reminders now rather than waiting on the 15-min cron.
  // Fire-and-forget — the cron reconciles on enqueue miss.
  fireAndForget(() => enqueueReminderSatisfy(userId), {
    action: "reminder.satisfy.enqueue",
  });
  try {
    await enqueuePrDetection(userId, { silent });
    // Telemetry, not an audit event: it rides the wide event.
    annotate({
      meta: { pr_detection_enqueued: true, pr_detection_silent: silent },
    });
  } catch (err) {
    // Enqueue failure is non-fatal — the 30-minute fallback cron
    // picks the user up in the next slot. Log so the operator
    // notices repeated failures in Wide-Event traffic.
    annotate({
      action: { name: "personal_records.detection_enqueue_failed" },
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** The batch's own wide-event summary, the last annotation of the request. */
export function annotateIngest(args: {
  processed: number;
  tallies: BatchTallies;
  skipped: SkippedEntry[];
  skippedByReason: Record<string, number>;
  syncTrigger: HealthKitRequestSyncTrigger | undefined;
}): void {
  const { processed, tallies, skipped, skippedByReason, syncTrigger } = args;
  annotate({
    action: { name: "measurement.batch.ingest" },
    meta: {
      processed,
      inserted: tallies.insertedCount,
      updated: tallies.updatedCount + tallies.unchangedStatsCount,
      stats_unchanged: tallies.unchangedStatsCount,
      duplicates: tallies.duplicateCount,
      skipped: skipped.length,
      // Per-reason skip breakdown (issue #585); see `summariseSkips`.
      skipped_by_reason: skippedByReason,
      failed: tallies.failedCount,
      // Diagnostic sync-trigger tag (iOS #66: foreground / background / push
      // / manual), or null when the client did not send one. It never
      // influences any count above; it decides how hard the caches are
      // invalidated.
      syncTrigger: syncTrigger ?? null,
      // Duplicates refused because a live `stats:` row already covers the
      // sample's hour or day (`folded-window.ts`).
      folded_window: tallies.foldedWindowCount,
      // Inserts that took the set-based path rather than one reconciler
      // transaction each.
      set_inserted: tallies.setInsertedCount,
    },
  });
}
