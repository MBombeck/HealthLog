/**
 * Bucketed reads of a dense measurement stream, folded in Postgres.
 *
 * A watch that records heart rate every couple of seconds writes about
 * 35 000 pulse rows a day. A reader that fetched the day's rows with a row
 * cap and folded them in JavaScript drew the first hours of the day and then
 * stopped, with nothing on the screen to say so: the cap ran out at the
 * fourth hour and the rest of the day never reached the fold. Every reader
 * here aggregates per bucket in SQL instead, so the database returns one row
 * per bucket (at most 144 for a day of ten-minute buckets) however dense the
 * stream is, and no row cap exists to run out.
 *
 * Each helper reads raw per-sample rows only: a `stats:` row is an aggregate
 * that already stands for many samples (an uploaded ten-minute bucket, a
 * folded hour, a day total) and the callers read those on their own. The
 * window bound runs on `(user_id, type, measured_at)`, the leading columns of
 * the measurements' natural-key index, so a day's read is one index range.
 *
 * Local placement follows the reading-zone rule (`reading-zone.ts`): a
 * reading's day and wall clock are read in its own zone when it carries one,
 * in the profile zone otherwise (`readingWallSql`). A read of one local day
 * selects by the profile day's instant window, widened by
 * `READING_ZONE_SLACK_MS` for the readings that carry a zone, and decides the
 * day per row. Every value is a bound parameter.
 */
import {
  Prisma,
  type MeasurementSource,
  type MeasurementType,
  type PrismaClient,
} from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { combineHourCells } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import { plausibleMetricRange } from "@/lib/measurements/value-domain";
import { isValidTimezone } from "@/lib/tz/format";
import { localDayWindow } from "@/lib/tz/local-day";
import { READING_ZONE_SLACK_MS } from "@/lib/tz/reading-zone";
import { readingWallSql } from "@/lib/tz/reading-zone-sql";

type RawDb = Pick<PrismaClient, "$queryRaw">;

/** One bucket of raw readings: how many, their sum and their range. */
export interface DenseBucket {
  n: number;
  sum: number;
  min: number;
  max: number;
}

/** A bucket of one local day, anchored on its first minute after midnight. */
export interface LocalMinuteBucket extends DenseBucket {
  /** Minutes since local midnight at the bucket's start (0, 10, 20, …). */
  startMinute: number;
}

/** A bucket of a session window, anchored on its index from the origin. */
export interface ElapsedBucket extends DenseBucket {
  /** `floor((measuredAt − origin) / bucket)`; bucket 0 starts at the origin. */
  index: number;
}

/** One local day's extremes. */
export interface LocalDayExtremes {
  /** `YYYY-MM-DD` in the zone the read was cut in. */
  day: string;
  n: number;
  min: number;
  max: number;
}

function zoneOrUtc(timeZone: string): string {
  return isValidTimezone(timeZone) ? timeZone : "UTC";
}

/**
 * The raw readings of one local day of `type`, folded into buckets of
 * `bucketMinutes` on the local wall clock. A fall-back day's repeated hour
 * folds into its one set of slots, as the wall-clock fold in JavaScript did.
 * Empty buckets are absent; ascending by `startMinute`.
 */
export async function readLocalDayMinuteBuckets(opts: {
  userId: string;
  type: MeasurementType;
  /** The local calendar day, `YYYY-MM-DD`. */
  dateKey: string;
  timeZone: string;
  /** Bucket width in minutes, 1 to 1440. */
  bucketMinutes: number;
  db?: RawDb;
}): Promise<LocalMinuteBucket[]> {
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{
      start_minute: number;
      n: number;
      sum: number;
      min_value: number;
      max_value: number;
    }>
  >(localDayMinuteBucketsSql(opts));
  return rows.map((r) => ({
    startMinute: Number(r.start_minute),
    n: Number(r.n),
    sum: Number(r.sum),
    min: Number(r.min_value),
    max: Number(r.max_value),
  }));
}

/**
 * The statement {@link readLocalDayMinuteBuckets} sends, exported so the
 * plan check can `EXPLAIN` exactly what the reader runs.
 */
export function localDayMinuteBucketsSql(opts: {
  userId: string;
  type: MeasurementType;
  dateKey: string;
  timeZone: string;
  bucketMinutes: number;
}): Prisma.Sql {
  const bucketMinutes = Math.trunc(opts.bucketMinutes);
  if (!(bucketMinutes >= 1 && bucketMinutes <= 1440)) {
    throw new RangeError(`bucketMinutes out of range: ${opts.bucketMinutes}`);
  }
  const timeZone = zoneOrUtc(opts.timeZone);
  const { dayStart, dayEnd } = localDayWindow(opts.dateKey, timeZone);
  const wideStart = new Date(dayStart.getTime() - READING_ZONE_SLACK_MS);
  const wideEnd = new Date(dayEnd.getTime() + READING_ZONE_SLACK_MS);
  // A reading without a zone is on the profile day exactly when it is inside
  // the day's window; only one that carries a zone needs the slack.
  return Prisma.sql`
    WITH src AS (
      SELECT
        ${readingWallSql("m", timeZone)} AS local_at,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = ${opts.type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${wideStart}
        AND m."measured_at" < ${wideEnd}
        AND (
          m."time_zone" IS NOT NULL
          OR (m."measured_at" >= ${dayStart} AND m."measured_at" < ${dayEnd})
        )
        AND (m."external_id" IS NULL OR m."external_id" NOT LIKE 'stats:%')
    ),
    placed AS (
      SELECT
        ((EXTRACT(HOUR FROM local_at)::int * 60 + EXTRACT(MINUTE FROM local_at)::int)
          / ${bucketMinutes}::int) * ${bucketMinutes}::int AS start_minute,
        value
      FROM src
      WHERE to_char(local_at, 'YYYY-MM-DD') = ${opts.dateKey}
    )
    SELECT
      start_minute,
      COUNT(*)::int                AS n,
      SUM(value)::double precision AS sum,
      MIN(value)::double precision AS min_value,
      MAX(value)::double precision AS max_value
    FROM placed
    GROUP BY start_minute
    ORDER BY start_minute ASC
  `;
}

/**
 * The raw readings of `type` in `[from, to]`, folded into buckets of
 * `bucketSec` counted from `originMs`. Only readings inside
 * `[origin, origin + spanSec)` are bucketed; `windowCount` counts every raw
 * reading of the whole window, the padding included, for callers that gate
 * on how much signal the window holds. Ascending by `index`.
 */
export async function readElapsedBuckets(opts: {
  userId: string;
  type: MeasurementType;
  from: Date;
  to: Date;
  originMs: number;
  spanSec: number;
  bucketSec: number;
  db?: RawDb;
}): Promise<{ buckets: ElapsedBucket[]; windowCount: number }> {
  if (!(opts.bucketSec > 0) || !(opts.spanSec >= 0)) {
    throw new RangeError("bucketSec must be positive and spanSec non-negative");
  }
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{
      idx: number | null;
      n: number;
      sum: number;
      min_value: number;
      max_value: number;
    }>
  >(Prisma.sql`
    WITH src AS (
      SELECT
        EXTRACT(EPOCH FROM m."measured_at")::double precision * 1000
          - ${opts.originMs}::double precision AS rel_ms,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = ${opts.type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.from}
        AND m."measured_at" <= ${opts.to}
        AND (m."external_id" IS NULL OR m."external_id" NOT LIKE 'stats:%')
    ),
    placed AS (
      SELECT
        CASE
          WHEN rel_ms >= 0 AND rel_ms < ${opts.spanSec * 1000}::double precision
          THEN FLOOR(rel_ms / ${opts.bucketSec * 1000}::double precision)::int
        END AS idx,
        value
      FROM src
    )
    SELECT
      idx,
      COUNT(*)::int                AS n,
      SUM(value)::double precision AS sum,
      MIN(value)::double precision AS min_value,
      MAX(value)::double precision AS max_value
    FROM placed
    GROUP BY idx
    ORDER BY idx ASC NULLS LAST
  `);
  let windowCount = 0;
  const buckets: ElapsedBucket[] = [];
  for (const r of rows) {
    const n = Number(r.n);
    windowCount += n;
    if (r.idx === null) continue;
    buckets.push({
      index: Number(r.idx),
      n,
      sum: Number(r.sum),
      min: Number(r.min_value),
      max: Number(r.max_value),
    });
  }
  return { buckets, windowCount };
}

/**
 * Per local day, the lowest and highest reading of `type` in `[from, to]`,
 * every row counted (a `stats:` row is a reading of its own day here, as it
 * was for the row-by-row fold this replaces). Ascending by day.
 */
export async function readLocalDayExtremes(opts: {
  userId: string;
  type: MeasurementType;
  from: Date;
  to: Date;
  timeZone: string;
  db?: RawDb;
}): Promise<LocalDayExtremes[]> {
  const timeZone = zoneOrUtc(opts.timeZone);
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{ day: string; n: number; min_value: number; max_value: number }>
  >(Prisma.sql`
    SELECT
      to_char(${readingWallSql("m", timeZone)}, 'YYYY-MM-DD') AS day,
      COUNT(*)::int                  AS n,
      MIN(m."value")::double precision AS min_value,
      MAX(m."value")::double precision AS max_value
    FROM measurements m
    WHERE m."user_id" = ${opts.userId}
      AND m."type" = ${opts.type}::measurement_type
      AND m."deleted_at" IS NULL
      AND m."measured_at" >= ${opts.from}
      AND m."measured_at" <= ${opts.to}
    GROUP BY 1
    ORDER BY 1 ASC
  `);
  return rows.map((r) => ({
    day: r.day,
    n: Number(r.n),
    min: Number(r.min_value),
    max: Number(r.max_value),
  }));
}

/**
 * The value of the most recent local day of `type` since `since`, every
 * reading of that day counted, and that day's key and newest instant. The
 * day value is the one `day-mean.ts` defines: the weighted mean of the day's
 * hour means for an hour-weighted type (pulse), the plain mean otherwise.
 * With `plausibleOnly`, readings outside the metric's plausibility domain are
 * neither part of the value nor able to make a day the latest, so a day
 * holding only impossible values gives way to the day before it. `null` when
 * nothing qualifies. The day's readings arrive as one row per local hour.
 */
export async function readLatestLocalDayMean(opts: {
  userId: string;
  type: MeasurementType;
  since: Date;
  timeZone: string;
  plausibleOnly: boolean;
  db?: RawDb;
}): Promise<{ value: number; day: string; lastAt: Date } | null> {
  const timeZone = zoneOrUtc(opts.timeZone);
  const range = opts.plausibleOnly
    ? plausibleMetricRange(opts.type)
    : undefined;
  const valueFilter = range
    ? Prisma.sql`AND m."value" >= ${range.min} AND m."value" <= ${range.max}`
    : Prisma.empty;
  const hours = await (opts.db ?? prisma).$queryRaw<
    Array<{ day: string; n: number; sum: number; last_at: Date }>
  >(Prisma.sql`
    WITH src AS (
      SELECT
        ${readingWallSql("m", timeZone)} AS local_at,
        m."measured_at" AS measured_at,
        m."value" AS value
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = ${opts.type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.since}
        ${valueFilter}
    ),
    dayed AS (
      SELECT to_char(local_at, 'YYYY-MM-DD') AS day,
             date_trunc('hour', local_at) AS local_hour,
             measured_at, value
      FROM src
    )
    SELECT
      day,
      COUNT(*)::int                AS n,
      SUM(value)::double precision AS sum,
      MAX(measured_at)             AS last_at
    FROM dayed
    WHERE day = (SELECT MAX(day) FROM dayed)
    GROUP BY day, local_hour
  `);
  if (hours.length === 0) return null;
  const cells = hours.map((h) => ({ n: Number(h.n), sum: Number(h.sum) }));
  const value = usesHourlyMeanDay(opts.type)
    ? combineHourCells(cells)
    : cells.reduce((s, c) => s + c.sum, 0) / cells.reduce((s, c) => s + c.n, 0);
  if (value === null) return null;
  const lastAt = new Date(
    Math.max(...hours.map((h) => new Date(h.last_at).getTime())),
  );
  return { value, day: hours[0].day, lastAt };
}

/** One local hour of readings, as one reading. */
export interface HourCell {
  /** The hour's earliest reading, so the cell keeps its reading's local day. */
  measuredAt: Date;
  /** The hour's mean, or its sum for a summed type. */
  value: number;
  /** Raw readings behind the cell. */
  n: number;
  /** The cell's source and device type; null without `bySource`. */
  source: MeasurementSource | null;
  deviceType: string | null;
}

/**
 * Every reading of `type` since `since`, folded to one cell per local hour
 * (and, with `bySource`, per source and device type, so a source picker can
 * still choose between them). The value is the hour's mean, or its sum when
 * `summed`. A reader that would otherwise hold the raw stream of a window too
 * dense to hold reads this instead: at most 24 cells a day per source,
 * whatever the stream's rate, and nothing is cut off.
 *
 * Under the default pulse day method a day of cells has the same day value as
 * the day of readings, because a day is the mean of its hours' means; a
 * summed type's day total is exact under any method. Ascending by instant.
 */
export async function readHourCells(opts: {
  userId: string;
  type: MeasurementType;
  since: Date;
  timeZone: string;
  summed: boolean;
  bySource: boolean;
  db?: RawDb;
}): Promise<HourCell[]> {
  const rows = await (opts.db ?? prisma).$queryRaw<
    Array<{
      first_at: Date;
      n: number;
      sum: number;
      source?: MeasurementSource;
      device_type?: string | null;
    }>
  >(hourCellsSql(opts));
  return rows.map((r) => {
    const n = Number(r.n);
    const sum = Number(r.sum);
    return {
      measuredAt: r.first_at,
      value: opts.summed ? sum : sum / n,
      n,
      source: r.source ?? null,
      deviceType: r.device_type ?? null,
    };
  });
}

/**
 * The statement {@link readHourCells} sends, exported so the plan check can
 * `EXPLAIN` exactly what the reader runs.
 */
export function hourCellsSql(opts: {
  userId: string;
  type: MeasurementType;
  since: Date;
  timeZone: string;
  bySource: boolean;
}): Prisma.Sql {
  const timeZone = zoneOrUtc(opts.timeZone);
  const sourceColumns = opts.bySource
    ? Prisma.sql`, m."source", m."device_type"`
    : Prisma.empty;
  const groupColumns = opts.bySource
    ? Prisma.sql`, "source", "device_type"`
    : Prisma.empty;
  return Prisma.sql`
    WITH src AS (
      SELECT
        date_trunc('hour', ${readingWallSql("m", timeZone)}) AS local_hour,
        m."measured_at" AS measured_at,
        m."value" AS value
        ${sourceColumns}
      FROM measurements m
      WHERE m."user_id" = ${opts.userId}
        AND m."type" = ${opts.type}::measurement_type
        AND m."deleted_at" IS NULL
        AND m."measured_at" >= ${opts.since}
    )
    SELECT
      MIN(measured_at)             AS first_at,
      COUNT(*)::int                AS n,
      SUM(value)::double precision AS sum
      ${groupColumns}
    FROM src
    GROUP BY local_hour ${groupColumns}
    ORDER BY first_at ASC
  `;
}

/**
 * How many live readings of `type` the window holds, counted no further
 * than `cap + 1`: enough to tell a reader whether the raw rows fit under its
 * bound without counting a dense stream to the end.
 */
export async function countReadingsUpTo(opts: {
  userId: string;
  type: MeasurementType;
  since: Date;
  cap: number;
  db?: RawDb;
}): Promise<number> {
  const rows = await (opts.db ?? prisma).$queryRaw<Array<{ n: number }>>(
    Prisma.sql`
      SELECT COUNT(*)::int AS n FROM (
        SELECT 1
        FROM measurements m
        WHERE m."user_id" = ${opts.userId}
          AND m."type" = ${opts.type}::measurement_type
          AND m."deleted_at" IS NULL
          AND m."measured_at" >= ${opts.since}
        LIMIT ${Math.trunc(opts.cap) + 1}
      ) capped
    `,
  );
  return Number(rows[0]?.n ?? 0);
}
