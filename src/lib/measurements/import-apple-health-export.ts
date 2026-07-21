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
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sax from "sax";

import { Prisma } from "@/generated/prisma/client";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import {
  APPLE_HEALTH_SLEEP_STAGE_MAP,
  APPLE_HEALTH_TYPE_MAP,
  CUMULATIVE_HK_TYPES,
  HK_QUANTITY_TYPE_DEFERRED,
  dailyStatsExternalId,
  mapAppleHealthEntry,
} from "@/lib/measurements/apple-health-mapping";
import {
  dayKeyForUserTz,
  canonicalDailyTimestamp,
} from "@/lib/measurements/drain-per-sample-cumulative";
import { reconcileExternalMeasurement } from "@/lib/measurements/reconcile-external-measurement";
import { resolveHkWorkoutSportType } from "@/lib/measurements/hk-workout-activity-type-map";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { validateMeasurementRange } from "@/lib/validations/measurement";
import {
  CycleImportAccumulator,
  EMPTY_CYCLE_IMPORT_STATS,
  type CycleImportStats,
} from "@/lib/cycle/import-accumulator";
import { HK_SEXUAL_ACTIVITY_PROTECTION_META } from "@/lib/cycle/healthkit-mapping";

/**
 * Reverse-lookup for the symbolic `HKCategoryValueSleepAnalysis*`
 * names Apple writes to `Record[type="HKCategoryTypeIdentifierSleepAnalysis"]`
 * `value` attributes. The web batch endpoint receives the integer
 * codepoint pre-resolved by iOS; the XML export carries the symbolic
 * name. Mirrors `APPLE_HEALTH_SLEEP_STAGE_MAP` inverted by stage
 * label so the existing `mapAppleHealthEntry()` path picks up the
 * integer codepoint without further translation.
 */
const SLEEP_STAGE_NAME_TO_CODEPOINT: Record<string, number> = {
  HKCategoryValueSleepAnalysisInBed: 0,
  HKCategoryValueSleepAnalysisAsleep: 1,
  HKCategoryValueSleepAnalysisAsleepUnspecified: 1,
  HKCategoryValueSleepAnalysisAwake: 2,
  HKCategoryValueSleepAnalysisAsleepCore: 3,
  HKCategoryValueSleepAnalysisAsleepDeep: 4,
  HKCategoryValueSleepAnalysisAsleepREM: 5,
};

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
    unknownActivityType: number;
    routesAttached: number;
    durationMs: number;
  };
  clinical: { skipped: number };
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
  totals: {
    recordsRead: number;
    rowsUpserted: number;
    durationMs: number;
  };
}

/** Flush row written to the `Measurement` table. */
interface PreparedMeasurement {
  userId: string;
  type: MeasurementType;
  value: number;
  unit: string;
  measuredAt: Date;
  externalId: string;
  externalSourceVersion: string | null;
  sleepStage: Prisma.MeasurementCreateInput["sleepStage"];
  deviceType: string | null;
}

/** Flush row written to the `Workout` table. */
interface PreparedWorkout {
  userId: string;
  sportType: string;
  startedAt: Date;
  endedAt: Date;
  durationSec: number;
  totalEnergyKcal: number | null;
  totalDistanceM: number | null;
  externalId: string;
  externalSourceVersion: string | null;
  metadata: Prisma.JsonValue | null;
}

type CumulativeSourceSubtotals = Map<string, number>;

/** Per-type running stats accumulator. */
interface MutableTypeStat {
  read: number;
  inserted: number;
  updated: number;
  durationMs: number;
}

/** Tick frequency for the live `ImportJob.progress` write. */
const PROGRESS_TICK_RECORDS = 1_000;
const SPOT_FLUSH_BATCH = 500;
const WORKOUT_FLUSH_BATCH = 100;

/**
 * Hash the upload to a deterministic `externalId` when no
 * `HKMetadataKeyExternalUUID` is present. Truncated to 28 hex chars
 * (~112 bits) — well inside the 120-char Zod cap on `externalId`,
 * and orders of magnitude more collision budget than any reasonable
 * export could need.
 */
export function hashSampleKey(
  hkIdentifier: string,
  value: number | string,
  startDate: string,
  endDate: string,
): string {
  return (
    "sample:" +
    createHash("sha256")
      .update(`${hkIdentifier}|${value}|${startDate}|${endDate}`)
      .digest("hex")
      .slice(0, 28)
  );
}

const UNATTRIBUTED_CUMULATIVE_SOURCE_HASH = createHash("sha256")
  .update(JSON.stringify(["unattributed"]))
  .digest("hex");

/**
 * Hash the source tuple used only to keep overlapping export.xml contributors
 * separate. Records without source metadata share one stable bucket so parser
 * state remains bounded by actual source cardinality rather than record count.
 * Raw source/device labels never leave the parser.
 */
export function hashCumulativeSourceIdentity(
  sourceName: string | undefined,
  sourceVersion: string | undefined,
  device: string | undefined,
): string {
  const sourceTuple = [
    sourceName?.trim() ?? "",
    sourceVersion?.trim() ?? "",
    device?.trim() ?? "",
  ];
  if (!sourceTuple.some(Boolean)) {
    return UNATTRIBUTED_CUMULATIVE_SOURCE_HASH;
  }
  return createHash("sha256")
    .update(JSON.stringify(["source", ...sourceTuple]))
    .digest("hex");
}

/**
 * Parse the Apple `Record` `value` attribute. Quantity records carry
 * a numeric string; sleep-analysis records carry the symbolic name.
 * Returns `null` for unparseable values so the caller can skip the
 * row rather than poisoning the batch.
 */
export function parseRecordValue(
  hkIdentifier: string,
  rawValue: string | undefined,
  startDate: string,
  endDate: string,
): { value: number; sleepStage?: number } | null {
  if (rawValue === undefined) return null;
  if (hkIdentifier === "HKCategoryTypeIdentifierSleepAnalysis") {
    const stage = SLEEP_STAGE_NAME_TO_CODEPOINT[rawValue];
    if (stage === undefined) return null;
    // For sleep, our `mapAppleHealthEntry` expects the value to be the
    // duration in minutes; derive it from start/end so the row carries
    // the canonical reading downstream.
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return null;
    }
    const minutes = Math.max(0, (end.getTime() - start.getTime()) / 60_000);
    return { value: minutes, sleepStage: stage };
  }
  if (
    hkIdentifier ===
      "HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent" ||
    hkIdentifier === "HKCategoryTypeIdentifierHeadphoneAudioExposureEvent"
  ) {
    // Apple writes these category-type events with empty / sentinel
    // value strings. `mapAppleHealthEntry()` ignores the inbound
    // number and always converts to a 1.0 count.
    return { value: 1 };
  }
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed)) return null;
  return { value: parsed };
}

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
  prisma: Pick<PrismaClient, "measurement" | "workout" | "$transaction">;
  /**
   * Live progress hook. Called every `PROGRESS_TICK_RECORDS` records
   * read, and once on terminal `done`. Best-effort; the parser
   * continues even if the hook throws.
   */
  onProgress?: (snapshot: ImportJobProgress) => Promise<void> | void;
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
    spotBatchSize = SPOT_FLUSH_BATCH,
    workoutBatchSize = WORKOUT_FLUSH_BATCH,
  } = input;

  const startedAt = Date.now();
  const perType: Record<string, MutableTypeStat> = {};
  const workouts = {
    read: 0,
    inserted: 0,
    updated: 0,
    unknownActivityType: 0,
    routesAttached: 0,
    durationMs: 0,
  };
  const clinical = { skipped: 0 };
  const deferred: Record<string, number> = {};
  const unknown: Record<string, number> = {};

  // v1.15.0 — reproductive HK samples fold into one CycleDayLog per day.
  // The accumulator buckets in memory; the flush at end of parse upserts.
  const cycleAccumulator = new CycleImportAccumulator(userId, userTimezone);
  // Context for a reproductive `<Record>` whose protection metadata
  // arrives as a following `<MetadataEntry>` child (SexualActivity). Held
  // between the Record open-tag and its close-tag so the child can attach.
  let currentCycleRecord: {
    hkType: string;
    dayKey: string;
    rawValue: string | undefined;
    protectionUsed?: boolean;
  } | null = null;

  // Cumulative fold: type -> local day -> hashed source identity -> subtotal.
  const cumulativeBucket = new Map<
    MeasurementType,
    Map<string, CumulativeSourceSubtotals>
  >();
  // Spot-row batch awaiting flush.
  const spotBatch: PreparedMeasurement[] = [];
  // Workout-row batch awaiting flush.
  const workoutBatch: PreparedWorkout[] = [];

  let recordsRead = 0;
  let rowsUpserted = 0;
  const cumulativeEstimatedDays = new Set<string>();
  let cumulativeEstimatedRows = 0;
  // Per R-1 §8 the percent stays best-effort and may remain null
  // until the parser sees the closing `</HealthData>` tag. We don't
  // currently mutate this in v1.4.34 — the iOS app keeps polling on
  // the elapsed-ms instead — but keep the field around so the
  // progress envelope stays additive for future percent backfill.
  const totalRecords: number | null = null;

  const bumpStat = (type: MeasurementType): MutableTypeStat => {
    const key = type as string;
    let stat = perType[key];
    if (!stat) {
      stat = { read: 0, inserted: 0, updated: 0, durationMs: 0 };
      perType[key] = stat;
    }
    return stat;
  };

  const emitProgress = async (
    phase: ImportJobProgress["currentPhase"],
  ): Promise<void> => {
    if (!onProgress) return;
    const snapshot: ImportJobProgress = {
      currentPhase: phase,
      recordsRead,
      rowsUpserted,
      percent:
        totalRecords && totalRecords > 0
          ? Math.min(99, Math.round((recordsRead / totalRecords) * 100))
          : null,
      elapsedMs: Date.now() - startedAt,
    };
    try {
      await onProgress(snapshot);
    } catch {
      // best-effort; do not poison the parse loop
    }
  };

  // ── Flush helpers ──────────────────────────────────────────
  const flushSpotBatch = async (): Promise<void> => {
    if (spotBatch.length === 0) return;
    const chunk = spotBatch.splice(0, spotBatch.length);
    const insertedArrivals: Array<{
      id: string;
      type: MeasurementType;
      measuredAt: Date;
    }> = [];
    const createData: Prisma.MeasurementCreateManyInput[] = chunk.map(
      (row) => ({
        userId,
        type: row.type,
        value: row.value,
        unit: row.unit,
        source: "APPLE_HEALTH",
        measuredAt: row.measuredAt,
        externalId: row.externalId,
        externalSourceVersion: row.externalSourceVersion,
        sleepStage: row.sleepStage ?? null,
        deviceType: row.deviceType,
      }),
    );
    const insertStartedAt = Date.now();
    let createdRows: Array<{
      id: string;
      type: MeasurementType;
      measuredAt: Date;
      externalId: string | null;
    }> = [];
    const failedInsertIndexes = new Set<number>();
    try {
      createdRows = await prisma.measurement.createManyAndReturn({
        data: createData,
        skipDuplicates: true,
        select: {
          id: true,
          type: true,
          measuredAt: true,
          externalId: true,
        },
      });
    } catch {
      // Retain the old per-sample failure isolation if an unexpected database
      // error rejects the bulk statement. Conflicts remain non-errors because
      // every retry still uses skipDuplicates.
      for (let index = 0; index < createData.length; index += 1) {
        try {
          const created = await prisma.measurement.createManyAndReturn({
            data: [createData[index]],
            skipDuplicates: true,
            select: {
              id: true,
              type: true,
              measuredAt: true,
              externalId: true,
            },
          });
          createdRows.push(...created);
        } catch {
          failedInsertIndexes.add(index);
        }
      }
    }
    const insertDurationShare =
      chunk.length > 0 ? (Date.now() - insertStartedAt) / chunk.length : 0;
    const createdByKey = new Map<string, Array<(typeof createdRows)[number]>>();
    for (const created of createdRows) {
      if (!created.externalId) continue;
      const key = `${created.type}::${created.externalId}`;
      const matches = createdByKey.get(key);
      if (matches) matches.push(created);
      else createdByKey.set(key, [created]);
    }

    for (let index = 0; index < chunk.length; index += 1) {
      const row = chunk[index];
      const stat = bumpStat(row.type);
      const rowStart = Date.now();
      if (failedInsertIndexes.has(index)) {
        unknown[`${row.type}::upsert_failed`] =
          (unknown[`${row.type}::upsert_failed`] ?? 0) + 1;
        stat.durationMs += insertDurationShare + (Date.now() - rowStart);
        continue;
      }

      const key = `${row.type}::${row.externalId}`;
      const inserted = createdByKey.get(key)?.shift();
      if (inserted) {
        stat.inserted += 1;
        insertedArrivals.push(inserted);
        rowsUpserted += 1;
        stat.durationMs += insertDurationShare + (Date.now() - rowStart);
        continue;
      }

      try {
        await prisma.measurement.update({
          where: {
            userId_type_source_externalId: {
              userId,
              type: row.type,
              source: "APPLE_HEALTH",
              externalId: row.externalId,
            },
          },
          data: {
            value: row.value,
            measuredAt: row.measuredAt,
            externalSourceVersion: row.externalSourceVersion,
            sleepStage: row.sleepStage ?? null,
            deviceType: row.deviceType,
          },
        });
        stat.updated += 1;
        rowsUpserted += 1;
      } catch (err) {
        // A skipped INSERT can mean the second natural key won rather than
        // this external id. Adopt that row exactly as the old upsert rescue
        // did. P2025 is the expected "external id absent" signal; P2002 can
        // still arise when an existing external-id row changes natural key.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          (err.code === "P2002" || err.code === "P2025")
        ) {
          try {
            const twin = await prisma.measurement.findFirst({
              where: {
                userId,
                type: row.type,
                source: "APPLE_HEALTH",
                measuredAt: row.measuredAt,
                sleepStage: row.sleepStage ?? null,
              },
              select: { id: true },
            });
            if (twin) {
              await prisma.measurement.update({
                where: { id: twin.id },
                data: {
                  value: row.value,
                  unit: row.unit,
                  externalId: row.externalId,
                  externalSourceVersion: row.externalSourceVersion,
                  deviceType: row.deviceType,
                  deletedAt: null,
                },
              });
              stat.updated += 1;
              rowsUpserted += 1;
            } else {
              unknown[`${row.type}::natural_key_unresolved`] =
                (unknown[`${row.type}::natural_key_unresolved`] ?? 0) + 1;
            }
          } catch {
            unknown[`${row.type}::natural_key_rescue_failed`] =
              (unknown[`${row.type}::natural_key_rescue_failed`] ?? 0) + 1;
          }
        } else {
          unknown[`${row.type}::upsert_failed`] =
            (unknown[`${row.type}::upsert_failed`] ?? 0) + 1;
        }
      }
      stat.durationMs += insertDurationShare + (Date.now() - rowStart);
    }
    if (insertedArrivals.length > 0) {
      await emitInsertedMeasurementArrivals(
        userId,
        insertedArrivals,
        "apple_export",
      );
      const insertedSleepAts = insertedArrivals
        .filter((row) => row.type === "SLEEP_DURATION")
        .map((row) => row.measuredAt);
      if (insertedSleepAts.length > 0) {
        void maybeEnqueueMorningRefresh(userId, insertedSleepAts).catch(
          () => {},
        );
      }
    }
  };

  const flushWorkoutBatch = async (): Promise<void> => {
    if (workoutBatch.length === 0) return;
    const chunk = workoutBatch.splice(0, workoutBatch.length);
    const insertedArrivals: Array<{ id: string; startedAt: Date }> = [];
    const createData: Prisma.WorkoutCreateManyInput[] = chunk.map((row) => ({
      userId,
      sportType: row.sportType,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      totalEnergyKcal: row.totalEnergyKcal,
      totalDistanceM: row.totalDistanceM,
      source: "APPLE_HEALTH",
      externalId: row.externalId,
      externalSourceVersion: row.externalSourceVersion,
      metadata: row.metadata ?? undefined,
    }));
    const insertStartedAt = Date.now();
    const createdRows = await prisma.workout.createManyAndReturn({
      data: createData,
      skipDuplicates: true,
      select: { id: true, startedAt: true, externalId: true },
    });
    const insertDurationShare =
      chunk.length > 0 ? (Date.now() - insertStartedAt) / chunk.length : 0;
    const createdByExternalId = new Map<
      string,
      Array<(typeof createdRows)[number]>
    >();
    for (const created of createdRows) {
      if (!created.externalId) continue;
      const matches = createdByExternalId.get(created.externalId);
      if (matches) matches.push(created);
      else createdByExternalId.set(created.externalId, [created]);
    }

    for (const row of chunk) {
      const rowStart = Date.now();
      const inserted = createdByExternalId.get(row.externalId)?.shift();
      if (inserted) {
        workouts.inserted += 1;
        insertedArrivals.push(inserted);
      } else {
        await prisma.workout.update({
          where: {
            userId_source_externalId: {
              userId,
              source: "APPLE_HEALTH",
              externalId: row.externalId,
            },
          },
          data: {
            sportType: row.sportType,
            startedAt: row.startedAt,
            endedAt: row.endedAt,
            durationSec: row.durationSec,
            totalEnergyKcal: row.totalEnergyKcal,
            totalDistanceM: row.totalDistanceM,
            externalSourceVersion: row.externalSourceVersion,
            metadata: row.metadata ?? undefined,
          },
        });
        workouts.updated += 1;
      }
      workouts.durationMs += insertDurationShare + (Date.now() - rowStart);
      rowsUpserted += 1;
    }
    for (const workout of insertedArrivals.sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    )) {
      await emitDataArrival({
        userId,
        kind: "workout",
        newestSampleAt: workout.startedAt,
        insertedCount: 1,
        refId: workout.id,
        source: "apple_export",
      });
    }
  };

  const flushCumulativeBuckets = async (): Promise<void> => {
    for (const [type, byDay] of cumulativeBucket.entries()) {
      // Re-resolve the HK identifier from the mapping table — the bucket keys
      // are MeasurementType, but the shared externalId carries the HK
      // identifier used by native HealthKit statistics.
      const mapping = Object.values(APPLE_HEALTH_TYPE_MAP).find(
        (candidate) => candidate.measurementType === type,
      );
      if (!mapping) continue;
      const stat = bumpStat(type);

      for (const [dayKey, bySource] of byDay.entries()) {
        let selected: [sourceHash: string, subtotal: number] | undefined;
        for (const entry of bySource.entries()) {
          if (
            !selected ||
            entry[1] > selected[1] ||
            (entry[1] === selected[1] && entry[0] < selected[0])
          ) {
            selected = entry;
          }
        }
        if (!selected) continue;
        const [selectedSourceHash, selectedSubtotal] = selected;
        if (validateMeasurementRange(type, selectedSubtotal) !== null) {
          unknown[`${type}::aggregate_out_of_range`] =
            (unknown[`${type}::aggregate_out_of_range`] ?? 0) + 1;
          continue;
        }
        const externalId = dailyStatsExternalId(mapping.hkIdentifier, dayKey);
        const measuredAt = canonicalDailyTimestamp(dayKey, userTimezone);
        const rowStart = Date.now();
        const verdict = await prisma.$transaction((tx) =>
          reconcileExternalMeasurement(
            tx,
            {
              userId,
              type,
              value: selectedSubtotal,
              unit: mapping.dbUnit,
              source: "APPLE_HEALTH",
              measuredAt,
              externalId,
              externalSourceVersion: null,
              sleepStage: null,
              deviceType: null,
              aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
              aggregationContributorCount: bySource.size,
              aggregationSelectedSourceHash: selectedSourceHash,
            },
            { exactExternalMatch: "update" },
          ),
        );

        cumulativeEstimatedDays.add(dayKey);
        cumulativeEstimatedRows += 1;
        if (verdict.status === "inserted") {
          stat.inserted += 1;
          rowsUpserted += 1;
        } else if (
          verdict.status === "updated" ||
          verdict.status === "resurrected"
        ) {
          stat.updated += 1;
          rowsUpserted += 1;
        } else if (verdict.status === "failed") {
          unknown[`${type}::upsert_failed`] =
            (unknown[`${type}::upsert_failed`] ?? 0) + 1;
        }
        stat.durationMs += Date.now() - rowStart;
      }
    }
  };

  // ── SAX parser configuration ────────────────────────────────
  const parser = sax.parser(true, { trim: true });
  let pendingError: Error | null = null;
  let currentWorkout: PreparedWorkout | null = null;

  parser.onerror = (err) => {
    pendingError = err instanceof Error ? err : new Error(String(err));
  };

  parser.onopentag = (node) => {
    const name = node.name;
    const attrs = node.attributes as Record<string, string>;

    if (name === "Record") {
      const hkType = attrs.type;
      if (!hkType) return;
      recordsRead += 1;

      // v1.15.0 — reproductive HK identifiers route into CYCLE day-logs,
      // not Measurement. Defer the fold until the Record's close-tag so a
      // child `<MetadataEntry>` (SexualActivity protection flag) can
      // attach. The accumulator's per-day bucketing handles same-day
      // merges + idempotent re-import.
      if (CycleImportAccumulator.handles(hkType)) {
        const dayKey = dayKeyForUserTz(
          new Date(attrs.endDate ?? attrs.startDate ?? ""),
          userTimezone,
        );
        currentCycleRecord = Number.isNaN(
          Date.parse(attrs.endDate ?? attrs.startDate ?? ""),
        )
          ? null
          : { hkType, dayKey, rawValue: attrs.value };
        return;
      }

      if (HK_QUANTITY_TYPE_DEFERRED.has(hkType)) {
        deferred[hkType] = (deferred[hkType] ?? 0) + 1;
        return;
      }
      const mapping = APPLE_HEALTH_TYPE_MAP[hkType];
      if (!mapping) {
        unknown[hkType] = (unknown[hkType] ?? 0) + 1;
        return;
      }

      const parsedValue = parseRecordValue(
        hkType,
        attrs.value,
        attrs.startDate,
        attrs.endDate,
      );
      if (!parsedValue) {
        unknown[`${hkType}::unparseable`] =
          (unknown[`${hkType}::unparseable`] ?? 0) + 1;
        return;
      }

      const mapped = mapAppleHealthEntry({
        hkIdentifier: hkType,
        value: parsedValue.value,
        unit: attrs.unit ?? mapping.hkUnit,
        startDate: attrs.startDate,
        endDate: attrs.endDate,
        sleepStage: parsedValue.sleepStage,
      });
      if (!mapped) {
        unknown[`${hkType}::map_failed`] =
          (unknown[`${hkType}::map_failed`] ?? 0) + 1;
        return;
      }

      // Plausibility-range guard. A single rogue sample shouldn't
      // poison the import — record under `unknown` with the
      // explicit reason tag so operators can spot ingest pathologies.
      const rangeError = validateMeasurementRange(mapped.type, mapped.value);
      if (rangeError !== null) {
        unknown[`${hkType}::out_of_range`] =
          (unknown[`${hkType}::out_of_range`] ?? 0) + 1;
        return;
      }

      const stat = bumpStat(mapped.type);
      stat.read += 1;

      if (CUMULATIVE_HK_TYPES.has(mapped.type)) {
        const dayKey = dayKeyForUserTz(mapped.takenAt, userTimezone);
        const sourceHash = hashCumulativeSourceIdentity(
          attrs.sourceName,
          attrs.sourceVersion,
          attrs.device,
        );
        let byDay = cumulativeBucket.get(mapped.type);
        if (!byDay) {
          byDay = new Map();
          cumulativeBucket.set(mapped.type, byDay);
        }
        let bySource = byDay.get(dayKey);
        if (!bySource) {
          bySource = new Map();
          byDay.set(dayKey, bySource);
        }
        bySource.set(
          sourceHash,
          (bySource.get(sourceHash) ?? 0) + mapped.value,
        );
      } else {
        // Spot row: derive a stable externalId, queue for flush.
        const externalId = hashSampleKey(
          hkType,
          attrs.value ?? "",
          attrs.startDate,
          attrs.endDate,
        );
        spotBatch.push({
          userId,
          type: mapped.type,
          value: mapped.value,
          unit: mapped.unit,
          measuredAt: mapped.takenAt,
          externalId,
          externalSourceVersion: attrs.sourceVersion ?? null,
          sleepStage: mapped.sleepStage ?? null,
          deviceType: null,
        });
      }
      return;
    }

    if (name === "Workout") {
      recordsRead += 1;
      workouts.read += 1;
      const activityType = attrs.workoutActivityType ?? "";
      const { sportType, known } = resolveHkWorkoutSportType(activityType);
      if (!known) workouts.unknownActivityType += 1;

      const startDate = new Date(attrs.startDate);
      const endDate = new Date(attrs.endDate);
      if (
        Number.isNaN(startDate.getTime()) ||
        Number.isNaN(endDate.getTime())
      ) {
        unknown[`Workout::bad_dates`] =
          (unknown[`Workout::bad_dates`] ?? 0) + 1;
        return;
      }
      const durationSec = Math.max(
        0,
        Math.round((endDate.getTime() - startDate.getTime()) / 1000),
      );

      const totalDistance = Number.parseFloat(attrs.totalDistance ?? "");
      const totalEnergy = Number.parseFloat(attrs.totalEnergyBurned ?? "");
      const distanceUnit = attrs.totalDistanceUnit ?? "";
      // Apple ships km for HKWorkout.totalDistance by default; metres
      // is the canonical DB unit. Convert when the unit is km.
      const distanceM = Number.isFinite(totalDistance)
        ? distanceUnit === "km"
          ? totalDistance * 1000
          : distanceUnit === "mi"
            ? totalDistance * 1609.344
            : totalDistance
        : null;

      const externalId = hashSampleKey(
        activityType || "Workout",
        attrs.duration ?? "",
        attrs.startDate,
        attrs.endDate,
      );

      currentWorkout = {
        userId,
        sportType,
        startedAt: startDate,
        endedAt: endDate,
        durationSec,
        totalEnergyKcal: Number.isFinite(totalEnergy) ? totalEnergy : null,
        totalDistanceM: distanceM,
        externalId,
        externalSourceVersion: attrs.sourceVersion ?? null,
        metadata: {
          activityType,
          sourceName: attrs.sourceName ?? null,
          durationUnit: attrs.durationUnit ?? null,
          totalDistanceUnit: distanceUnit || null,
          totalEnergyBurnedUnit: attrs.totalEnergyBurnedUnit ?? null,
        } as Prisma.JsonValue,
      };
      return;
    }

    if (name === "ClinicalRecord") {
      recordsRead += 1;
      clinical.skipped += 1;
      return;
    }

    if (name === "MetadataEntry") {
      // Attach the SexualActivity protection flag to the open cycle record.
      // Apple writes `HKMetadataKeySexualActivityProtectionUsed` with a
      // `"0"`/`"1"` (or `"true"`/`"false"`) value.
      if (
        currentCycleRecord &&
        attrs.key === HK_SEXUAL_ACTIVITY_PROTECTION_META
      ) {
        const v = (attrs.value ?? "").toLowerCase();
        currentCycleRecord.protectionUsed =
          v === "1" || v === "true" || v === "yes";
      }
      return;
    }

    if (
      name === "ExportDate" ||
      name === "Me" ||
      name === "Correlation" ||
      name === "ActivitySummary" ||
      name === "WorkoutEvent" ||
      name === "WorkoutRoute" ||
      name === "FileReference" ||
      name === "HealthData"
    ) {
      // Known elements we intentionally ignore at the open-tag stage.
      // Correlation envelopes flatten naturally because their child
      // `<Record>` elements still fire their own `onopentag`.
      return;
    }

    // Any other element name lands as a structural unknown — log
    // once per name so operators can spot future schema additions.
    unknown[`element::${name}`] = (unknown[`element::${name}`] ?? 0) + 1;
  };

  parser.onclosetag = async (tagName) => {
    if (tagName === "Workout" && currentWorkout) {
      workoutBatch.push(currentWorkout);
      currentWorkout = null;
    }
    if (tagName === "Record" && currentCycleRecord) {
      const rec = currentCycleRecord;
      currentCycleRecord = null;
      const consumed = cycleAccumulator.consume(
        rec.hkType,
        rec.dayKey,
        rec.rawValue,
        rec.protectionUsed,
      );
      if (!consumed) {
        // Recognised identifier but unrecognised value — count it under
        // `unknown` with the reason tag so operators can spot it.
        unknown[`${rec.hkType}::cycle_unmapped`] =
          (unknown[`${rec.hkType}::cycle_unmapped`] ?? 0) + 1;
      }
    }
  };

  // ── Drive the parser from a node read stream ────────────────
  const readable = createReadStream(xmlPath, { highWaterMark: 64 * 1024 });

  let lastProgressEmitAt = 0;
  const PROGRESS_EMIT_INTERVAL_MS = 250;

  const sink = new Writable({
    write(chunk: Buffer, _enc, callback) {
      try {
        parser.write(chunk.toString("utf8"));
        if (pendingError) {
          callback(pendingError);
          return;
        }
        // Drain any batches the parser filled to keep memory bounded.
        const shouldFlush =
          spotBatch.length >= spotBatchSize ||
          workoutBatch.length >= workoutBatchSize;
        const drain = async (): Promise<void> => {
          if (spotBatch.length >= spotBatchSize) await flushSpotBatch();
          if (workoutBatch.length >= workoutBatchSize)
            await flushWorkoutBatch();
          const now = Date.now();
          if (
            (recordsRead > 0 && recordsRead % PROGRESS_TICK_RECORDS === 0) ||
            now - lastProgressEmitAt > PROGRESS_EMIT_INTERVAL_MS
          ) {
            lastProgressEmitAt = now;
            await emitProgress("parsing");
          }
        };
        if (shouldFlush || recordsRead % PROGRESS_TICK_RECORDS === 0) {
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
        parser.close();
        callback();
      } catch (err) {
        callback(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  await pipeline(readable, sink);
  if (pendingError) throw pendingError;

  await emitProgress("upserting");
  // Drain any partial spot/workout batches that did not hit the flush
  // threshold during the parse.
  await flushSpotBatch();
  await flushWorkoutBatch();
  await flushCumulativeBuckets();

  // v1.15.0 — fold the accumulated reproductive samples into CYCLE
  // day-logs. Gated on cycle-tracking being enabled for the account so a
  // non-cycle Apple Health export never silently provisions cycle rows.
  let cycle: CycleImportStats = { ...EMPTY_CYCLE_IMPORT_STATS };
  // Only touch the cycle tables when the export actually carried
  // reproductive samples AND the account has cycle tracking enabled. The
  // empty-accumulator short-circuit also keeps the no-cycle import path
  // (and its unit tests) free of any cycle DB round-trip. A flush failure
  // (e.g. a single colliding day) must never abort the whole import — fold
  // the error into zeroed cycle stats and continue.
  if (cycleAccumulator.hasSamples() && (await cycleAccumulator.isEnabled())) {
    try {
      cycle = await cycleAccumulator.flush();
      rowsUpserted += cycle.daysUpserted;
    } catch (err: unknown) {
      cycle = { ...EMPTY_CYCLE_IMPORT_STATS };
      console.warn(
        `cycle import flush failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await emitProgress("upserting");

  return {
    perType,
    workouts,
    clinical,
    cycle,
    deferred,
    unknown,
    cumulativeEstimates: {
      days: cumulativeEstimatedDays.size,
      rows: cumulativeEstimatedRows,
    },
    totals: {
      recordsRead,
      rowsUpserted,
      durationMs: Date.now() - startedAt,
    },
  };
}

// Re-export the SLEEP_STAGE table for unit tests.
export { SLEEP_STAGE_NAME_TO_CODEPOINT, APPLE_HEALTH_SLEEP_STAGE_MAP };
