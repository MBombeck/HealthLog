/**
 * Streaming Apple Health `export.xml` parser + ingest mapper.
 *
 * Reads an `export.xml` byte-stream via `sax` (event-driven SAX, no
 * DOM) and folds every `<Record>`, `<Workout>`, and `<Correlation>`
 * element into the row shape the existing `Measurement` and
 * `Workout` models expect. Cumulative-quantity `<Record>` rows
 * (steps, energy, distance, flights, daylight) collapse into one
 * `stats:<HKType>:<YYYY-MM-DD>` `Measurement` per user-local day
 * — mirroring iOS's `HKStatisticsCollectionQuery` daily-aggregation
 * convention locked in v1.4.30. Spot rows (BP, weight, HRV, …)
 * survive verbatim, keyed by `HKSample.uuid` when present.
 *
 * Memory profile: SAX callbacks fire as the byte cursor advances,
 * so peak RSS stays bounded regardless of the input file size. The
 * cumulative-bucket map holds at most one `(type, day)` entry per
 * observed day per cumulative type — a 10-year export with five
 * cumulative types lands at ~18 000 entries (~1 MB).
 *
 * Locks per `.planning/research/v1434-r-1-xml-import.md` §6.
 */
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import sax from "sax";

import { Prisma } from "@/generated/prisma/client";
import type {
  MeasurementType,
  PrismaClient,
} from "@/generated/prisma/client";
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
import { resolveHkWorkoutSportType } from "@/lib/measurements/hk-workout-activity-type-map";
import { validateMeasurementRange } from "@/lib/validations/measurement";

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
  | "queued"
  | "unpacking"
  | "parsing"
  | "upserting"
  | "done"
  | "failed";

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
  deferred: Record<string, number>;
  unknown: Record<string, number>;
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

/** Per-type running stats accumulator. */
interface MutableTypeStat {
  read: number;
  inserted: number;
  updated: number;
  durationMs: number;
}

/** Tick frequency for the live `ImportJob.progress` write. */
export const PROGRESS_TICK_RECORDS = 1_000;
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
  if (hkIdentifier === "HKCategoryTypeIdentifierEnvironmentalAudioExposureEvent"
    || hkIdentifier === "HKCategoryTypeIdentifierHeadphoneAudioExposureEvent") {
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
  prisma: Pick<PrismaClient, "measurement" | "workout">;
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

  // Cumulative-type fold: type -> dayKey -> running sum.
  const cumulativeBucket = new Map<MeasurementType, Map<string, number>>();
  // Spot-row batch awaiting flush.
  const spotBatch: PreparedMeasurement[] = [];
  // Workout-row batch awaiting flush.
  const workoutBatch: PreparedWorkout[] = [];

  let recordsRead = 0;
  let rowsUpserted = 0;
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
    // Look up existing rows by the compound unique key so we can
    // attribute inserts vs updates accurately for the per-type stats.
    const existingRows = await prisma.measurement.findMany({
      where: {
        userId,
        source: "APPLE_HEALTH",
        OR: chunk.map((r) => ({
          type: r.type,
          externalId: r.externalId,
        })),
      },
      select: { type: true, externalId: true },
    });
    const existingKey = new Set(
      existingRows.map((r) => `${r.type}::${r.externalId}`),
    );

    for (const row of chunk) {
      const stat = bumpStat(row.type);
      const rowStart = Date.now();
      const exists = existingKey.has(`${row.type}::${row.externalId}`);
      await prisma.measurement.upsert({
        where: {
          userId_type_source_externalId: {
            userId,
            type: row.type,
            source: "APPLE_HEALTH",
            externalId: row.externalId,
          },
        },
        create: {
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
        },
        update: {
          value: row.value,
          measuredAt: row.measuredAt,
          externalSourceVersion: row.externalSourceVersion,
          sleepStage: row.sleepStage ?? null,
          deviceType: row.deviceType,
        },
      });
      stat.durationMs += Date.now() - rowStart;
      if (exists) stat.updated += 1;
      else stat.inserted += 1;
      rowsUpserted += 1;
    }
  };

  const flushWorkoutBatch = async (): Promise<void> => {
    if (workoutBatch.length === 0) return;
    const chunk = workoutBatch.splice(0, workoutBatch.length);
    const existingRows = await prisma.workout.findMany({
      where: {
        userId,
        source: "APPLE_HEALTH",
        externalId: { in: chunk.map((r) => r.externalId) },
      },
      select: { externalId: true },
    });
    const existingKey = new Set(existingRows.map((r) => r.externalId));

    for (const row of chunk) {
      const rowStart = Date.now();
      const exists = existingKey.has(row.externalId);
      await prisma.workout.upsert({
        where: {
          userId_source_externalId: {
            userId,
            source: "APPLE_HEALTH",
            externalId: row.externalId,
          },
        },
        create: {
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
        },
        update: {
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
      workouts.durationMs += Date.now() - rowStart;
      if (exists) workouts.updated += 1;
      else workouts.inserted += 1;
      rowsUpserted += 1;
    }
  };

  const flushCumulativeBuckets = async (): Promise<void> => {
    for (const [type, byDay] of cumulativeBucket.entries()) {
      // Re-resolve the HK identifier from the mapping table — the
      // bucket keys are MeasurementType, but the externalId carries
      // the HK identifier so a future re-import collides on the
      // same string.
      const mapping = Object.values(APPLE_HEALTH_TYPE_MAP).find(
        (m) => m.measurementType === type,
      );
      if (!mapping) continue;
      const stat = bumpStat(type);

      for (const [dayKey, sum] of byDay.entries()) {
        const externalId = dailyStatsExternalId(mapping.hkIdentifier, dayKey);
        const measuredAt = canonicalDailyTimestamp(dayKey, userTimezone);
        const rowStart = Date.now();
        const existing = await prisma.measurement.findUnique({
          where: {
            userId_type_source_externalId: {
              userId,
              type,
              source: "APPLE_HEALTH",
              externalId,
            },
          },
          select: { id: true },
        });
        await prisma.measurement.upsert({
          where: {
            userId_type_source_externalId: {
              userId,
              type,
              source: "APPLE_HEALTH",
              externalId,
            },
          },
          create: {
            userId,
            type,
            value: sum,
            unit: mapping.dbUnit,
            source: "APPLE_HEALTH",
            measuredAt,
            externalId,
          },
          update: {
            value: sum,
            measuredAt,
          },
        });
        stat.durationMs += Date.now() - rowStart;
        if (existing) stat.updated += 1;
        else stat.inserted += 1;
        rowsUpserted += 1;
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
        let byDay = cumulativeBucket.get(mapped.type);
        if (!byDay) {
          byDay = new Map();
          cumulativeBucket.set(mapped.type, byDay);
        }
        byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + mapped.value);
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
      if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
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

    if (name === "ExportDate" || name === "Me" || name === "Correlation"
        || name === "ActivitySummary" || name === "MetadataEntry"
        || name === "WorkoutEvent" || name === "WorkoutRoute"
        || name === "FileReference" || name === "HealthData") {
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
          spotBatch.length >= spotBatchSize
          || workoutBatch.length >= workoutBatchSize;
        const drain = async (): Promise<void> => {
          if (spotBatch.length >= spotBatchSize) await flushSpotBatch();
          if (workoutBatch.length >= workoutBatchSize) await flushWorkoutBatch();
          const now = Date.now();
          if (
            (recordsRead > 0 && recordsRead % PROGRESS_TICK_RECORDS === 0)
            || now - lastProgressEmitAt > PROGRESS_EMIT_INTERVAL_MS
          ) {
            lastProgressEmitAt = now;
            await emitProgress("parsing");
          }
        };
        if (shouldFlush || recordsRead % PROGRESS_TICK_RECORDS === 0) {
          drain().then(() => callback()).catch((err) => callback(err));
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

  await emitProgress("upserting");

  return {
    perType,
    workouts,
    clinical,
    deferred,
    unknown,
    totals: {
      recordsRead,
      rowsUpserted,
      durationMs: Date.now() - startedAt,
    },
  };
}

// Re-export the SLEEP_STAGE table for unit tests.
export { SLEEP_STAGE_NAME_TO_CODEPOINT, APPLE_HEALTH_SLEEP_STAGE_MAP };
