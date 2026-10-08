/**
 * v1.18.7 — progressive / tiered data-context builder for the AI surfaces.
 *
 * The principle (research/coach-prompt-tiering.md §3): feed the model the
 * RIGHT RESOLUTION of history — recent dense, older progressively coarser —
 * plus a preserved peak/anomaly envelope so a sharp reading from months ago
 * survives even when its month is a single coarse bucket. Downsampling
 * silently eats peaks unless you keep the min/max envelope; our rollup
 * buckets already carry `minValue` / `maxValue`, so the envelope is free.
 *
 * Five progressive bands per metric:
 *
 *   | Band      | Source                | Resolution           |
 *   |-----------|-----------------------|----------------------|
 *   | 0–14d     | raw `Measurement`     | daily points         |
 *   | 14–30d    | DAY rollup            | daily mean + min/max |
 *   | 30–90d    | WEEK rollup           | weekly mean + slope  |
 *   | 90d–1y    | MONTH rollup          | monthly mean + min/max |
 *   | >1y       | YEAR rollup           | yearly mean + min/max |
 *
 * plus a per-metric `anomalies` list (≤5) ranked by `|deltaSd|`.
 *
 * Coverage is "replace, fall back on miss": `probeRollupCoverage` /
 * `ensureUserRollupsFresh` run first; on a per-type coverage miss the band
 * falls back to live SQL exactly as the existing readers do (the readers
 * themselves never throw — an empty result simply yields an empty band).
 *
 * ~600 tokens / metric at ~4 chars/token: ≈14 raw + ≈16 DAY + ≈9 WEEK +
 * ≈12 MONTH + ≤5 YEAR + ≤5 anomalies.
 */
import { prisma } from "@/lib/db";
import type {
  MeasurementType,
  RollupGranularity,
} from "@/generated/prisma/client";
import { isNearUtc, isValidTimezone } from "@/lib/tz/format";
import {
  ensureUserRollupsFresh,
  readRollupBuckets,
} from "./measurement-rollups";
import { probeRollupCoverage } from "./measurement-coverage";
import { readDayAggregates } from "@/lib/measurements/day-aggregates";
import { dayWeightedRowsSql, windowMeanSql } from "@/lib/measurements/day-mean";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import { Prisma } from "@/generated/prisma/client";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Band cut points in days-ago. */
const TIERED_BANDS = {
  rawDays: 14,
  dayUntil: 30,
  weekUntil: 90,
  monthUntil: 365,
  yearUntil: 5 * 365,
} as const;

/** One raw daily point in the 0–14d band. */
export interface TieredRawPoint {
  /**
   * `YYYY-MM-DD` of the day the point summarises, keyed in the user's
   * timezone (`options.tz`). A 23:30-local reading on a DST-changeover
   * night lands on the correct local calendar day, not the UTC day.
   */
  date: string;
  /** Mean of that day's readings (a single point for most metrics). */
  value: number;
  count: number;
}

/** One coarser bucket carrying the min/max envelope that keeps peaks alive. */
export interface TieredBucket {
  /** ISO timestamp anchored to the bucket start (date_trunc semantics). */
  bucketStart: string;
  mean: number;
  min: number;
  max: number;
  count: number;
  /** Units-per-day trend slope when the rollup carried one. */
  slope?: number | null;
}

/** A peak/trough preserved from the envelope so a coarse band cannot hide it. */
export interface TieredAnomaly {
  band: "raw" | "day" | "week" | "month" | "year";
  /** ISO date of the extreme bucket. */
  date: string;
  kind: "peak" | "trough";
  value: number;
  /** Standard deviations from the window mean, signed. */
  deltaSd: number;
}

export interface TieredSeries {
  type: MeasurementType;
  /** 0–14d raw daily points. */
  recentDaily: TieredRawPoint[];
  /** 14–30d DAY-rollup buckets. */
  dayBand: TieredBucket[];
  /** 30–90d WEEK-rollup buckets. */
  weekBand: TieredBucket[];
  /** 90d–1y MONTH-rollup buckets. */
  monthBand: TieredBucket[];
  /** >1y YEAR-rollup buckets. */
  yearBand: TieredBucket[];
  /** Preserved peaks/troughs, ≤5, ranked by |deltaSd|. */
  anomalies: TieredAnomaly[];
  /** Window-level stats used for anomaly scoring + a quick baseline read. */
  windowStats: {
    mean: number | null;
    sd: number | null;
    n: number;
  };
}

export interface BuildTieredSeriesOptions {
  /**
   * The user's IANA timezone. REQUIRED — the raw 0–14d band keys its
   * daily fold on the user's local calendar day so a
   * late-evening reading lands on the right day across DST boundaries
   * and for non-UTC users. The coarser DAY/WEEK/MONTH/YEAR bands read
   * straight from the rollup table, whose `bucketStart` is UTC-anchored
   * by system-wide design (the live aggregator's `date_trunc` and the
   * rollup writer agree on UTC day boundaries — see
   * `start-of-utc-day.ts`); re-keying those into `tz` here would diverge
   * from the parity-locked read-swap fallback, so they are intentionally
   * left UTC. Callers without a resolved zone should pass
   * `DEFAULT_TIMEZONE`.
   */
  tz: string;
  /** Clock override for tests; defaults to `Date.now()`. */
  now?: number;
  /**
   * Skip the `ensureUserRollupsFresh` recompute (the caller already ran it
   * for the batch, or is on a hot path). Coverage is still probed.
   */
  skipEnsureFresh?: boolean;
  /**
   * Cap on anomalies per metric. Defaults to 5. The list is ranked by
   * `|deltaSd|` before the cap.
   */
  maxAnomalies?: number;
  /**
   * v1.18.7 — skip the raw 0–14d `Measurement` read and return an empty
   * `recentDaily`. For callers (the Coach snapshot) that already hold the
   * recent daily rows from their own query and only need the coarser
   * MONTH/YEAR bands + anomaly envelope; avoids a duplicate raw round-trip.
   */
  skipRecentDaily?: boolean;
  /**
   * v1.18.7 — skip the raw 0–14d read AND the DAY (14–30d) / WEEK (30–90d)
   * band reads, returning only the MONTH / YEAR bands plus the anomaly
   * envelope. For the Coach's `buildCoarseTimelineTail`, which consumes only
   * month/year + anomalies; the skipped near-term bands would otherwise be
   * read and discarded. The anomaly window-stats then span the coarse bands
   * only, which is the right baseline for the deep-history tail. Implies
   * `skipRecentDaily`.
   */
  coarseOnly?: boolean;
  /**
   * The user's source-priority blob, when the caller already holds it; the
   * bands otherwise load it themselves.
   */
  userPriorityJson?: unknown;
}

interface RollupBucket {
  bucketStart: Date;
  count: number;
  mean: number;
  minValue: number;
  maxValue: number;
  sd: number | null;
  slope: number | null;
  r2: number | null;
}

function toBucket(r: RollupBucket): TieredBucket {
  return {
    bucketStart: r.bucketStart.toISOString(),
    mean: round(r.mean),
    min: round(r.minValue),
    max: round(r.maxValue),
    count: r.count,
    slope: r.slope,
  };
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/** Window mean + population SD over every bucket's mean. */
function windowStats(buckets: RollupBucket[]): {
  mean: number | null;
  sd: number | null;
  n: number;
} {
  const usable = buckets.filter((b) => b.count >= 1);
  const n = usable.reduce((s, b) => s + b.count, 0);
  if (usable.length === 0) return { mean: null, sd: null, n: 0 };
  const means = usable.map((b) => b.mean);
  const mean = means.reduce((s, m) => s + m, 0) / means.length;
  if (means.length < 2) return { mean: round(mean), sd: null, n };
  const variance =
    means.reduce((s, m) => s + (m - mean) ** 2, 0) / means.length;
  return { mean: round(mean), sd: round(Math.sqrt(variance)), n };
}

/**
 * Scan every bucket's min/max envelope and emit the buckets whose extreme
 * exceeds `mean ± 2·sd`. The min/max-envelope technique guarantees a spike
 * from months ago survives a coarse MONTH/YEAR bucket. Requires `count ≥ 3`
 * and a usable spread to suppress sparse-metric false positives.
 */
function extractAnomalies(
  bands: Array<{ band: TieredAnomaly["band"]; buckets: RollupBucket[] }>,
  stats: { mean: number | null; sd: number | null },
  cap: number,
): TieredAnomaly[] {
  if (stats.mean === null || stats.sd === null || stats.sd <= 0) return [];
  const { mean, sd } = stats;
  const out: TieredAnomaly[] = [];
  for (const { band, buckets } of bands) {
    for (const b of buckets) {
      if (b.count < 3) continue;
      const highSd = (b.maxValue - mean) / sd;
      const lowSd = (b.minValue - mean) / sd;
      if (highSd >= 2) {
        out.push({
          band,
          date: b.bucketStart.toISOString(),
          kind: "peak",
          value: round(b.maxValue),
          deltaSd: round(highSd, 1),
        });
      }
      if (lowSd <= -2) {
        out.push({
          band,
          date: b.bucketStart.toISOString(),
          kind: "trough",
          value: round(b.minValue),
          deltaSd: round(lowSd, 1),
        });
      }
    }
  }
  return out
    .sort((a, b) => Math.abs(b.deltaSd) - Math.abs(a.deltaSd))
    .slice(0, cap);
}

/**
 * Read the 0–14d daily points for one type, folding same-day rows.
 * Days are keyed on the user's local calendar in `tz`, so a
 * 23:30-local reading folds onto its local day rather than the UTC day —
 * correct across DST transitions and for non-UTC users.
 */
async function readRecentDaily(
  userId: string,
  type: MeasurementType,
  now: number,
  tz: string,
): Promise<TieredRawPoint[]> {
  const since = new Date(now - TIERED_BANDS.rawDays * DAY_MS);
  // Folded per local day in SQL: one row per day however densely the type
  // is sampled, never the raw stream (#1023).
  const days = await readDayAggregates({
    userId,
    type,
    since,
    timeZone: tz,
  });
  // A pulse day is the mean of its local hours' means (`dayMean`, see
  // `day-mean.ts`); every other type's day is the mean of its readings.
  return days.map((d) => ({
    date: d.day,
    value: round(d.dayMean ?? d.sum / d.n),
    count: d.n,
  }));
}

/**
 * The `date_trunc` unit per band — a CLOSED map over the granularity enum,
 * which is what makes splicing `unit` into the raw SQL below a
 * whitelist-splice, not an injection surface.
 */
const BAND_TRUNC_UNIT: Record<
  RollupGranularity,
  "day" | "week" | "month" | "year"
> = {
  DAY: "day",
  WEEK: "week",
  MONTH: "month",
  YEAR: "year",
};

/**
 * v1.37.19 (A6-11) — LIVE aggregate for one band, the fallback the module
 * doc has promised since v1.18.7 but `readBand` never had: a coverage
 * miss (or a >5y account whose YEAR partition was never folded) used to
 * hand the AI an empty MONTH/YEAR band as if the history did not exist.
 *
 * One grouped aggregate over raw rows, shaped like a rollup bucket. Two
 * documented approximations against the folded tier: no source-priority
 * collapse (a dual-source day counts both readings into the mean), and
 * no slope/r² (left null, exactly like a pre-0190 bucket). Both are
 * acceptable for prompt context — the alternative was silence.
 *
 * `tzKey` (the far-from-UTC day-grain guard) buckets on the user's LOCAL
 * calendar via `AT TIME ZONE`; parameter-bound, never spliced.
 *
 * v1.42 — `measured_at` is a `timestamp` without time zone holding UTC wall
 * time, so the local wall clock is `(measured_at AT TIME ZONE 'UTC') AT TIME
 * ZONE tz`: the first step says what the value is, the second converts it.
 * The single `measured_at AT TIME ZONE tz` this used read the UTC value AS IF
 * it were local time and converted the wrong way, so a far-from-UTC reader's
 * readings were shifted by twice their offset (sixteen hours in Los Angeles):
 * an evening reading landed on the next day's bucket. Every other local-day
 * reader
 * (`day-aggregates.ts`, `day-mean.ts`) already used the two-step form.
 */
async function readBandLive(
  userId: string,
  type: MeasurementType,
  granularity: RollupGranularity,
  from: Date,
  to: Date,
  tzKey?: string,
): Promise<RollupBucket[]> {
  const unit = BAND_TRUNC_UNIT[granularity];
  if (usesHourlyMeanDay(type)) {
    return readHourlyMeanBandLive(userId, type, unit, from, to, tzKey);
  }
  try {
    const rows = tzKey
      ? await prisma.$queryRaw<
          Array<{
            bucket_start: Date;
            count: number;
            mean: number;
            min_value: number;
            max_value: number;
            sd: number | null;
          }>
        >`
          SELECT
            date_trunc(${unit}, (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tzKey}) AS bucket_start,
            COUNT(*)::int                        AS count,
            AVG(m."value")::double precision     AS mean,
            MIN(m."value")::double precision     AS min_value,
            MAX(m."value")::double precision     AS max_value,
            STDDEV_POP(m."value")::double precision AS sd
          FROM measurements m
          WHERE m."user_id" = ${userId}
            AND m."type" = ${type}::"measurement_type"
            AND m."deleted_at" IS NULL
            AND m."measured_at" >= ${from}
            AND m."measured_at" < ${to}
          GROUP BY 1
          ORDER BY 1
        `
      : await prisma.$queryRaw<
          Array<{
            bucket_start: Date;
            count: number;
            mean: number;
            min_value: number;
            max_value: number;
            sd: number | null;
          }>
        >`
          SELECT
            date_trunc(${unit}, m."measured_at") AS bucket_start,
            COUNT(*)::int                        AS count,
            AVG(m."value")::double precision     AS mean,
            MIN(m."value")::double precision     AS min_value,
            MAX(m."value")::double precision     AS max_value,
            STDDEV_POP(m."value")::double precision AS sd
          FROM measurements m
          WHERE m."user_id" = ${userId}
            AND m."type" = ${type}::"measurement_type"
            AND m."deleted_at" IS NULL
            AND m."measured_at" >= ${from}
            AND m."measured_at" < ${to}
          GROUP BY 1
          ORDER BY 1
        `;
    return rows.map((r) => ({
      bucketStart: new Date(r.bucket_start),
      count: Number(r.count),
      mean: Number(r.mean),
      minValue: Number(r.min_value),
      maxValue: Number(r.max_value),
      sd: r.sd === null ? null : Number(r.sd),
      slope: null,
      r2: null,
    }));
  } catch {
    // The band builder never throws — an unreadable band degrades to
    // empty exactly like the rollup path always has.
    return [];
  }
}

/**
 * `readBandLive` for a type whose day is the mean of its hours' means (pulse,
 * `day-mean.ts`): a bucket's mean is the mean of its days, each the mean of
 * its hours, so a workout's dense samples do not outweigh the rest of the
 * bucket. Count, min, max and the spread stay over every reading. The bucket
 * boundary is the one the plain branch uses; hours and days are cut in the
 * user's zone when `tzKey` is set, in the session's (UTC) frame otherwise.
 */
async function readHourlyMeanBandLive(
  userId: string,
  type: MeasurementType,
  unit: "day" | "week" | "month" | "year",
  from: Date,
  to: Date,
  tzKey?: string,
): Promise<RollupBucket[]> {
  const mean = Prisma.raw(
    windowMeanSql({
      typeColumn: 'm."type"',
      value: 'm."value"',
      weight: "m.day_weight",
    }),
  );
  const bucket = tzKey
    ? Prisma.sql`date_trunc(${unit}, (m."measured_at" AT TIME ZONE 'UTC') AT TIME ZONE ${tzKey})`
    : Prisma.sql`date_trunc(${unit}, m."measured_at")`;
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        bucket_start: Date;
        count: number;
        mean: number;
        min_value: number;
        max_value: number;
        sd: number | null;
      }>
    >`
      WITH src AS (
        SELECT * FROM measurements m
        WHERE m."user_id" = ${userId}
          AND m."type" = ${type}::"measurement_type"
          AND m."deleted_at" IS NULL
          AND m."measured_at" >= ${from}
          AND m."measured_at" < ${to}
      )
      SELECT
        ${bucket}                                AS bucket_start,
        COUNT(*)::int                            AS count,
        ${mean}::double precision                AS mean,
        MIN(m."value")::double precision         AS min_value,
        MAX(m."value")::double precision         AS max_value,
        STDDEV_POP(m."value")::double precision  AS sd
      FROM ${dayWeightedRowsSql("src", tzKey ?? null)} m
      GROUP BY 1, m."type"
      ORDER BY 1
    `;
    return rows.map((r) => ({
      bucketStart: new Date(r.bucket_start),
      count: Number(r.count),
      mean: Number(r.mean),
      minValue: Number(r.min_value),
      maxValue: Number(r.max_value),
      sd: r.sd === null ? null : Number(r.sd),
      slope: null,
      r2: null,
    }));
  } catch {
    // Degrades to empty, like the plain branch.
    return [];
  }
}

async function readBand(
  userId: string,
  type: MeasurementType,
  granularity: RollupGranularity,
  fromDaysAgo: number,
  toDaysAgo: number,
  now: number,
  tz?: string,
  userPriorityJson?: unknown,
): Promise<RollupBucket[]> {
  const from = new Date(now - fromDaysAgo * DAY_MS);
  const to = new Date(now - toDaysAgo * DAY_MS);
  // v1.37.19 (A6-11) — the far-from-UTC guard the correlation readers
  // carry (v1.4.38 W-A class): DAY rollup buckets group by UTC day, which
  // diverges from the user's local calendar for most of the day outside
  // the ±3 h near-UTC band. For those users the day-grain band goes
  // straight to the live path keyed in their zone. The coarser bands stay
  // on the UTC-anchored rollups — a few hours of offset moves bucket
  // MEMBERSHIP at week/month/year grain by at most one edge reading.
  if (
    granularity === "DAY" &&
    tz &&
    isValidTimezone(tz) &&
    !isNearUtc(tz, new Date(now))
  ) {
    return readBandLive(userId, type, granularity, from, to, tz);
  }
  // `readRollupBuckets` never throws — an empty / missing partition yields
  // an empty array. v1.37.19 — an empty band now falls back to the live
  // aggregate instead of silently handing the AI nothing (the module doc
  // promised replace-with-fallback from day one; only the "replace" half
  // existed).
  const buckets = await readRollupBuckets(
    userId,
    type,
    granularity,
    from,
    to,
    userPriorityJson,
  );
  if (buckets.length > 0) return buckets;
  return readBandLive(userId, type, granularity, from, to);
}

/**
 * Build the 5-band progressive context + anomaly envelope for one metric.
 *
 * Reuses `probeRollupCoverage` / `ensureUserRollupsFresh` (replace, fall
 * back on miss). The coarse bands read straight from the rollup table; the
 * 0–14d band reads raw rows so the most recent days are exact.
 */
export async function buildTieredSeries(
  userId: string,
  type: MeasurementType,
  options: BuildTieredSeriesOptions,
): Promise<TieredSeries> {
  const now = options.now ?? Date.now();
  const cap = options.maxAnomalies ?? 5;

  if (!options.skipEnsureFresh) {
    // Recompute a stale trailing-90-day DAY window before reading; the helper
    // is in-flight-deduped and swallows its own errors.
    await ensureUserRollupsFresh(userId);
  }

  const coarseOnly = options.coarseOnly ?? false;
  const emptyBand = Promise.resolve<RollupBucket[]>([]);
  const [recentDaily, dayBand, weekBand, monthBand, yearBand] =
    await Promise.all([
      options.skipRecentDaily || coarseOnly
        ? Promise.resolve<TieredRawPoint[]>([])
        : readRecentDaily(userId, type, now, options.tz),
      coarseOnly
        ? emptyBand
        : readBand(
            userId,
            type,
            "DAY",
            TIERED_BANDS.dayUntil,
            TIERED_BANDS.rawDays,
            now,
            options.tz,
            options.userPriorityJson,
          ),
      coarseOnly
        ? emptyBand
        : readBand(
            userId,
            type,
            "WEEK",
            TIERED_BANDS.weekUntil,
            TIERED_BANDS.dayUntil,
            now,
            undefined,
            options.userPriorityJson,
          ),
      readBand(
        userId,
        type,
        "MONTH",
        TIERED_BANDS.monthUntil,
        TIERED_BANDS.weekUntil,
        now,
        undefined,
        options.userPriorityJson,
      ),
      readBand(
        userId,
        type,
        "YEAR",
        TIERED_BANDS.yearUntil,
        TIERED_BANDS.monthUntil,
        now,
        undefined,
        options.userPriorityJson,
      ),
    ]);

  // Window stats span every coarse bucket so the anomaly threshold reflects
  // the user's whole logged history, not just one band.
  const allBuckets = [...dayBand, ...weekBand, ...monthBand, ...yearBand];
  const stats = windowStats(allBuckets);

  const anomalies = extractAnomalies(
    [
      { band: "day", buckets: dayBand },
      { band: "week", buckets: weekBand },
      { band: "month", buckets: monthBand },
      { band: "year", buckets: yearBand },
    ],
    stats,
    cap,
  );

  return {
    type,
    recentDaily,
    dayBand: dayBand.map(toBucket),
    weekBand: weekBand.map(toBucket),
    monthBand: monthBand.map(toBucket),
    yearBand: yearBand.map(toBucket),
    anomalies,
    windowStats: stats,
  };
}

/**
 * Convenience batch — build tiered series for several metrics, probing
 * coverage once and recomputing freshness once for the whole set. Types with
 * no rollup coverage AND no raw rows simply come back with empty bands.
 */
export async function buildTieredSeriesForTypes(
  userId: string,
  types: MeasurementType[],
  options: BuildTieredSeriesOptions,
): Promise<TieredSeries[]> {
  const now = options.now ?? Date.now();
  if (!options.skipEnsureFresh) {
    await ensureUserRollupsFresh(userId);
  }
  // Probe coverage once so the caller can reason about which bands are
  // rollup-backed vs raw-only; the per-type builder still falls back on miss.
  const coverage = await probeRollupCoverage(userId);
  const present = types.filter((t) => coverage.has(t));
  return Promise.all(
    present.map((type) =>
      buildTieredSeries(userId, type, {
        ...options,
        now,
        skipEnsureFresh: true,
      }),
    ),
  );
}
