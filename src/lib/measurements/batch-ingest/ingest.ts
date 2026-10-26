/**
 * The native batch ingest behind `POST /api/measurements/batch`, from a
 * parsed and admitted request to the per-entry answer.
 *
 * The stages run in a fixed order, and the order is part of the contract:
 * the first pass maps every entry; the measurements are written, then the
 * hourly sums; the sync checkpoint is stamped from the verdicts; the audit
 * row, the wide-event breakdowns and the record jobs follow; the caches and
 * the arrival spine hear last. The route owns authentication, the rate
 * limit, the body and the response envelope.
 */
import { annotate } from "@/lib/logging/context";
import { unstableExternalIdMeta } from "@/lib/validations/external-id";

import type { BatchIngestInput, EntryResult } from "./entries";
import { prepareBatch } from "./prepare";
import {
  annotateIngest,
  enqueueRecordJobs,
  reportBatchOutcome,
  summariseSkips,
  type BatchTallies,
  type SkippedEntry,
} from "./report";
import { stampSyncCheckpoint } from "./sync-checkpoint";
import { afterBatchWrite } from "./tail";
import { writeBatchHours } from "./write-hours";
import { MeasurementBatchWriter } from "./write-measurements";

/** The response body of the batch route. */
export interface BatchIngestResult {
  processed: number;
  inserted: number;
  updated: number;
  duplicates: number;
  failed: number;
  skipped: SkippedEntry[];
  entries: EntryResult[];
}

export async function ingestMeasurementBatch(
  input: BatchIngestInput,
): Promise<BatchIngestResult> {
  const { user, scoped, entries, syncTrigger, ipAddress } = input;

  const batch = await prepareBatch(input);
  const { prepared, results } = batch;
  if (batch.unstableShapes.length > 0) {
    annotate({
      meta: unstableExternalIdMeta("measurement.batch", batch.unstableShapes),
    });
  }

  const writer = new MeasurementBatchWriter(user.id, results);
  await writer.write(prepared);

  const hours = await writeBatchHours({
    userId: user.id,
    hourWrites: batch.hourWrites,
    accountTz: batch.accountTz,
    results,
    processed: entries.length,
  });
  writer.duplicateCount += hours.duplicates;
  writer.failedCount += hours.failed;

  await stampSyncCheckpoint({
    userId: user.id,
    scoped,
    syncTrigger,
    prepared,
    results,
    failedCount: writer.failedCount,
    unchangedStatsRows: writer.unchangedStatsRows,
    hourLanded: hours.hourLanded,
    hourChanged: hours.hourChanged,
  });

  const tallies: BatchTallies = writer;
  const { skipped, skippedByReason } = summariseSkips(results);
  await reportBatchOutcome({
    userId: user.id,
    ipAddress,
    entries,
    results,
    tallies,
    skipped,
  });
  await enqueueRecordJobs({
    userId: user.id,
    processed: entries.length,
    tallies,
  });
  annotateIngest({
    processed: entries.length,
    tallies,
    skipped,
    skippedByReason,
    syncTrigger,
  });

  await afterBatchWrite({
    userId: user.id,
    syncTrigger,
    prepared,
    results,
    insertedCount: writer.insertedCount,
    updatedCount: writer.updatedCount,
    insertedPrepared: writer.insertedPrepared,
    writtenIdentities: writer.writtenIdentities,
    hourInsertedCount: hours.hourInsertedCount,
    hourUpdatedCount: hours.hourUpdatedCount,
  });

  return {
    processed: entries.length,
    inserted: writer.insertedCount + hours.hourInsertedCount,
    updated:
      writer.updatedCount + writer.unchangedStatsCount + hours.hourUpdatedCount,
    duplicates: writer.duplicateCount,
    failed: writer.failedCount,
    skipped,
    entries: results,
  };
}
