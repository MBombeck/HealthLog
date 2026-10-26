/**
 * The consumers a written batch has to tell: the measurement caches, the
 * rollup and status tail, the morning refresh and the data-arrival spine.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { groupRowsByArrivalKind } from "@/lib/arrivals/measurement-kind";
import { invalidateUserMeasurements } from "@/lib/cache/invalidate";
import { afterMeasurementMutation } from "@/lib/rollups/after-measurement-mutation";
import type { HealthKitRequestSyncTrigger } from "@/lib/integrations/healthkit-type-sync";

import type { EntryResult, PreparedEntry } from "./entries";

type Identity = { type: MeasurementType; measuredAt: Date };

export async function afterBatchWrite(args: {
  userId: string;
  syncTrigger: HealthKitRequestSyncTrigger | undefined;
  prepared: PreparedEntry[];
  results: EntryResult[];
  insertedCount: number;
  updatedCount: number;
  insertedPrepared: PreparedEntry[];
  writtenIdentities: Identity[];
  hourInsertedCount: number;
  hourUpdatedCount: number;
}): Promise<void> {
  const { userId, insertedCount, updatedCount } = args;
  const freshlyInsertedRows = args.insertedPrepared.map((p) => ({
    type: p.row.type as MeasurementType,
    measuredAt:
      p.row.measuredAt instanceof Date
        ? p.row.measuredAt
        : new Date(p.row.measuredAt as string),
  }));

  // Bust per-user analytics + achievements + workouts caches when at least
  // one row landed so the next read picks up the ingested batch. Skipped-only
  // ingests don't change state, so the invalidation is gated on
  // `insertedCount > 0 || updatedCount > 0` — overwriting a per-day `stats:*`
  // row changes the day's reading and must invalidate every consumer that
  // reads through this user's measurements.
  if (insertedCount > 0 || updatedCount > 0) {
    await afterMeasurementsWritten({ ...args, freshlyInsertedRows });
  }

  // The hours are not measurements, so they touched none of the measurement
  // consumers above; only the caches that read the intraday profile (the
  // same-time baseline) are marked stale.
  if (
    args.hourInsertedCount + args.hourUpdatedCount > 0 &&
    insertedCount === 0 &&
    updatedCount === 0
  ) {
    invalidateUserMeasurements(userId);
  }
}

async function afterMeasurementsWritten(args: {
  userId: string;
  syncTrigger: HealthKitRequestSyncTrigger | undefined;
  prepared: PreparedEntry[];
  results: EntryResult[];
  writtenIdentities: Identity[];
  freshlyInsertedRows: Identity[];
}): Promise<void> {
  const {
    userId,
    syncTrigger,
    prepared,
    results,
    writtenIdentities,
    freshlyInsertedRows,
  } = args;
  // Evict only when someone is looking (#38 evicted on every batch so a
  // focus-refetch after a sync showed post-sync data, but a phone syncing in
  // the background posts a batch every few minutes all day, and each
  // eviction sent the next dashboard read into a cold rebuild). Every other
  // background sync marks stale, which `cachedSwr` serves once while one
  // rebuild runs; this route does the same unless the app is open
  // (`foreground`), the person pressed sync (`manual`), or the batch wrote
  // one of their own hand-entered readings (`MANUAL`), whose entry has to
  // show on the very next read.
  const wroteManualRow = prepared.some(
    (p) =>
      p.row.source === "MANUAL" &&
      (results[p.index]?.status === "inserted" ||
        results[p.index]?.status === "updated"),
  );
  const evict =
    syncTrigger === "foreground" || syncTrigger === "manual" || wroteManualRow;
  // Every row this batch created, changed or retired is in
  // `writtenIdentities`, so its earliest `measuredAt` bounds what changed:
  // closed blocks of older readings (the pre-fold remainder, the day
  // view's past history blocks) stay cached across the sync.
  const touchedFrom = new Date(
    Math.min(...writtenIdentities.map((w) => w.measuredAt.getTime())),
  );
  invalidateUserMeasurements(userId, {
    ...(evict ? { evict: true } : {}),
    ...(Number.isFinite(touchedFrom.getTime()) ? { touchedFrom } : {}),
  });

  // The shared post-mutation tail for every distinct (type, day) the batch
  // touched. Updates participate as well as inserts, so this deliberately
  // retains the prepared-row scope. A batch is the phone's sync, held to the
  // sync gap, unless it wrote one of the person's own hand-entered readings,
  // which is narrated like any other hand entry.
  await afterMeasurementMutation(userId, writtenIdentities, {
    source: wroteManualRow ? "manual" : "sync",
  });

  // Apple-Health sleep is the third sleep transport. If any SLEEP_DURATION
  // row for last night just landed, kick the debounced morning refresh so the
  // digest/score finalise with the current sleep. The trigger judges "last
  // night" in the user's profile tz, so a historical Apple export replaying
  // months of nights never re-triggers for an old night. Fire-and-forget.
  void maybeEnqueueMorningRefresh(
    userId,
    freshlyInsertedRows
      .filter((row) => row.type === "SLEEP_DURATION")
      .map((row) => row.measuredAt),
  ).catch(() => {});

  // The measurement arm of the data-arrival spine.
  //
  // ONE emit per kind per request, never one per row. The batch route is the
  // Apple-Health / iOS ingest path, so it is also the single biggest backfill
  // path in the product: a ten-year export arrives here in 500-row batches.
  // Emitting per row would put thousands of classifier calls (and thousands
  // of dropped-event annotations) on the hot path for no gain, since the
  // day-scoped singleton key collapses them to one job anyway.
  //
  // Blood pressure is deliberately one arrival, not two: it is stored as two
  // rows (SYS + DIA) sharing a `measuredAt`, and a reader cares about the
  // reading, not the arms.
  //
  // Only rows the write actually INSERTED count — updated rows are the
  // `stats:` overwrite contract re-stating a value the record already had,
  // which is not news. If nothing was inserted the classifier returns `noop`
  // and nothing is enqueued.
  for (const [kind, group] of groupRowsByArrivalKind(freshlyInsertedRows)) {
    void emitDataArrival({
      userId,
      kind,
      newestSampleAt: group.newestAt,
      insertedCount: group.count,
      source: "batch",
    }).catch(() => {});
  }
}
