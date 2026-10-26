/**
 * The hourly sums of a batch, written to the intraday profile after the
 * measurements. One write per slot: the last entry for one start wins (an
 * earlier one in the same batch is a superseded duplicate), and the two
 * starts of the hour a fall-back day repeats are summed
 * (`combineHourWrites`).
 */
import { prisma } from "@/lib/db";
import { annotate } from "@/lib/logging/context";
import {
  combineHourWrites,
  writeHourBuckets,
  type HourBucketEntry,
  type HourBucketWrite,
} from "@/lib/measurements/intraday-hour-buckets";

import type { EntryResult } from "./entries";

export interface HourOutcome {
  hourInsertedCount: number;
  hourUpdatedCount: number;
  hourLanded: HourBucketWrite[];
  /** #1259: the slots whose value changed, as opposed to an unchanged re-post. */
  hourChanged: Set<HourBucketWrite>;
  /** Superseded entries, counted with the batch's duplicates. */
  duplicates: number;
  /** Entries whose write failed, counted with the batch's failures. */
  failed: number;
}

export async function writeBatchHours(args: {
  userId: string;
  hourWrites: HourBucketEntry[];
  accountTz: string | undefined;
  results: EntryResult[];
  processed: number;
}): Promise<HourOutcome> {
  const { userId, hourWrites, accountTz, results, processed } = args;
  const outcome: HourOutcome = {
    hourInsertedCount: 0,
    hourUpdatedCount: 0,
    hourLanded: [],
    hourChanged: new Set<HourBucketWrite>(),
    duplicates: 0,
    failed: 0,
  };
  if (!(hourWrites.length > 0 && accountTz)) return outcome;

  const { writes, superseded } = combineHourWrites(hourWrites);
  for (const index of superseded) {
    results[index] = {
      index,
      status: "duplicate",
      reason: "superseded_in_batch",
    };
    outcome.duplicates++;
  }
  const toWrite = writes.map(({ write }) => write);
  try {
    const statuses = await writeHourBuckets(prisma, userId, accountTz, toWrite);
    for (const { write, contributors } of writes) {
      const status = statuses.get(write.index) ?? "inserted";
      // An unchanged hour still reads `updated` on the wire (#1259).
      const wire = status === "inserted" ? "inserted" : "updated";
      for (const index of contributors) {
        results[index] = { index, status: wire };
        if (status === "inserted") outcome.hourInsertedCount++;
        else outcome.hourUpdatedCount++;
      }
      outcome.hourLanded.push(write);
      if (status !== "unchanged") outcome.hourChanged.add(write);
    }
  } catch (err) {
    for (const { contributors } of writes) {
      for (const index of contributors) {
        results[index] = {
          index,
          status: "failed",
          reason: "write_failed",
        };
        outcome.failed++;
      }
    }
    annotate({
      action: { name: "measurement.batch.hour-bucket.failed" },
      meta: { error: err instanceof Error ? err.message : String(err) },
    });
  }
  annotate({
    action: { name: "measurement.batch.hour-bucket" },
    meta: {
      attempted: hourWrites.length,
      inserted: outcome.hourInsertedCount,
      updated: outcome.hourUpdatedCount,
      processed,
    },
  });
  return outcome;
}
