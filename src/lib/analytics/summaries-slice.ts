/**
 * v1.4.36 — slim `summaries` slice for `/api/analytics?slice=summaries`.
 *
 * The default `/api/analytics` path fans out 30+ `Promise.all`-wrapped
 * chunked findMany reads (one per `MeasurementType`) so it can hand
 * each series to `summarize()` for slope7/30/90 + anomaly detection +
 * lastMonth/lastYear means. The dashboard tile strip only consumes
 * `count`, `latest`, `avg7`, `avg30`, `min`, `max`, `mean`, and the
 * three slope tuples — every other field gets `null`-coalesced before
 * it ever paints — yet the user waits on the full chunked walk.
 *
 * Read shape (v1.4.36)
 * --------------------
 * v1.4.35 partially read-swapped onto the persistent `measurement_rollups`
 * table but kept the full-fat `$queryRaw` running in parallel as a
 * parity check. The heavy COUNT/MIN/MAX/AVG aggregate scanned the
 * measurements table every request even on warm rollups.
 *
 * v1.4.36 promotes the rollup table to the canonical source on the
 * happy path: a single cheap COUNT against `measurement_rollups`
 * decides whether to read the composable stats from buckets or fall
 * back to the heavy live aggregate. When the rollup is populated:
 *
 *   1. **DAY-bucket read** — composes `count / min / max / mean` per
 *      type via `aggregateBuckets`. The four are linearly composable
 *      across DAY buckets so the composed value is mathematically
 *      identical to the live aggregate over the same rows.
 *
 *   2. **Narrow `$queryRaw`** — carries only the non-composable
 *      windowed columns (`avg7`, `avg30`, and the slope tuples). The
 *      heavy COUNT/MIN/MAX/AVG columns are NOT projected.
 *
 *   3. **`DISTINCT ON (type)` latest read** — most-recent `(type,
 *      value, measured_at)` triplet per type for the `latest` field
 *      and the `lastSeenByType` freshness map.
 *
 * On the cold fallback (no rollup rows yet) the slim slice runs the
 * legacy heavy aggregate so the response shape is correct on the very
 * first request.
 *
 * Fields the slim shape intentionally omits (the dashboard never
 * reads them on first paint):
 *   - `anomalyCount`: would require an extra per-type read for the
 *     z-score loop. v1.37.19 removed it from the wire shape entirely —
 *     the insights pipeline computes its own via `summarize()` /
 *     the comprehensive aggregator, and no client component reads it.
 *   - `avg30LastMonth` / `avg30LastYear`: the dashboard tile delta
 *     callout uses them, but only when the comparison-baseline
 *     widget is enabled — that path already pre-fetches the default
 *     slice via the explicit comparison opt-in.
 *
 * Slope `confidence` is the SQL `regr_r2` value (R²) which matches
 * the existing `trendSlope()` helper's `Math.round(rSquared * 100) /
 * 100`. Slope `direction` is derived from `slope`'s sign with the
 * same 0.01-units-per-day "stable" threshold the JS helper uses.
 */
import pLimit from "p-limit";

import type { MeasurementType } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import type { DataSummary } from "@/lib/analytics/trends";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { annotate } from "@/lib/logging/context";
import {
  ensureUserRollupsFresh,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";
import {
  collapseRollupRowsBySource,
  composeWindowedRegression,
  hasPendingAccumulatorBackfill,
  loadUserSourcePriority,
  type AccumulatorBucketRow,
} from "@/lib/rollups/measurement-read";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import {
  buildSourceRankCase,
  canonicalMeasurementsFrom,
} from "@/lib/analytics/source-rank-sql";
import {
  isFullyCovered,
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";
import {
  summarizeSleepNights,
  type SleepSourceDiscrepancy,
  type SleepStageRow,
} from "@/lib/analytics/sleep-night";
import { resolveUserTimezone } from "@/lib/tz/resolver";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * v1.18.10 P-7 — upper bound on the cold-fallback `allTime` aggregate's
 * scan window. Sits far beyond any real account's history (the earliest prod
 * measurements are < 10 years old) so it never changes a real all-time
 * count / min / max / mean; it exists purely so a coverage-miss cold read
 * can't trigger an unbounded full-partition scan. Whitelisted by
 * `canonicalMeasurementsFrom`'s interval regex (`<N> years`).
 */
const ALL_TIME_LIVE_CAP_INTERVAL = "15 years" as const;

/**
 * v1.4.48 — all-time aggregate row used on the cold-mount fallback
 * path. Holds the linearly composable columns (`count / min / max /
 * mean`) that must reflect every row the user has ever logged for
 * that type, capped at `ALL_TIME_LIVE_CAP_INTERVAL` (v1.18.10 P-7) as a
 * scan-DoS floor.
 */
interface AllTimeAggregateRow {
  type: string;
  count: bigint;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
}

/**
 * Narrow aggregate row — only the columns DAY buckets can't compose
 * linearly. The heavy `COUNT / MIN / MAX / AVG` columns are dropped
 * so the rollup-fresh read path's SQL projection is half as wide as
 * the legacy aggregate's.
 */
/**
 * v1.4.37.2 — shape returned by the per-type GROUP BY over
 * `measurement_rollups`. Replaces the v1.4.35 row-per-bucket transfer
 * that materialised a six-figure row count on tenants with large
 * measurement partitions; the SQL now does the aggregation
 * server-side and hands back one row per type.
 */
interface RollupAggregateRow {
  type: string;
  count: number;
  min: number;
  max: number;
  mean: number;
}

interface NarrowAggregateRow {
  type: string;
  avg7: number | null;
  avg30: number | null;
  /**
   * v1.8.5 — 50th percentile over the trailing 90-day window. The
   * windowed median is cheap (the narrow query already index-scans the
   * 90-day partition) and represents the central reading the stat strip
   * surfaces next to min / max / mean. An all-time median would require
   * sorting every raw row per type, which the rollup tier cannot
   * compose and which the perf posture (v1.8.3 anti-freeze) forbids on
   * the read path. Null when the window holds no rows.
   *
   * NOTE: this window (trailing 90 days) is the contract for the stat
   * strip's `DataSummary.median`. The JS `summarize()` in `trends.ts`
   * computes its median over the *full* series it is handed (a
   * caller-defined window), so the two share a field name but not a
   * window — see the `median` doc on `DataSummary`.
   */
  median: number | null;
  avg30_last_month: number | null;
  // v1.20.0 F6 — slope7/30/90 + r2_7/30/90 have moved off this live query
  // onto the rollup accumulators (composeWindowedRegression); they no longer
  // scan the raw measurements partition on the warm path. `median` stays
  // live (PERCENTILE_CONT is non-composable across buckets).
}

/**
 * v1.20.0 F6 — cold-fallback windowed row. The coverage-miss path keeps the
 * live REGR_* regression (no rollup accumulators to compose from yet), so it
 * carries the slope / r² columns the warm `NarrowAggregateRow` dropped.
 */
interface WindowedAggregateRow extends NarrowAggregateRow {
  slope7: number | null;
  r2_7: number | null;
  slope30: number | null;
  r2_30: number | null;
}

interface LatestRow {
  type: string;
  value: number;
  /**
   * v1.4.34 IW-B — per-type freshness timestamp. The DISTINCT ON pass
   * already orders by `measured_at DESC` to pick the latest row's
   * value; surfacing `measured_at` from the same row costs zero extra
   * round-trips and feeds the dashboard tile-strip's stale-data
   * caption (driven via `<TrendCard staleDays>`).
   */
  measured_at: Date;
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

function emptySummary(): DataSummary {
  return {
    count: 0,
    latest: null,
    min: null,
    max: null,
    mean: null,
    median: null,
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    avg30LastMonth: null,
    avg30LastYear: null,
  };
}

export interface SummariesSlice {
  summaries: Record<string, DataSummary>;
  /**
   * `null` on the slim slice. The default route computes BMI from
   * `summaries.WEIGHT.latest` + `user.heightCm`; consumers of the
   * slim slice that need BMI re-derive client-side or fetch the
   * default slice.
   */
  bmi: null;
  /**
   * v1.4.34 IW-B — per-type freshness map matching the default-slice
   * shape so the dashboard tile strip can render a "Letzter Wert vor
   * Xd" caption on stale tiles regardless of which slice the client
   * read from. Types the user has never logged report `null`.
   */
  lastSeenByType: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  >;
  /**
   * v1.28.x — source-discrepancy annotation for the LATEST night's main
   * session (see `SleepNight.sourceDiscrepancy`): non-null when two writer
   * buckets reported clearly different asleep totals for the night behind
   * `summaries.SLEEP_DURATION.latest`. Observational only — the served
   * summary stays the winning writer's totals; the dashboard sleep tile
   * marks the number with a discreet "sources disagree" hint. Minutes are
   * whole (rounded), matching the `/api/sleep/night` serialisation.
   * Additive on the wire; every consumer must tolerate `null`.
   */
  sleepSourceDiscrepancy: SleepSourceDiscrepancy | null;
}

export async function computeSummariesSlice(
  userId: string,
  /**
   * v1.12.7 A5 — optional pre-probed coverage map. The dashboard
   * snapshot already calls `probeRollupCoverage` up front to decide
   * whether to run the thick `extras` phase, then called this slice
   * which re-probed the identical query. Threading the map in lets the
   * slice reuse it and saves one round-trip on the snapshot's hot path.
   * Omit it (every other caller) to keep the internal probe as the
   * fallback — byte-stable for those callers.
   */
  precomputedCoverage?: RollupCoverageMap,
): Promise<SummariesSlice> {
  // v1.4.37.1 hotfix — fire-and-forget. See `src/app/api/analytics/route.ts`
  // for the full rationale: awaiting this on the read path can stall
  // the event loop for tens of seconds on tenants with large iOS step
  // sample sets that keep the 90-day window slightly stale. The downstream
  // coverage probe falls back to live SQL for uncovered types, so
  // correctness is preserved; the read just doesn't block waiting
  // for the background refresh.
  void ensureUserRollupsFresh(userId);

  // v1.4.36 QA C1 — per-type coverage probe replaces the legacy global
  // COUNT. The previous gate returned true as soon as ANY type had at
  // least one DAY bucket. Pathology: a user with BP fully rolled up
  // logs their first WEIGHT measurement → the sync write-hook upserts
  // one WEIGHT DAY bucket → the global probe stayed >0 → the route
  // flipped to the bucket-derived path for WEIGHT as well → all-time
  // count collapsed to whatever the trailing window covers because the
  // narrow aggregate's windowed columns + the single fresh bucket
  // can't reconstruct the prior history. We now decide per type and
  // only take the rollup path when EVERY type the user has logged is
  // covered. Partial coverage falls back to the live aggregate so the
  // brand-new-type case stays correct.
  const coverage = precomputedCoverage ?? (await probeRollupCoverage(userId));
  if (isFullyCovered(coverage)) {
    return withSleepNightTotals(userId, await computeFromRollups(userId));
  }
  // v1.4.38.7 — annotate the live fallback with the per-type
  // coverage map so the operator can see WHICH type stranded the
  // request on the live aggregator. Without this the wide-event only
  // says `path:"live"`, and "why" requires shell access to the DB.
  const missing: string[] = [];
  for (const [type, hasBuckets] of coverage.entries()) {
    if (!hasBuckets) missing.push(type);
  }
  annotate({
    meta: {
      analytics: {
        slim_summaries: {
          fallback_reason: "partial_rollup_coverage",
          missing_types: missing,
          covered_count: coverage.size - missing.length,
          total_types: coverage.size,
        },
      },
    },
  });
  return withSleepNightTotals(userId, await computeFromLiveAggregate(userId));
}

/**
 * v1.11.4 — replace the per-stage `summaries.SLEEP_DURATION` with a
 * per-NIGHT summary (iOS #1, HIGH).
 *
 * `SLEEP_DURATION` is stored one row per sleep STAGE per night (minutes).
 * The slim slice's generic aggregate therefore treats each stage as an
 * independent reading: `latest` is the most-recent STAGE (not the night),
 * `mean` / `avg7` / `avg30` average across stage rows. For the dashboard
 * sleep tile and the insights overview that is wrong — they want the
 * per-night TIME-ASLEEP total.
 *
 * This post-pass reads the SLEEP_DURATION rows once and overwrites the
 * summary with one computed over per-night asleep totals (one DataPoint
 * per night). The unit stays MINUTES (canonical), so existing consumers
 * that already treat the summary as minutes keep working — they now
 * average nights instead of stages, which is strictly more correct. The
 * read is bounded to a year (~5 rows/night) and is skipped entirely when
 * the user has logged no sleep.
 */
async function withSleepNightTotals(
  userId: string,
  slice: SummariesSlice,
): Promise<SummariesSlice> {
  const existing = slice.summaries.SLEEP_DURATION;
  // No sleep data at all → nothing to recompute (the empty summary stays).
  if (!existing || existing.count === 0) return slice;

  const since = new Date(Date.now() - 365 * DAY_MS);
  const rows = (await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION",
      deletedAt: null,
      measuredAt: { gte: since },
    },
    orderBy: { measuredAt: "asc" },
    // `deviceType` feeds the writer-level collapse: two HealthKit apps
    // behind one source (watch stages vs phone in-bed) must not blend.
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  })) as SleepStageRow[];
  if (rows.length === 0) return slice;

  const [tz, priorityJson] = await Promise.all([
    resolveUserTimezone(userId),
    loadUserSourcePriority(userId),
  ]);
  const { summary, latestNight } = summarizeSleepNights(rows, tz, priorityJson);
  // Preserve the slope tuples the night summary doesn't compute (the
  // dashboard tile reads slope30); recompute them off the night series is
  // out of scope here — the per-night `summarize()` already fills slope7 /
  // slope30 from the night DataPoints, so use them directly.
  slice.summaries.SLEEP_DURATION = summary;
  // Additive, observational: the latest night's main session saw two
  // writer buckets with clearly different asleep totals. Round to whole
  // minutes, matching the `/api/sleep/night` serialisation.
  slice.sleepSourceDiscrepancy = latestNight?.sourceDiscrepancy
    ? {
        deltaMinutes: Math.round(latestNight.sourceDiscrepancy.deltaMinutes),
        sources: latestNight.sourceDiscrepancy.sources.map((b) => ({
          source: b.source,
          deviceType: b.deviceType,
          asleepMinutes: Math.round(b.asleepMinutes),
        })),
      }
    : null;
  return slice;
}

/**
 * Happy path — DAY buckets carry `count / min / max / mean`; a narrow
 * `$queryRaw` carries only the windowed avgs + regression columns the
 * buckets cannot reconstruct.
 *
 * v1.4.47.1 — the `narrows` query takes an outer 90-day `measured_at`
 * cap so the planner does an index range scan on
 * `(user_id, type, measured_at)` instead of reading every row in the
 * user's measurements partition. Every FILTER expression inside the
 * SELECT already restricts to 7/30/90 days, so the cap excludes only
 * rows that were already being aggregated to NULL. On tenants with
 * large measurement partitions this lifts the slim slice from
 * multi-second cold to sub-second; output is bit-identical.
 */
async function computeFromRollups(userId: string): Promise<SummariesSlice> {
  // v1.11.1 — resolve the user's source-priority ladders once, then build the
  // rank CASE expressions used to collapse overlapping sources to the canonical
  // reading per (type, day) inside each query. `"type"`/`"source"` variants for
  // the unqualified rollup + inner-subquery columns, `m."…"` for the latest
  // read's outer alias.
  const priorityJson = await loadUserSourcePriority(userId);
  const rankUnqualified = buildSourceRankCase(
    priorityJson,
    '"type"',
    '"source"',
  );
  const rankM = buildSourceRankCase(priorityJson, 'm."type"', 'm."source"');

  // v1.37.19 (A6-10) — where the fold window starts. DAY rollup buckets
  // only exist inside the trailing `ROLLUP_FOLD_WINDOW_MS` (5 y), so the
  // rollup-composed "all-time" figures silently truncated to that window
  // for accounts with older history, while the cold live path reported
  // the true unbounded numbers. The pre-fold remainder query below
  // splices the older rows back in.
  //
  // The two halves meet at ONE instant, and it is a DAY bucket boundary:
  // buckets from `foldSplit` on, raw readings before it. Buckets older than
  // the window do exist — the per-write hook folds any day it touches, the
  // import folded whole spans up to v1.39.0, every fold snaps its start down
  // to the whole day, and nothing prunes a bucket the moving window has
  // passed — so bounding only the raw half counted each reading on such a
  // day twice. Split on a boundary, a reading is in exactly one half
  // whichever buckets exist.
  const foldSplit = startOfUtcDay(new Date(Date.now() - ROLLUP_FOLD_WINDOW_MS));

  const [narrows, latests, dayBuckets, accumulatorRows, preFoldRemainder] =
    await Promise.all([
      // The FROM is restricted to the canonical-source rows per (type, day): the
      // inner DISTINCT ON picks the ladder-winning source for each day, and the
      // join keeps only that source's readings so the 90-day AVG / median / slope
      // never blend two devices that both reported the same vital.
      prisma.$queryRawUnsafe<NarrowAggregateRow[]>(
        `
      SELECT
        m."type"::text                                                AS type,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS avg7,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS avg30,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '60 days'
            AND m."measured_at" <  NOW() - INTERVAL '30 days'
        )::double precision                                           AS avg30_last_month,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY m."value"
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '90 days'
        )::double precision                                           AS median
      FROM ${canonicalMeasurementsFrom(rankUnqualified, "90 days")}
      GROUP BY m."type"
    `,
        userId,
      ),
      // v1.11.1 — the latest tile reflects the canonical source for the latest
      // day, matching the chart: order by latest day first, then the ladder rank
      // (canonical source wins), then the latest reading of that source.
      prisma.$queryRawUnsafe<LatestRow[]>(
        `
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = $1
        AND m."deleted_at" IS NULL
      ORDER BY m."type", date_trunc('day', m."measured_at") DESC, (${rankM}), m."measured_at" DESC
    `,
        userId,
      ),
      // v1.4.37.2 hotfix — the v1.4.35 implementation read EVERY DAY
      // rollup bucket for the user (`findMany` without a `bucketStart`
      // window) and then composed `count / min / max / mean` in JS.
      // On tenants with large measurement partitions that materialised
      // as a six-figure row transfer + a JS loop = multi-second per
      // cache miss, even with the rollup table hot. The slim slice's
      // contract is the all-time count / min / max / mean per type —
      // exactly what a SQL `GROUP BY type` returns in a single
      // round-trip.
      //
      // v1.11.1 — rows are now per source. Collapse each (type, day) to the
      // ladder-canonical source via DISTINCT ON before the all-time aggregate,
      // so a dual-source vital is counted once. Still one server-side pass —
      // the DISTINCT ON + GROUP BY runs in Postgres and returns one row/type.
      prisma.$queryRawUnsafe<RollupAggregateRow[]>(
        `
      WITH collapsed AS (
        SELECT DISTINCT ON ("type", "bucket_start")
          "type"      AS type,
          "count"     AS count,
          "min_value" AS min_value,
          "max_value" AS max_value,
          "mean"      AS mean
        FROM "measurement_rollups"
        WHERE "user_id" = $1
          AND "granularity" = 'DAY'
          AND "bucket_start" >= $2
        ORDER BY "type", "bucket_start", (${rankUnqualified}), "source"
      )
      SELECT
        "type"::text                                       AS type,
        SUM("count")::int                                  AS count,
        MIN("min_value")::double precision                 AS min,
        MAX("max_value")::double precision                 AS max,
        (
          SUM("count" * "mean")::double precision
          / NULLIF(SUM("count")::double precision, 0)
        )                                                  AS mean
      FROM collapsed
      GROUP BY "type"
    `,
        userId,
        foldSplit,
      ),
      // v1.20.0 F6 — trailing 90-day DAY rollup rows carrying the per-bucket
      // regression accumulators. The windowed slope / r² / sd compose from
      // these (composeWindowedRegression) instead of the live REGR_* scan the
      // narrow query used to run. Rows are per source; collapsed per type
      // below so a dual-source vital contributes only its canonical source's
      // accumulators. Bounded to 90 days (≤ ~90 rows/type), the same window
      // the dropped slope columns covered.
      prisma.measurementRollup.findMany({
        where: {
          userId,
          granularity: "DAY",
          bucketStart: {
            gte: startOfUtcDay(new Date(Date.now() - 90 * DAY_MS)),
          },
        },
        orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
        select: {
          type: true,
          source: true,
          bucketStart: true,
          count: true,
          mean: true,
          sumX: true,
          sumXy: true,
          sumXx: true,
          sumYy: true,
        },
      }),
      // v1.37.19 (A6-10) — all-time remainder OLDER than the fold window.
      // One grouped aggregate over the pre-fold rows (index range scan on
      // `(user_id, measured_at)`; empty for any account younger than the
      // window). Spliced into the per-type figures below so "all-time"
      // means all time on the rollup path too. Deliberately without the
      // source-priority collapse: pre-fold history predates the rollup
      // tier's per-day canonicalisation, and a per-day DISTINCT ON over a
      // multi-year span is the cost this splice exists to avoid — for
      // count/min/max/mean over years-old data the raw figures are the
      // honest ones.
      prisma.$queryRaw<
        Array<{
          type: string;
          count: number;
          min: number;
          max: number;
          mean: number;
        }>
      >`
      SELECT
        m."type"::text                     AS type,
        COUNT(*)::int                      AS count,
        MIN(m."value")::double precision   AS min,
        MAX(m."value")::double precision   AS max,
        AVG(m."value")::double precision   AS mean
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
        AND m."measured_at" < ${foldSplit}
      GROUP BY m."type"
    `,
    ]);

  const preFoldByType = new Map<
    string,
    { count: number; min: number; max: number; mean: number }
  >();
  for (const row of preFoldRemainder) {
    preFoldByType.set(row.type, {
      count: Number(row.count),
      min: Number(row.min),
      max: Number(row.max),
      mean: Number(row.mean),
    });
  }

  // v1.20.0 F6 — collapse the 90-day accumulator rows to the canonical
  // source per (type, day), then build a per-type accumulator-bucket list so
  // the windowed slope / r² / sd compose from the canonical source only.
  const accBucketsByType = new Map<string, AccumulatorBucketRow[]>();
  {
    const byType = new Map<string, (typeof accumulatorRows)[number][]>();
    for (const r of accumulatorRows) {
      const list = byType.get(r.type) ?? [];
      list.push(r);
      byType.set(r.type, list);
    }
    for (const [type, rows] of byType) {
      const collapsed = collapseRollupRowsBySource(
        rows,
        type as MeasurementType,
        priorityJson,
      );
      accBucketsByType.set(
        type,
        collapsed.map((b) => ({
          bucketStart: b.bucketStart,
          count: b.count,
          mean: b.mean,
          sumX: b.sumX,
          sumXy: b.sumXy,
          sumXx: b.sumXx,
          sumYy: b.sumYy,
        })),
      );
    }
  }

  // Day-aligned 7/30/90-day anchors — the rollup-grain equivalent of the
  // live `measured_at >= NOW() - INTERVAL 'N days'` filter.
  const nowMs = Date.now();
  const since7 = startOfUtcDay(new Date(nowMs - 7 * DAY_MS));
  const since30 = startOfUtcDay(new Date(nowMs - 30 * DAY_MS));
  const since90 = startOfUtcDay(new Date(nowMs - 90 * DAY_MS));

  const latestByType = new Map<string, number>();
  // v1.4.34 IW-B — capture the per-type `measured_at` alongside the
  // value so we can surface the freshness map on the slim slice
  // without an extra round-trip.
  const lastSeenAtByType = new Map<string, Date>();
  for (const row of latests) {
    latestByType.set(row.type, Number(row.value));
    if (row.measured_at) {
      lastSeenAtByType.set(row.type, new Date(row.measured_at));
    }
  }

  // Seed every enum option so consumers can read `summaries.PULSE` and
  // get a deterministic empty shape rather than `undefined`. Mirrors
  // the default route which iterates `measurementTypeEnum.options`.
  const summaries: Record<string, DataSummary> = {};
  const lastSeenByType: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  > = {};
  for (const type of measurementTypeEnum.options) {
    summaries[type] = emptySummary();
    lastSeenByType[type] = null;
  }

  const nowForStaleness = Date.now();
  for (const [type, measuredAt] of lastSeenAtByType.entries()) {
    const daysAgo = Math.floor(
      (nowForStaleness - measuredAt.getTime()) / (24 * 60 * 60 * 1000),
    );
    lastSeenByType[type] = {
      lastSeenAt: measuredAt.toISOString(),
      daysAgo,
    };
  }

  // v1.4.37.2 hotfix — the rollup aggregate is now shaped server-side
  // (one row per type with count / min / max / mean already computed),
  // so we map straight through instead of partitioning + composing in
  // JS. The narrows query feeds the windowed avgs + slope columns the
  // GROUP BY cannot reconstruct.
  const narrowByType = new Map<string, NarrowAggregateRow>();
  for (const row of narrows) {
    narrowByType.set(row.type, row);
  }

  let totalRows = 0;
  let typeCount = 0;
  const typesWithData: string[] = [];
  // v1.20.0 P3 M-1 — set once any in-window bucket carries a NULL
  // accumulator (pre-0190 row, or boot re-fold pending). The slope stays
  // null then — honest, it converges after backfill — but the miss must be
  // observable per the "no silent cap" rule, so it surfaces in the
  // annotation below rather than passing silently as a plain rollup read.
  let regressionPendingBackfill = false;
  for (const row of dayBuckets) {
    if (!row.count || row.count <= 0) continue;
    typeCount += 1;
    totalRows += row.count;
    typesWithData.push(row.type);
    const narrow = narrowByType.get(row.type);
    const latest = latestByType.get(row.type) ?? null;
    // v1.20.0 F6 — windowed slope / r² compose from the per-bucket
    // accumulators (canonical-source-collapsed above) rather than the live
    // REGR_* scan. A full miss (NULL accumulators pre-backfill, or < 2
    // readings) yields a null slope, the same shape the empty REGR_* FILTER
    // returned.
    const accBuckets = accBucketsByType.get(row.type) ?? [];
    if (
      !regressionPendingBackfill &&
      hasPendingAccumulatorBackfill(accBuckets, since90)
    ) {
      regressionPendingBackfill = true;
    }
    const reg7 = composeWindowedRegression(accBuckets, since7);
    const reg30 = composeWindowedRegression(accBuckets, since30);
    // v1.37.19 (A6-10) — splice the pre-fold remainder into the all-time
    // figures: the rollup tier only covers the trailing fold window, so
    // count / min / max / mean composed from it alone truncated "all
    // time" to 5 y. Windowed fields (avg7/30, median, slopes) are
    // unaffected — their windows sit far inside the fold window.
    const pre = preFoldByType.get(row.type);
    const allCount = row.count + (pre?.count ?? 0);
    const allMin = pre ? Math.min(row.min, pre.min) : row.min;
    const allMax = pre ? Math.max(row.max, pre.max) : row.max;
    const allMean = pre
      ? (row.mean * row.count + pre.mean * pre.count) / allCount
      : row.mean;
    summaries[row.type] = {
      count: allCount,
      latest,
      min: round2(allMin),
      max: round2(allMax),
      mean: round2(allMean),
      median: round2(narrow?.median ?? null),
      avg7: round2(narrow?.avg7 ?? null),
      avg30: round2(narrow?.avg30 ?? null),
      slope7: buildSlope(reg7.slope, reg7.r2),
      slope30: buildSlope(reg30.slope, reg30.r2),
      avg30LastMonth: round2(narrow?.avg30_last_month ?? null),
      avg30LastYear: null,
    };
    if (pre) totalRows += pre.count;
  }

  // v1.37.19 (A6-10) — a type whose ONLY rows are older than the fold
  // window has no DAY bucket at all; without this arm it read as "never
  // logged" on the rollup path while the live path reported its history.
  for (const [type, pre] of preFoldByType) {
    if (typesWithData.includes(type)) continue;
    typeCount += 1;
    totalRows += pre.count;
    typesWithData.push(type);
    summaries[type] = {
      count: pre.count,
      latest: latestByType.get(type) ?? null,
      min: round2(pre.min),
      max: round2(pre.max),
      mean: round2(pre.mean),
      median: null,
      avg7: null,
      avg30: null,
      slope7: null,
      slope30: null,
      avg30LastMonth: null,
      avg30LastYear: null,
    };
  }

  // v1.4.40 W-WMY-WIRE — populate `avg30LastYear` per type from the
  // WMY rollup tier. Only types with data in the current window are
  // probed so we don't pay the per-type round-trip on the long tail
  // of unlogged measurement enums. Types without YEAR/MONTH coverage
  // surface as `null` (existing behaviour) — additive only.
  const avg30LastYearMap = await computeAvg30LastYearMap(userId, typesWithData);
  let yearOverYearTypeCount = 0;
  for (const [type, value] of avg30LastYearMap.entries()) {
    if (value === null) continue;
    const summary = summaries[type];
    if (!summary) continue;
    summary.avg30LastYear = round2(value);
    yearOverYearTypeCount += 1;
  }

  annotate({
    action: { name: "analytics.get.slim" },
    meta: {
      analytics: {
        slim_summaries: {
          row_count: totalRows,
          type_count: typeCount,
          path: "rollup",
          year_over_year_types: yearOverYearTypeCount,
          // v1.20.0 F6 — slope / r² now compose from the rollup
          // accumulators (no live REGR_* scan). The median stays live
          // (PERCENTILE_CONT is non-composable); both sources are logged
          // per the "no silent cap" rule so a regression is observable.
          slope_source: "rollup",
          median_source: "live",
          // v1.20.0 P3 M-1 — when a NULL accumulator (pre-0190 row, or boot
          // re-fold pending) forced a slope miss, the read intentionally
          // returns null without a live-SQL fallback (the design avoids the
          // heavy scan). Surface the gap so the silent null is observable;
          // it clears once the boot backfill refills the accumulators.
          regression_source: regressionPendingBackfill
            ? "unavailable_pending_backfill"
            : "rollup",
        },
      },
    },
  });

  return { summaries, bmi: null, lastSeenByType, sleepSourceDiscrepancy: null };
}

/**
 * Cold fallback — runs the legacy heavy aggregate when the rollup
 * table is empty for this user. Subsequent reads pick up the populated
 * rollup on `computeFromRollups`.
 *
 * v1.4.48 — split into two parallel queries:
 *
 *   1. `allTime` — the linearly composable columns (`count / min /
 *      max / mean`). v1.18.10 P-7 caps this at `ALL_TIME_LIVE_CAP_INTERVAL`
 *      (15 years) so an un-windowed cold-fallback read on a coverage-miss
 *      tenant can never scan an unbounded partition. The cap is a scan-DoS
 *      floor, not a semantic change: it sits far beyond any real account's
 *      history (the earliest prod rows are < 10 years old) and the steady
 *      state is rollup-backed anyway, so it only ever bounds the cold path.
 *
 *
 *   2. `windowed` — `avg7 / avg30` and the slope/r² tuples are all
 *      already filtered to a 7/30/90 day window inside the SELECT.
 *      Adding an outer `measured_at >= NOW() - INTERVAL '90 days'`
 *      cap lets the planner do an index range scan on
 *      `(user_id, type, measured_at)` instead of a full-partition
 *      sequential scan and discarding 95 % of rows inside FILTER
 *      clauses. On tenants with large measurement partitions the
 *      cold fallback drops from multi-second to sub-second. Output is
 *      bit-identical because every row excluded by the new outer cap
 *      was already aggregating to NULL inside its FILTER clause.
 */
async function computeFromLiveAggregate(
  userId: string,
): Promise<SummariesSlice> {
  // v1.11.1 — collapse overlapping sources to the ladder-canonical reading per
  // (type, day) BEFORE aggregating, exactly as the rollup path does, so a
  // coverage-miss tenant gets the same numbers as a warm one (live/rollup
  // parity). `canonicalMeasurementsFrom` swaps `FROM measurements m` for a
  // canonical-source-filtered subquery; the latest read uses the ladder rank.
  const priorityJson = await loadUserSourcePriority(userId);
  const rankUnqualified = buildSourceRankCase(
    priorityJson,
    '"type"',
    '"source"',
  );
  const rankM = buildSourceRankCase(priorityJson, 'm."type"', 'm."source"');

  const [allTime, windowed, latests] = await Promise.all([
    prisma.$queryRawUnsafe<AllTimeAggregateRow[]>(
      `
      SELECT
        m."type"::text                                                AS type,
        COUNT(*)                                                      AS count,
        MIN(m."value")::double precision                              AS min_value,
        MAX(m."value")::double precision                              AS max_value,
        AVG(m."value")::double precision                              AS mean_value
      FROM ${canonicalMeasurementsFrom(rankUnqualified, ALL_TIME_LIVE_CAP_INTERVAL)}
      GROUP BY m."type"
    `,
      userId,
    ),
    prisma.$queryRawUnsafe<WindowedAggregateRow[]>(
      `
      SELECT
        m."type"::text                                                AS type,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS avg7,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS avg30,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '60 days'
            AND m."measured_at" <  NOW() - INTERVAL '30 days'
        )::double precision                                           AS avg30_last_month,
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY m."value"
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '90 days'
        )::double precision                                           AS median,
        -- A2-M2 — anchor the regression windows on the UTC-midnight day
        -- boundary so this cold-fallback path returns the SAME boundary-day
        -- membership the warm computeFromRollups composes via
        -- startOfUtcDay(now - N days) + composeWindowedRegression. The
        -- expression date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL
        -- 'N days' is the SQL twin of startOfUtcDay; the trailing AT TIME
        -- ZONE 'UTC' re-materialises the naive truncation as a UTC instant
        -- so the measured_at (timestamptz) comparison lands on the same wall
        -- the rollup bucketStart sits on. The wall-clock NOW() - INTERVAL
        -- bound let the boundary day flip in/out of the slope window across
        -- a warm-to-cold coverage transition (cache-dependent slope on the
        -- same request); the avg7/30/median windows above stay wall-clock
        -- because the warm narrow query computes THOSE the same way.
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
      FROM ${canonicalMeasurementsFrom(rankUnqualified, "90 days")}
      GROUP BY m."type"
    `,
      userId,
    ),
    prisma.$queryRawUnsafe<LatestRow[]>(
      `
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = $1
        AND m."deleted_at" IS NULL
      ORDER BY m."type", date_trunc('day', m."measured_at") DESC, (${rankM}), m."measured_at" DESC
    `,
      userId,
    ),
  ]);

  const latestByType = new Map<string, number>();
  const lastSeenAtByType = new Map<string, Date>();
  for (const row of latests) {
    latestByType.set(row.type, Number(row.value));
    if (row.measured_at) {
      lastSeenAtByType.set(row.type, new Date(row.measured_at));
    }
  }

  const summaries: Record<string, DataSummary> = {};
  const lastSeenByType: Record<
    string,
    { lastSeenAt: string; daysAgo: number } | null
  > = {};
  for (const type of measurementTypeEnum.options) {
    summaries[type] = emptySummary();
    lastSeenByType[type] = null;
  }

  const nowForStaleness = Date.now();
  for (const [type, measuredAt] of lastSeenAtByType.entries()) {
    const daysAgo = Math.floor(
      (nowForStaleness - measuredAt.getTime()) / (24 * 60 * 60 * 1000),
    );
    lastSeenByType[type] = {
      lastSeenAt: measuredAt.toISOString(),
      daysAgo,
    };
  }

  // v1.4.48 — windowed columns are keyed by type alongside the
  // all-time aggregate. Types that exist in `allTime` but have no
  // measurements in the 90-day window leave their windowed columns at
  // `null` (the same shape the pre-split query produced via FILTER
  // returning NULL on an empty set).
  const windowedByType = new Map<string, WindowedAggregateRow>();
  for (const row of windowed) {
    windowedByType.set(row.type, row);
  }

  let totalRows = 0;
  const typesWithData: string[] = [];
  for (const row of allTime) {
    const count = Number(row.count);
    totalRows += count;
    typesWithData.push(row.type);
    const latest = latestByType.get(row.type) ?? null;
    const win = windowedByType.get(row.type);
    summaries[row.type] = {
      count,
      latest,
      min: round2(row.min_value),
      max: round2(row.max_value),
      mean: round2(row.mean_value),
      median: round2(win?.median ?? null),
      avg7: round2(win?.avg7 ?? null),
      avg30: round2(win?.avg30 ?? null),
      slope7: buildSlope(win?.slope7 ?? null, win?.r2_7 ?? null),
      slope30: buildSlope(win?.slope30 ?? null, win?.r2_30 ?? null),
      avg30LastMonth: round2(win?.avg30_last_month ?? null),
      avg30LastYear: null,
    };
  }

  // v1.4.40 W-WMY-WIRE — even on the live-aggregate fallback (DAY
  // coverage incomplete), the YEAR / MONTH rollup tier may still
  // carry the year-ago baseline because the boot-time backfill mints
  // all granularities once per user. Probing here means a partial-
  // coverage cold mount still surfaces `avg30LastYear` whenever the
  // long-tail tier is populated, instead of waiting for the next
  // refresh cycle.
  const avg30LastYearMap = await computeAvg30LastYearMap(userId, typesWithData);
  let yearOverYearTypeCount = 0;
  for (const [type, value] of avg30LastYearMap.entries()) {
    if (value === null) continue;
    const summary = summaries[type];
    if (!summary) continue;
    summary.avg30LastYear = round2(value);
    yearOverYearTypeCount += 1;
  }

  annotate({
    action: { name: "analytics.get.slim" },
    meta: {
      analytics: {
        slim_summaries: {
          row_count: totalRows,
          type_count: allTime.length,
          path: "live",
          year_over_year_types: yearOverYearTypeCount,
        },
      },
    },
  });

  return { summaries, bmi: null, lastSeenByType, sleepSourceDiscrepancy: null };
}

/**
 * v1.4.39 W-WMY — long-window summary for a single `(userId, type)`
 * pair, served from the WEEK / MONTH / YEAR rollup tier when the
 * window justifies it.
 *
 * Why this helper exists
 * ----------------------
 * The slim `computeSummariesSlice` caps its windowed columns at 90 d
 * (`slope7 / slope30`). The v1.5 multi-year trend feature
 * + the Coach drawer's "history" tile need linearly composable stats
 * (count / min / max / mean / sum) over much larger windows — 1 y,
 * 2 y, 3 y. Hitting the live `measurements` table for a 3-year span
 * walks every row the user has ever logged for that type, which on
 * the maintainer's tenant is tens of thousands of rows per type.
 *
 * The WMY rollup tier already carries the per-bucket stats we need:
 * the writer mints WEEK / MONTH / YEAR buckets via pg-boss on every
 * measurement write and the boot backfill fills the long tail. This
 * helper routes the requested window into the largest granularity
 * that still resolves it (via `readBestGranularityRollups`) and
 * composes the trailing-window aggregate in JS — typically 3-15
 * bucket rows on a multi-year window, vs the thousands of raw rows
 * the live aggregator would scan.
 *
 * Compositional caveats
 * ---------------------
 * `count / min / max / mean / sum` are mathematically exact across
 * any granularity (linearly composable). `sd / slope / r2` are NOT
 * exact across coarser buckets — this helper deliberately omits them
 * so callers cannot accidentally consume stale slope data. The v1.5
 * multi-year trend card derives its slope from the per-bucket `mean`
 * series instead.
 *
 * Coverage-miss policy
 * --------------------
 * `readBestGranularityRollups` falls back from YEAR → MONTH → WEEK
 * → DAY on per-tier coverage miss. Returns `null` only when the
 * user has zero buckets in the entire window — the caller treats
 * that as "no data" rather than "stale rollup". The route is
 * intentionally NOT wired to live SQL fallback here; the all-time
 * aggregate path inside `computeSummariesSlice` already covers the
 * "rollup tier empty" cold-mount case, and v1.5's multi-year card
 * accepts a `null` "no data yet" state.
 */

/**
 * v1.4.40 W-WMY-WIRE — year-ago 30-day baseline per type, served from
 * the WEEK / MONTH / YEAR rollup tier.
 *
 * Why this helper exists
 * ----------------------
 * `DataSummary.avg30LastYear` is the mean over `[now-395d, now-365d)` —
 * the 30-day window starting 365 days ago. The dashboard tile-strip's
 * delta callout uses it to narrate "current avg vs same time last
 * year". Up to v1.4.39 the slim slice (and the comprehensive
 * aggregator's rollup branch) hardcoded the field to `null` because
 * the 90-day windowed `$queryRaw` cannot reach back a year, and the
 * live `measurements` table walk for a 395-day per-type window is
 * exactly the cold-path cost we're trying to avoid.
 *
 * The WMY rollup tier already carries the per-bucket stats this
 * window needs. `readBestGranularityRollups(userId, type, 395)`
 * routes the 395-day window through YEAR (if covered) → MONTH → WEEK
 * → DAY and returns the buckets whose `bucketStart` falls inside the
 * window. We then keep only the buckets that overlap the
 * `[now-395d, now-365d)` slice and compose `count / mean` linearly to
 * produce the year-ago baseline.
 *
 * Compositional contract
 * ----------------------
 * `count / mean` are linearly composable across any granularity, so
 * the year-ago mean derived from MONTH or YEAR buckets is
 * mathematically equivalent to the per-row average over the same
 * window. The bucket-overlap filter is conservative: we include only
 * buckets whose `bucketStart` is strictly inside the slice. On a
 * YEAR-granularity routing this collapses to at most one bucket and
 * approximates the 30-day mean by the surrounding yearly average —
 * acceptable for a UI hint that explicitly narrates "last year".
 *
 * Coverage-miss policy
 * --------------------
 * Returns `null` when `readBestGranularityRollups` returns null (no
 * coverage at any granularity) OR when no buckets overlap the
 * year-ago slice. The caller leaves the dashboard field as `null`,
 * which the UI already handles as "no comparison available".
 */
async function computeAvg30LastYearForType(
  userId: string,
  type: MeasurementType,
): Promise<number | null> {
  const resolved = await readBestGranularityRollups(userId, type, 395);
  if (!resolved) return null;
  const now = Date.now();
  const sliceStart = now - 395 * DAY_MS;
  const sliceEnd = now - 365 * DAY_MS;
  const overlapping = resolved.rows.filter((row) => {
    const t = row.bucketStart.getTime();
    return t >= sliceStart && t < sliceEnd;
  });
  if (overlapping.length === 0) return null;
  let totalCount = 0;
  let weighted = 0;
  for (const row of overlapping) {
    totalCount += row.count;
    weighted += row.count * row.mean;
  }
  if (totalCount === 0) return null;
  return weighted / totalCount;
}

/**
 * v1.4.40 W-WMY-WIRE — fan out `computeAvg30LastYearForType` across
 * the types the caller actually surfaces. Runs the per-type WMY reads
 * in parallel so the long-tail of types doesn't serialise into a
 * per-type round-trip stack.
 *
 * v1.4.43 — cap concurrent per-type WMY reads at 4.
 *
 * Pre-fix this helper ran an unbounded Promise.all over every type the
 * user has data for. On a 15-type tenant the burst held 15+ Prisma
 * slots simultaneously, and with the slim and thick analytics slices
 * firing in parallel on dashboard mount the combined fan-out drowned
 * the pg.Pool max=20 even after the v1.4.40 W-POOL raise. The cap
 * mirrors the W-POOL `p-limit(4)` discipline v1.4.40 applied to the
 * thick route's per-type live walk (`ANALYTICS_TYPE_FETCH_CONCURRENCY`
 * in `src/app/api/analytics/route.ts`) so both slices behave the same
 * way under burst.
 *
 * Returns a `type → mean | null` map; types with no coverage at any
 * granularity (or no buckets in the year-ago slice) map to `null` so
 * the caller can blanket-assign without per-type null-checking.
 */
export const WMY_FANOUT_CONCURRENCY = 4;

export async function computeAvg30LastYearMap(
  userId: string,
  types: ReadonlyArray<string>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (types.length === 0) return out;
  const limit = pLimit(WMY_FANOUT_CONCURRENCY);
  const results = await Promise.all(
    types.map((type) =>
      limit(async () => {
        const value = await computeAvg30LastYearForType(
          userId,
          type as MeasurementType,
        );
        return [type, value] as const;
      }),
    ),
  );
  for (const [type, value] of results) {
    out.set(type, value);
  }
  return out;
}
