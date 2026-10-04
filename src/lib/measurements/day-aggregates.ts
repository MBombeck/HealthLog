/**
 * Per-day aggregates of one measurement type, folded in Postgres.
 *
 * Several background readers (the status cards' graded series, the vitals
 * baseline, the tiered context, the plan review) used to `findMany` every raw
 * row in a time window and then fold them into days in JavaScript. The window
 * bounded the time span but not the row count, so an account whose watch
 * streams heart rate every few seconds materialised hundreds of thousands to
 * millions of objects per read. In the worker that was enough to exhaust the
 * heap, and the read itself outran the statement timeout.
 *
 * This reader returns at most one row per (day, segment), whatever the sample
 * density: the fold runs in SQL and only the aggregates cross the wire. `sum`,
 * `n`, `min` and `max` are exact, so every consumer that averaged, counted or
 * took extremes over the raw rows gets the same numbers from these rows.
 *
 * Days are cut in `timeZone`. `segmentStarts` optionally splits the window at
 * instants (newest first): a row's segment is the number of starts it lies
 * before, so a caller that treated "the last 21 days" and "the 70 days before
 * that" differently keeps exactly the same per-row partition.
 */
import type {
  MeasurementSource,
  MeasurementType,
  PrismaClient,
} from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { isValidTimezone } from "@/lib/tz/format";
import { dayWeightedRowsSql } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";

export interface DayAggregateRow {
  /** Calendar day in the requested zone, `YYYY-MM-DD`. */
  day: string;
  /** Segment index: 0 for rows at or after `segmentStarts[0]`, and so on. */
  segment: number;
  n: number;
  sum: number;
  min: number;
  max: number;
  /**
   * For a type whose day is the mean of its hours' means (pulse, see
   * `day-mean.ts`): `SUM(value * day_weight)` and `SUM(day_weight)` over the
   * row's readings. A whole day's weights add up to one, so `weightedSum /
   * weightSum` is the day value and the same ratio over several rows the mean
   * of their days. Absent for every other type.
   */
  weightedSum?: number;
  weightSum?: number;
  /**
   * The row's value for an hourly-mean type, `weightedSum / weightSum`: the
   * mean of its local hours' means. Absent for every other type, whose value
   * stays `sum / n`. Read it as `dayMean ?? sum / n`.
   */
  dayMean?: number;
}

export interface ReadDayAggregatesOptions {
  userId: string;
  type: MeasurementType;
  /** Inclusive lower bound on `measuredAt`. */
  since: Date;
  /** Inclusive upper bound on `measuredAt`; omit for no upper bound. */
  until?: Date;
  /** IANA zone the day boundary is cut in. */
  timeZone: string;
  /** Rows outside `[min, max]` are dropped before the fold. */
  valueRange?: { min: number; max: number };
  /** Segment boundaries, newest first. */
  segmentStarts?: readonly Date[];
  /** Client to read through; defaults to the shared one. */
  db?: Pick<PrismaClient, "$queryRaw">;
}

export async function readDayAggregates(
  opts: ReadDayAggregatesOptions,
): Promise<DayAggregateRow[]> {
  const timeZone = isValidTimezone(opts.timeZone) ? opts.timeZone : "UTC";
  const until = opts.until
    ? Prisma.sql`AND m."measured_at" <= ${opts.until}`
    : Prisma.empty;
  const range = opts.valueRange
    ? Prisma.sql`AND m."value" >= ${opts.valueRange.min} AND m."value" <= ${opts.valueRange.max}`
    : Prisma.empty;
  const starts = opts.segmentStarts ?? [];
  const segment =
    starts.length === 0
      ? Prisma.sql`0`
      : Prisma.sql`(${Prisma.join(
          starts.map(
            (s) =>
              Prisma.sql`(CASE WHEN m."measured_at" < ${s} THEN 1 ELSE 0 END)`,
          ),
          " + ",
        )})`;

  if (usesHourlyMeanDay(opts.type)) {
    return readHourlyMeanDayAggregates(opts, timeZone, until, range, segment);
  }

  // The day and segment are computed once per row in `src` and grouped by
  // name, so the bound zone / boundary parameters never have to match
  // themselves across SELECT and GROUP BY.
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{
      day: string;
      segment: number;
      n: number;
      sum: number;
      min: number;
      max: number;
    }>
  >`
    WITH src AS (
      SELECT
        to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
        ${segment} AS segment,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = ${opts.type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.since}
        ${until}
        ${range}
    )
    SELECT
      day,
      segment::int                 AS segment,
      COUNT(*)::int                AS n,
      SUM(value)::double precision AS sum,
      MIN(value)::double precision AS min,
      MAX(value)::double precision AS max
    FROM src
    GROUP BY day, segment
    ORDER BY day ASC, segment DESC
  `;
  return rows.map((r) => ({
    day: r.day,
    segment: Number(r.segment),
    n: Number(r.n),
    sum: Number(r.sum),
    min: Number(r.min),
    max: Number(r.max),
  }));
}

/**
 * `readDayAggregates` for an hourly-mean type: the same rows, plus the day
 * weights of `day-mean.ts` cut in the same zone, so a day's hours count once
 * each however densely they were sampled.
 */
async function readHourlyMeanDayAggregates(
  opts: ReadDayAggregatesOptions,
  timeZone: string,
  until: Prisma.Sql,
  range: Prisma.Sql,
  segment: Prisma.Sql,
): Promise<DayAggregateRow[]> {
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{
      day: string;
      segment: number;
      n: number;
      sum: number;
      min: number;
      max: number;
      wsum: number;
      wdays: number;
    }>
  >`
    WITH base AS (
      SELECT m.*
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = ${opts.type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.since}
        ${until}
        ${range}
    ),
    src AS (
      SELECT
        to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
        ${segment} AS segment,
        m."value" AS value,
        m.day_weight AS day_weight
      FROM ${dayWeightedRowsSql("base", timeZone)} m
    )
    SELECT
      day,
      segment::int                             AS segment,
      COUNT(*)::int                            AS n,
      SUM(value)::double precision             AS sum,
      MIN(value)::double precision             AS min,
      MAX(value)::double precision             AS max,
      SUM(value * day_weight)::double precision AS wsum,
      SUM(day_weight)::double precision        AS wdays
    FROM src
    GROUP BY day, segment
    ORDER BY day ASC, segment DESC
  `;
  return rows.map((r) => ({
    day: r.day,
    segment: Number(r.segment),
    n: Number(r.n),
    sum: Number(r.sum),
    min: Number(r.min),
    max: Number(r.max),
    weightedSum: Number(r.wsum),
    weightSum: Number(r.wdays),
    dayMean: Number(r.wsum) / Number(r.wdays),
  }));
}

export interface SourceDayAggregateRow {
  type: MeasurementType;
  /** Calendar day in the requested zone, `YYYY-MM-DD`. */
  day: string;
  source: MeasurementSource;
  deviceType: string | null;
  n: number;
  sum: number;
  /** Earliest reading of the group; lies inside `day` in the zone. */
  firstAt: Date;
}

/**
 * Per-day aggregates of several types, kept apart per source and device.
 *
 * For readers that pick one source per day (`pickCanonicalSourceRows`) and
 * then add up or average that day. The picker decides from which sources and
 * device types are present on a day, never from individual values, so it
 * makes the same pick over these groups as over the raw rows, and the day's
 * sum and count follow exactly. Size: one row per type, day, source and
 * device, however densely a type is sampled.
 */
export async function readSourceDayAggregates(opts: {
  userId: string;
  types: readonly MeasurementType[];
  since: Date;
  timeZone: string;
  db?: Pick<PrismaClient, "$queryRaw">;
}): Promise<SourceDayAggregateRow[]> {
  if (opts.types.length === 0) return [];
  const timeZone = isValidTimezone(opts.timeZone) ? opts.timeZone : "UTC";
  const types = Prisma.join(
    opts.types.map((t) => Prisma.sql`${t}::measurement_type`),
  );
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{
      type: string;
      day: string;
      source: string;
      device_type: string | null;
      n: number;
      sum: number;
      first_at: Date;
    }>
  >`
    WITH src AS (
      SELECT
        m."type"::text AS type,
        to_char((m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}, 'YYYY-MM-DD') AS day,
        m."source"::text AS source,
        m."device_type" AS device_type,
        m."value" AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" IN (${types})
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.since}
    )
    SELECT
      type, day, source, device_type,
      COUNT(*)::int                AS n,
      SUM(value)::double precision AS sum,
      MIN(measured_at)             AS first_at
    FROM src
    GROUP BY type, day, source, device_type
    ORDER BY day ASC, type ASC, source ASC
  `;
  return rows.map((r) => ({
    type: r.type as MeasurementType,
    day: r.day,
    source: r.source as MeasurementSource,
    deviceType: r.device_type,
    n: Number(r.n),
    sum: Number(r.sum),
    firstAt: r.first_at,
  }));
}
