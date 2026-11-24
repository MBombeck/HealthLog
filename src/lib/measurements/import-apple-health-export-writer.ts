/**
 * The write side of the Apple Health `export.xml` import.
 *
 * `ImportTally` holds the counters the import reports; `ExportImportWriter`
 * holds the rows the parser queued (spot rows, workouts, the cumulative
 * fold) and flushes them. The parser in
 * `import-apple-health-export.ts` owns the order the flushes run in.
 */
import { Prisma } from "@/generated/prisma/client";
import type { MeasurementType, PrismaClient } from "@/generated/prisma/client";
import {
  APPLE_HEALTH_TYPE_MAP,
  dailyStatsExternalId,
} from "@/lib/measurements/apple-health-mapping";
import { canonicalDailyTimestamp } from "@/lib/measurements/drain-per-sample-cumulative";
import {
  isSameReadingAcrossSource,
  MEASURED_AT_TOLERANCE_MS,
} from "@/lib/measurements/cross-source-merge";
import {
  reconcileExternalMeasurementsInChunks,
  type ExternalMeasurementWrite,
} from "@/lib/measurements/reconcile-external-measurement";
import {
  FOLDED_WINDOW_REASON,
  findFoldedWindowDuplicates,
  isFoldedWindowCandidate,
} from "@/lib/measurements/folded-window";
import {
  insertNewMeasurementRows,
  type InsertedMeasurementRow,
  type NewMeasurementRow,
} from "@/lib/export/measurement-bulk-insert";
import {
  adoptLegacyWorkoutKeys,
  storedWorkoutTotals,
  workoutTotalsUpdate,
  type PreparedWorkout,
} from "@/lib/measurements/apple-health-export-workouts";
import {
  adoptNaturalKeyTwin,
  storedUnchangedKeys,
} from "@/lib/measurements/import-unchanged-rows";
import { emitInsertedMeasurementArrivals } from "@/lib/arrivals/measurement-emit";
import { maybeEnqueueMorningRefresh } from "@/lib/daily/morning-refresh-trigger";
import { emitDataArrival } from "@/lib/arrivals/emit-shared";
import { validateMeasurementRange } from "@/lib/validations/measurement";
import { ownRecord, type OwnRecord } from "@/lib/own-key";

/** The Prisma surface the import writes through. */
export type ExportImportPrisma = Pick<
  PrismaClient,
  "measurement" | "workout" | "cycleDayLog" | "$transaction" | "$queryRawUnsafe"
>;

/** Flush row written to the `Measurement` table. */
export interface PreparedMeasurement {
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

/** Per-type running stats accumulator. */
export interface MutableTypeStat {
  read: number;
  inserted: number;
  updated: number;
  durationMs: number;
}

type CumulativeSourceSubtotals = Map<string, number>;

/** The two halves of a blood pressure reading are one kind for an id match. */
function kindOf(type: MeasurementType): string {
  return type === "BLOOD_PRESSURE_SYS" || type === "BLOOD_PRESSURE_DIA"
    ? "BLOOD_PRESSURE"
    : type;
}

/** Count one more `key` in a reason tally. */
export function tallyReason(map: OwnRecord<number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

/** The counters one import run reports. */
export class ImportTally {
  readonly perType = ownRecord<MutableTypeStat>();
  readonly workouts = {
    read: 0,
    inserted: 0,
    updated: 0,
    duplicate: 0,
    unknownActivityType: 0,
    routesAttached: 0,
    durationMs: 0,
  };
  readonly clinical = { skipped: 0 };
  readonly deferred = ownRecord<number>();
  readonly unknown = ownRecord<number>();
  readonly writtenByHealthLog = {
    byMarker: 0,
    byExternalId: 0,
    matchedManual: 0,
  };
  // An export can carry the same sample twice (a correlation's records also
  // stand on their own), so a left-out sample is counted by its sample key.
  private readonly countedOwn = new Set<string>();
  recordsRead = 0;
  rowsUpserted = 0;
  readonly cumulativeEstimatedDays = new Set<string>();
  cumulativeEstimatedRows = 0;
  // The instants this import wrote measurements at, oldest and newest. The
  // worker folds the rollup table over exactly this span afterwards.
  spanFrom: Date | null = null;
  spanTo: Date | null = null;

  bumpStat(type: MeasurementType): MutableTypeStat {
    const key = type as string;
    let stat = this.perType[key];
    if (!stat) {
      stat = { read: 0, inserted: 0, updated: 0, durationMs: 0 };
      this.perType[key] = stat;
    }
    return stat;
  }

  countOwn(
    reason: keyof ImportTally["writtenByHealthLog"],
    sampleKey: string,
  ): void {
    if (this.countedOwn.has(sampleKey)) return;
    this.countedOwn.add(sampleKey);
    this.writtenByHealthLog[reason] += 1;
  }

  widenSpan(at: Date): void {
    if (this.spanFrom === null || at < this.spanFrom) this.spanFrom = at;
    if (this.spanTo === null || at > this.spanTo) this.spanTo = at;
  }
}

/** The rows one import run queued, and the flushes that write them. */
export class ExportImportWriter {
  // Spot-row batch awaiting flush.
  readonly spotBatch: PreparedMeasurement[] = [];
  // Workout-row batch awaiting flush.
  readonly workoutBatch: PreparedWorkout[] = [];
  // Cumulative fold: type -> local day -> hashed source identity -> subtotal.
  private readonly cumulativeBucket = new Map<
    MeasurementType,
    Map<string, CumulativeSourceSubtotals>
  >();
  // The `HKExternalUUID` a queued spot row carried, checked at flush, and the
  // queued rows that carried the origin marker.
  private readonly healthLogIdOf = new Map<PreparedMeasurement, string>();
  private readonly markedRows = new Set<PreparedMeasurement>();
  // Marked cumulative samples that named a HealthLog row id, held to the end
  // of the parse and added to their day only when the id is not this
  // account's. Small: one per mirrored total.
  private readonly markedCumulative: Array<{
    type: MeasurementType;
    healthLogId: string;
    sampleKey: string;
    add: () => void;
  }> = [];
  private manualTypes: Promise<Set<MeasurementType>> | null = null;

  constructor(
    private readonly prisma: ExportImportPrisma,
    private readonly userId: string,
    private readonly userTimezone: string,
    private readonly tally: ImportTally,
  ) {}

  /** Queue a spot row, with the id and marker its sample carried. */
  queueSpot(
    row: PreparedMeasurement,
    healthLogId: string | null,
    marked: boolean,
  ): void {
    this.spotBatch.push(row);
    if (healthLogId) this.healthLogIdOf.set(row, healthLogId);
    if (marked) this.markedRows.add(row);
  }

  /** Add a cumulative sample to its source subtotal on its local day. */
  addCumulative(
    type: MeasurementType,
    dayKey: string,
    sourceHash: string,
    value: number,
  ): void {
    let byDay = this.cumulativeBucket.get(type);
    if (!byDay) {
      byDay = new Map();
      this.cumulativeBucket.set(type, byDay);
    }
    let bySource = byDay.get(dayKey);
    if (!bySource) {
      bySource = new Map();
      byDay.set(dayKey, bySource);
    }
    bySource.set(sourceHash, (bySource.get(sourceHash) ?? 0) + value);
  }

  /** Hold a marked cumulative sample until the end of the parse. */
  holdMarkedCumulative(entry: {
    type: MeasurementType;
    healthLogId: string;
    sampleKey: string;
    add: () => void;
  }): void {
    this.markedCumulative.push(entry);
  }

  // A sample the app wrote carries the HealthLog row id as `HKExternalUUID`,
  // with the origin marker or (before the marker existed) without it. A hit on
  // one of this account's rows (deleted ones included: the sample is ours
  // either way) of the same kind is an exact match. The marker alone proves
  // nothing about THIS account: after a move to a new instance without a
  // backup, re-importing the export must bring the mirrored values back.
  // Blood pressure is one row per half, while the app stamps both samples of a
  // reading with one id (the systolic row's, the diastolic row's in older
  // builds), so either half matches either id.
  private async ownRowKinds(
    ids: ReadonlySet<string>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const list = [...ids];
    for (let i = 0; i < list.length; i += 1000) {
      const known = await this.prisma.measurement.findMany({
        where: { userId: this.userId, id: { in: list.slice(i, i + 1000) } },
        select: { id: true, type: true },
      });
      for (const row of known) out.set(row.id, kindOf(row.type));
    }
    return out;
  }

  private async withoutHealthLogIds(
    rows: PreparedMeasurement[],
  ): Promise<PreparedMeasurement[]> {
    const ids = new Set<string>();
    for (const row of rows) {
      const id = this.healthLogIdOf.get(row);
      if (id) ids.add(id);
    }
    if (ids.size === 0) return rows;
    const kindOfId = await this.ownRowKinds(ids);
    if (kindOfId.size === 0) return rows;
    return rows.filter((row) => {
      const id = this.healthLogIdOf.get(row);
      const rowKind = id ? kindOfId.get(id) : undefined;
      if (!rowKind || rowKind !== kindOf(row.type)) return true;
      this.tally.countOwn(
        this.markedRows.has(row) ? "byMarker" : "byExternalId",
        row.externalId,
      );
      return false;
    });
  }

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
  private async withoutManualMirrors(
    rows: PreparedMeasurement[],
  ): Promise<PreparedMeasurement[]> {
    if (rows.length === 0) return rows;
    this.manualTypes ??= this.prisma.measurement
      .groupBy({
        by: ["type"],
        where: { userId: this.userId, source: "MANUAL", deletedAt: null },
      })
      .then((groups) => new Set(groups.map((group) => group.type)));
    const typed = await this.manualTypes;
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
    const candidates = await this.prisma.measurement.findMany({
      where: {
        userId: this.userId,
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
          this.tally.countOwn("matchedManual", row.externalId);
          return false;
        }
      }
      return true;
    });
  }

  // The `folded_window` guard, the same rule the batch route applies
  // (`folded-window.ts`). A raw sample of a dense or mean type whose hour or
  // day the consolidation has already folded into a live `stats:` row is left
  // out: the fold deletes its raw rows outright, so re-importing the export
  // would otherwise put them back beside the mean that already accounts for
  // them. One read per flush, none when nothing is old enough.
  private async withoutFoldedWindows(
    rows: PreparedMeasurement[],
  ): Promise<PreparedMeasurement[]> {
    if (rows.length === 0) return rows;
    const now = new Date();
    const candidates = rows.map((row) => ({
      type: row.type,
      source: "APPLE_HEALTH" as const,
      externalId: row.externalId,
      measuredAt: row.measuredAt,
    }));
    if (!candidates.some((row) => isFoldedWindowCandidate(row, now))) {
      return rows;
    }
    const folded = await findFoldedWindowDuplicates(
      this.prisma,
      this.userId,
      candidates,
      { now, tz: this.userTimezone },
    );
    if (folded.size === 0) return rows;
    return rows.filter((row, index) => {
      if (!folded.has(index)) return true;
      tallyReason(this.tally.unknown, `${row.type}::${FOLDED_WINDOW_REASON}`);
      return false;
    });
  }

  async flushSpotBatch(): Promise<void> {
    const { prisma, userId, tally } = this;
    const unknown = tally.unknown;
    if (this.spotBatch.length === 0) return;
    const incoming = this.spotBatch.splice(0, this.spotBatch.length);
    const chunk = await this.withoutFoldedWindows(
      await this.withoutManualMirrors(await this.withoutHealthLogIds(incoming)),
    );
    for (const row of incoming) {
      this.healthLogIdOf.delete(row);
      this.markedRows.delete(row);
    }
    for (const row of chunk) tally.widenSpan(row.measuredAt);
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

    // Rows already stored as they are: counted, not written (see module).
    const unchanged = await storedUnchangedKeys(
      prisma,
      userId,
      chunk,
      (r, i) =>
        failedInsertIndexes.has(i) ||
        createdByKey.has(`${r.type}::${r.externalId}`),
    );
    for (let index = 0; index < chunk.length; index += 1) {
      const row = chunk[index];
      const stat = tally.bumpStat(row.type);
      const rowStart = Date.now();
      if (failedInsertIndexes.has(index)) {
        tallyReason(unknown, `${row.type}::upsert_failed`);
        stat.durationMs += insertDurationShare + (Date.now() - rowStart);
        continue;
      }

      const key = `${row.type}::${row.externalId}`;
      if (unchanged.has(key)) {
        stat.updated += 1;
        tally.rowsUpserted += 1;
        continue;
      }
      const inserted = createdByKey.get(key)?.shift();
      if (inserted) {
        stat.inserted += 1;
        insertedArrivals.push(inserted);
        tally.rowsUpserted += 1;
        stat.durationMs += insertDurationShare + (Date.now() - rowStart);
        continue;
      }

      await this.updateSpotRow(row, stat);
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
  }

  /** Update a spot row the bulk insert skipped and that is not unchanged. */
  private async updateSpotRow(
    row: PreparedMeasurement,
    stat: MutableTypeStat,
  ): Promise<void> {
    const { prisma, userId, tally } = this;
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
      tally.rowsUpserted += 1;
    } catch (err) {
      // A skipped INSERT can mean the second natural key won rather than
      // this external id. Adopt that row exactly as the old upsert rescue
      // did. P2025 is the expected "external id absent" signal; P2002 can
      // still arise when an existing external-id row changes natural key.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === "P2002" || err.code === "P2025")
      ) {
        const adopted = await adoptNaturalKeyTwin(prisma, userId, row);
        if (adopted === "updated") {
          stat.updated += 1;
          tally.rowsUpserted += 1;
        } else {
          tallyReason(tally.unknown, `${row.type}::${adopted}`);
        }
      } else {
        tallyReason(tally.unknown, `${row.type}::upsert_failed`);
      }
    }
  }

  async flushWorkoutBatch(): Promise<void> {
    const { prisma, userId, tally } = this;
    const workouts = tally.workouts;
    if (this.workoutBatch.length === 0) return;
    const chunk = this.workoutBatch.splice(0, this.workoutBatch.length);
    await adoptLegacyWorkoutKeys(prisma, userId, chunk);
    const insertedArrivals: Array<{ id: string; startedAt: Date }> = [];
    const createData: Prisma.WorkoutCreateManyInput[] = chunk.map((row) => ({
      userId,
      sportType: row.sportType,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      durationSec: row.durationSec,
      totalEnergyKcal: row.totalEnergyKcal,
      totalDistanceM: row.totalDistanceM,
      avgHeartRate: row.avgHeartRate,
      minHeartRate: row.minHeartRate,
      maxHeartRate: row.maxHeartRate,
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

    const storedTotals = await storedWorkoutTotals(
      prisma,
      userId,
      chunk.filter((row) => !createdByExternalId.has(row.externalId)),
    );
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
            // Fills or replaces only what it may (`workoutTotalsUpdate`).
            ...workoutTotalsUpdate(row, storedTotals.get(row.externalId)),
            externalSourceVersion: row.externalSourceVersion,
            metadata: row.metadata ?? undefined,
          },
        });
        workouts.updated += 1;
      }
      workouts.durationMs += insertDurationShare + (Date.now() - rowStart);
      tally.rowsUpserted += 1;
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
  }

  async flushCumulativeBuckets(): Promise<void> {
    const { prisma, userId, userTimezone, tally } = this;
    const unknown = tally.unknown;
    for (const [type, byDay] of this.cumulativeBucket.entries()) {
      // Re-resolve the HK identifier from the mapping table — the bucket keys
      // are MeasurementType, but the shared externalId carries the HK
      // identifier used by native HealthKit statistics.
      const mapping = Object.values(APPLE_HEALTH_TYPE_MAP).find(
        (candidate) => candidate.measurementType === type,
      );
      if (!mapping) continue;
      const stat = tally.bumpStat(type);

      const days: string[] = [];
      const writes: ExternalMeasurementWrite[] = [];
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
          tallyReason(unknown, `${type}::aggregate_out_of_range`);
          continue;
        }
        const measuredAt = canonicalDailyTimestamp(dayKey, userTimezone);
        tally.widenSpan(measuredAt);
        days.push(dayKey);
        writes.push({
          userId,
          type,
          value: selectedSubtotal,
          unit: mapping.dbUnit,
          source: "APPLE_HEALTH",
          measuredAt,
          externalId: dailyStatsExternalId(mapping.hkIdentifier, dayKey),
          externalSourceVersion: null,
          sleepStage: null,
          deviceType: null,
          aggregationProvenance: "EXPORT_XML_SOURCE_MAX",
        });
      }
      const writeStart = Date.now();
      const verdicts = await reconcileExternalMeasurementsInChunks(
        prisma,
        writes,
        { exactExternalMatch: "update" },
      );
      verdicts.forEach((verdict, index) => {
        // The reconciler carries the same plausibility gate the block above
        // already applied, so this arm means the two disagreed. Tally it under
        // the same counter the earlier guard uses and count no row.
        if (verdict.status === "rejected_range") {
          tallyReason(unknown, `${type}::aggregate_out_of_range`);
          return;
        }
        tally.cumulativeEstimatedDays.add(days[index]!);
        tally.cumulativeEstimatedRows += 1;
        if (verdict.status === "inserted") stat.inserted += 1;
        if (verdict.status === "updated" || verdict.status === "resurrected")
          stat.updated += 1;
        if (verdict.status === "failed") {
          tallyReason(unknown, `${type}::upsert_failed`);
        } else if (verdict.status !== "duplicate") tally.rowsUpserted += 1;
      });
      stat.durationMs += Date.now() - writeStart;
    }
  }

  // Marked cumulative samples: left out when their id is a row of this
  // account of the same kind, added to their day otherwise.
  async settleMarkedCumulative(): Promise<void> {
    if (this.markedCumulative.length === 0) return;
    const kindOfId = await this.ownRowKinds(
      new Set(this.markedCumulative.map((m) => m.healthLogId)),
    );
    for (const m of this.markedCumulative.splice(
      0,
      this.markedCumulative.length,
    )) {
      if (kindOfId.get(m.healthLogId) === kindOf(m.type)) {
        this.tally.countOwn("byMarker", m.sampleKey);
      } else {
        m.add();
      }
    }
  }
}
