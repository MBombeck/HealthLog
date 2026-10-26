/**
 * Second pass of the batch ingest: write the prepared rows and record each
 * one's verdict.
 *
 * Every row ends in one of the reconciler's verdicts, reached one of four
 * ways: superseded by a later `stats:` entry in the same batch, an unchanged
 * `stats:` re-post answered without a write, a duplicate found without a
 * transaction (the cross-source merge, the exact stored duplicate, the
 * folded window), or a write: the set-based insert for rows that share no
 * identity with another entry, the per-entry reconciler for the rest.
 */
import { prisma } from "@/lib/db";
import {
  MEASURED_AT_TOLERANCE_MS,
  isMergeableSource,
  isSameReadingAcrossSource,
  oppositeMergeSource,
  type MergeCandidate,
} from "@/lib/measurements/cross-source-merge";
import {
  externalKeyOf,
  onceInBatch,
  readStoredSampleIdentities,
  readStoredStatsRows,
  sampleIsStoredDuplicate,
  statsWriteUnchanged,
} from "@/lib/measurements/batch-stored-rows";
import {
  lockMeasurementUser,
  reconcileExternalMeasurement,
  type MeasurementReconciliationVerdict,
} from "@/lib/measurements/reconcile-external-measurement";
import { classifyRangeRejection } from "@/lib/measurements/plausibility-gate";
import {
  FOLDED_WINDOW_REASON,
  findFoldedWindowDuplicates,
} from "@/lib/measurements/folded-window";
import { annotate } from "@/lib/logging/context";
import type {
  MeasurementSource,
  MeasurementType,
  Prisma,
} from "@/generated/prisma/client";

import {
  isStatsExternalId,
  outOfRangeResult,
  type EntryResult,
  type PreparedEntry,
} from "./entries";

/**
 * Rows per set-based insert statement. 500 entries fit two statements; each
 * row binds about fifteen parameters, far under PostgreSQL's 65 535.
 */
const SET_INSERT_CHUNK = 250;

type Verdict = Pick<MeasurementReconciliationVerdict, "status"> &
  Partial<{
    dirtyIdentities: Array<{ type: MeasurementType; measuredAt: Date }>;
    error: { code?: string };
  }>;

/** What the reads before the write loop found for this batch. */
interface StoredState {
  crossSourceCandidates: MergeCandidate[];
  onceInThisBatch: ReturnType<typeof onceInBatch>;
  existingByExternalKey: Awaited<ReturnType<typeof readStoredSampleIdentities>>;
  storedStats: Awaited<ReturnType<typeof readStoredStatsRows>>;
  foldedPrepared: Set<PreparedEntry>;
}

/** The reconciler's input for one prepared row. */
function desiredFor(userId: string, p: PreparedEntry) {
  const statsRow = isStatsExternalId(p.row.externalId as string);
  return {
    userId,
    type: p.row.type as MeasurementType,
    value: p.row.value as number,
    valueMin: p.row.valueMin as number | null,
    valueMax: p.row.valueMax as number | null,
    unit: p.row.unit as string,
    source: p.row.source as Prisma.MeasurementUncheckedCreateInput["source"],
    measuredAt: p.row.measuredAt as Date,
    externalId: p.row.externalId as string,
    externalSourceVersion: p.row.externalSourceVersion as string | null,
    glucoseContext: p.row
      .glucoseContext as Prisma.MeasurementUncheckedCreateInput["glucoseContext"],
    sleepStage: p.row
      .sleepStage as Prisma.MeasurementUncheckedCreateInput["sleepStage"],
    rhythmClassification: p.row
      .rhythmClassification as Prisma.MeasurementUncheckedCreateInput["rhythmClassification"],
    deviceType: p.row.deviceType as string | null,
    aggregationProvenance: statsRow ? ("HEALTHKIT_STATISTICS" as const) : null,
    // Only a bridge row names its token (#1272); a phone row leaves the
    // column as it is.
    ...(p.row.ingestTokenId
      ? { ingestTokenId: p.row.ingestTokenId as string }
      : {}),
  };
}

/**
 * The reads the verdicts need, in the order the route has always made them:
 * the cross-source candidates, the stored sample identities, the stored
 * `stats:` rows, the folded windows.
 */
async function readStoredState(
  userId: string,
  prepared: PreparedEntry[],
): Promise<StoredState> {
  // Same-reading merge for the MANUAL ↔ APPLE_HEALTH mirror duplicate
  // (iOS #2). When the iOS app logs a manual reading offline it
  // mirrors that reading into HealthKit; on pairing, adopt-on-pair
  // uploads it as MANUAL and HealthKit background sync independently
  // re-ingests the mirrored sample as APPLE_HEALTH. The two carry
  // different externalIds + sources, so the composite unique index lets
  // both land — duplicating the whole hand-logged history on first pair.
  // We collapse them at ingest: an incoming MANUAL / APPLE_HEALTH row is
  // dropped as a `duplicate` when a same-reading row of the OPPOSITE
  // source already exists (same type + value + measuredAt within a tight
  // ±2 s window). `stats:*` cumulative rows are excluded — those are
  // per-day aggregates the observer overwrites in place, never
  // hand-entered point readings. See `cross-source-merge.ts` for the
  // full rule + why first-physical-reading-wins (the value is identical
  // between the two rows, so only the source label differs).
  //
  // Pull the opposite-source candidate rows in one widened query: for
  // every mergeable, non-`stats:*` incoming row, look for an opposite-
  // source row of the same type whose measuredAt falls inside the
  // tolerance window. Compared in JS because the value match needs a
  // float epsilon the SQL `IN` can't express.
  const mergeProbes = prepared.filter(
    (p) =>
      isMergeableSource(p.row.source as string) &&
      !isStatsExternalId(p.row.externalId as string),
  );
  const crossSourceCandidates: MergeCandidate[] = [];
  if (mergeProbes.length > 0) {
    const candidateRows = await prisma.measurement.findMany({
      where: {
        userId,
        deletedAt: null,
        OR: mergeProbes.map((p) => {
          const measuredAt = p.row.measuredAt as Date;
          return {
            type: p.row.type as MeasurementType,
            source: oppositeMergeSource(
              p.row.source as "MANUAL" | "APPLE_HEALTH",
            ),
            measuredAt: {
              gte: new Date(measuredAt.getTime() - MEASURED_AT_TOLERANCE_MS),
              lte: new Date(measuredAt.getTime() + MEASURED_AT_TOLERANCE_MS),
            },
          };
        }),
      },
      select: { type: true, source: true, value: true, measuredAt: true },
    });
    crossSourceCandidates.push(...candidateRows);
  }

  // Exact-duplicate prefilter. A re-sent sample used to cost one
  // interactive transaction of about ten round-trips (savepoint, three
  // advisory locks, two candidate reads, a row lock) only for the
  // reconciler to answer `duplicate` without writing. A backfill after an
  // anchor reset re-sends whole 500-entry batches of exactly that.
  //
  // The reconciler answers `duplicate` for a non-`stats:` row exactly when
  // an existing row, live OR tombstoned, has the same
  // `(type, source, externalId)` AND the same `measuredAt` and
  // `sleepStage`: the natural-identity index is unique NULLS NOT DISTINCT,
  // so that row is both its external and its natural match, and with no
  // aggregation provenance on a sample nothing else can win. One read over
  // the batch's sample ids, without a `deletedAt` filter, answers that for
  // every row at once.
  //
  // The verdict is taken at the very point the reconciler would have been
  // called, after `superseded_in_batch` and the cross-source merge, so
  // statuses, reasons, counters and the in-batch merge candidates are the
  // same as before. A row is only prefiltered when neither its external
  // key nor its natural identity occurs a second time in the batch: an
  // earlier entry sharing either could move or retire the matched row
  // before this one is reached, and then the reconciler has to decide.
  // `stats:` rows are never prefiltered (overwrite semantics), and neither
  // is a value the reconciler's own plausibility gate would refuse.
  const onceInThisBatch = onceInBatch(prepared.map((p) => p.row));
  const existingByExternalKey = await readStoredSampleIdentities(
    prisma,
    userId,
    [
      ...new Set(
        prepared
          .map((p) => p.row.externalId as string)
          .filter((externalId) => !isStatsExternalId(externalId)),
      ),
    ],
  );

  // An unchanged `stats:` re-post is reported `updated` without a write
  // (see `batch-stored-rows.ts`), under the same once-per-batch key rule.
  const storedStats = await readStoredStatsRows(prisma, userId, [
    ...new Set(
      prepared
        .map((p) => p.row.externalId as string)
        .filter((externalId) => isStatsExternalId(externalId)),
    ),
  ]);

  // The `folded_window` guard (`folded-window.ts`). A raw Apple Health
  // sample of a dense or mean type, old enough to have been folded, whose
  // hour or day a live `stats:` row already covers, is a duplicate: the fold
  // no longer leaves the raw rows behind as tombstones, so this is what
  // keeps a re-upload after an anchor reset from standing beside the mean
  // that already accounts for it. One read for the batch, and none at all
  // when no row is old enough.
  const foldedIndexes = await findFoldedWindowDuplicates(
    prisma,
    userId,
    prepared.map((p) => ({
      type: p.row.type as MeasurementType,
      source: p.row.source as MeasurementSource,
      externalId: p.row.externalId as string,
      measuredAt: p.row.measuredAt as Date,
    })),
  );
  const foldedPrepared = new Set(
    [...foldedIndexes].map((index) => prepared[index]),
  );

  return {
    crossSourceCandidates,
    onceInThisBatch,
    existingByExternalKey,
    storedStats,
    foldedPrepared,
  };
}

/** The measurement half of one batch: its verdicts and what they started. */
export class MeasurementBatchWriter {
  insertedCount = 0;
  updatedCount = 0;
  /**
   * `stats:` re-posts reported `updated` with nothing to write (see
   * `isUnchangedStatsRow`). Counted in the response's `updated` like before,
   * and in nothing that starts work.
   */
  unchangedStatsCount = 0;
  readonly unchangedStatsRows = new Set<PreparedEntry>(); // #1259: not an arrival
  duplicateCount = 0;
  failedCount = 0;
  /** Subset of `insertedCount` written by the set-based insert. */
  setInsertedCount = 0;
  /**
   * Subset of `duplicateCount` collapsed by the MANUAL↔APPLE_HEALTH
   * same-reading merge (iOS #2), as opposed to a plain composite-key
   * duplicate. Surfaced as a dedicated wide-event count so an operator can
   * see how often the standalone-pair mirror collapses.
   */
  crossSourceMergedCount = 0;
  /** Subset of `duplicateCount` refused by the `folded_window` guard. */
  foldedWindowCount = 0;
  /** Only rows the reconciler actually inserted drive arrival side effects. */
  readonly insertedPrepared: PreparedEntry[] = [];
  readonly writtenIdentities: Array<{
    type: MeasurementType;
    measuredAt: Date;
  }> = [];

  /**
   * Rows already chosen for insert earlier in THIS batch — so a MANUAL
   * and an APPLE_HEALTH same-reading arriving in the SAME batch also
   * collapse (the DB probe only sees rows from prior batches).
   */
  private readonly inBatchCandidates: MergeCandidate[] = [];
  private readonly pendingInserts: PreparedEntry[] = [];
  private stored!: StoredState;

  constructor(
    private readonly userId: string,
    private readonly results: EntryResult[],
  ) {}

  /** Write every prepared row, in order, recording each verdict. */
  async write(prepared: PreparedEntry[]): Promise<void> {
    if (prepared.length === 0) return;
    this.stored = await readStoredState(this.userId, prepared);

    // `stats:` rows carry overwrite semantics and the last entry in one batch
    // is authoritative. Earlier snapshots are safe duplicates.
    const lastStatsIndexByKey = new Map<string, number>();
    for (const p of prepared) {
      if (!isStatsExternalId(p.row.externalId as string)) continue;
      lastStatsIndexByKey.set(
        `${p.row.type}::${p.row.source}::${p.row.externalId}`,
        p.index,
      );
    }

    for (const p of prepared) {
      await this.writeRow(p, lastStatsIndexByKey);
    }
    await this.flushPendingInserts();
  }

  private async writeRow(
    p: PreparedEntry,
    lastStatsIndexByKey: Map<string, number>,
  ): Promise<void> {
    const externalId = p.row.externalId as string;
    const statsRow = isStatsExternalId(externalId);
    const key = `${p.row.type}::${p.row.source}::${externalId}`;
    if (statsRow && lastStatsIndexByKey.get(key) !== p.index) {
      this.results[p.index] = {
        index: p.index,
        status: "duplicate",
        reason: "superseded_in_batch",
      };
      this.duplicateCount++;
      return;
    }

    if (statsRow && this.isUnchangedStatsRow(p)) {
      this.results[p.index] = { index: p.index, status: "updated" };
      this.unchangedStatsCount++;
      this.unchangedStatsRows.add(p);
      this.pushMergeCandidate(p);
      return;
    }

    if (!statsRow && this.hasSameReadingSibling(p)) {
      this.results[p.index] = {
        index: p.index,
        status: "duplicate",
        reason: "cross_source_merge",
      };
      this.duplicateCount++;
      this.crossSourceMergedCount++;
      return;
    }

    // Both verdicts below are the reconciler's `duplicate`, reached without
    // its transaction; like every duplicate they fall through to the
    // in-batch merge candidates.
    const prefiltered = !statsRow && this.isExactStoredDuplicate(p);
    const folded =
      !prefiltered && !statsRow && this.stored.foldedPrepared.has(p);
    if (prefiltered || folded) {
      this.results[p.index] = folded
        ? {
            index: p.index,
            status: "duplicate",
            reason: FOLDED_WINDOW_REASON,
          }
        : { index: p.index, status: "duplicate" };
      this.duplicateCount++;
      if (folded) this.foldedWindowCount++;
      this.pushMergeCandidate(p);
      return;
    }

    if (this.stored.onceInThisBatch(p.row)) {
      this.pendingInserts.push(p);
      this.pushMergeCandidate(p);
      return;
    }

    await this.flushPendingInserts();
    this.applyVerdict(p, await this.reconcileRow(p), true);
  }

  private hasSameReadingSibling(p: PreparedEntry): boolean {
    const incoming = {
      type: p.row.type as MeasurementType,
      source: p.row.source as string,
      value: p.row.value as number,
      measuredAt: p.row.measuredAt as Date,
    };
    if (!isMergeableSource(incoming.source)) return false;
    for (const candidate of this.stored.crossSourceCandidates) {
      if (isSameReadingAcrossSource(incoming, candidate)) return true;
    }
    for (const candidate of this.inBatchCandidates) {
      if (isSameReadingAcrossSource(incoming, candidate)) return true;
    }
    return false;
  }

  private isExactStoredDuplicate(p: PreparedEntry): boolean {
    return (
      sampleIsStoredDuplicate(
        this.stored.existingByExternalKey.get(
          externalKeyOf(p.row.type, p.row.source, p.row.externalId),
        ),
        p.row,
      ) &&
      this.stored.onceInThisBatch(p.row) &&
      classifyRangeRejection(
        p.row.type as MeasurementType,
        p.row.value as number,
      ) === null
    );
  }

  private isUnchangedStatsRow(p: PreparedEntry): boolean {
    return (
      this.stored.onceInThisBatch(p.row) &&
      classifyRangeRejection(
        p.row.type as MeasurementType,
        p.row.value as number,
      ) === null &&
      statsWriteUnchanged(
        this.stored.storedStats.get(
          externalKeyOf(p.row.type, p.row.source, p.row.externalId),
        ),
        desiredFor(this.userId, p),
      )
    );
  }

  private pushMergeCandidate(p: PreparedEntry): void {
    if (isMergeableSource(p.row.source as string)) {
      this.inBatchCandidates.push({
        type: p.row.type as MeasurementType,
        source: p.row.source as string,
        value: p.row.value as number,
        measuredAt: p.row.measuredAt as Date,
      });
    }
  }

  /**
   * Record one row's verdict. `candidate` is false for a row whose merge
   * candidate was already pushed when it was buffered (see below).
   */
  private applyVerdict(
    p: PreparedEntry,
    verdict: Verdict,
    candidate: boolean,
  ): void {
    switch (verdict.status) {
      case "inserted":
        this.results[p.index] = { index: p.index, status: "inserted" };
        this.insertedCount++;
        this.insertedPrepared.push(p);
        this.writtenIdentities.push({
          type: p.row.type as MeasurementType,
          measuredAt: p.row.measuredAt as Date,
        });
        break;
      case "updated":
      case "resurrected":
        this.results[p.index] = { index: p.index, status: "updated" };
        this.updatedCount++;
        this.writtenIdentities.push(
          {
            type: p.row.type as MeasurementType,
            measuredAt: p.row.measuredAt as Date,
          },
          ...(verdict.dirtyIdentities ?? []),
        );
        break;
      case "duplicate":
        this.results[p.index] = { index: p.index, status: "duplicate" };
        this.duplicateCount++;
        break;
      case "failed":
        this.results[p.index] = {
          index: p.index,
          status: "failed",
          reason: verdict.error?.code ?? "write_failed",
        };
        this.failedCount++;
        return;
      case "rejected_range":
        // The reconciler carries the same plausibility gate the first pass
        // already applied, so reaching here means the two disagreed —
        // report it exactly as the earlier guard would have, and let the
        // wide-event tally record which end refused.
        this.results[p.index] = outOfRangeResult(
          p.index,
          p.row.type as string,
          p.row.value as number,
        );
        return;
    }
    if (candidate) this.pushMergeCandidate(p);
  }

  private reconcileRow(p: PreparedEntry) {
    return prisma.$transaction((tx) =>
      reconcileExternalMeasurement(tx, desiredFor(this.userId, p), {
        exactExternalMatch: isStatsExternalId(p.row.externalId as string)
          ? "update"
          : "duplicate",
      }),
    );
  }

  // Set-based inserts. A fresh sample used to cost one interactive
  // transaction of about ten round trips (savepoint, three advisory locks,
  // two candidate reads, the insert), so a 500-entry batch of new samples
  // was 500 of those in a row: the 2–15 s outliers.
  //
  // The reconciler inserts exactly when no row, live or tombstoned, holds
  // the entry's external identity `(type, source, externalId)` or its
  // natural identity `(type, measuredAt, source, sleepStage)`. Both are
  // full unique indexes (the natural one NULLS NOT DISTINCT), so
  // `INSERT … ON CONFLICT DO NOTHING` inserts exactly those rows and skips
  // every other; a skipped row then goes through the reconciler as before
  // and gets its own verdict (update, resurrect, duplicate). The insert
  // runs under the same per-account advisory lock the reconciler takes, so
  // the two serialise like two reconcilers would.
  //
  // Only a row whose external and natural key each occur once in the batch
  // is buffered, and the buffer is flushed before any other row reaches the
  // reconciler. Such a row shares no identity with another entry, so no
  // other entry's reconcile can create, move or retire a row at its
  // identity, and inserting it out of turn changes nothing. Rows the insert
  // skips are reconciled in their original order. A buffered row's merge
  // candidate is pushed when it is buffered, as the sequential loop pushed
  // it after a successful write; the only case that differs is a write that
  // fails outright, where the candidate stays.
  private async flushPendingInserts(): Promise<void> {
    if (this.pendingInserts.length === 0) return;
    const batch = this.pendingInserts.splice(0, this.pendingInserts.length);
    const landed = new Set<PreparedEntry>();
    try {
      for (let i = 0; i < batch.length; i += SET_INSERT_CHUNK) {
        const slice = batch.slice(i, i + SET_INSERT_CHUNK);
        const rows = await prisma.$transaction(async (tx) => {
          await lockMeasurementUser(tx, this.userId);
          return tx.measurement.createManyAndReturn({
            data: slice.map((p) => ({
              ...desiredFor(this.userId, p),
              sleepStage: (p.row.sleepStage ??
                null) as Prisma.MeasurementUncheckedCreateInput["sleepStage"],
              deletedAt: null,
            })),
            skipDuplicates: true,
            select: { type: true, source: true, externalId: true },
          });
        });
        const keys = new Set(
          rows.map((r) => `${r.type}::${r.source}::${r.externalId}`),
        );
        for (const p of slice) {
          if (keys.has(`${p.row.type}::${p.row.source}::${p.row.externalId}`))
            landed.add(p);
        }
      }
    } catch (err) {
      // Whatever did not land goes through the reconciler below, which
      // turns a real database fault into a per-entry `failed` verdict.
      annotate({
        action: { name: "measurement.batch.set_insert_fallback" },
        meta: {
          error_class: err instanceof Error ? err.name : "unknown",
          landed: landed.size,
          pending: batch.length,
        },
      });
    }
    this.setInsertedCount += landed.size;
    for (const p of batch) {
      if (landed.has(p)) this.applyVerdict(p, { status: "inserted" }, false);
      else this.applyVerdict(p, await this.reconcileRow(p), false);
    }
  }
}
