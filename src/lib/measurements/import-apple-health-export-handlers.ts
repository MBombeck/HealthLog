/**
 * The read side of the Apple Health `export.xml` import: what one SAX open or
 * close tag does. One handler per element kind; each reads the element's
 * attributes, updates the parse state, and hands finished rows to the writer
 * (`import-apple-health-export-writer.ts`, `-cycle.ts`). The record-level helpers the
 * handlers share live here too.
 */
import type { WorkoutRouteReference } from "@/lib/apple-health/route-import";
import { createHash } from "node:crypto";

import type { Prisma } from "@/generated/prisma/client";
import {
  APPLE_HEALTH_TYPE_MAP,
  CUMULATIVE_HK_TYPES,
  HK_QUANTITY_TYPE_DEFERRED,
  mapAppleHealthEntry,
} from "@/lib/measurements/apple-health-mapping";
import { isHealthLogOriginEntry } from "@/lib/apple-health/own-origin";
import {
  routeClinicalRecord,
  type ClinicalLabReference,
} from "@/lib/apple-health/clinical-record-ref";
import { resolveHkWorkoutSportType } from "@/lib/measurements/hk-workout-activity-type-map";
import {
  exportWorkoutFigures,
  exportWorkoutTracker,
  workoutExternalId,
  type PreparedWorkout,
} from "@/lib/measurements/apple-health-export-workouts";
import { validateMeasurementRange } from "@/lib/validations/measurement";
import { CycleImportAccumulator } from "@/lib/cycle/import-accumulator";
import { HK_SEXUAL_ACTIVITY_PROTECTION_META } from "@/lib/cycle/healthkit-mapping";
import { userDayKey } from "@/lib/tz/format";
import {
  tallyReason,
  type ExportImportWriter,
  type ImportTally,
  type PreparedMeasurement,
} from "@/lib/measurements/import-apple-health-export-writer";
import type {
  ExportCycleWriter,
  MarkedCycleSample,
} from "@/lib/measurements/import-apple-health-export-cycle";

/**
 * Reverse-lookup for the symbolic `HKCategoryValueSleepAnalysis*`
 * names Apple writes to `Record[type="HKCategoryTypeIdentifierSleepAnalysis"]`
 * `value` attributes. The web batch endpoint receives the integer
 * codepoint pre-resolved by iOS; the XML export carries the symbolic
 * name. Mirrors `APPLE_HEALTH_SLEEP_STAGE_MAP` inverted by stage
 * label so the existing `mapAppleHealthEntry()` path picks up the
 * integer codepoint without further translation.
 */
export const SLEEP_STAGE_NAME_TO_CODEPOINT: Record<string, number> = {
  HKCategoryValueSleepAnalysisInBed: 0,
  HKCategoryValueSleepAnalysisAsleep: 1,
  HKCategoryValueSleepAnalysisAsleepUnspecified: 1,
  HKCategoryValueSleepAnalysisAwake: 2,
  HKCategoryValueSleepAnalysisAsleepCore: 3,
  HKCategoryValueSleepAnalysisAsleepDeep: 4,
  HKCategoryValueSleepAnalysisAsleepREM: 5,
};

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
/** Apple's symbolic `HKCategoryValueAppleStandHour` values in `export.xml`. */
const STAND_HOUR_STOOD = "HKCategoryValueAppleStandHourStood";
const STAND_HOUR_IDLE = "HKCategoryValueAppleStandHourIdle";

/** An idle stand hour: skipped on purpose, never a row and never "unparseable". */
export function isIdleStandHour(
  hkIdentifier: string,
  rawValue: string | undefined,
): boolean {
  return (
    hkIdentifier === "HKCategoryTypeIdentifierAppleStandHour" &&
    rawValue === STAND_HOUR_IDLE
  );
}

function minutesBetween(startDate: string, endDate: string): number | null {
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }
  return Math.max(0, (end.getTime() - start.getTime()) / 60_000);
}

export function parseRecordValue(
  hkIdentifier: string,
  rawValue: string | undefined,
  startDate: string,
  endDate: string,
): { value: number; sleepStage?: number } | null {
  // Mindful sessions carry no quantity (Apple writes no `value`, or the
  // not-applicable sentinel): the reading is the session length, minutes
  // from the record's own dates, the same contract as sleep.
  if (hkIdentifier === "HKCategoryTypeIdentifierMindfulSession") {
    const minutes = minutesBetween(startDate, endDate);
    return minutes === null ? null : { value: minutes };
  }
  if (rawValue === undefined) return null;
  // A stood hour is one; an idle hour is dropped by the caller before it
  // gets here (`isIdleStandHour`), so it never becomes a row.
  if (hkIdentifier === "HKCategoryTypeIdentifierAppleStandHour") {
    return rawValue === STAND_HOUR_STOOD ? { value: 1 } : null;
  }
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

/** A reproductive `<Record>` held open so a `<MetadataEntry>` child can attach. */
interface OpenCycleRecord extends MarkedCycleSample {
  ownOrigin: boolean;
}

/**
 * Parse state carried between tags: the element each open tag left open,
 * read by its children and settled at its close tag.
 */
export interface ExportParseState {
  // A record's contribution is committed at its close tag, once its child
  // `<MetadataEntry>` rows are read: one of them can mark the sample as written
  // by HealthLog itself, which has to keep it out of the import.
  pendingRecord: PendingRecord | null;
  // Context for a reproductive `<Record>` whose protection metadata
  // arrives as a following `<MetadataEntry>` child (SexualActivity). Held
  // between the Record open-tag and its close-tag so the child can attach.
  currentCycleRecord: OpenCycleRecord | null;
  // A `<Correlation>` (a blood pressure reading) wraps its records, and the
  // marker may sit on the correlation itself, before or after them. Its records
  // are held until it closes, then all kept or all left out together.
  currentCorrelation: {
    ownOrigin: boolean;
    healthLogId: string | null;
    held: PendingRecord[];
  } | null;
  currentWorkout: PreparedWorkout | null;
  // Apple stamps the archive with its own export instant as the first
  // child of `<HealthData>`. The value is captured in the synchronous tag
  // handler and handed to `onExportDate` from the async drain.
  pendingExportDate: Date | null;
}

/** Everything a tag handler reads or writes. */
export interface ExportTagContext {
  userId: string;
  userTimezone: string;
  tally: ImportTally;
  writer: ExportImportWriter;
  cycle: ExportCycleWriter;
  state: ExportParseState;
  exportWorkouts: ReturnType<typeof exportWorkoutTracker>;
  onWorkoutRoute?: (ref: WorkoutRouteReference) => void;
  onClinicalLabRecord?: (ref: ClinicalLabReference) => void;
}

type TagAttributes = Record<string, string>;

export function emptyExportParseState(): ExportParseState {
  return {
    pendingRecord: null,
    currentCycleRecord: null,
    currentCorrelation: null,
    currentWorkout: null,
    pendingExportDate: null,
  };
}

// Reproductive HK identifiers route into CYCLE day-logs, not Measurement.
// Defer the fold until the Record's close-tag so a child `<MetadataEntry>`
// (SexualActivity protection flag) can attach. The accumulator's per-day
// bucketing handles same-day merges + idempotent re-import.
function openCycleRecord(
  ctx: ExportTagContext,
  hkType: string,
  attrs: TagAttributes,
): void {
  const dayKey = userDayKey(
    new Date(attrs.endDate ?? attrs.startDate ?? ""),
    ctx.userTimezone,
  );
  ctx.state.currentCycleRecord = Number.isNaN(
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
}

function openRecord(ctx: ExportTagContext, attrs: TagAttributes): void {
  const { tally } = ctx;
  const { deferred, unknown } = tally;
  const hkType = attrs.type;
  if (!hkType) return;
  tally.recordsRead += 1;

  if (CycleImportAccumulator.handlesStatus(hkType)) {
    // Pregnancy / lactation status: held for the profile decision at
    // flush, never a day log or a measurement.
    const start = Date.parse(attrs.startDate ?? "");
    const end = Date.parse(attrs.endDate ?? "");
    if (Number.isNaN(start)) tallyReason(unknown, `${hkType}::unparseable`);
    else {
      ctx.cycle.consumeStatus(
        hkType,
        userDayKey(new Date(start), ctx.userTimezone),
        Number.isNaN(end) ? null : userDayKey(new Date(end), ctx.userTimezone),
      );
    }
    return;
  }

  if (CycleImportAccumulator.handles(hkType)) {
    openCycleRecord(ctx, hkType, attrs);
    return;
  }

  if (HK_QUANTITY_TYPE_DEFERRED.has(hkType)) {
    tallyReason(deferred, hkType);
    return;
  }
  const mapping = APPLE_HEALTH_TYPE_MAP[hkType];
  if (!mapping) {
    tallyReason(unknown, hkType);
    return;
  }

  if (isIdleStandHour(hkType, attrs.value)) {
    // An hour without standing is the absence of a stood hour. Counted
    // so the import summary still shows the archive carried it.
    tallyReason(deferred, `${hkType}::idle`);
    return;
  }

  const parsedValue = parseRecordValue(
    hkType,
    attrs.value,
    attrs.startDate,
    attrs.endDate,
  );
  if (!parsedValue) {
    tallyReason(unknown, `${hkType}::unparseable`);
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
    tallyReason(unknown, `${hkType}::map_failed`);
    return;
  }

  // Plausibility-range guard. A single rogue sample shouldn't
  // poison the import — record under `unknown` with the
  // explicit reason tag so operators can spot ingest pathologies.
  const rangeError = validateMeasurementRange(mapped.type, mapped.value);
  if (rangeError !== null) {
    tallyReason(unknown, `${hkType}::out_of_range`);
    return;
  }

  const stat = tally.bumpStat(mapped.type);
  stat.read += 1;

  ctx.state.pendingRecord = pendingQuantityRecord(ctx, hkType, attrs, mapped);
}

/** The pending record for a mapped quantity `<Record>`, committed at close. */
function pendingQuantityRecord(
  ctx: ExportTagContext,
  hkType: string,
  attrs: TagAttributes,
  mapped: NonNullable<ReturnType<typeof mapAppleHealthEntry>>,
): PendingRecord {
  const { userId, userTimezone, writer } = ctx;
  return {
    ownOrigin: false,
    healthLogId: null,
    sampleKey: () =>
      hashSampleKey(hkType, attrs.value ?? "", attrs.startDate, attrs.endDate),
    commit: (healthLogId, marked) => {
      if (CUMULATIVE_HK_TYPES.has(mapped.type)) {
        const dayKey = userDayKey(mapped.takenAt, userTimezone);
        const sourceHash = hashCumulativeSourceIdentity(
          attrs.sourceName,
          attrs.device,
        );
        const add = () =>
          writer.addCumulative(mapped.type, dayKey, sourceHash, mapped.value);
        if (marked && healthLogId) {
          writer.holdMarkedCumulative({
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
        writer.queueSpot(row, healthLogId, marked);
      }
    },
  };
}

function openWorkout(ctx: ExportTagContext, attrs: TagAttributes): void {
  const { tally } = ctx;
  const workouts = tally.workouts;
  tally.recordsRead += 1;
  workouts.read += 1;
  const activityType = attrs.workoutActivityType ?? "";
  const { sportType, known } = resolveHkWorkoutSportType(activityType);
  if (!known) workouts.unknownActivityType += 1;

  const startDate = new Date(attrs.startDate);
  const endDate = new Date(attrs.endDate);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    tallyReason(tally.unknown, `Workout::bad_dates`);
    return;
  }
  const durationSec = Math.max(
    0,
    Math.round((endDate.getTime() - startDate.getTime()) / 1000),
  );

  const externalId = workoutExternalId(activityType, startDate, endDate);
  const legacyExternalId = hashSampleKey(
    activityType || "Workout",
    attrs.duration ?? "",
    attrs.startDate,
    attrs.endDate,
  );

  ctx.state.currentWorkout = {
    userId: ctx.userId,
    sportType,
    startedAt: startDate,
    endedAt: endDate,
    durationSec,
    ...exportWorkoutFigures(attrs),
    externalId,
    legacyExternalId,
    externalSourceVersion: attrs.sourceVersion ?? null,
    metadata: {
      activityType,
      sourceName: attrs.sourceName ?? null,
      durationUnit: attrs.durationUnit ?? null,
      totalDistanceUnit: attrs.totalDistanceUnit || null,
      totalEnergyBurnedUnit: attrs.totalEnergyBurnedUnit ?? null,
    } as Prisma.JsonValue,
  };
}

function openClinicalRecord(ctx: ExportTagContext, attrs: TagAttributes): void {
  ctx.tally.recordsRead += 1;
  if (!routeClinicalRecord(attrs, ctx.onClinicalLabRecord)) {
    ctx.tally.clinical.skipped += 1;
  }
}

function openMetadataEntry(
  state: ExportParseState,
  attrs: TagAttributes,
): void {
  const { pendingRecord, currentCycleRecord, currentCorrelation } = state;
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
  if (currentCycleRecord && attrs.key === HK_SEXUAL_ACTIVITY_PROTECTION_META) {
    const v = (attrs.value ?? "").toLowerCase();
    currentCycleRecord.protectionUsed =
      v === "1" || v === "true" || v === "yes";
  }
}

function openExportDate(state: ExportParseState, attrs: TagAttributes): void {
  // `value` carries Apple's own format ("2026-05-15 14:32:01 +0200"),
  // the same shape every `Record` start/end date uses. An archive
  // without the element, or with a value the runtime cannot read,
  // leaves the column null rather than guessing at an instant.
  const stamped = new Date(attrs.value ?? "");
  if (!Number.isNaN(stamped.getTime())) state.pendingExportDate = stamped;
}

/** Known elements we intentionally ignore at the open-tag stage. */
const IGNORED_ELEMENTS = new Set([
  "Me",
  "ActivitySummary",
  "WorkoutEvent",
  "WorkoutRoute",
  "FileReference",
  "HealthData",
]);

/** The SAX open-tag handler: route the element to its kind's handler. */
export function handleOpenTag(
  ctx: ExportTagContext,
  node: { name: string; attributes: unknown },
): void {
  const name = node.name;
  const attrs = node.attributes as TagAttributes;
  const { state } = ctx;

  if (name === "Record") return openRecord(ctx, attrs);
  if (name === "Workout") return openWorkout(ctx, attrs);

  // A workout's `<WorkoutStatistics>` and `<WorkoutActivity>` children.
  if (
    state.currentWorkout &&
    ctx.exportWorkouts.open(name, state.currentWorkout, attrs)
  ) {
    return;
  }

  if (name === "ClinicalRecord") return openClinicalRecord(ctx, attrs);
  if (name === "Correlation") {
    state.currentCorrelation = {
      ownOrigin: false,
      healthLogId: null,
      held: [],
    };
    return;
  }
  if (name === "MetadataEntry") return openMetadataEntry(state, attrs);
  if (name === "ExportDate") return openExportDate(state, attrs);

  if (
    name === "FileReference" &&
    ctx.onWorkoutRoute &&
    state.currentWorkout &&
    typeof attrs.path === "string" &&
    attrs.path.toLowerCase().endsWith(".gpx")
  ) {
    state.currentWorkout.routePath = attrs.path;
    return;
  }

  // A `<Correlation>` is handled above: its child `<Record>` elements fire
  // their own `onopentag`, and are held until it closes.
  if (IGNORED_ELEMENTS.has(name)) return;

  // Any other element name lands as a structural unknown — log
  // once per name so operators can spot future schema additions.
  tallyReason(ctx.tally.unknown, `element::${name}`);
}

/** The SAX close-tag handler: settle the element the tag closes. */
export async function handleCloseTag(
  ctx: ExportTagContext,
  tagName: string,
): Promise<void> {
  const { state, writer, cycle } = ctx;
  if (tagName === "Record" && state.pendingRecord) {
    const rec = state.pendingRecord;
    state.pendingRecord = null;
    if (state.currentCorrelation) state.currentCorrelation.held.push(rec);
    else rec.commit(rec.healthLogId, rec.ownOrigin);
  }
  if (tagName === "Correlation" && state.currentCorrelation) {
    const correlation = state.currentCorrelation;
    state.currentCorrelation = null;
    for (const rec of correlation.held) {
      rec.commit(
        rec.healthLogId ?? correlation.healthLogId,
        correlation.ownOrigin || rec.ownOrigin,
      );
    }
  }
  if (tagName === "WorkoutActivity") ctx.exportWorkouts.leaveActivity();
  if (tagName === "Workout" && state.currentWorkout) {
    if (ctx.exportWorkouts.admit(state.currentWorkout, ctx.onWorkoutRoute)) {
      writer.workoutBatch.push(state.currentWorkout);
    } else ctx.tally.workouts.duplicate += 1;
    state.currentWorkout = null;
  }
  if (tagName === "Record" && state.currentCycleRecord) {
    const rec = state.currentCycleRecord;
    state.currentCycleRecord = null;
    if (rec.ownOrigin) {
      // A day HealthLog mirrored into Apple Health from a day-log; decided
      // at the end of the parse against this account's day-logs.
      cycle.holdMarked(rec);
      return;
    }
    cycle.consume(rec);
  }
}
