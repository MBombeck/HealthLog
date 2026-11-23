/**
 * Emit an arrival for a workout row a writer proved it freshly inserted.
 *
 * Provider writers must pass only rows returned by their INSERT statement.
 * Existing-row updates and duplicate-race losers never enter this seam. It
 * also notes a `workouts` DATA_CHANGED wake (`push-relay/data-changed.ts`).
 */
import { noteDataChanged } from "@/lib/push-relay/data-changed";

import { emitDataArrival } from "./emit-shared";

export interface InsertedWorkoutArrivalRow {
  id: string;
  startedAt: Date;
}

/**
 * Best-effort callers invoke this after the write and suppress queue failures,
 * so arrival infrastructure can never fail provider ingestion. Historical
 * inserts remain silent through `emitDataArrival`'s recency classifier.
 */
export async function emitInsertedWorkoutArrival(
  userId: string,
  row: InsertedWorkoutArrivalRow,
  source: string,
  now?: Date,
): Promise<void> {
  // A provider workout wakes the owner's iOS devices; the app's own batch
  // (`workouts/batch-ingest`) does not come through here.
  void noteDataChanged(userId, ["workouts"]);
  await emitDataArrival({
    userId,
    kind: "workout",
    newestSampleAt: row.startedAt,
    insertedCount: 1,
    refId: row.id,
    source,
    now,
  });
}
