/**
 * The write of a planned workout batch, in one transaction: the manual
 * corrections, the new workouts, then their tracks and series and the
 * enrichments. Statuses are settled from what actually landed.
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { lockPersonalRecordsForUser } from "@/lib/personal-records/pr-detection-worker";
import { encryptRouteGeometry } from "@/lib/workouts/route-geometry-cipher";

import type { EntryResult, PreparedWorkout } from "./entries";
import { MANUAL_OVERWRITE_FIELDS, type WritePlan } from "./plan";

const CHUNK = 100;

type Tx = Prisma.TransactionClient;

/** What the write reports back for the counters and the arrivals. */
export interface WriteOutcome {
  insertedCount: number;
  enrichedCount: number;
  updatedCount: number;
  /** Planned entries that ended as duplicates once the write had run. */
  duplicates: number;
  insertedIdByIndex: Map<number, string>;
  /** Workout ids of the manual edits this request actually wrote. */
  overwrittenIdByIndex: Map<number, string>;
}

export async function writeWorkoutPlan(
  userId: string,
  plan: WritePlan,
  results: EntryResult[],
): Promise<WriteOutcome> {
  const { toInsert, toEnrich, toOverwrite } = plan;
  const outcome: WriteOutcome = {
    insertedCount: 0,
    enrichedCount: 0,
    updatedCount: 0,
    duplicates: 0,
    insertedIdByIndex: new Map<number, string>(),
    overwrittenIdByIndex: new Map<number, string>(),
  };
  if (!(toInsert.length > 0 || toEnrich.length > 0 || toOverwrite.length > 0)) {
    return outcome;
  }
  const { insertedIdByIndex } = outcome;
  /** Workout ids whose series row this request actually wrote. */
  const seriesLanded = new Set<string>();
  /** Batch indices whose manual edit this request actually wrote. */
  const overwritten = new Set<number>();

  await prisma.$transaction(async (tx) => {
    await overwriteManualWorkouts(tx, userId, toOverwrite, overwritten);
    await insertWorkouts(tx, toInsert, insertedIdByIndex);
    await insertChildren(tx, plan, insertedIdByIndex, seriesLanded);
  });

  outcome.insertedCount = insertedIdByIndex.size;
  for (const p of toInsert) {
    if (insertedIdByIndex.has(p.index)) {
      results[p.index] = { index: p.index, status: "inserted" };
    } else {
      results[p.index] = { index: p.index, status: "duplicate" };
      outcome.duplicates += 1;
    }
  }

  // An enriched entry is still a duplicate of the workout row: the
  // top-level counters count rows, and no row was inserted for it.
  // The per-entry status carries what happened to the series.
  for (const e of toEnrich) {
    results[e.index] = {
      index: e.index,
      status: seriesLanded.has(e.workoutId) ? "enriched" : "duplicate",
    };
    if (seriesLanded.has(e.workoutId)) outcome.enrichedCount += 1;
    outcome.duplicates += 1;
  }

  // Like an enrichment, an edit inserts no row, so it counts towards
  // `duplicates`; the per-entry status says the stored row changed.
  for (const o of toOverwrite) {
    const landed = overwritten.has(o.index);
    results[o.index] = {
      index: o.index,
      status: landed ? "updated" : "duplicate",
    };
    if (landed) {
      outcome.updatedCount += 1;
      outcome.overwrittenIdByIndex.set(o.index, o.workoutId);
    }
    outcome.duplicates += 1;
  }
  return outcome;
}

/**
 * A hand-entered workout sent again with other values. Columns are copied
 * one by one from the validated entry; the records the old values set go
 * with them and the detection pass re-derives the honest best, as the
 * DELETE does.
 */
async function overwriteManualWorkouts(
  tx: Tx,
  userId: string,
  toOverwrite: WritePlan["toOverwrite"],
  overwritten: Set<number>,
): Promise<void> {
  if (toOverwrite.length > 0) {
    await lockPersonalRecordsForUser(tx, userId);
  }
  for (const o of toOverwrite) {
    const data: Prisma.WorkoutUpdateManyMutationInput = {};
    for (const field of MANUAL_OVERWRITE_FIELDS) {
      if (field in o.changes) {
        (data as Record<string, unknown>)[field] = o.changes[field];
      }
    }
    const written = await tx.workout.updateMany({
      where: { id: o.workoutId, userId, source: "MANUAL" },
      data,
    });
    if (written.count === 1) {
      overwritten.add(o.index);
      await tx.personalRecord.deleteMany({
        where: {
          userId,
          source: "MANUAL",
          metricSlot: { not: null },
          externalId: o.externalId,
        },
      });
      // The paragraph described the old values (a 12 km run corrected
      // to 1.2 km must not keep its 12 km story). It goes with them,
      // and the claim is let go of its workout the way a delete does
      // (`ON DELETE SET NULL`): the row stays as the day's ledger, so
      // the edit buys no slot back, and the arrival emitted afterwards can
      // claim a fresh one through the ordinary path, under the same cap.
      await tx.workoutInsight.deleteMany({
        where: { userId, workoutId: o.workoutId },
      });
      await tx.workoutInsightGenerationClaim.updateMany({
        where: { userId, workoutId: o.workoutId },
        data: { workoutId: null },
      });
    }
  }
}

async function insertWorkouts(
  tx: Tx,
  toInsert: PreparedWorkout[],
  insertedIdByIndex: Map<number, string>,
): Promise<void> {
  const withExternalId = toInsert.filter((p) => p.dedupKey !== null);
  const withoutExternalId = toInsert.filter((p) => p.dedupKey === null);

  // PostgreSQL RETURNING is the only reliable way to identify the exact
  // winner when another request races the same unique key.
  for (let i = 0; i < withExternalId.length; i += CHUNK) {
    const slice = withExternalId.slice(i, i + CHUNK);
    const pendingByKey = new Map<string, PreparedWorkout[]>();
    for (const p of slice) {
      const key = `${p.dedupKey!.source}::${p.dedupKey!.externalId}`;
      const pending = pendingByKey.get(key);
      if (pending) pending.push(p);
      else pendingByKey.set(key, [p]);
    }

    const inserted = await tx.workout.createManyAndReturn({
      data: slice.map((p) => p.row),
      skipDuplicates: true,
      select: { id: true, source: true, externalId: true },
    });
    for (const row of inserted) {
      if (row.externalId === null) continue;
      const key = `${row.source}::${row.externalId}`;
      const preparedRow = pendingByKey.get(key)?.shift();
      if (preparedRow) insertedIdByIndex.set(preparedRow.index, row.id);
    }
  }

  // NULL external ids are intentionally distinct in PostgreSQL. Insert
  // them one at a time so a route/HR series can never attach to a
  // different otherwise-identical manual workout.
  for (const p of withoutExternalId) {
    const inserted = await tx.workout.createManyAndReturn({
      data: p.row,
      select: { id: true },
    });
    const row = inserted[0];
    if (row) insertedIdByIndex.set(p.index, row.id);
  }
}

async function insertChildren(
  tx: Tx,
  plan: WritePlan,
  insertedIdByIndex: Map<number, string>,
  seriesLanded: Set<string>,
): Promise<void> {
  const routesToInsert: Prisma.WorkoutRouteCreateManyInput[] = [];
  const samplesToInsert: Prisma.WorkoutSamplesCreateManyInput[] = [];
  for (const p of plan.toInsert) {
    const id = insertedIdByIndex.get(p.index);
    if (!id) continue;
    if (p.route) {
      routesToInsert.push({
        workoutId: id,
        // The GPS track is stored sealed only; the readable `geometry`
        // column stays NULL.
        geometryEncrypted: encryptRouteGeometry(p.route.geometry),
        sampleTimestamps:
          p.route.sampleTimestamps === null
            ? Prisma.JsonNull
            : (p.route.sampleTimestamps as Prisma.InputJsonValue),
      });
    }
    if (p.samples) {
      samplesToInsert.push({
        workoutId: id,
        samples: p.samples.samples as Prisma.InputJsonValue,
        sampleCount: p.samples.sampleCount,
      });
    }
  }

  // Enrichment rides the SAME child write as a fresh workout's
  // series — one mechanism, one place where a series is stored.
  // The only difference is where the `workoutId` came from: the
  // pre-flight probe instead of this request's INSERT ... RETURNING.
  // Nothing here writes to the workout row.
  for (const e of plan.toEnrich) {
    samplesToInsert.push({
      workoutId: e.workoutId,
      samples: e.samples.samples as Prisma.InputJsonValue,
      sampleCount: e.samples.sampleCount,
    });
  }

  for (let i = 0; i < routesToInsert.length; i += CHUNK) {
    await tx.workoutRoute.createMany({
      data: routesToInsert.slice(i, i + CHUNK),
      skipDuplicates: true,
    });
  }
  for (let i = 0; i < samplesToInsert.length; i += CHUNK) {
    // RETURNING names the rows that actually landed. `workoutId` is
    // unique, so a workout that gained a series between the probe
    // and this write is skipped here and reports as a duplicate —
    // the re-post stays a no-op and never overwrites a stored curve.
    const landed = await tx.workoutSamples.createManyAndReturn({
      data: samplesToInsert.slice(i, i + CHUNK),
      skipDuplicates: true,
      select: { workoutId: true },
    });
    for (const row of landed) seriesLanded.add(row.workoutId);
  }
}
