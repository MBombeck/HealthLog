/**
 * One number per local day and type, read live (v1.42, #613).
 *
 * The usual range under a reading, the notable-day rules and the day index
 * all compare days with each other, and they have to compare the same days
 * the day view shows. The rollup tier cuts days at UTC midnight, so a reading
 * at 00:30 in Berlin sits in the day before there; this reader groups by the
 * record's own local date in SQL instead (`measured_at` is stored as UTC
 * wall time, so it is read `AT TIME ZONE 'UTC'` first and then into the
 * record's zone).
 *
 * The day value follows the type: a cumulative type (steps, energy, distance)
 * is the day's total, a pulse-like type is the mean of its hourly means (a
 * workout hour must not outweigh the rest of the day, `day-statistic.ts`),
 * everything else is the mean of the day's readings. Each day keeps one
 * source, picked through the record's source ladder exactly as the rollup
 * readers pick it.
 */
import {
  Prisma,
  type MeasurementSource,
  type MeasurementType,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isCumulativeDaySumType } from "@/lib/measurements/cumulative-day-sum";
import { HOURLY_MEAN_DAY_TYPES } from "@/lib/measurements/day-statistic";
import { dateOnlyAtNoonUtc, dateOnlyKey } from "@/lib/tz/date-only";
import { collapseRollupRowsBySource } from "@/lib/rollups/measurement-read";

/** Day key → the day's value, per type. */
export type DailyStats = Map<MeasurementType, Map<string, number>>;

/** A day's value with the readings behind it (the picked source's). */
export interface DayCell {
  value: number;
  count: number;
}

/** Day key → the day's value and reading count, per type. */
export type DailyCells = Map<MeasurementType, Map<string, DayCell>>;

interface StatRow {
  type: MeasurementType;
  source: MeasurementSource;
  day: string;
  hour: number;
  total: number;
  count: number;
}

interface DaySourceCell {
  bucketStart: Date;
  source: MeasurementSource;
  count: number;
  value: number;
}

/**
 * The day value of each type on each local day in `[from, to)`.
 *
 * `from` and `to` are instants (the start of the first local day and the
 * start of the day after the last), so the window itself is local too.
 */
export async function readLocalDailyStats(args: {
  userId: string;
  types: readonly MeasurementType[];
  from: Date;
  to: Date;
  tz: string;
  priorityJson: unknown;
}): Promise<DailyStats> {
  return valuesOnly(await readLocalDailyCells(args));
}

/**
 * {@link readLocalDailyStats} with each day's reading count beside its
 * value: the timeline marks a mean that rests on few readings.
 */
export async function readLocalDailyCells(args: {
  userId: string;
  types: readonly MeasurementType[];
  from: Date;
  to: Date;
  tz: string;
  priorityJson: unknown;
}): Promise<DailyCells> {
  const out: DailyCells = new Map();
  if (args.types.length === 0 || args.from >= args.to) return out;
  const hourlyTypes = args.types.filter((t) => HOURLY_MEAN_DAY_TYPES.has(t));
  // Every value is parameter-bound; the enum casts are literal SQL. The hour
  // column is only split out for the pulse-like types, so a dense type of any
  // other kind still comes back as one row per day and source.
  const hourExpr =
    hourlyTypes.length > 0
      ? Prisma.sql`CASE WHEN "type" = ANY(${hourlyTypes}::"measurement_type"[])
          THEN EXTRACT(HOUR FROM ("measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${args.tz})::int
          ELSE 0 END`
      : Prisma.sql`0`;
  const rows = await prisma.$queryRaw<StatRow[]>`
    SELECT "type"::text AS "type",
           "source"::text AS "source",
           to_char(("measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${args.tz}, 'YYYY-MM-DD') AS "day",
           ${hourExpr} AS "hour",
           SUM("value")::float8 AS "total",
           COUNT(*)::int AS "count"
    FROM "measurements"
    WHERE "user_id" = ${args.userId}
      AND "deleted_at" IS NULL
      AND "type" = ANY(${[...args.types]}::"measurement_type"[])
      AND "measured_at" >= ${args.from}
      AND "measured_at" < ${args.to}
    GROUP BY 1, 2, 3, 4
  `;
  return foldDailyCells(rows, args.priorityJson);
}

function valuesOnly(cells: DailyCells): DailyStats {
  const out: DailyStats = new Map();
  for (const [type, days] of cells) {
    const perDay = new Map<string, number>();
    for (const [day, cell] of days) perDay.set(day, cell.value);
    out.set(type, perDay);
  }
  return out;
}

/**
 * Fold the grouped rows into one value per type and day. Exported for the
 * unit tests, which pin the three day statistics and the source pick without
 * a database.
 */
export function foldDailyStats(
  rows: readonly StatRow[],
  priorityJson: unknown,
): DailyStats {
  return valuesOnly(foldDailyCells(rows, priorityJson));
}

/** {@link foldDailyStats} with the picked source's reading count per day. */
export function foldDailyCells(
  rows: readonly StatRow[],
  priorityJson: unknown,
): DailyCells {
  // type → day → source → hour cells
  const nested = new Map<
    MeasurementType,
    Map<string, Map<MeasurementSource, { total: number; count: number }[]>>
  >();
  for (const row of rows) {
    let days = nested.get(row.type);
    if (!days) nested.set(row.type, (days = new Map()));
    let sources = days.get(row.day);
    if (!sources) days.set(row.day, (sources = new Map()));
    let cells = sources.get(row.source);
    if (!cells) sources.set(row.source, (cells = []));
    cells.push({ total: Number(row.total), count: Number(row.count) });
  }

  const out: DailyCells = new Map();
  for (const [type, days] of nested) {
    const cumulative = isCumulativeDaySumType(type);
    const hourly = HOURLY_MEAN_DAY_TYPES.has(type);
    const cells: DaySourceCell[] = [];
    for (const [day, sources] of days) {
      for (const [source, hours] of sources) {
        const count = hours.reduce((n, h) => n + h.count, 0);
        if (count === 0) continue;
        let value: number;
        if (cumulative) {
          value = hours.reduce((s, h) => s + h.total, 0);
        } else if (hourly) {
          value =
            hours.reduce((s, h) => s + h.total / h.count, 0) / hours.length;
        } else {
          value = hours.reduce((s, h) => s + h.total, 0) / count;
        }
        cells.push({
          bucketStart: dateOnlyAtNoonUtc(day),
          source,
          count,
          value,
        });
      }
    }
    const picked = collapseRollupRowsBySource(cells, type, priorityJson);
    const perDay = new Map<string, DayCell>();
    for (const cell of picked) {
      perDay.set(dateOnlyKey(cell.bucketStart), {
        value: cell.value,
        count: cell.count,
      });
    }
    out.set(type, perDay);
  }
  return out;
}

/**
 * The local days in `[from, to)` that hold a reading of any of `types`.
 * Distinct in SQL, so a dense type costs a scan and not a transfer.
 * `shiftHours` files a reading under the day `shiftHours` later (the day
 * index files a late-evening sleep stage under the night it belongs to).
 */
export async function readLocalDaysWithReadings(args: {
  userId: string;
  types: readonly MeasurementType[];
  from: Date;
  to: Date;
  tz: string;
  shiftHours?: number;
}): Promise<Set<string>> {
  const out = new Set<string>();
  if (args.types.length === 0 || args.from >= args.to) return out;
  const shiftHours = args.shiftHours ?? 0;
  const shift = `${shiftHours} hours`;
  const rows = await prisma.$queryRaw<Array<{ day: string }>>`
    SELECT DISTINCT to_char((("measured_at" + ${shift}::interval) AT TIME ZONE 'UTC') AT TIME ZONE ${args.tz}, 'YYYY-MM-DD') AS "day"
    FROM "measurements"
    WHERE "user_id" = ${args.userId}
      AND "deleted_at" IS NULL
      AND "type" = ANY(${[...args.types]}::"measurement_type"[])
      AND "measured_at" >= ${new Date(args.from.getTime() - shiftHours * 3_600_000)}
      AND "measured_at" < ${new Date(args.to.getTime() - shiftHours * 3_600_000)}
  `;
  for (const row of rows) out.add(row.day);
  return out;
}
