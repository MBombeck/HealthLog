/**
 * Streaming Apple Health `export.xml` parser + ingest mapper.
 *
 * Reads an `export.xml` byte-stream via `sax` (event-driven SAX, no
 * DOM) and folds every `<Record>`, `<Workout>`, and `<Correlation>`
 * element into the row shape the existing `Measurement` and
 * `Workout` models expect. Cumulative-quantity `<Record>` rows are folded by
 * `(type, local day, hashed source identity)`, summed within each source-day,
 * then reduced to the largest source subtotal. The resulting
 * `stats:<HKType>:<YYYY-MM-DD>` row is explicitly an export estimate; native
 * HealthKit statistics remain authoritative.
 *
 * Spot rows (BP, weight, HRV, …) survive verbatim, keyed by `HKSample.uuid`
 * when present. SAX callbacks fire as the byte cursor advances, so peak RSS
 * stays bounded regardless of input size. The cumulative map grows with the
 * observed `(type, day, source hash)` combinations; every record without source
 * metadata shares one bounded bucket, and raw source/device labels are never
 * retained.
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §6.
 */

import type { WorkoutRouteReference } from "@/lib/apple-health/route-import";
import { createReadStream } from "node:fs";
import { StringDecoder } from "node:string_decoder";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sax from "sax";

import { APPLE_HEALTH_SLEEP_STAGE_MAP } from "@/lib/measurements/apple-health-mapping";
import { type ClinicalLabReference } from "@/lib/apple-health/clinical-record-ref";
import { exportWorkoutTracker } from "@/lib/measurements/apple-health-export-workouts";
import { type CycleImportStats } from "@/lib/cycle/import-accumulator";
import {
  ExportImportWriter,
  ImportTally,
  type ExportImportPrisma,
} from "@/lib/measurements/import-apple-health-export-writer";
import { ExportCycleWriter } from "@/lib/measurements/import-apple-health-export-cycle";
import {
  SLEEP_STAGE_NAME_TO_CODEPOINT,
  emptyExportParseState,
  handleCloseTag,
  handleOpenTag,
  type ExportTagContext,
} from "@/lib/measurements/import-apple-health-export-handlers";

export {
  hashSampleKey,
  parseRecordValue,
} from "@/lib/measurements/import-apple-health-export-handlers";

/** Phase the worker is currently in. */
export type ImportJobPhase =
  "queued" | "unpacking" | "parsing" | "upserting" | "done" | "failed";

/**
 * Live snapshot the worker writes to `ImportJob.progress` every
 * `PROGRESS_TICK_RECORDS` records parsed. The polling endpoint
 * returns it verbatim.
 */
export interface ImportJobProgress {
  currentPhase: Exclude<ImportJobPhase, "queued" | "done" | "failed">;
  recordsRead: number;
  rowsUpserted: number;
  /** Percent is best-effort and may stay null until the parser sees
   *  `</HealthData>` (we don't know the total record count up-front). */
  percent: number | null;
  elapsedMs: number;
}

/** Final outcome carried on `ImportJob.result` once terminal. */
export interface ImportJobResult {
  perType: Record<
    string,
    { read: number; inserted: number; updated: number; durationMs: number }
  >;
  workouts: {
    read: number;
    inserted: number;
    updated: number;
    duplicate: number; // repeats of a workout the export already stated
    /**
     * Of `updated`: workouts the iPhone app had already stored under their
     * HealthKit UUID, filled from the export instead of stored again (#1414).
     */
    mergedIntoHealthKit: number;

    unknownActivityType: number;
    routesAttached: number;
    durationMs: number;
  };
  clinical: { skipped: number };
  /**
   * Records left out because HealthLog wrote them into Apple Health itself and
   * this account already holds them under their own source, each counted once
   * however often the export repeats it: `byMarker` carry the app's origin
   * marker and a HealthLog row id of this account (a cycle sample: a day-log of
   * this account on its day), `byExternalId` carry such a row id without the
   * marker (samples from before the marker existed), `matchedManual` match a
   * manual entry (same type and value, within 2 s). A marked sample this
   * account does not hold (a move to a new instance without a backup) is
   * imported like any other.
   */
  writtenByHealthLog: {
    byMarker: number;
    byExternalId: number;
    matchedManual: number;
  };
  /**
   * v1.15.0 — reproductive HealthKit samples routed into CYCLE day-logs
   * (NOT Measurement). Absent / zeroed when the account has no cycle
   * tracking enabled (the fold is gated) or the export carried no
   * reproductive records.
   */
  cycle: CycleImportStats;
  deferred: Record<string, number>;
  unknown: Record<string, number>;
  cumulativeEstimates: {
    /** Distinct local calendar days containing at least one estimated total. */
    days: number;
    /** Estimated `(measurement type, local day)` aggregate rows considered. */
    rows: number;
  };
  /**
   * Oldest and newest instant this import wrote a measurement at (ISO), or
   * null when it wrote none. What the rollup fold after the import covers.
   */
  measuredSpan: { from: string; to: string } | null;
  /** Bounded auxiliary ECG outcomes. Never contains filenames or waveform data. */
  ecg: {
    discovered: number;
    imported: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  totals: {
    recordsRead: number;
    rowsUpserted: number;
    durationMs: number;
  };
}

/** Tick frequency for the live `ImportJob.progress` write. */
const PROGRESS_TICK_RECORDS = 1_000;
const SPOT_FLUSH_BATCH = 500;
const WORKOUT_FLUSH_BATCH = 100;

/**
 * Input to `streamParseExportXml()`.
 */
export interface StreamParseInput {
  /** Filesystem path to an unzipped `export.xml`. */
  xmlPath: string;
  /** Owner of the imported rows. */
  userId: string;
  /** IANA timezone, used to anchor cumulative-type day-keys. */
  userTimezone: string;
  /** Prisma client to flush rows through. */
  prisma: ExportImportPrisma;
  /**
   * Live progress hook. Called every `PROGRESS_TICK_RECORDS` records
   * read, and once on terminal `done`. Best-effort; the parser
   * continues even if the hook throws.
   */
  onProgress?: (snapshot: ImportJobProgress) => Promise<void> | void;
  /**
   * Called once, mid-run, with the instant Apple stamped on the archive
   * (`<ExportDate value="..."/>`, the first child of `<HealthData>`).
   * Never called for an archive that omits the element or writes an
   * unreadable value. Best-effort, like `onProgress`.
   */
  onExportDate?: (exportedAt: Date) => Promise<void> | void;
  /**
   * Optional override of the spot-row flush batch size. Defaults to
   * `SPOT_FLUSH_BATCH`. Lower values make the upsert path more
   * granular for tests; production runs should keep the default.
   */
  spotBatchSize?: number;
  /**
   * Optional override of the workout flush batch size. Defaults to
   * `WORKOUT_FLUSH_BATCH`.
   */
  workoutBatchSize?: number;
  /**
   * Called once per workout whose `<WorkoutRoute>` references a GPX file,
   * with the workout's `externalId` and the path Apple wrote. Only passed
   * when the account keeps workout routes (`storeWorkoutRoutes`); without it
   * the reference is not even read. The track is attached after the XML
   * pass, from the archive (`src/lib/apple-health/route-import.ts`).
   */
  onWorkoutRoute?: (ref: WorkoutRouteReference) => void;
  /** Called once per lab-result `<ClinicalRecord>`; without it every clinical
   *  record is counted as skipped (`src/lib/apple-health/clinical-labs-import.ts`). */
  onClinicalLabRecord?: (ref: ClinicalLabReference) => void;
}

/**
 * Streaming parse of an Apple Health `export.xml`. Returns the
 * terminal `ImportJobResult` envelope; mid-run updates flow through
 * `onProgress`. Throws on a fatal SAX error.
 *
 * Idempotency contract: every row UPSERTs against the existing
 * `(userId, type, source, externalId)` compound unique on
 * `Measurement` and `(userId, source, externalId)` on `Workout`. A
 * re-import of the exact same file reports 0 inserts and N updates.
 */
export async function streamParseExportXml(
  input: StreamParseInput,
): Promise<ImportJobResult> {
  const {
    xmlPath,
    userId,
    userTimezone,
    prisma,
    onProgress,
    onExportDate,
    onWorkoutRoute,
    spotBatchSize = SPOT_FLUSH_BATCH,
    workoutBatchSize = WORKOUT_FLUSH_BATCH,
  } = input;

  const startedAt = Date.now();
  const tally = new ImportTally();
  const writer = new ExportImportWriter(prisma, userId, userTimezone, tally);
  const cycleWriter = new ExportCycleWriter(
    prisma,
    userId,
    userTimezone,
    tally,
  );
  const state = emptyExportParseState();
  // Per R-1 §8 the percent stays best-effort and may remain null
  // until the parser sees the closing `</HealthData>` tag. We don't
  // currently mutate this in v1.4.34 — the iOS app keeps polling on
  // the elapsed-ms instead — but keep the field around so the
  // progress envelope stays additive for future percent backfill.
  const totalRecords: number | null = null;

  const emitProgress = async (
    phase: ImportJobProgress["currentPhase"],
  ): Promise<void> => {
    if (!onProgress) return;
    const snapshot: ImportJobProgress = {
      currentPhase: phase,
      recordsRead: tally.recordsRead,
      rowsUpserted: tally.rowsUpserted,
      percent:
        totalRecords && totalRecords > 0
          ? Math.min(99, Math.round((tally.recordsRead / totalRecords) * 100))
          : null,
      elapsedMs: Date.now() - startedAt,
    };
    try {
      await onProgress(snapshot);
    } catch {
      // best-effort; do not poison the parse loop
    }
  };

  // ── SAX parser configuration ────────────────────────────────
  const parser = sax.parser(true, { trim: true });
  let pendingError: Error | null = null;
  const ctx: ExportTagContext = {
    userId,
    userTimezone,
    tally,
    writer,
    cycle: cycleWriter,
    state,
    exportWorkouts: exportWorkoutTracker(),
    onWorkoutRoute,
    onClinicalLabRecord: input.onClinicalLabRecord,
  };

  // Apple stamps the archive with its own export instant as the first
  // child of `<HealthData>`. The element used to be on the ignore list,
  // so `ImportJob.exportedAt` — a column the status endpoint and the
  // published contract both promise — could only ever answer null. The
  // value is captured in the synchronous tag handler and handed to
  // `onExportDate` from the async drain, so the worker can persist it
  // while the run is still going rather than only on the terminal write.
  const flushExportDate = async (): Promise<void> => {
    const stamped = state.pendingExportDate;
    if (!stamped) return;
    state.pendingExportDate = null;
    if (onExportDate) await onExportDate(stamped);
  };

  parser.onerror = (err) => {
    pendingError = err instanceof Error ? err : new Error(String(err));
  };
  parser.onopentag = (node) => handleOpenTag(ctx, node);
  parser.onclosetag = (tagName) => handleCloseTag(ctx, tagName);

  // ── Drive the parser from a node read stream ────────────────
  const readable = createReadStream(xmlPath, { highWaterMark: 64 * 1024 });

  let lastProgressEmitAt = 0;
  const PROGRESS_EMIT_INTERVAL_MS = 250;

  // A read chunk can end mid-way through a multi-byte UTF-8 sequence
  // (umlauts in source names are routine); a bare `toString("utf8")`
  // per chunk would decay those split characters to U+FFFD. The
  // StringDecoder carries the partial sequence across chunk boundaries.
  const utf8Decoder = new StringDecoder("utf8");

  const sink = new Writable({
    write(chunk: Buffer, _enc, callback) {
      try {
        parser.write(utf8Decoder.write(chunk));
        if (pendingError) {
          callback(pendingError);
          return;
        }
        // Drain any batches the parser filled to keep memory bounded.
        const shouldFlush =
          state.pendingExportDate !== null ||
          writer.spotBatch.length >= spotBatchSize ||
          writer.workoutBatch.length >= workoutBatchSize;
        const drain = async (): Promise<void> => {
          await flushExportDate();
          if (writer.spotBatch.length >= spotBatchSize)
            await writer.flushSpotBatch();
          if (writer.workoutBatch.length >= workoutBatchSize)
            await writer.flushWorkoutBatch();
          const now = Date.now();
          if (
            (tally.recordsRead > 0 &&
              tally.recordsRead % PROGRESS_TICK_RECORDS === 0) ||
            now - lastProgressEmitAt > PROGRESS_EMIT_INTERVAL_MS
          ) {
            lastProgressEmitAt = now;
            await emitProgress("parsing");
          }
        };
        if (shouldFlush || tally.recordsRead % PROGRESS_TICK_RECORDS === 0) {
          drain()
            .then(() => callback())
            .catch((err) => callback(err));
        } else {
          callback();
        }
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
    final(callback) {
      try {
        const tail = utf8Decoder.end();
        if (tail.length > 0) parser.write(tail);
        parser.close();
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  await pipeline(readable, sink);
  if (pendingError) throw pendingError;

  // An archive small enough to arrive in a single chunk can finish
  // before any drain ran; the stamp still has to reach the caller.
  await flushExportDate();

  await emitProgress("upserting");
  // Drain any partial spot/workout batches that did not hit the flush
  // threshold during the parse.
  await writer.flushSpotBatch();
  await writer.flushWorkoutBatch();
  await writer.settleMarkedCumulative();
  await writer.flushCumulativeBuckets();
  await cycleWriter.settleMarked();

  // Fold the accumulated reproductive samples into CYCLE day-logs.
  const cycle: CycleImportStats = await cycleWriter.flush();

  await emitProgress("upserting");

  return importResult(tally, cycle, startedAt);
}

/** The terminal `ImportJobResult` envelope for one finished run. */
function importResult(
  tally: ImportTally,
  cycle: CycleImportStats,
  startedAt: number,
): ImportJobResult {
  const { spanFrom, spanTo } = tally;
  return {
    perType: tally.perType,
    workouts: tally.workouts,
    clinical: tally.clinical,
    writtenByHealthLog: tally.writtenByHealthLog,
    cycle,
    deferred: tally.deferred,
    unknown: tally.unknown,
    cumulativeEstimates: {
      days: tally.cumulativeEstimatedDays.size,
      rows: tally.cumulativeEstimatedRows,
    },
    measuredSpan:
      spanFrom !== null && spanTo !== null
        ? { from: spanFrom.toISOString(), to: spanTo.toISOString() }
        : null,
    ecg: {
      discovered: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
    },
    totals: {
      recordsRead: tally.recordsRead,
      rowsUpserted: tally.rowsUpserted,
      durationMs: Date.now() - startedAt,
    },
  };
}

// Re-export the SLEEP_STAGE table for unit tests.
export { SLEEP_STAGE_NAME_TO_CODEPOINT, APPLE_HEALTH_SLEEP_STAGE_MAP };
