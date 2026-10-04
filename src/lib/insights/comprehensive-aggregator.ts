/**
 * v1.4.36 — SQL-driven aggregator for `/api/insights/comprehensive`,
 * rollup-first read with live-SQL fallback on cold mounts.
 *
 * Background
 * ----------
 * The route previously pulled every measurement of every type from the
 * trailing 90 days into JS, then ran `summarize()` per type plus a
 * pile of in-JS correlation pairings. Post Apple-Health import the
 * unbounded `findMany` on line 49 of the old route routinely returned
 * 100 000+ rows and dominated request time (29 s in the v1.4.34 prod
 * HAR capture, with sibling endpoints cascading into 503s on pool
 * starvation).
 *
 * The shape mirrors the `summaries-slice` aggregator
 * (`src/lib/analytics/summaries-slice.ts`) the v1.4.33 C1 dashboard
 * tile strip already proved out: a single `$queryRaw` per surface,
 * grouped by `type`, with Postgres-side `AVG` / `MIN` / `MAX` /
 * `REGR_SLOPE` / `REGR_R2` against the index path
 * `measurements (user_id, type, measured_at)`. Difference vs. the
 * slim slice: the comprehensive endpoint also needs `anomalyCount`,
 * `avg30LastMonth`, `avg30LastYear`, and the 90-day window cap.
 *
 * Read-swap (v1.4.35 → v1.4.36)
 * -----------------------------
 * v1.4.35 landed a partial read-swap that ran both the live aggregate
 * AND the rollup read in parallel, then preferred the rollup-derived
 * values when the count matched. That left the regression intact: the
 * heavy `$queryRaw` over `measurements` still ran on every request,
 * still scanning the 311k-row table on a power-user account.
 *
 * v1.4.36 promotes the rollup table to the canonical source on the
 * happy path:
 *
 *   - On entry we call `ensureUserRollupsFresh` (warm-on-read populator
 *     for the trailing 90-day DAY window) and then probe the rollup
 *     table with a single COUNT.
 *
 *   - When the DAY rollup table has rows for this user the **heavy**
 *     `$queryRaw` over `measurements` is skipped. `count / min / max /
 *     mean` per type compose from the persisted DAY buckets via
 *     `aggregateBuckets`; `dailyByType` reads the same buckets keyed
 *     on `(type, bucketStart)`.
 *
 *   - A **narrow** `$queryRaw` still fires for the non-composable
 *     fields: `stddev`, `anomalyCount`, `avg7 / avg30 / avg30LastMonth`,
 *     and the `slope7 / slope30` tuples. These don't compose
 *     linearly across DAY buckets so live SQL stays canonical, but the
 *     query no longer carries the redundant `COUNT(*)` / `MIN` / `MAX`
 *     / `AVG` columns that duplicated the bucket-derived values.
 *
 *   - `latest / latestMeasuredAt` keep their dedicated `DISTINCT ON
 *     (type)` pass; the bucket stores the day's mean rather than the
 *     last reading.
 *
 *   - Fallback path — when the COUNT probe returns zero rows
 *     (post-restart cold mount or a brand-new account whose boot-time
 *     backfill is mid-flight) we run the legacy heavy aggregate so the
 *     response shape is correct on the very first request.
 *
 * Scope notes
 * -----------
 *   - The 90-day window is preserved (the legacy `findMany` clamped on
 *     `measuredAt >= ninetyDaysAgo`). `min` / `max` / `mean` therefore
 *     describe the 90-day window, NOT the user's all-time range —
 *     identical to the old behaviour.
 *
 *   - For correlations:
 *       - **weight × BP**: directive accepts a daily-key swap from the
 *         old `pairByTimestamp` (24h default tolerance). Postgres
 *         joins on `date_trunc('day', measured_at)`.
 *       - **mood × {BP, weight, pulse}**: same daily-key shape the
 *         legacy code already used (the `buildMoodMetricPairs` helper
 *         bucketed by `toISOString().slice(0,10)`).
 *
 *   - BP target adherence (`bpPctInTarget`) keeps the 5-minute
 *     tolerance contract — that pairing is sys/dia within the *same*
 *     reading session. The aggregator pulls sys+dia raw rows (90d,
 *     bounded — typically <2k rows even for power users) so
 *     `pairByTimestamp` semantics survive byte-identical.
 *
 *   - `bpMedicationCorrelation` is computed in the route itself; the
 *     aggregator surfaces daily BP_SYS means via the same daily-join
 *     query so the medication block can pair compliance × systolic
 *     without a second findMany.
 *
 *   - Mood data still loads via `prisma.moodEntry.findMany` — that
 *     table is small (a row per user-recorded entry, bounded) and the
 *     `moodSummary` field calls `summarize()` against raw scores. The
 *     legacy route's `moodSummary` was built off raw rows so we keep
 *     the raw fetch.
 *
 * Output shape
 * ------------
 * The aggregator returns the bundle of pre-computed values the route
 * stitches into the final response. Helper functions inside the
 * aggregator collapse `$queryRaw` rows into the same `DataSummary`
 * shape `summarize()` would return.
 */
import { prisma } from "@/lib/db";
import type { DataSummary } from "@/lib/analytics/trends";
import { annotate } from "@/lib/logging/context";
import type {
  MeasurementSource,
  MeasurementType,
} from "@/generated/prisma/client";
import { ensureUserRollupsFresh } from "@/lib/rollups/measurement-rollups";
import {
  aggregateBuckets,
  collapseRollupRowsBySource,
  composeWindowedRegression,
  hasPendingAccumulatorBackfill,
  loadUserSourcePriority,
  type AccumulatorBucketRow,
} from "@/lib/rollups/measurement-read";
import { windowWeighting } from "@/lib/measurements/day-statistic";
import {
  SESSION_DAY_FRAME,
  dayWeightedRows,
  windowMeanSql,
} from "@/lib/measurements/day-mean";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import {
  buildSourceRankCase,
  canonicalMeasurementsCte,
  canonicalMeasurementsFrom,
} from "@/lib/analytics/source-rank-sql";
import {
  isFullyCovered,
  probeRollupCoverage,
} from "@/lib/rollups/measurement-coverage";
import { dateOnlyKey } from "@/lib/tz/date-only";

/**
 * Window means over canonical readings carrying a `day_weight` (see
 * `day-mean.ts`): the mean of the day values for an hourly-mean type (pulse),
 * the unchanged `AVG(value)` otherwise. Days are UTC days, the frame the
 * canonical-source pick buckets by.
 */
function windowedMean(filter: string): string {
  return windowMeanSql({
    typeColumn: 'm."type"',
    value: 'm."value"',
    weight: "m.day_weight",
    filter,
  });
}
const AVG7_SQL = windowedMean(`m."measured_at" >= NOW() - INTERVAL '7 days'`);
const AVG30_SQL = windowedMean(`m."measured_at" >= NOW() - INTERVAL '30 days'`);
const AVG30_LAST_MONTH_SQL = windowedMean(
  `m."measured_at" >= NOW() - INTERVAL '60 days' AND m."measured_at" <  NOW() - INTERVAL '30 days'`,
);

/**
 * Heavy aggregate row — count/min/max/mean alongside the non-composable
 * windowed columns. Used on the cold-mount fallback path where the
 * rollup table is empty (the populator hasn't caught up yet) so the
 * response shape is correct on the very first request.
 */
interface HeavyAggregateRow {
  type: string;
  count: bigint;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
  stddev_value: number | null;
  anomaly_count: bigint;
  avg7: number | null;
  avg30: number | null;
  avg30_last_month: number | null;
  slope7: number | null;
  r2_7: number | null;
  slope30: number | null;
  r2_30: number | null;
}

/**
 * Narrow aggregate row — only the columns the DAY rollup buckets cannot
 * compose linearly. `count` rides along so the anomaly z-score loop
 * knows the divisor for the window-wide mean / stddev; the per-type
 * count exposed on `DataSummary` still comes from the bucket
 * composition.
 */
interface NarrowAggregateRow {
  type: string;
  count: bigint;
  stddev_value: number | null;
  anomaly_count: bigint;
  avg7: number | null;
  avg30: number | null;
  avg30_last_month: number | null;
  // v1.20.0 F6 — the slope7/30/90 + r2_7/30/90 columns have moved off this
  // live query onto the rollup accumulators (composeWindowedRegression);
  // they no longer scan the raw measurements partition on the warm path.
}

/** Latest raw value per type (DISTINCT ON over the 90-day window). */
interface LatestRow {
  type: string;
  value: number;
  measured_at: Date;
}

/**
 * Result bundle. Everything the route handler needs to assemble the
 * comprehensive response without holding the 100k-row raw measurement
 * array in memory.
 */
export interface ComprehensiveAggregate {
  /** Per-type DataSummary, 90-day window. Only types with rows are
   *  populated — matches the legacy route's behaviour (only types
   *  with rows landed on `summaries[t]`). */
  summaries: Record<string, DataSummary>;
  /** Sys/dia raw rows for the BP target adherence path. Bounded:
   *  typically <2k rows per user over 90 days even with Apple Health. */
  bpRawRows: {
    sys: Array<{ measuredAt: Date; value: number }>;
    dia: Array<{ measuredAt: Date; value: number }>;
  };
  /** Raw weight rows over the same 90-day window, same canonical-source
   *  dedup as `bpRawRows` (they ride one query). Weight is sparse
   *  (~1-2 rows/day). v1.32.17 derives the mood × weight correlation from
   *  these local-day-keyed means instead of the UTC `dailyByType.WEIGHT`,
   *  so the mood join partner shares the mood series' local-day key space. */
  weightRawRows: Array<{ measuredAt: Date; value: number }>;
  /** Daily means per (type, day) for the correlation pairings. The
   *  route filters down to the types it needs (WEIGHT, BLOOD_PRESSURE_SYS,
   *  PULSE) when joining against mood / weight / bp. */
  dailyByType: Record<string, Array<{ day: string; value: number }>>;
  /** Earliest measurement timestamp across the 90-day window — feeds
   *  the route's `dataSpanDays` field. NULL when the user has no rows. */
  firstMeasurementAt: Date | null;
  /** Total row count across all types in the 90-day window — feeds the
   *  wide-event meta + the response's `totalMeasurements` field. */
  totalMeasurements: number;
}

/** Same threshold/rounding contract as `trendSlope()` in `trends.ts`. */
function buildSlope(
  slope: number | null,
  rSquared: number | null,
): DataSummary["slope7"] {
  if (slope === null) return null;
  const threshold = 0.01;
  const direction: "up" | "down" | "stable" =
    Math.abs(slope) < threshold ? "stable" : slope > 0 ? "up" : "down";
  return {
    slope: Math.round(slope * 1000) / 1000,
    direction,
    confidence: rSquared === null ? 0 : Math.round(rSquared * 100) / 100,
  };
}

function round2(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

/**
 * Build the per-type `DataSummary` bundle for the comprehensive route.
 *
 * Two read shapes:
 *
 *   - **Rollup-fresh path** (the happy path on every warm request):
 *     `count / min / max / mean` + `dailyByType` compose from the
 *     persisted DAY buckets; a narrow `$queryRaw` carries only the
 *     non-composable windowed columns. The heavy COUNT/MIN/MAX/AVG
 *     aggregate is **not** executed.
 *
 *   - **Live fallback path** (cold mount before the populator catches
 *     up, or a brand-new account whose backfill is mid-flight): the
 *     legacy heavy aggregate runs so the response shape stays correct
 *     on the very first request. Subsequent requests fall back to the
 *     rollup-fresh path once `ensureUserRollupsFresh` has written
 *     buckets.
 */
export async function buildComprehensiveAggregate(
  userId: string,
): Promise<ComprehensiveAggregate> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // v1.4.38 W-F — per-sub-query wall-clock timing. Emitted under
  // `meta.insights.sub_*_ms` so the next perf-verify can attribute
  // a regression to a specific aggregate (narrow, latests, day-buckets,
  // bp-raw, first-at, coverage-probe) without re-instrumenting.
  const timings: Record<string, number> = {};

  // v1.4.37.1 hotfix — fire-and-forget. See `src/app/api/analytics/route.ts`
  // for the full rationale: awaiting this on the read path can stall
  // the event loop for 30–60 s on power-user accounts whose iOS step
  // samples keep the 90-day window slightly stale. The downstream
  // coverage probe falls back to live SQL for uncovered types, so
  // correctness is preserved; the read just doesn't block waiting
  // for the background refresh.
  void ensureUserRollupsFresh(userId);

  // v1.4.36 QA C1 — per-type coverage probe. The legacy global COUNT
  // returned true as soon as any one type had a DAY bucket, which made
  // the bucket-derived path swallow a brand-new type's all-time history
  // (the per-write hook upserts a single bucket for the new type, the
  // probe flips to true, the comprehensive response then iterates only
  // bucket-bearing types and the trailing-90d narrow aggregate becomes
  // the new "all-time" total for that type). We now decide per type
  // and only take the rollup path when EVERY type the user has logged
  // is covered. Partial coverage falls back to the live aggregate so
  // a fresh-type measurement doesn't break its summary card.
  const probeStart = Date.now();
  const coverage = await probeRollupCoverage(userId);
  timings["insights.sub_coverage_ms"] = Date.now() - probeStart;

  const result = isFullyCovered(coverage)
    ? await buildFromRollups(userId, ninetyDaysAgo, timings)
    : await buildFromLiveAggregate(userId, ninetyDaysAgo, timings);

  annotate({ meta: timings });
  return result;
}

/**
 * v1.4.38 W-F — tiny timing helper. Wraps a promise-returning sub-query
 * builder so each Promise.all slot lands a wall-clock observation under
 * `meta.insights.sub_<label>_ms`. The helper itself never throws — the
 * builder's rejection propagates unchanged so the existing error
 * handling stays intact.
 */
function timeSubquery<T>(
  timings: Record<string, number>,
  label: string,
  builder: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  return builder().then((value) => {
    timings[`insights.sub_${label}_ms`] = Date.now() - t0;
    return value;
  });
}

interface BpRawRow {
  type: string;
  measured_at: Date;
  value: number;
}

/**
 * v1.4.38 W-F — fetch the trailing-90d sys + dia raw rows in a single
 * round-trip rather than two parallel queries.
 *
 * v1.18.10 I-1 — collapse overlapping sources before returning. BP is a
 * multi-source metric (a Withings reading mirrored into Apple Health is two
 * rows for one event). The legacy `findMany` returned every source's row, so
 * `computeBpInTargetPct` and the recency-weighted grade double-counted the
 * shared reading — and a rollup-warm account (which reads source-collapsed
 * `measurement_rollups` via `bp-in-target-fast-path`) returned a different
 * BP percentage / grade than a rollup-cold account on identical data. Routing
 * both raw pulls through `canonicalMeasurementsFrom` picks the ladder-winning
 * source per (type, day) so the cold/live path matches the warm/rollup path
 * (web↔iOS parity). `BLOOD_PRESSURE_SYS/DIA` are already in `RANKED_TYPES`.
 *
 * Per-event rows survive the collapse (the subquery keeps every reading of the
 * winning source per day, not a daily mean), so the downstream ±5-min pairing
 * still sees individual readings. Partitioning by type in JS preserves the
 * byte-shape of the legacy sys / dia arrays (ASC by measuredAt).
 */
async function fetchBpRawRows(
  userId: string,
  // The 90-day window is expressed as a SQL interval inside the canonical
  // subquery (parity with the rollup fast-path's `"90 days"`); the bound
  // `Date` arg is retained for call-site symmetry and is exactly 90 days.
  ninetyDaysAgo: Date,
  // The source-rank CASE built once by the caller (over unqualified
  // `"type"`/`"source"` columns) — reused so the BP pull doesn't re-load the
  // user's source-priority blob the caller already resolved.
  rankUnqualified: string,
): Promise<{
  sys: Array<{ measuredAt: Date; value: number }>;
  dia: Array<{ measuredAt: Date; value: number }>;
  weight: Array<{ measuredAt: Date; value: number }>;
}> {
  void ninetyDaysAgo;
  // v1.32.17 — WEIGHT rides this same canonical-dedup pull (one extra
  // sparse type, no new round-trip) so the route can derive a local-day
  // mood × weight series without re-scanning raw rows.
  const rows = await prisma.$queryRawUnsafe<BpRawRow[]>(
    `
      SELECT
        m."type"::text                  AS type,
        m."measured_at"                 AS measured_at,
        m."value"::double precision     AS value
      FROM ${canonicalMeasurementsFrom(rankUnqualified, "90 days")}
      WHERE m."type" IN ('BLOOD_PRESSURE_SYS', 'BLOOD_PRESSURE_DIA', 'WEIGHT')
      ORDER BY m."measured_at" ASC
    `,
    userId,
  );
  const sys: Array<{ measuredAt: Date; value: number }> = [];
  const dia: Array<{ measuredAt: Date; value: number }> = [];
  const weight: Array<{ measuredAt: Date; value: number }> = [];
  for (const r of rows) {
    const measuredAt = new Date(r.measured_at);
    if (r.type === "BLOOD_PRESSURE_SYS") {
      sys.push({ measuredAt, value: Number(r.value) });
    } else if (r.type === "BLOOD_PRESSURE_DIA") {
      dia.push({ measuredAt, value: Number(r.value) });
    } else if (r.type === "WEIGHT") {
      weight.push({ measuredAt, value: Number(r.value) });
    }
  }
  return { sys, dia, weight };
}

/**
 * Happy path — DAY buckets carry the composable stats; a narrow
 * `$queryRaw` carries only the windowed / regression columns the
 * buckets cannot reconstruct.
 */
async function buildFromRollups(
  userId: string,
  ninetyDaysAgo: Date,
  timings: Record<string, number>,
): Promise<ComprehensiveAggregate> {
  // v1.4.38 W-F — bp sys + dia consolidated into one `findMany`
  // (`type: { in: [...] }`) plus per-sub-query wall-clock timings.
  // v1.11.1 — collapse overlapping sources to the ladder-canonical reading per
  // (type, day) before aggregating. `rankUnqualified` ranks the inner
  // canonical-source subquery; `rankM` ranks the latest read's `m.`-aliased
  // columns. The window_stats CTE + the main narrow both read from the
  // canonical-source-filtered set so a dual-source vital isn't blended.
  const priorityJson = await loadUserSourcePriority(userId);
  const rankUnqualified = buildSourceRankCase(
    priorityJson,
    '"type"',
    '"source"',
  );
  const rankM = buildSourceRankCase(priorityJson, 'm."type"', 'm."source"');

  const [narrows, latests, dayBuckets, bpRawRows, firstRows] =
    await Promise.all([
      timeSubquery(timings, "narrow", () =>
        prisma.$queryRawUnsafe<NarrowAggregateRow[]>(
          `
      -- v1.18.11 perf#3a — the canonical-source self-join is the dominant
      -- cost; bind it ONCE as a CTE and reference it from both window_stats
      -- and the outer aggregate so the DISTINCT-ON pick runs a single time
      -- instead of twice per rebuild. Output is identical.
      WITH cm AS (${canonicalMeasurementsCte(rankUnqualified, "90 days")}
      ),
      -- The z-score's mean and spread stay over every reading: they measure
      -- how far one reading sits from the others, a per-reading dispersion,
      -- not the level the window means below report.
      window_stats AS (
        SELECT
          m."type",
          AVG(m."value") AS mean_value,
          STDDEV_POP(m."value") AS stddev_value
        FROM cm m
        GROUP BY m."type"
      )
      SELECT
        m."type"::text                                                AS type,
        COUNT(*)                                                      AS count,
        ws.stddev_value::double precision                             AS stddev_value,
        -- |z| > 2 anomaly count over the 90-day window. STDDEV_POP
        -- matches the JS helper which divides by n (not n-1).
        COUNT(*) FILTER (
          WHERE ws.stddev_value IS NOT NULL
            AND ws.stddev_value > 0
            AND ABS(
              (ROUND(((m."value" - ws.mean_value) / ws.stddev_value)::numeric, 2))
            ) > 2
        )                                                             AS anomaly_count,
        ${AVG7_SQL}::double precision                                 AS avg7,
        ${AVG30_SQL}::double precision                                AS avg30,
        -- Prior 30d window (days [30, 60) ago) used by tile delta callout.
        ${AVG30_LAST_MONTH_SQL}::double precision                     AS avg30_last_month
      FROM ${dayWeightedRows("cm", SESSION_DAY_FRAME)} m
      JOIN window_stats ws ON ws."type" = m."type"
      GROUP BY m."type", ws.stddev_value
    `,
          userId,
        ),
      ),
      timeSubquery(timings, "latests", () =>
        prisma.$queryRawUnsafe<LatestRow[]>(
          `
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = $1
        AND m."measured_at" >= NOW() - INTERVAL '90 days'
        AND m."deleted_at" IS NULL
      ORDER BY m."type", date_trunc('day', m."measured_at") DESC, (${rankM}), m."measured_at" DESC
    `,
          userId,
        ),
      ),
      // v1.4.35 — DAY rollup buckets for the trailing 90 days, every
      // type. Drives both the per-type `count / min / max / mean`
      // composition (via `aggregateBuckets`) and the `dailyByType`
      // correlation feed below. Replaces the legacy
      // `date_trunc('day', m."measured_at")` GROUP BY query and the
      // per-type AVG/MIN/MAX/COUNT columns the live aggregate kept.
      timeSubquery(timings, "buckets", () =>
        prisma.measurementRollup.findMany({
          where: {
            userId,
            granularity: "DAY",
            bucketStart: { gte: ninetyDaysAgo },
          },
          orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
        }),
      ),
      // v1.4.38 W-F — bp sys + dia merged into one round-trip. Halves
      // the bp-raw cost on accounts whose iOS Health source spams BP
      // readings; the per-type partition in `fetchBpRawRows` preserves
      // the legacy `bpRawRows.sys` / `bpRawRows.dia` byte-shape.
      timeSubquery(timings, "bpRaw", () =>
        fetchBpRawRows(userId, ninetyDaysAgo, rankUnqualified),
      ),
      timeSubquery(
        timings,
        "firstAt",
        () => prisma.$queryRaw<Array<{ first_at: Date | null }>>`
      SELECT MIN(m."measured_at") AS first_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${ninetyDaysAgo}
        AND m."deleted_at" IS NULL
    `,
      ),
    ]);

  const latestByType = new Map<string, { value: number; measuredAt: Date }>();
  for (const row of latests) {
    latestByType.set(row.type, {
      value: Number(row.value),
      measuredAt: new Date(row.measured_at),
    });
  }

  const bucketsByType = partitionBucketsByType(dayBuckets, priorityJson);
  const narrowByType = new Map<string, NarrowAggregateRow>();
  for (const row of narrows) {
    narrowByType.set(row.type, row);
  }

  const summaries: Record<string, DataSummary> = {};
  let totalMeasurements = 0;
  // v1.20.0 F6 — day-aligned 7/30/90-day window anchors, matching the
  // DAY-rollup grain. `startOfUtcDay(now − N days)` is the day-aligned
  // equivalent of the live `measured_at >= NOW() - INTERVAL 'N days'`.
  const now = Date.now();
  const since7 = startOfUtcDay(new Date(now - 7 * 24 * 60 * 60 * 1000));
  const since30 = startOfUtcDay(new Date(now - 30 * 24 * 60 * 60 * 1000));
  const since90 = startOfUtcDay(new Date(now - 90 * 24 * 60 * 60 * 1000));
  // v1.20.0 P3 M-1 — set once any in-window bucket carries a NULL
  // accumulator (pre-0190 row, or boot re-fold pending). The slope stays
  // null then — it converges after backfill — but the miss must be
  // observable per the "no silent cap" rule, so it surfaces in the
  // annotation below rather than passing silently as a plain rollup read.
  let regressionPendingBackfill = false;

  // Seed every type that has buckets — the bucket set is the source of
  // truth on this path. The narrow aggregate provides the non-composable
  // windowed columns (avg + anomaly) alongside; slope / r² / sd compose
  // from the per-bucket regression accumulators (v1.20.0 F6).
  for (const [type, buckets] of bucketsByType.entries()) {
    const composed = aggregateBuckets(buckets, windowWeighting(type));
    if (composed.count === 0) continue;
    totalMeasurements += composed.count;
    const latest = latestByType.get(type);
    const narrow = narrowByType.get(type);
    // The buckets are already source-collapsed (one canonical row per day),
    // so the accumulator sum is over the canonical source only.
    const accBuckets: AccumulatorBucketRow[] = buckets.map((b) => ({
      bucketStart: b.day,
      count: b.count,
      mean: b.mean,
      sumX: b.sumX,
      sumXy: b.sumXy,
      sumXx: b.sumXx,
      sumYy: b.sumYy,
    }));
    if (
      !regressionPendingBackfill &&
      hasPendingAccumulatorBackfill(accBuckets, since90)
    ) {
      regressionPendingBackfill = true;
    }
    const reg7 = composeWindowedRegression(accBuckets, since7);
    const reg30 = composeWindowedRegression(accBuckets, since30);
    summaries[type] = {
      count: composed.count,
      latest: latest?.value ?? null,
      min: round2(composed.min),
      max: round2(composed.max),
      mean: round2(composed.mean),
      // v1.8.5 — the comprehensive aggregator feeds the AI snapshot, not
      // the category-page stat strip, and does not compute a percentile.
      // Left null so the shared `DataSummary` contract holds without
      // paying a per-type percentile sort on the AI read path.
      median: null,
      avg7: round2(narrow?.avg7 ?? null),
      avg30: round2(narrow?.avg30 ?? null),
      slope7: buildSlope(reg7.slope, reg7.r2),
      slope30: buildSlope(reg30.slope, reg30.r2),
      anomalyCount: Number(narrow?.anomaly_count ?? 0),
      avg30LastMonth: round2(narrow?.avg30_last_month ?? null),
      // Legacy semantics: the 90-day window guarantees no rows from a
      // year ago. Always null.
      avg30LastYear: null,
    };
  }

  const firstMeasurementAt = firstRows[0]?.first_at
    ? new Date(firstRows[0].first_at)
    : null;

  // v1.20.0 F6 — observability: slope / r² / sd now compose from the rollup
  // accumulators (no raw-partition REGR_* scan); the anomaly count stays on
  // a live FILTER (per-reading |z|>2 is non-composable). The "no silent
  // cap" rule wants both sources visible so a regression to the heavy path
  // is observable.
  annotate({
    meta: {
      insights: {
        slope_source: "rollup",
        anomaly_source: "live",
        // v1.20.0 P3 M-1 — when a NULL accumulator (pre-0190 row, or boot
        // re-fold pending) forced a slope miss, the read intentionally
        // returns null without a live-SQL fallback (the design avoids the
        // heavy scan). Surface the gap so the silent null is observable; it
        // clears once the boot backfill refills the accumulators.
        regression_source: regressionPendingBackfill
          ? "unavailable_pending_backfill"
          : "rollup",
      },
    },
  });

  return {
    summaries,
    bpRawRows,
    weightRawRows: bpRawRows.weight,
    dailyByType: buildDailyByType(bucketsByType),
    firstMeasurementAt,
    totalMeasurements,
  };
}

/**
 * Cold fallback — the rollup table is empty for this user (e.g. brand-
 * new account, or post-restart before the boot-time backfill landed).
 * Runs the legacy heavy aggregate so the response shape is correct on
 * the very first request; subsequent requests will see the rollup
 * populator catch up and route through `buildFromRollups`.
 */
async function buildFromLiveAggregate(
  userId: string,
  ninetyDaysAgo: Date,
  timings: Record<string, number>,
): Promise<ComprehensiveAggregate> {
  // v1.4.38 W-F — same sub-query timing + consolidated bp-raw read as
  // the rollup-fresh path so the prod observability covers cold mounts
  // too.
  // v1.11.1 — same source-aware collapse as the rollup-fresh path so the cold
  // start agrees with the warm path (live/rollup parity).
  const priorityJson = await loadUserSourcePriority(userId);
  const rankUnqualified = buildSourceRankCase(
    priorityJson,
    '"type"',
    '"source"',
  );
  const rankM = buildSourceRankCase(priorityJson, 'm."type"', 'm."source"');

  const [aggregates, latests, dayBuckets, bpRawRows] = await Promise.all([
    timeSubquery(timings, "heavy", () =>
      prisma.$queryRawUnsafe<HeavyAggregateRow[]>(
        `
      -- v1.18.11 perf#3a — bind the canonical-source self-join once (see the
      -- warm narrow query). window_stats + the outer aggregate both read cm,
      -- so the DISTINCT-ON pick runs once. Output is identical.
      WITH cm AS (${canonicalMeasurementsCte(rankUnqualified, "90 days")}
      ),
      -- The z-score's mean and spread stay over every reading: they measure
      -- how far one reading sits from the others, a per-reading dispersion,
      -- not the level the window means below report.
      window_stats AS (
        SELECT
          m."type",
          AVG(m."value") AS mean_value,
          STDDEV_POP(m."value") AS stddev_value
        FROM cm m
        GROUP BY m."type"
      )
      SELECT
        m."type"::text                                                AS type,
        COUNT(*)                                                      AS count,
        MIN(m."value")::double precision                              AS min_value,
        MAX(m."value")::double precision                              AS max_value,
        ${windowMeanSql({ typeColumn: 'm."type"', value: 'm."value"', weight: "m.day_weight" })}::double precision
                                                                      AS mean_value,
        ws.stddev_value::double precision                             AS stddev_value,
        COUNT(*) FILTER (
          WHERE ws.stddev_value IS NOT NULL
            AND ws.stddev_value > 0
            AND ABS(
              (ROUND(((m."value" - ws.mean_value) / ws.stddev_value)::numeric, 2))
            ) > 2
        )                                                             AS anomaly_count,
        ${AVG7_SQL}::double precision                                 AS avg7,
        ${AVG30_SQL}::double precision                                AS avg30,
        ${AVG30_LAST_MONTH_SQL}::double precision                     AS avg30_last_month,
        -- A2-M2 — the regression windows anchor on the UTC-midnight day
        -- boundary, NOT the wall-clock instant, so this cold-fallback path
        -- returns the SAME boundary-day membership the warm rollup path
        -- composes from (startOfUtcDay(now - N days) +
        -- composeWindowedRegression). The expression
        -- date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL 'N days'
        -- is the SQL twin of startOfUtcDay; the trailing AT TIME ZONE 'UTC'
        -- re-materialises the naive truncation as a UTC instant so the
        -- measured_at (timestamptz) comparison is on the same wall the
        -- rollup bucketStart sits on. Without this anchor an account that
        -- crosses a coverage boundary (warm to cold) saw the boundary day
        -- flip in/out of the slope window, giving a cache-dependent answer
        -- to the same request.
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= (date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days') AT TIME ZONE 'UTC'
        )::double precision                                           AS slope7,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= (date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '7 days') AT TIME ZONE 'UTC'
        )::double precision                                           AS r2_7,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= (date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days') AT TIME ZONE 'UTC'
        )::double precision                                           AS slope30,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= (date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days') AT TIME ZONE 'UTC'
        )::double precision                                           AS r2_30
      FROM ${dayWeightedRows("cm", SESSION_DAY_FRAME)} m
      JOIN window_stats ws ON ws."type" = m."type"
      GROUP BY m."type", ws.stddev_value
    `,
        userId,
      ),
    ),
    timeSubquery(timings, "latests", () =>
      prisma.$queryRawUnsafe<LatestRow[]>(
        `
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = $1
        AND m."measured_at" >= NOW() - INTERVAL '90 days'
        AND m."deleted_at" IS NULL
      ORDER BY m."type", date_trunc('day', m."measured_at") DESC, (${rankM}), m."measured_at" DESC
    `,
        userId,
      ),
    ),
    // Buckets may exist for some types even when the COUNT probe came
    // back zero (race window between the probe and a sibling
    // populator); the cold-path read still honours them for the
    // `dailyByType` feed.
    timeSubquery(timings, "buckets", () =>
      prisma.measurementRollup.findMany({
        where: {
          userId,
          granularity: "DAY",
          bucketStart: { gte: ninetyDaysAgo },
        },
        orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
      }),
    ),
    // v1.4.38 W-F — bp sys + dia in one round-trip (see `fetchBpRawRows`).
    timeSubquery(timings, "bpRaw", () =>
      fetchBpRawRows(userId, ninetyDaysAgo, rankUnqualified),
    ),
  ]);

  const latestByType = new Map<string, { value: number; measuredAt: Date }>();
  for (const row of latests) {
    latestByType.set(row.type, {
      value: Number(row.value),
      measuredAt: new Date(row.measured_at),
    });
  }

  const bucketsByType = partitionBucketsByType(dayBuckets, priorityJson);

  const summaries: Record<string, DataSummary> = {};
  let totalMeasurements = 0;
  let firstMeasurementAt: Date | null = null;

  for (const row of aggregates) {
    const count = Number(row.count);
    totalMeasurements += count;
    const latest = latestByType.get(row.type);
    summaries[row.type] = {
      count,
      latest: latest?.value ?? null,
      min: round2(row.min_value),
      max: round2(row.max_value),
      mean: round2(row.mean_value),
      // v1.8.5 — see the parallel block above: the AI snapshot path
      // omits the percentile.
      median: null,
      avg7: round2(row.avg7),
      avg30: round2(row.avg30),
      slope7: buildSlope(row.slope7, row.r2_7),
      slope30: buildSlope(row.slope30, row.r2_30),
      anomalyCount: Number(row.anomaly_count),
      avg30LastMonth: round2(row.avg30_last_month),
      avg30LastYear: null,
    };
  }

  if (totalMeasurements > 0) {
    const firstRows = await timeSubquery(
      timings,
      "firstAt",
      () =>
        prisma.$queryRaw<Array<{ first_at: Date | null }>>`
        SELECT MIN(m."measured_at") AS first_at
        FROM measurements m
        WHERE m."user_id" = ${userId}
          AND m."measured_at" >= ${ninetyDaysAgo}
          AND m."deleted_at" IS NULL
      `,
    );
    firstMeasurementAt = firstRows[0]?.first_at
      ? new Date(firstRows[0].first_at)
      : null;
  }

  return {
    summaries,
    bpRawRows,
    weightRawRows: bpRawRows.weight,
    dailyByType: buildDailyByType(bucketsByType),
    firstMeasurementAt,
    totalMeasurements,
  };
}

/**
 * Partition DAY buckets by type so the per-type aggregator can compose
 * `count / min / max / mean` from them in O(1) and the daily-by-type
 * builder can replay them as the correlation feed.
 */
/**
 * v1.20.0 F6 — a partitioned DAY bucket carrying the composable stats plus
 * the regression accumulators the windowed slope / r² / sd compose from.
 */
interface PartitionedBucket {
  day: Date;
  count: number;
  mean: number;
  minValue: number;
  maxValue: number;
  sumX: number | null;
  sumXy: number | null;
  sumXx: number | null;
  sumYy: number | null;
}

function partitionBucketsByType(
  rows: ReadonlyArray<{
    type: string;
    source: MeasurementSource;
    bucketStart: Date;
    count: number;
    mean: number;
    minValue: number;
    maxValue: number;
    sumX: number | null;
    sumXy: number | null;
    sumXx: number | null;
    sumYy: number | null;
  }>,
  userPriorityJson: unknown,
): Map<string, PartitionedBucket[]> {
  // v1.11.1 — rollup rows are per source. Group by type, then collapse each
  // type's buckets to the ladder-canonical source per day before composing,
  // so a dual-source vital is not double-counted in count/mean/dailyByType.
  // v1.20.0 F6 — the collapse runs BEFORE the regression accumulators are
  // consumed, so a dual-source day contributes only the canonical source's
  // accumulators to the windowed slope / r² / sd (no cross-source sum).
  const byType = new Map<string, Array<(typeof rows)[number]>>();
  for (const b of rows) {
    const list = byType.get(b.type) ?? [];
    list.push(b);
    byType.set(b.type, list);
  }

  const map = new Map<string, PartitionedBucket[]>();
  for (const [type, typeRows] of byType) {
    const collapsed = collapseRollupRowsBySource(
      typeRows,
      type as MeasurementType,
      userPriorityJson,
    );
    map.set(
      type,
      collapsed.map((b) => ({
        day: b.bucketStart,
        count: b.count,
        mean: b.mean,
        minValue: b.minValue,
        maxValue: b.maxValue,
        sumX: b.sumX,
        sumXy: b.sumXy,
        sumXx: b.sumXx,
        sumYy: b.sumYy,
      })),
    );
  }
  return map;
}

/**
 * `dailyByType` is sourced from DAY rollup buckets, filtered to the
 * three types the correlation pairings consume so downstream consumers
 * see a byte-identical shape with the legacy
 * `date_trunc('day', m."measured_at")` GROUP BY query.
 */
function buildDailyByType(
  bucketsByType: Map<
    string,
    Array<{
      day: Date;
      count: number;
      mean: number;
      minValue: number;
      maxValue: number;
    }>
  >,
): Record<string, Array<{ day: string; value: number }>> {
  const dailyByType: Record<string, Array<{ day: string; value: number }>> = {};
  const DAILY_TYPES = ["WEIGHT", "BLOOD_PRESSURE_SYS", "PULSE"] as const;
  for (const type of DAILY_TYPES) {
    const buckets = bucketsByType.get(type);
    if (!buckets || buckets.length === 0) continue;
    dailyByType[type] = buckets.map((b) => ({
      // `bucketStart` is the UTC midnight of the bucketed day — the
      // same boundary Postgres' `date_trunc('day', ...)` would pick
      // when the session timezone is UTC (the container default).
      day: dateOnlyKey(b.day),
      // Match the legacy `ROUND(AVG, 2)::double precision` semantics
      // so correlation thresholds tuned against the v1.4.34 output
      // don't drift on the third decimal.
      value: round2(b.mean) ?? 0,
    }));
  }
  return dailyByType;
}
