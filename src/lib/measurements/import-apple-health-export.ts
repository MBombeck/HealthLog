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
import { StringDecoder } from "node:string_decoder";
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
import { isHealthLogOriginEntry } from "@/lib/apple-health/own-origin";
import {
  isSameReadingAcrossSource,
  MEASURED_AT_TOLERANCE_MS,
} from "@/lib/measurements/cross-source-merge";
import { reconcileExternalMeasurement } from "@/lib/measurements/reconcile-external-measurement";
import {
  insertNewMeasurementRows,
  type InsertedMeasurementRow,
  type NewMeasurementRow,
} from "@/lib/export/measurement-bulk-insert";
import { resolveHkWorkoutSportType } from "@/lib/measurements/hk-workout-activity-type-map";
import {
  convertHkValue,
  hkDistanceToMetres,
} from "@/lib/measurements/hk-units";
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

/**
 * A quantity `<Record>` read up to its open tag. Its contribution is committed
 * at the close tag, once its `<MetadataEntry>` children have been read.
 */
interface PendingRecord {
  /**
   * Queue the record; `healthLogId` is the `HKExternalUUID` it carried and
   * `marked` whether it (or its correlation) carried the origin marker.
   */
  commit: (healthLogId: string | null, marked: boolean) => void;
  ownOrigin: boolean;
  healthLogId: string | null;
  /** The record's sample identity, computed only when it is left out. */
  sampleKey: () => string;
}

/** Apple's export name for `HKMetadataKeyExternalUUID`. */
const HK_EXTERNAL_UUID_METADATA_KEY = "HKExternalUUID";

/** The two halves of a blood pressure reading are one kind for an id match. */
function kindOf(type: MeasurementType): string {
  return type === "BLOOD_PRESSURE_SYS" || type === "BLOOD_PRESSURE_DIA"
    ? "BLOOD_PRESSURE"
    : type;
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
 * (issue #775) Apple serialises the `device` attribute from the live
 * HKDevice object, embedding its runtime address:
 * `<<HKDevice: 0x283a08640>, name:Apple Watch, …>`. That address is not
 * stable across the export enumeration — the same physical device shows
 * up under many addresses in one archive. Hashing it verbatim fragments
 * the per-day source buckets toward one bucket per RECORD: an 11-million
 * record export grows the cumulative fold map past the default 1 GB Node
 * heap and kills the worker mid-parse. Stripping the volatile address
 * before hashing restores the documented invariant (state bounded by
 * actual source cardinality) — the stable parts (device name, model,
 * hardware, software) still keep genuinely different devices apart.
 */
const HK_DEVICE_RUNTIME_ADDRESS = /0x[0-9a-f]+/gi;

/**
 * The device's `software:` field is its OS version, which changes when the
 * device updates. Like `sourceVersion`, it names the same device twice on an
 * update day, so it is dropped from the identity too.
 */
const HK_DEVICE_SOFTWARE_VERSION = /software:[^,>]*/gi;

function stableDeviceIdentity(device: string | undefined): string | undefined {
  return device
    ?.replace(HK_DEVICE_RUNTIME_ADDRESS, "0x0")
    .replace(HK_DEVICE_SOFTWARE_VERSION, "software:");
}

/**
 * Hash the source tuple used only to keep overlapping export.xml contributors
 * separate. Records without source metadata share one stable bucket so parser
 * state remains bounded by actual source cardinality rather than record count.
 * Raw source/device labels never leave the parser.
 *
 * The identity is the source and its device, never a version. On the day a
 * phone or watch updates, its records carry two `sourceVersion` values; keyed
 * on the version, the one device became two sources, and the per-day pick
 * (the largest source subtotal) kept only the larger half of that day.
 */
export function hashCumulativeSourceIdentity(
  sourceName: string | undefined,
  device: string | undefined,
): string {
  const sourceTuple = [
    sourceName?.trim() ?? "",
    stableDeviceIdentity(device)?.trim() ?? "",
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
  prisma: Pick<
    PrismaClient,
    | "measurement"
    | "workout"
    | "cycleDayLog"
    | "$transaction"
    | "$queryRawUnsafe"
  >;
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
    sampleKey: string;
    ownOrigin: boolean;
  } | null = null;
  // Marked cycle samples, held to the end of the parse: one counts as written
  // by HealthLog only when this account holds a day-log on its day.
  const markedCycle: Array<{
    hkType: string;
    dayKey: string;
    rawValue: string | undefined;
    protectionUsed?: boolean;
    sampleKey: string;
  }> = [];

  // Cumulative fold: type -> local day -> hashed source identity -> subtotal.
  const cumulativeBucket = new Map<
    MeasurementType,
    Map<string, CumulativeSourceSubtotals>
  >();
  // A record's contribution is committed at its close tag, once its child
  // `<MetadataEntry>` rows are read: one of them can mark the sample as written
  // by HealthLog itself, which has to keep it out of the import.
  let pendingRecord: PendingRecord | null = null;
  const writtenByHealthLog = { byMarker: 0, byExternalId: 0, matchedManual: 0 };
  // An export can carry the same sample twice (a correlation's records also
  // stand on their own), so a left-out sample is counted by its sample key.
  const countedOwn = new Set<string>();
  const countOwn = (
    reason: keyof typeof writtenByHealthLog,
    sampleKey: string,
  ): void => {
    if (countedOwn.has(sampleKey)) return;
    countedOwn.add(sampleKey);
    writtenByHealthLog[reason] += 1;
  };
  // The `HKExternalUUID` a queued spot row carried, checked at flush, and the
  // queued rows that carried the origin marker.
  const healthLogIdOf = new Map<PreparedMeasurement, string>();
  const markedRows = new Set<PreparedMeasurement>();
  // Marked cumulative samples that named a HealthLog row id, held to the end
  // of the parse and added to their day only when the id is not this
  // account's. Small: one per mirrored total.
  const markedCumulative: Array<{
    type: MeasurementType;
    healthLogId: string;
    sampleKey: string;
    add: () => void;
  }> = [];
  // A `<Correlation>` (a blood pressure reading) wraps its records, and the
  // marker may sit on the correlation itself, before or after them. Its records
  // are held until it closes, then all kept or all left out together.
  let currentCorrelation: {
    ownOrigin: boolean;
    healthLogId: string | null;
    held: PendingRecord[];
  } | null = null;
  // Spot-row batch awaiting flush.
  const spotBatch: PreparedMeasurement[] = [];
  // Workout-row batch awaiting flush.
  const workoutBatch: PreparedWorkout[] = [];

  let recordsRead = 0;
  let rowsUpserted = 0;
  const cumulativeEstimatedDays = new Set<string>();
  let cumulativeEstimatedRows = 0;
  // The instants this import wrote measurements at, oldest and newest. The
  // worker folds the rollup table over exactly this span afterwards.
  let spanFrom: Date | null = null;
  let spanTo: Date | null = null;
  const widenSpan = (at: Date) => {
    if (spanFrom === null || at < spanFrom) spanFrom = at;
    if (spanTo === null || at > spanTo) spanTo = at;
  };
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
  // A sample the app wrote carries the HealthLog row id as `HKExternalUUID`,
  // with the origin marker or (before the marker existed) without it. A hit on
  // one of this account's rows (deleted ones included: the sample is ours
  // either way) of the same kind is an exact match. The marker alone proves
  // nothing about THIS account: after a move to a new instance without a
  // backup, re-importing the export must bring the mirrored values back.
  // Blood pressure is one row per half, while the app stamps both samples of a
  // reading with one id (the systolic row's, the diastolic row's in older
  // builds), so either half matches either id.
  const ownRowKinds = async (
    ids: ReadonlySet<string>,
  ): Promise<Map<string, string>> => {
    const out = new Map<string, string>();
    const list = [...ids];
    for (let i = 0; i < list.length; i += 1000) {
      const known = await prisma.measurement.findMany({
        where: { userId, id: { in: list.slice(i, i + 1000) } },
        select: { id: true, type: true },
      });
      for (const row of known) out.set(row.id, kindOf(row.type));
    }
    return out;
  };
  const withoutHealthLogIds = async (
    rows: PreparedMeasurement[],
  ): Promise<PreparedMeasurement[]> => {
    const ids = new Set<string>();
    for (const row of rows) {
      const id = healthLogIdOf.get(row);
      if (id) ids.add(id);
    }
    if (ids.size === 0) return rows;
    const kindOfId = await ownRowKinds(ids);
    if (kindOfId.size === 0) return rows;
    return rows.filter((row) => {
      const id = healthLogIdOf.get(row);
      const rowKind = id ? kindOfId.get(id) : undefined;
      if (!rowKind || rowKind !== kindOf(row.type)) return true;
      countOwn(
        markedRows.has(row) ? "byMarker" : "byExternalId",
        row.externalId,
      );
      return false;
    });
  };

  // A manual entry mirrored with neither the marker nor an id comes back as a
  // second copy of the reading. Leave it out when a MANUAL row of the same
  // type and value sits within 2 s. Only MANUAL: Withings and import rows are
  // written into Apple Health by the server-to-Health mirror, which has always
  // stamped the row id, so a value-and-time match against them would only add
  // false positives. Same rule and tolerance as the sync path
  // (`cross-source-merge.ts`).
  //
  // The types that hold MANUAL rows are read once per import, so a batch of a
  // type the account never typed in asks nothing, and a batch that does asks
  // one time window per type rather than one clause per row.
  let manualTypes: Promise<Set<MeasurementType>> | null = null;
  const withoutManualMirrors = async (
    rows: PreparedMeasurement[],
  ): Promise<PreparedMeasurement[]> => {
    if (rows.length === 0) return rows;
    manualTypes ??= prisma.measurement
      .groupBy({
        by: ["type"],
        where: { userId, source: "MANUAL", deletedAt: null },
      })
      .then((groups) => new Set(groups.map((group) => group.type)));
    const typed = await manualTypes;
    const windows = new Map<MeasurementType, { from: number; to: number }>();
    for (const row of rows) {
      if (!typed.has(row.type)) continue;
      const at = row.measuredAt.getTime();
      const window = windows.get(row.type);
      if (!window) windows.set(row.type, { from: at, to: at });
      else {
        if (at < window.from) window.from = at;
        if (at > window.to) window.to = at;
      }
    }
    if (windows.size === 0) return rows;
    const candidates = await prisma.measurement.findMany({
      where: {
        userId,
        source: "MANUAL",
        deletedAt: null,
        OR: [...windows].map(([type, window]) => ({
          type,
          measuredAt: {
            gte: new Date(window.from - MEASURED_AT_TOLERANCE_MS),
            lte: new Date(window.to + MEASURED_AT_TOLERANCE_MS),
          },
        })),
      },
      select: { type: true, source: true, value: true, measuredAt: true },
      orderBy: { measuredAt: "asc" },
    });
    if (candidates.length === 0) return rows;
    const byType = new Map<MeasurementType, typeof candidates>();
    for (const candidate of candidates) {
      const list = byType.get(candidate.type);
      if (list) list.push(candidate);
      else byType.set(candidate.type, [candidate]);
    }
    return rows.filter((row) => {
      const list = byType.get(row.type);
      if (!list) return true;
      const at = row.measuredAt.getTime();
      // First candidate not earlier than the tolerance window.
      let lo = 0;
      let hi = list.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (list[mid].measuredAt.getTime() < at - MEASURED_AT_TOLERANCE_MS)
          lo = mid + 1;
        else hi = mid;
      }
      for (let i = lo; i < list.length; i++) {
        if (list[i].measuredAt.getTime() > at + MEASURED_AT_TOLERANCE_MS) break;
        const mirrored = isSameReadingAcrossSource(
          {
            type: row.type,
            source: "APPLE_HEALTH",
            value: row.value,
            measuredAt: row.measuredAt,
          },
          list[i],
        );
        if (mirrored) {
          countOwn("matchedManual", row.externalId);
          return false;
        }
      }
      return true;
    });
  };

  const flushSpotBatch = async (): Promise<void> => {
    if (spotBatch.length === 0) return;
    const incoming = spotBatch.splice(0, spotBatch.length);
    const chunk = await withoutManualMirrors(
      await withoutHealthLogIds(incoming),
    );
    for (const row of incoming) {
      healthLogIdOf.delete(row);
      markedRows.delete(row);
    }
    for (const row of chunk) widenSpan(row.measuredAt);
    const insertedArrivals: Array<{
      id: string;
      type: MeasurementType;
      measuredAt: Date;
    }> = [];
    // Written as one `INSERT … SELECT FROM unnest(…) ON CONFLICT DO NOTHING
    // RETURNING` rather than `createManyAndReturn`: the Prisma call left about
    // 5 MB of heap behind per flush until some two dozen had piled up, which
    // is the import's whole budget in a small container. Same semantics —
    // duplicates on either unique identity are skipped, never thrown — and the
    // same answer: the rows that landed. See `insertNewMeasurementRows`.
    const createData: NewMeasurementRow[] = chunk.map((row) => ({
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
    }));
    const insertStartedAt = Date.now();
    let createdRows: InsertedMeasurementRow[] = [];
    const failedInsertIndexes = new Set<number>();
    try {
      createdRows = await insertNewMeasurementRows(prisma, createData);
    } catch {
      // Retain the old per-sample failure isolation if an unexpected database
      // error rejects the bulk statement. Conflicts remain non-errors because
      // every retry still skips duplicates.
      for (let index = 0; index < createData.length; index += 1) {
        try {
          const created = await insertNewMeasurementRows(prisma, [
            createData[index],
          ]);
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
        // Only the subtotal is carried forward. The source hash stays an
        // in-memory map key — it is what makes the max-subtotal selection
        // above deterministic on a tie, and it is not persisted.
        const [, selectedSubtotal] = selected;
        if (validateMeasurementRange(type, selectedSubtotal) !== null) {
          unknown[`${type}::aggregate_out_of_range`] =
            (unknown[`${type}::aggregate_out_of_range`] ?? 0) + 1;
          continue;
        }
        const externalId = dailyStatsExternalId(mapping.hkIdentifier, dayKey);
        const measuredAt = canonicalDailyTimestamp(dayKey, userTimezone);
        widenSpan(measuredAt);
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
            },
            { exactExternalMatch: "update" },
          ),
        );

        // The reconciler carries the same plausibility gate the block above
        // already applied, so this arm means the two disagreed. Tally it under
        // the same counter the earlier guard uses and count no row.
        if (verdict.status === "rejected_range") {
          unknown[`${type}::aggregate_out_of_range`] =
            (unknown[`${type}::aggregate_out_of_range`] ?? 0) + 1;
          stat.durationMs += Date.now() - rowStart;
          continue;
        }

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

  const consumeCycle = (rec: {
    hkType: string;
    dayKey: string;
    rawValue: string | undefined;
    protectionUsed?: boolean;
  }): void => {
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
  };

  // Marked cumulative samples: left out when their id is a row of this
  // account of the same kind, added to their day otherwise.
  const settleMarkedCumulative = async (): Promise<void> => {
    if (markedCumulative.length === 0) return;
    const kindOfId = await ownRowKinds(
      new Set(markedCumulative.map((m) => m.healthLogId)),
    );
    for (const m of markedCumulative.splice(0, markedCumulative.length)) {
      if (kindOfId.get(m.healthLogId) === kindOf(m.type)) {
        countOwn("byMarker", m.sampleKey);
      } else {
        m.add();
      }
    }
  };

  // Marked cycle samples: left out when this account holds a day-log on
  // their day (deleted ones included), folded in otherwise.
  const settleMarkedCycle = async (): Promise<void> => {
    if (markedCycle.length === 0) return;
    const days = [...new Set(markedCycle.map((rec) => rec.dayKey))];
    const held = new Set<string>();
    for (let i = 0; i < days.length; i += 1000) {
      const logs = await prisma.cycleDayLog.findMany({
        where: { userId, date: { in: days.slice(i, i + 1000) } },
        select: { date: true },
      });
      for (const log of logs) held.add(log.date);
    }
    for (const rec of markedCycle.splice(0, markedCycle.length)) {
      if (held.has(rec.dayKey)) countOwn("byMarker", rec.sampleKey);
      else consumeCycle(rec);
    }
  };

  // ── SAX parser configuration ────────────────────────────────
  const parser = sax.parser(true, { trim: true });
  let pendingError: Error | null = null;
  let currentWorkout: PreparedWorkout | null = null;

  // Apple stamps the archive with its own export instant as the first
  // child of `<HealthData>`. The element used to be on the ignore list,
  // so `ImportJob.exportedAt` — a column the status endpoint and the
  // published contract both promise — could only ever answer null. The
  // value is captured in the synchronous tag handler and handed to
  // `onExportDate` from the async drain, so the worker can persist it
  // while the run is still going rather than only on the terminal write.
  let pendingExportDate: Date | null = null;
  const flushExportDate = async (): Promise<void> => {
    const stamped = pendingExportDate;
    if (!stamped) return;
    pendingExportDate = null;
    if (onExportDate) await onExportDate(stamped);
  };

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
          : {
              hkType,
              dayKey,
              rawValue: attrs.value,
              sampleKey: hashSampleKey(
                hkType,
                attrs.value ?? "",
                attrs.startDate,
                attrs.endDate,
              ),
              ownOrigin: false,
            };
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

      const mapped = mapAppleHealthEntry(
        {
          hkIdentifier: hkType,
          value: parsedValue.value,
          unit: attrs.unit ?? mapping.hkUnit,
          startDate: attrs.startDate,
          endDate: attrs.endDate,
          sleepStage: parsedValue.sleepStage,
        },
        // issue #944 — the archive is the one caller whose unit attribute
        // is authoritative: Apple writes the account's own display unit on
        // every quantity `<Record>`, so `km` here means kilometres and the
        // reading has to be converted before it is stored.
        { convertRecordUnit: true },
      );
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

      pendingRecord = {
        ownOrigin: false,
        healthLogId: null,
        sampleKey: () =>
          hashSampleKey(
            hkType,
            attrs.value ?? "",
            attrs.startDate,
            attrs.endDate,
          ),
        commit: (healthLogId, marked) => {
          if (CUMULATIVE_HK_TYPES.has(mapped.type)) {
            const dayKey = dayKeyForUserTz(mapped.takenAt, userTimezone);
            const sourceHash = hashCumulativeSourceIdentity(
              attrs.sourceName,
              attrs.device,
            );
            const add = () => {
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
            };
            if (marked && healthLogId) {
              markedCumulative.push({
                type: mapped.type,
                healthLogId,
                sampleKey: hashSampleKey(
                  hkType,
                  attrs.value ?? "",
                  attrs.startDate,
                  attrs.endDate,
                ),
                add,
              });
            } else {
              add();
            }
          } else {
            // Spot row: derive a stable externalId, queue for flush.
            const externalId = hashSampleKey(
              hkType,
              attrs.value ?? "",
              attrs.startDate,
              attrs.endDate,
            );
            const row: PreparedMeasurement = {
              userId,
              type: mapped.type,
              value: mapped.value,
              unit: mapped.unit,
              measuredAt: mapped.takenAt,
              externalId,
              externalSourceVersion: attrs.sourceVersion ?? null,
              sleepStage: mapped.sleepStage ?? null,
              deviceType: null,
            };
            spotBatch.push(row);
            if (healthLogId) healthLogIdOf.set(row, healthLogId);
            if (marked) markedRows.add(row);
          }
        },
      };
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
      const energyUnit = attrs.totalEnergyBurnedUnit ?? "";
      // Apple ships the ACCOUNT's own length unit on HKWorkout.totalDistance
      // (km for a metric account, mi for an imperial one); metres is the
      // canonical DB unit. issue #944 — the same conversion the `<Record>`
      // path now runs, so the two can never drift apart again.
      const distanceM = Number.isFinite(totalDistance)
        ? hkDistanceToMetres(totalDistance, distanceUnit)
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
        totalEnergyKcal: Number.isFinite(totalEnergy)
          ? // issue #944 — the energy attribute carries the account's own
            // unit too: a Health app set to kilojoules writes `kJ` here, and
            // the column is kilocalories. Same shared conversion; an unknown
            // unit leaves the number alone.
            (convertHkValue(totalEnergy, energyUnit, "kcal") ?? totalEnergy)
          : null,
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

    if (name === "Correlation") {
      currentCorrelation = { ownOrigin: false, healthLogId: null, held: [] };
      return;
    }

    if (name === "MetadataEntry") {
      if (isHealthLogOriginEntry(attrs.key, attrs.value)) {
        // On a record, or on the correlation that wraps it.
        if (pendingRecord) pendingRecord.ownOrigin = true;
        else if (currentCycleRecord) currentCycleRecord.ownOrigin = true;
        else if (currentCorrelation) currentCorrelation.ownOrigin = true;
      }
      if (attrs.key === HK_EXTERNAL_UUID_METADATA_KEY) {
        // On a record, or on the correlation that wraps it.
        if (pendingRecord) pendingRecord.healthLogId = attrs.value || null;
        else if (currentCorrelation && !currentCycleRecord) {
          currentCorrelation.healthLogId = attrs.value || null;
        }
      }
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

    if (name === "ExportDate") {
      // `value` carries Apple's own format ("2026-05-15 14:32:01 +0200"),
      // the same shape every `Record` start/end date uses. An archive
      // without the element, or with a value the runtime cannot read,
      // leaves the column null rather than guessing at an instant.
      const stamped = new Date(attrs.value ?? "");
      if (!Number.isNaN(stamped.getTime())) pendingExportDate = stamped;
      return;
    }

    if (
      name === "Me" ||
      name === "ActivitySummary" ||
      name === "WorkoutEvent" ||
      name === "WorkoutRoute" ||
      name === "FileReference" ||
      name === "HealthData"
    ) {
      // Known elements we intentionally ignore at the open-tag stage. A
      // `<Correlation>` is handled above: its child `<Record>` elements fire
      // their own `onopentag`, and are held until it closes.
      return;
    }

    // Any other element name lands as a structural unknown — log
    // once per name so operators can spot future schema additions.
    unknown[`element::${name}`] = (unknown[`element::${name}`] ?? 0) + 1;
  };

  parser.onclosetag = async (tagName) => {
    if (tagName === "Record" && pendingRecord) {
      const rec = pendingRecord;
      pendingRecord = null;
      if (currentCorrelation) currentCorrelation.held.push(rec);
      else rec.commit(rec.healthLogId, rec.ownOrigin);
    }
    if (tagName === "Correlation" && currentCorrelation) {
      const correlation = currentCorrelation;
      currentCorrelation = null;
      for (const rec of correlation.held) {
        rec.commit(
          rec.healthLogId ?? correlation.healthLogId,
          correlation.ownOrigin || rec.ownOrigin,
        );
      }
    }
    if (tagName === "Workout" && currentWorkout) {
      workoutBatch.push(currentWorkout);
      currentWorkout = null;
    }
    if (tagName === "Record" && currentCycleRecord) {
      const rec = currentCycleRecord;
      currentCycleRecord = null;
      if (rec.ownOrigin) {
        // A day HealthLog mirrored into Apple Health from a day-log; decided
        // at the end of the parse against this account's day-logs.
        markedCycle.push(rec);
        return;
      }
      consumeCycle(rec);
    }
  };

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
          pendingExportDate !== null ||
          spotBatch.length >= spotBatchSize ||
          workoutBatch.length >= workoutBatchSize;
        const drain = async (): Promise<void> => {
          await flushExportDate();
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
  await flushSpotBatch();
  await flushWorkoutBatch();
  await settleMarkedCumulative();
  await flushCumulativeBuckets();
  await settleMarkedCycle();

  // v1.15.0 — fold the accumulated reproductive samples into CYCLE
  // day-logs. Gated on cycle-tracking being enabled for the account so a
  // non-cycle Apple Health export never silently provisions cycle rows.
  let cycle: CycleImportStats = { ...EMPTY_CYCLE_IMPORT_STATS };
  // Only touch the cycle tables when the export actually carried
  // reproductive samples AND the account has cycle tracking enabled. The
  // empty-accumulator short-circuit also keeps the no-cycle import path
  // (and its unit tests) free of any cycle DB round-trip. A flush failure
  // must never abort the whole import — per-day failures are isolated
  // inside `flush()` (its stats stay honest); a whole-flush failure (the
  // hoisted lookups) is folded into stats that still name the consumed
  // samples and the reason instead of reading as "nothing happened".
  if (cycleAccumulator.hasSamples()) {
    if (await cycleAccumulator.isEnabled()) {
      try {
        cycle = await cycleAccumulator.flush();
        rowsUpserted += cycle.daysUpserted;
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err);
        cycle = {
          ...EMPTY_CYCLE_IMPORT_STATS,
          samplesConsumed: cycleAccumulator.sampleCount(),
          daysFailed: cycleAccumulator.dayCount(),
          firstFailureReason: reason,
        };
        console.warn(`cycle import flush failed: ${reason}`);
      }
    } else {
      // Cycle tracking is off for the account: the reproductive samples
      // are DROPPED, and the drop is named so the recordsRead-vs-imported
      // gap stays explained in the result the user sees.
      cycle = {
        ...EMPTY_CYCLE_IMPORT_STATS,
        samplesSkippedModuleDisabled: cycleAccumulator.sampleCount(),
      };
    }
  }

  await emitProgress("upserting");

  return {
    perType,
    workouts,
    clinical,
    writtenByHealthLog,
    cycle,
    deferred,
    unknown,
    cumulativeEstimates: {
      days: cumulativeEstimatedDays.size,
      rows: cumulativeEstimatedRows,
    },
    measuredSpan:
      spanFrom !== null && spanTo !== null
        ? {
            from: (spanFrom as Date).toISOString(),
            to: (spanTo as Date).toISOString(),
          }
        : null,
    ecg: {
      discovered: 0,
      imported: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
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
