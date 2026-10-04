/**
 * Shared daily-series reader for the chart surfaces.
 *
 * Serves the `GET /api/measurements?aggregate=daily&source=rollup` contract
 * and the batched series endpoint (`GET /api/measurements/series-batch`) from
 * one path, so both read the same numbers. Windows up to the DAY cap are
 * folded live, one row per local calendar day of the user (#1026); longer
 * windows step up to the WEEK / MONTH / YEAR rollup tier. The returned rows
 * match the wire shape the chart client consumes (`{ type, value,
 * measuredAt, count, minValue?, maxValue? }`), with `measuredAt` the instant
 * of the bucket's local midnight.
 */
import { prisma } from "@/lib/db";
import {
  BUCKET_CAP,
  type AggregateGrain,
} from "@/lib/measurements/range-aggregation";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { HOURLY_MEAN_DAY_TYPES } from "@/lib/measurements/day-statistic";
import { readTieredRollupSeries } from "@/lib/rollups/measurement-read-wmy";
import { buildSourceRankCase } from "@/lib/analytics/source-rank-sql";
import { annotate } from "@/lib/logging/context";
import { isValidTimezone } from "@/lib/tz/format";
import { resolveUserTimezone } from "@/lib/tz/resolver";
import type { MeasurementType } from "@/generated/prisma/client";
import { Prisma } from "@/generated/prisma/client";

/** Wire row the chart-data client consumes — mirrors the route's shape. */
export interface DailySeriesRow {
  type: string;
  value: number;
  measuredAt: string;
  count?: number;
  minValue?: number | null;
  maxValue?: number | null;
}

/**
 * Read one type's daily series for `[from, to]`, one row per local day of
 * the user (or per tier bucket when the window exceeds the DAY cap).
 *
 * `priorityJson` is the user's source-priority ladder (load once per
 * request via `loadUserSourcePriority` and thread it across types so the
 * batched reader doesn't re-query it per type). `cap` defaults to the
 * daily bucket ceiling.
 */
export async function readDailySeries(opts: {
  userId: string;
  type: MeasurementType;
  from: Date;
  to: Date;
  limit?: number;
  priorityJson: unknown;
  /** IANA zone the days are cut in; defaults to the user's own zone. */
  timeZone?: string;
}): Promise<DailySeriesRow[]> {
  const { userId, type, from, to, priorityJson } = opts;
  const cap = Math.min(opts.limit ?? BUCKET_CAP.daily, BUCKET_CAP.daily);

  // v1.19.2 — whole-history step-up for very long ranges. When the
  // requested window holds more days than the DAY bucket cap can carry,
  // the daily path below would `LIMIT`/`slice` to `cap` (365) buckets and
  // silently drop the older history — a multi-year "Alle" range collapsed
  // to roughly the most recent year. Step UP the bucket tier
  // (DAY → WEEK → MONTH → YEAR) so the series spans the whole window
  // inside a sane point budget instead. The chart's own `bucketTimeSeries`
  // downsampler already renders week / month points for long ranges, so a
  // coarser server tier is the resolution it would have collapsed to
  // anyway — minus the truncation. Short / normal ranges (≤ cap days)
  // never enter this branch and stay byte-identical with the prior daily
  // path, so there is no perf regression for the common case.
  const windowDaysFull = Math.ceil(
    (to.getTime() - from.getTime()) / 86_400_000,
  );
  if (windowDaysFull > cap) {
    // A rollup-table throw here (statement_timeout, deadlock, connection reset)
    // must not 500 the whole read — treat it as a coverage miss and fall
    // through to the daily path (which itself falls back to live SQL).
    let tiered: Awaited<ReturnType<typeof readTieredRollupSeries>> = null;
    try {
      tiered = await readTieredRollupSeries({
        userId,
        type,
        // v1.26.0 SEAM-N2 — pass the resolved `[from, to]` bounds so the tier
        // reads the REQUESTED window (which may be entirely historic), not a
        // trailing "to now" slice. `windowDaysFull` still gates entry above and
        // drives the tier width inside the reader.
        from,
        to,
        priorityJson,
      });
    } catch (err) {
      annotate({
        meta: {
          tiered_series_read_threw: true,
          tiered_series_read_error:
            err instanceof Error ? err.message : String(err),
          type,
        },
      });
    }
    if (tiered && tiered.rows.length > 0) {
      return tiered.rows;
    }
    // Coverage miss at every tier — fall through to the daily path, which
    // folds the live table. The daily fallback still caps at `cap`; the
    // annotate below records that the long-range read could not step up so
    // a truncated daily slice is an explicit, logged outcome rather than a
    // silent one.
    annotate({
      meta: {
        tiered_series_coverage_miss: true,
        window_days: windowDaysFull,
        type,
      },
    });
  }

  // The daily series is cut at the user's own midnight (#1026). The DAY
  // rollup tier cannot serve it: its buckets are UTC days, so east of UTC a
  // sample shortly after local midnight counted on the previous day, and
  // every bucket's UTC-midnight start read as the previous local day west of
  // UTC. The 7-day chart buckets raw rows by the local day, so switching
  // ranges moved daily totals between neighbouring days. The live fold is
  // one pass per window (about 0.3 s for a year of per-minute samples,
  // measured against Postgres 16) and returns at most one row per day.
  const timeZone = opts.timeZone ?? (await resolveUserTimezone(userId));
  const rows = await readLiveBuckets({
    userId,
    type,
    from,
    to,
    cap,
    priorityJson,
    grain: "daily",
    timeZone,
  });
  annotate({
    action: { name: "measurement.list" },
    meta: { total: rows.length, type, aggregate: "daily", source: "live" },
  });
  return rows;
}

/** SQL `date_trunc` unit per aggregate grain (a closed map, never input). */
const TRUNC_UNIT: Record<Exclude<AggregateGrain, "raw">, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

/**
 * Live aggregate of the measurements table into buckets cut at the user's
 * own calendar boundaries.
 *
 * Each sample is converted to wall-clock time in `timeZone` before
 * truncation, so a bucket is the user's local day (or week / month), and the
 * returned `measuredAt` is the instant of that local midnight. The chart
 * labels a row by formatting `measuredAt` in the same zone, which lands on
 * the bucket's own day for every offset, including half-hour and negative
 * ones, and across a DST change.
 *
 * Per local day the overlapping sources collapse to the ladder-canonical one
 * (the same pick the rollup reader makes), and the days then fold into the
 * bucket: cumulative types SUM and every other type averages over every
 * reading of the canonical days. The result set is at most `cap` rows,
 * however dense the underlying stream: the fold runs in Postgres.
 *
 * `type` narrows to one type; `null` folds every type in the window (the
 * multi-type `GET /api/measurements?aggregate=` form).
 */
export async function readLiveBuckets(opts: {
  userId: string;
  type: MeasurementType | null;
  from: Date;
  to: Date;
  cap: number;
  priorityJson: unknown;
  grain: Exclude<AggregateGrain, "raw">;
  timeZone: string;
}): Promise<DailySeriesRow[]> {
  const { userId, type, from, to, cap, priorityJson, grain } = opts;
  // A zone Postgres does not know would 500 the read; the resolver already
  // validates stored zones, this guards a caller passing a raw string.
  const timeZone = isValidTimezone(opts.timeZone) ? opts.timeZone : "UTC";
  // `date_trunc` needs its unit as a literal; the unit comes from the closed
  // `TRUNC_UNIT` map keyed by the Zod-constrained grain, never from input.
  const unit = Prisma.raw(`'${TRUNC_UNIT[grain]}'`);
  // Cumulative types SUM per bucket, every other type averages. The type list
  // is the closed code constant, spliced as literals; `m."type"` is a GROUP BY
  // column, so choosing the aggregate per group is legal.
  const cumulativeList = [...CUMULATIVE_HK_TYPES]
    .map((t) => `'${t}'`)
    .join(",");
  const isCumulative = Prisma.raw(`c."type"::text IN (${cumulativeList})`);
  // Types whose day is the mean of its per-local-hour means (see
  // `day-statistic.ts`). Closed code constants, spliced as enum literals.
  const hourlyMeanList = Prisma.raw(
    [...HOURLY_MEAN_DAY_TYPES].map((t) => `'${t}'::measurement_type`).join(","),
  );
  const rankRaw = Prisma.raw(
    buildSourceRankCase(priorityJson, 'p."type"', 'p."source"'),
  );
  const typeFilter = type
    ? Prisma.sql`AND m."type" = ${type}::measurement_type`
    : Prisma.empty;
  // measured_at is a UTC wall-clock timestamp: pin it to UTC, re-read it in
  // the user's zone and truncate there.
  //
  // The canonical source is chosen per local DAY, whatever the grain: each
  // source is folded per day in one hashed pass (a few rows per day, however
  // dense the stream), each day keeps its ladder-canonical source, and only
  // then are the days folded into the week or month. Picking the source per
  // week or month instead dropped every day the losing source carried, so a
  // month of manual readings plus one synced reading reported one day.
  // Folding first and picking second is the same result as collapsing the
  // raw rows first; it just never sorts more than one row per source per day.
  const buckets = await prisma.$queryRaw<
    Array<{
      type: string;
      bucket_start: Date;
      avg: number;
      cnt: number;
      min_value: number | null;
      max_value: number | null;
    }>
  >`
    WITH per_source AS (
      SELECT
        m."type",
        m."source",
        date_trunc('day', (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}) AS day,
        SUM(m."value")::double precision AS total,
        COUNT(*)::int AS cnt,
        MIN(m."value") AS min_value,
        MAX(m."value") AS max_value
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${from}
        AND m."measured_at" <= ${to}
        AND m."deleted_at" IS NULL
        ${typeFilter}
      GROUP BY m."type", m."source", 3
    ),
    -- A day of a type with an activity-dependent sampling rate is the mean of
    -- its local hours' means, each hour once, not the mean of its readings: a
    -- workout hour holds hundreds of times as many readings as a resting one.
    -- Empty for every other type.
    hour_mean AS (
      SELECT h."type", h."source", h.day,
             AVG(h.hour_mean)::double precision AS day_mean
      FROM (
        SELECT
          m."type",
          m."source",
          date_trunc('day', (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}) AS day,
          date_trunc('hour', (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${timeZone}) AS hr,
          AVG(m."value") AS hour_mean
        FROM measurements m
        WHERE m."user_id" = ${userId}
          AND m."measured_at" >= ${from}
          AND m."measured_at" <= ${to}
          AND m."deleted_at" IS NULL
          AND m."type" IN (${hourlyMeanList})
          ${typeFilter}
        GROUP BY m."type", m."source", 3, 4
      ) h
      GROUP BY h."type", h."source", h.day
    ),
    canon AS (
      SELECT DISTINCT ON (p."type", p.day)
        p."type", p.day, p.total, p.cnt, p.min_value, p.max_value, hm.day_mean
      FROM per_source p
      LEFT JOIN hour_mean hm
        ON hm."type" = p."type" AND hm."source" = p."source" AND hm.day = p.day
      ORDER BY p."type", p.day, (${rankRaw}), p."source"::text
    ),
    folded AS (
      SELECT
        c."type",
        date_trunc(${unit}, c.day) AS d,
        (CASE
           WHEN ${isCumulative} THEN SUM(c.total)
           -- Hourly-mean types: every day once, so a window of days does not
           -- hand a workout day its thousands of readings as weight.
           WHEN COUNT(c.day_mean) = COUNT(*) THEN AVG(c.day_mean)
           ELSE SUM(c.total) / SUM(c.cnt)
         END)::double precision AS avg,
        SUM(c.cnt)::int AS cnt,
        MIN(c.min_value) AS min_value,
        MAX(c.max_value) AS max_value
      FROM canon c
      GROUP BY c."type", 2
    )
    SELECT
      f."type"::text AS type,
      f.d AT TIME ZONE ${timeZone} AS bucket_start,
      f.avg,
      f.cnt,
      f.min_value,
      f.max_value
    FROM folded f
    ORDER BY f.d ASC
    LIMIT ${cap}
  `;
  return buckets.map((b) => {
    const isSum = CUMULATIVE_HK_TYPES.has(b.type as MeasurementType);
    return {
      type: b.type,
      value: Number(b.avg),
      measuredAt: b.bucket_start.toISOString(),
      count: Number(b.cnt),
      // A SUM has no meaningful intra-day spread; the chart draws the band
      // for averaged types only.
      minValue: isSum || b.min_value === null ? undefined : Number(b.min_value),
      maxValue: isSum || b.max_value === null ? undefined : Number(b.max_value),
    };
  });
}
