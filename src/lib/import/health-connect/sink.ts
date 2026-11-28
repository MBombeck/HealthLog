/**
 * The Health Connect write path: what happens to a mapped row between the
 * mapper and the table. Shared by the export import (`import.ts`) and the
 * live sync (`/api/health-connect/batch`), so a record reaches the same row
 * whichever way it arrives.
 *
 * Every function answers one outcome per input row, index-aligned. The export
 * import folds them into its per-type counters; the batch route turns them
 * into per-item results. No outcome carries a value.
 */
import { importValue } from "@/lib/integrations/import-value";
import type {
  GlucoseContext,
  MeasurementType,
  Prisma,
  PrismaClient,
  SleepStage,
} from "@/generated/prisma/client";
import { insertNewMeasurementRows } from "@/lib/export/measurement-bulk-insert";
import {
  measuredAtMatch,
  MEASURED_AT_TOLERANCE_MS,
  valuesMatch,
} from "@/lib/measurements/cross-source-merge";
import {
  reconcileExternalMeasurementsInChunks,
  type ExternalMeasurementWrite,
} from "@/lib/measurements/reconcile-external-measurement";
import {
  FOLDED_WINDOW_REASON,
  findFoldedWindowDuplicates,
  isFoldedWindowCandidate,
  loadFoldTimezone,
} from "@/lib/measurements/folded-window";
import { canonicalDailyTimestamp } from "@/lib/measurements/consolidation-tz";
import { validateMeasurementRange } from "@/lib/validations/measurement";

import {
  hcDailyStatsExternalId,
  hcUnit,
  mapHealthConnectSportType,
} from "./mapper";

export const HC_SOURCE = "HEALTH_CONNECT" as const;
const HOUR_MS = 3_600_000;

/** One measurement on its way to the table. */
export interface PendingRow {
  type: MeasurementType;
  value: number;
  valueMin?: number | null;
  valueMax?: number | null;
  measuredAt: Date;
  externalId: string;
  sleepStage: SleepStage | null;
  glucoseContext?: GlucoseContext | null;
  deviceType: string | null;
}

/** What became of one row. */
export type RowOutcome =
  | { status: "inserted" | "updated" | "unchanged" }
  | { status: "skipped"; reason: string };

/**
 * The one import rounding every value takes: a mapper's unit factor (grams
 * to kilograms, millis to minutes) leaves binary noise that would otherwise
 * be stored and compared as is.
 */
export function roundPendingRow(row: PendingRow): PendingRow {
  return {
    ...row,
    value: importValue(row.value),
    valueMin: row.valueMin == null ? row.valueMin : importValue(row.valueMin),
    valueMax: row.valueMax == null ? row.valueMax : importValue(row.valueMax),
  };
}

/** A workout session on its way to the table. */
export interface PendingWorkout {
  uuid: string;
  start: number;
  end: number;
  exerciseType: number | null;
  externalId: string;
}

/** One account's writer. Holds the fold zone once it was needed. */
export class HealthConnectSink {
  private foldTz: string | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly userId: string,
  ) {}

  /** The zone the nightly fold keys its hours in, read once. */
  async foldTimezone(): Promise<string> {
    this.foldTz ??= await loadFoldTimezone(this.prisma, this.userId);
    return this.foldTz;
  }

  /**
   * Write one batch of rows. `sameReadingCheck` leaves out a reading another
   * source already holds; `hourlyPulse` marks hourly heart-rate means, which
   * stay out of an hour that holds raw samples.
   */
  async writeRows(
    rows: readonly PendingRow[],
    opts: { sameReadingCheck: boolean; hourlyPulse: boolean },
  ): Promise<RowOutcome[]> {
    const outcomes: RowOutcome[] = new Array(rows.length);
    let batch: number[] = [];
    rows.forEach((row, i) => {
      if (validateMeasurementRange(row.type, row.value) !== null) {
        outcomes[i] = { status: "skipped", reason: "out_of_range" };
      } else {
        batch.push(i);
      }
    });
    if (opts.sameReadingCheck) {
      batch = await this.withoutOtherSourceTwins(rows, batch, outcomes);
    }
    if (opts.hourlyPulse) {
      batch = await this.withoutRawPulseHours(rows, batch, outcomes);
    } else {
      batch = await this.withoutFoldedHours(rows, batch, outcomes);
    }
    if (batch.length === 0) return outcomes;

    const inserted = await insertNewMeasurementRows(
      this.prisma,
      batch.map((i) => {
        const row = rows[i]!;
        return {
          userId: this.userId,
          type: row.type,
          value: row.value,
          valueMin: row.valueMin ?? null,
          valueMax: row.valueMax ?? null,
          unit: hcUnit(row.type),
          source: HC_SOURCE,
          measuredAt: row.measuredAt,
          externalId: row.externalId,
          externalSourceVersion: null,
          glucoseContext: row.glucoseContext ?? null,
          sleepStage: row.sleepStage,
          deviceType: row.deviceType,
        };
      }),
    );
    const landed = new Set(inserted.map((r) => `${r.type}|${r.externalId}`));
    const rest: number[] = [];
    for (const i of batch) {
      const row = rows[i]!;
      if (landed.has(`${row.type}|${row.externalId}`)) {
        outcomes[i] = { status: "inserted" };
      } else {
        rest.push(i);
      }
    }
    if (rest.length > 0) await this.reconcileExisting(rows, rest, outcomes);
    return outcomes;
  }

  /**
   * Rows the insert skipped: either this record was written before (update
   * it when its value changed, leave it when the person deleted it), or
   * another row already holds the same instant.
   */
  private async reconcileExisting(
    rows: readonly PendingRow[],
    indexes: readonly number[],
    outcomes: RowOutcome[],
  ): Promise<void> {
    const subset = indexes.map((i) => rows[i]!);
    const found = await this.prisma.measurement.findMany({
      where: {
        userId: this.userId,
        source: HC_SOURCE,
        type: { in: [...new Set(subset.map((r) => r.type))] },
        externalId: { in: [...new Set(subset.map((r) => r.externalId))] },
      },
      select: {
        id: true,
        type: true,
        externalId: true,
        value: true,
        valueMin: true,
        valueMax: true,
        deletedAt: true,
      },
    });
    const byKey = new Map(found.map((r) => [`${r.type}|${r.externalId}`, r]));
    for (const i of indexes) {
      const row = rows[i]!;
      const prior = byKey.get(`${row.type}|${row.externalId}`);
      if (!prior) {
        outcomes[i] = { status: "skipped", reason: "same_instant_exists" };
        continue;
      }
      if (prior.deletedAt !== null) {
        outcomes[i] = { status: "skipped", reason: "deleted_in_healthlog" };
        continue;
      }
      const same =
        valuesMatch(prior.value, row.value) &&
        (prior.valueMin ?? null) === (row.valueMin ?? null) &&
        (prior.valueMax ?? null) === (row.valueMax ?? null);
      if (same) {
        outcomes[i] = { status: "unchanged" };
        continue;
      }
      await this.prisma.measurement.update({
        where: { id: prior.id },
        data: {
          value: row.value,
          valueMin: row.valueMin ?? null,
          valueMax: row.valueMax ?? null,
          syncVersion: { increment: 1 },
        },
      });
      outcomes[i] = { status: "updated" };
    }
  }

  /**
   * The same reading already stored under another source (same type and
   * value within two seconds) is left out. The connected-integration skip
   * removes the known duplicates by app; this catches what it cannot name,
   * such as a reading typed into HealthLog and into a phone app alike.
   */
  private async withoutOtherSourceTwins(
    rows: readonly PendingRow[],
    indexes: number[],
    outcomes: RowOutcome[],
  ): Promise<number[]> {
    if (indexes.length === 0) return indexes;
    let from = Infinity;
    let to = -Infinity;
    for (const i of indexes) {
      const t = rows[i]!.measuredAt.getTime();
      if (t < from) from = t;
      if (t > to) to = t;
    }
    // Spot types only: the dense types (heart rate, sleep) never take this
    // check, so the read is bounded by one batch's window of sparse readings.
    const spotTypes = [...new Set(indexes.map((i) => rows[i]!.type))];
    const others = await this.prisma.measurement.findMany({
      where: {
        userId: this.userId,
        source: { not: HC_SOURCE },
        deletedAt: null,
        type: { in: spotTypes },
        measuredAt: {
          gte: new Date(from - MEASURED_AT_TOLERANCE_MS),
          lte: new Date(to + MEASURED_AT_TOLERANCE_MS),
        },
      },
      select: { type: true, value: true, measuredAt: true },
      orderBy: { measuredAt: "asc" },
    });
    if (others.length === 0) return indexes;
    const byType = new Map<string, typeof others>();
    for (const o of others) {
      const list = byType.get(o.type);
      if (list) list.push(o);
      else byType.set(o.type, [o]);
    }
    return indexes.filter((i) => {
      const row = rows[i]!;
      const list = byType.get(row.type);
      if (!list) return true;
      const twin = list.some(
        (o) =>
          measuredAtMatch(o.measuredAt, row.measuredAt) &&
          valuesMatch(o.value, row.value),
      );
      if (twin) {
        outcomes[i] = {
          status: "skipped",
          reason: "same_reading_other_source",
        };
      }
      return !twin;
    });
  }

  /**
   * An hourly mean is left out for an hour that already holds raw samples of
   * this source. A sample written raw while it was recent falls past the
   * 90-day window by the next import; folding it then would put the mean
   * beside the samples it summarises.
   */
  private async withoutRawPulseHours(
    rows: readonly PendingRow[],
    indexes: number[],
    outcomes: RowOutcome[],
  ): Promise<number[]> {
    if (indexes.length === 0) return indexes;
    let from = Infinity;
    let to = -Infinity;
    for (const i of indexes) {
      const t = rows[i]!.measuredAt.getTime();
      if (t < from) from = t;
      if (t > to) to = t;
    }
    const hours = await this.prisma.$queryRaw<Array<{ h: bigint }>>`
      SELECT DISTINCT floor(extract(epoch FROM measured_at) / 3600)::bigint AS h
      FROM measurements
      WHERE user_id = ${this.userId}
        AND type = 'PULSE'::measurement_type
        AND source = 'HEALTH_CONNECT'::measurement_source
        AND external_id LIKE 'hc:%'
        AND deleted_at IS NULL
        AND measured_at >= ${new Date(from - HOUR_MS)}
        AND measured_at < ${new Date(to + HOUR_MS)}`;
    if (hours.length === 0) return indexes;
    const taken = new Set(hours.map((r) => Number(r.h)));
    return indexes.filter((i) => {
      // The mean sits mid-hour; its hour spans half an hour either side.
      const start = rows[i]!.measuredAt.getTime() - HOUR_MS / 2;
      const clash =
        taken.has(Math.floor(start / HOUR_MS)) ||
        taken.has(Math.floor((start + HOUR_MS - 1) / HOUR_MS));
      if (clash)
        outcomes[i] = { status: "skipped", reason: "hour_already_raw" };
      return !clash;
    });
  }

  /**
   * A raw sample of a folded type is left out when the nightly fold has
   * already turned its hour into a `stats:` mean under this source. The fold
   * deletes the samples it summarises, so without this a later write of the
   * same samples would put them back beside their own mean. Same rule as the
   * Apple Health batch route and ZIP import (`folded-window.ts`); rows too
   * young to have been folded cost no query.
   */
  private async withoutFoldedHours(
    rows: readonly PendingRow[],
    indexes: number[],
    outcomes: RowOutcome[],
  ): Promise<number[]> {
    if (indexes.length === 0) return indexes;
    const candidates = indexes.map((i) => ({
      type: rows[i]!.type,
      source: HC_SOURCE,
      externalId: rows[i]!.externalId,
      measuredAt: rows[i]!.measuredAt,
    }));
    if (!candidates.some((row) => isFoldedWindowCandidate(row))) {
      return indexes;
    }
    const folded = await findFoldedWindowDuplicates(
      this.prisma,
      this.userId,
      candidates,
      { tz: await this.foldTimezone() },
    );
    if (folded.size === 0) return indexes;
    return indexes.filter((i, at) => {
      if (!folded.has(at)) return true;
      outcomes[i] = { status: "skipped", reason: FOLDED_WINDOW_REASON };
      return false;
    });
  }

  /**
   * Write day totals as `stats:<id>:<day>` rows, overwriting a stored total
   * of another value. `tz` anchors the day's instant. A total carrying
   * `computedAt` is refused (`stale`) when the stored one was computed later.
   */
  async writeDayTotals(
    type: MeasurementType,
    days: ReadonlyArray<{ dayKey: string; value: number; computedAt?: Date }>,
    tz: string,
  ): Promise<{ outcomes: RowOutcome[]; measuredAt: Date[] }> {
    const outcomes: RowOutcome[] = new Array(days.length);
    const measuredAt = days.map((d) => canonicalDailyTimestamp(d.dayKey, tz));
    if (days.length === 0) return { outcomes, measuredAt };
    const ids = days.map((d) => hcDailyStatsExternalId(type, d.dayKey));
    const existing = new Map(
      (
        await this.prisma.measurement.findMany({
          where: {
            userId: this.userId,
            type,
            source: HC_SOURCE,
            externalId: { in: ids },
          },
          select: { externalId: true, value: true, deletedAt: true },
        })
      ).map((row) => [row.externalId, row]),
    );
    const writes: ExternalMeasurementWrite[] = [];
    const writeIndex: number[] = [];
    for (let i = 0; i < days.length; i++) {
      const { value, computedAt } = days[i]!;
      if (validateMeasurementRange(type, value) !== null) {
        outcomes[i] = { status: "skipped", reason: "out_of_range" };
        continue;
      }
      const prior = existing.get(ids[i]);
      if (
        prior &&
        prior.deletedAt === null &&
        valuesMatch(prior.value, value)
      ) {
        outcomes[i] = { status: "unchanged" };
        continue;
      }
      writes.push({
        userId: this.userId,
        type,
        value,
        unit: hcUnit(type),
        source: HC_SOURCE,
        measuredAt: measuredAt[i]!,
        externalId: ids[i],
        externalSourceVersion: null,
        sleepStage: null,
        deviceType: null,
        ...(computedAt ? { statsComputedAt: computedAt } : {}),
      });
      writeIndex.push(i);
    }
    const verdicts = await reconcileExternalMeasurementsInChunks(
      this.prisma,
      writes,
      { exactExternalMatch: "update" },
    );
    verdicts.forEach((verdict, at) => {
      const i = writeIndex[at]!;
      if (verdict.status === "duplicate") {
        outcomes[i] =
          "stale" in verdict && verdict.stale
            ? { status: "skipped", reason: "stale" }
            : { status: "unchanged" };
        return;
      }
      if (verdict.status === "failed" || verdict.status === "rejected_range") {
        const refused = verdict.status === "rejected_range";
        outcomes[i] = {
          status: "skipped",
          reason: refused ? "out_of_range" : "write_failed",
        };
        return;
      }
      outcomes[i] = {
        status: verdict.status === "inserted" ? "inserted" : "updated",
      };
    });
    return { outcomes, measuredAt };
  }

  /**
   * Workouts, first write wins: a session written before is `unchanged`.
   * The raw Health Connect type rides the metadata, so the sport mapping
   * stays reversible.
   */
  async writeWorkouts(
    sessions: readonly PendingWorkout[],
  ): Promise<RowOutcome[]> {
    if (sessions.length === 0) return [];
    const data: Prisma.WorkoutCreateManyInput[] = sessions.map((s) => ({
      userId: this.userId,
      sportType: mapHealthConnectSportType(s.exerciseType),
      startedAt: new Date(s.start),
      endedAt: new Date(s.end),
      durationSec: Math.round((s.end - s.start) / 1000),
      source: HC_SOURCE,
      externalId: s.externalId,
      metadata: { healthConnectExerciseType: s.exerciseType },
    }));
    const created = await this.prisma.workout.createManyAndReturn({
      data,
      skipDuplicates: true,
      select: { externalId: true },
    });
    const landed = new Set(created.map((w) => w.externalId));
    return sessions.map((s) =>
      landed.has(s.externalId)
        ? { status: "inserted" as const }
        : { status: "unchanged" as const },
    );
  }
}
