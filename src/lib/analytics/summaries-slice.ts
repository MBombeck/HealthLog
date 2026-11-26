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
 *   3. **Latest read** (`readLatestCanonical`) — most-recent `(type,
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
import type { MeasurementType } from "@/generated/prisma/client";

import { prisma } from "@/lib/db";
import { runDetached } from "@/lib/logging/detached";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { usesHourlyMeanDay } from "@/lib/measurements/day-statistic";
import {
  SESSION_DAY_FRAME,
  dayWeightedRows,
  isHourlyMeanTypeSql,
  windowMeanSql,
} from "@/lib/measurements/day-mean";
import type { DataSummary } from "@/lib/analytics/trends";
import {
  liveTrend,
  liveTrendSql,
  type LiveTrendColumns,
} from "@/lib/analytics/trend-evidence-sql";
import {
  boundInstantSql,
  windowMeanColumnsSql,
} from "@/lib/analytics/request-clock-sql";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { annotate } from "@/lib/logging/context";
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import { readPreFoldRemainder } from "@/lib/analytics/pre-fold-remainder";
import {
  ensureUserRollupsFresh,
  ROLLUP_FOLD_WINDOW_MS,
} from "@/lib/rollups/measurement-rollups";
import {
  collapseRollupRowsBySource,
  composeWindowedTrend,
  hasPendingAccumulatorBackfill,
  loadUserSourcePriority,
  type AccumulatorBucketRow,
} from "@/lib/rollups/measurement-read";
// The warm read and the live fallback sum the same readings in different
// orders, so a served figure must not turn on the last bits.
import { roundStable2 as round2 } from "@/lib/stats/central";
import { startOfUtcDay } from "@/lib/tz/start-of-utc-day";
import {
  buildSourceRankCase,
  canonicalMeasurementsCte,
} from "@/lib/analytics/source-rank-sql";
import { readCanonicalWindow } from "@/lib/analytics/canonical-window";
import { readLatestCanonical } from "@/lib/measurements/latest-canonical";
import {
  isFullyCovered,
  probeRollupCoverage,
  type RollupCoverageMap,
} from "@/lib/rollups/measurement-coverage";
import type { SleepSourceDiscrepancy } from "@/lib/analytics/sleep-night";
import {
  startSlicePasses,
  type SlicePasses,
} from "@/lib/analytics/summaries-slice-passes";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * v1.18.10 — upper bound on the cold-fallback `allTime` aggregate's
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
  /** Days that hold a reading: the weight of the mean for an hourly-mean type. */
  days: number;
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
  // v1.20.0 — slope7/30/90 + r2_7/30/90 have moved off this live query
  // onto the rollup accumulators (composeWindowedRegression); they no longer
  // scan the raw measurements partition on the warm path. `median` stays
  // live (PERCENTILE_CONT is non-composable across buckets).
}

/**
 * v1.20.0 — cold-fallback windowed row. The coverage-miss path keeps the
 * live REGR_* regression (no rollup accumulators to compose from yet), so it
 * carries the slope / r² columns the warm `NarrowAggregateRow` dropped.
 */
interface WindowedAggregateRow extends NarrowAggregateRow, LiveTrendColumns {}

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
   * v1.4.34 — per-type freshness map matching the default-slice
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
   * v1.12.7 — optional pre-probed coverage map. The dashboard
   * snapshot already calls `probeRollupCoverage` up front to decide
   * whether to run the thick `extras` phase, then called this slice
   * which re-probed the identical query. Threading the map in lets the
   * slice reuse it and saves one round-trip on the snapshot's hot path.
   * Omit it (every other caller) to keep the internal probe as the
   * fallback — byte-stable for those callers.
   */
  precomputedCoverage?: RollupCoverageMap,
): Promise<SummariesSlice> {
  // One clock for every window of the slice, JS and SQL alike (see
  // `request-clock-sql.ts`).
  const now = new Date();
  // v1.4.37.1 — fire-and-forget (see `src/app/api/analytics/route.ts`):
  // awaiting it can stall the event loop for tens of seconds on accounts
  // whose iOS steps keep the 90-day window stale, and the coverage probe
  // falls back to live SQL meanwhile. Registered so the suite's settle hook
  // and the statement counter can await it.
  trackBackgroundTask(runDetached(() => ensureUserRollupsFresh(userId)));

  // v1.4.36 — per-type coverage probe replaces the legacy global
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
  // One read of the user's source ladder for the whole slice; the passes that
  // need no result of the aggregate round start beside it
  // (`summaries-slice-passes.ts`).
  const priorityJson = await loadUserSourcePriority(userId);
  const passes = startSlicePasses(userId, priorityJson, coverage);
  if (isFullyCovered(coverage)) {
    return passes.apply(
      await computeFromRollups(userId, now, priorityJson, passes),
    );
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
  return passes.apply(
    await computeFromLiveAggregate(userId, now, priorityJson, passes),
  );
}

/**
 * The one cache cell of the summaries slice. The tile-strip route, the thick
 * analytics body and the dashboard snapshot all read the slice; each used to
 * compute it inside its own cell, so one dashboard mount built it up to three
 * times over the same rows.
 *
 * `serveStale` is for the caller that answers the client with the slice
 * itself. The composing callers are stale-while-revalidate cells of their
 * own and read fresh-only: a background refresh after a write must not
 * compose the pre-write slice and cache it again as fresh.
 */
export async function readSummariesSlice(
  userId: string,
  options: { coverage?: RollupCoverageMap; serveStale?: boolean } = {},
): Promise<SummariesSlice> {
  const cache = caches.analytics as ServerCache<SummariesSlice>;
  const key = summariesSliceCacheKey(userId);
  const build = () => computeSummariesSlice(userId, options.coverage);
  const { value, outcome } = options.serveStale
    ? await cache.wrapSwr(key, build)
    : await cache.wrap(key, build);
  annotate({ meta: { "cache.summaries_slice.outcome": outcome } });
  return value;
}

export function summariesSliceCacheKey(userId: string): string {
  return `${userId}|summaries`;
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
async function computeFromRollups(
  userId: string,
  now: Date,
  priorityJson: unknown,
  passes: SlicePasses,
): Promise<SummariesSlice> {
  // The rank CASEs collapse overlapping sources to the canonical reading per
  // (type, day) inside each query (unqualified and per-source columns).
  const rankUnqualified = buildSourceRankCase(
    priorityJson,
    '"type"',
    '"source"',
  );
  const rankPerSource = buildSourceRankCase(
    priorityJson,
    'p."type"',
    'p."source"',
  );

  // v1.37.19 — where the fold window starts. DAY rollup buckets
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
  const nowMs = now.getTime();
  const foldSplit = startOfUtcDay(new Date(nowMs - ROLLUP_FOLD_WINDOW_MS));

  const [narrows, latests, dayBuckets, accumulatorRows, preFoldRemainder] =
    await Promise.all([
      // Over the canonical source per (type, day) only, so the 90-day means
      // and median never blend two devices that both reported the same
      // vital; the whole days before today come from a closed block
      // (`canonical-window.ts`). The window means weigh each day once for an
      // hourly-mean type; the median stays over every reading.
      readCanonicalWindow(userId, now, priorityJson, rankUnqualified),
      passes.withLatests(readLatestCanonical(userId, priorityJson)),
      // v1.4.37.2 — the v1.4.35 implementation read EVERY DAY
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
        ORDER BY "type", "bucket_start", (${rankUnqualified}), "source"::text
      )
      SELECT
        "type"::text                                       AS type,
        SUM("count")::int                                  AS count,
        COUNT(*)::int                                      AS days,
        MIN("min_value")::double precision                 AS min,
        MAX("max_value")::double precision                 AS max,
        -- An hourly-mean type (pulse): every day once, the DAY mean already
        -- being the mean of its hours' means. Every other type: every
        -- reading once.
        (CASE WHEN ${isHourlyMeanTypeSql('"type"')}
          THEN AVG("mean")::double precision
          ELSE (
            SUM("count" * "mean")::double precision
            / NULLIF(SUM("count")::double precision, 0)
          )
        END)                                               AS mean
      FROM collapsed
      GROUP BY "type"
    `,
        userId,
        foldSplit,
      ),
      // v1.20.0 — trailing 90-day DAY rollup rows carrying the per-bucket
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
            gte: startOfUtcDay(new Date(nowMs - 90 * DAY_MS)),
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
      // The all-time remainder older than the fold window (a closed block,
      // see `pre-fold-remainder.ts`).
      readPreFoldRemainder(userId, foldSplit, priorityJson, rankPerSource),
    ]);

  const preFoldByType = new Map<
    string,
    { count: number; days: number; min: number; max: number; mean: number }
  >();
  for (const row of preFoldRemainder) {
    preFoldByType.set(row.type, {
      count: Number(row.count),
      days: Number(row.days),
      min: Number(row.min),
      max: Number(row.max),
      mean: Number(row.mean),
    });
  }

  // v1.20.0 — collapse the 90-day accumulator rows to the canonical
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
  // live `measured_at >= now - INTERVAL 'N days'` filter.
  const since7 = startOfUtcDay(new Date(nowMs - 7 * DAY_MS));
  const since30 = startOfUtcDay(new Date(nowMs - 30 * DAY_MS));
  const since90 = startOfUtcDay(new Date(nowMs - 90 * DAY_MS));

  const latestByType = new Map<string, number>();
  // v1.4.34 — capture the per-type `measured_at` alongside the
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

  for (const [type, measuredAt] of lastSeenAtByType.entries()) {
    const daysAgo = Math.floor((nowMs - measuredAt.getTime()) / DAY_MS);
    lastSeenByType[type] = {
      lastSeenAt: measuredAt.toISOString(),
      daysAgo,
    };
  }

  // v1.4.37.2 — the rollup aggregate is now shaped server-side
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
  // v1.20.0 — set once any in-window bucket carries a NULL
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
    // v1.20.0 — windowed slope / r² compose from the per-bucket
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
    // v1.37.19 — splice the pre-fold remainder into the all-time
    // figures: the rollup tier only covers the trailing fold window, so
    // count / min / max / mean composed from it alone truncated "all
    // time" to 5 y. Windowed fields (avg7/30, median, slopes) are
    // unaffected — their windows sit far inside the fold window.
    const pre = preFoldByType.get(row.type);
    const allCount = row.count + (pre?.count ?? 0);
    const allMin = pre ? Math.min(row.min, pre.min) : row.min;
    const allMax = pre ? Math.max(row.max, pre.max) : row.max;
    // Both halves weigh their days once for an hourly-mean type (pulse), so
    // they combine by day count; every other type combines by readings.
    const allMean = pre
      ? usesHourlyMeanDay(row.type)
        ? (row.mean * Number(row.days) + pre.mean * pre.days) /
          (Number(row.days) + pre.days)
        : (row.mean * row.count + pre.mean * pre.count) / allCount
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
      slope7: composeWindowedTrend(accBuckets, since7, 7),
      slope30: composeWindowedTrend(accBuckets, since30, 30),
      avg30LastMonth: round2(narrow?.avg30_last_month ?? null),
      avg30LastYear: null,
    };
    if (pre) totalRows += pre.count;
  }

  // v1.37.19 — a type whose ONLY rows are older than the fold
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

  // Populate `avg30LastYear` per type from the DAY rollup tier. Only types
  // with data in the current window are probed so we don't pay the per-type
  // round-trip on the long tail of unlogged measurement enums. Types with no
  // reading in the year-ago window surface as `null`.
  const lastYear = await passes.yearAgo(typesWithData, nowMs);
  let yearOverYearTypeCount = 0;
  for (const [type, value] of lastYear.entries()) {
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
          // v1.20.0 — slope / r² now compose from the rollup
          // accumulators (no live REGR_* scan). The median stays live
          // (PERCENTILE_CONT is non-composable); both sources are logged
          // per the "no silent cap" rule so a regression is observable.
          slope_source: "rollup",
          median_source: "live",
          // v1.20.0 — when a NULL accumulator (pre-0190 row, or boot
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
 *      Adding an outer `measured_at >= now - INTERVAL '90 days'`
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
  now: Date,
  priorityJson: unknown,
  passes: SlicePasses,
): Promise<SummariesSlice> {
  const nowMs = now.getTime();
  // v1.11.1 — collapse overlapping sources to the ladder-canonical reading per
  // (type, day) BEFORE aggregating, exactly as the rollup path does, so a
  // coverage-miss tenant gets the same numbers as a warm one (live/rollup
  // parity). `canonicalMeasurementsFrom` swaps `FROM measurements m` for a
  // canonical-source-filtered subquery; the latest read uses the ladder rank.
  const rankUnqualified = buildSourceRankCase(
    priorityJson,
    '"type"',
    '"source"',
  );

  const [allTime, windowed, latests] = await Promise.all([
    prisma.$queryRawUnsafe<AllTimeAggregateRow[]>(
      `
      WITH cm AS (${canonicalMeasurementsCte(rankUnqualified, { from: boundInstantSql(2), interval: ALL_TIME_LIVE_CAP_INTERVAL })}
      )
      SELECT
        m."type"::text                                                AS type,
        COUNT(*)                                                      AS count,
        MIN(m."value")::double precision                              AS min_value,
        MAX(m."value")::double precision                              AS max_value,
        ${windowMeanSql({ typeColumn: 'm."type"', value: 'm."value"', weight: "m.day_weight" })}::double precision
                                                                      AS mean_value
      FROM ${dayWeightedRows("cm", SESSION_DAY_FRAME)} m
      GROUP BY m."type"
    `,
      userId,
      now,
    ),
    prisma.$queryRawUnsafe<WindowedAggregateRow[]>(
      `
      WITH cm AS (${canonicalMeasurementsCte(rankUnqualified, { from: boundInstantSql(2), interval: "90 days" })}
      )
      SELECT
        m."type"::text                                                AS type,
        ${windowMeanColumnsSql(boundInstantSql(2))},
        PERCENTILE_CONT(0.5) WITHIN GROUP (
          ORDER BY m."value"
        )::double precision                                           AS median,
        ${liveTrendSql(boundInstantSql(2))}
      FROM ${dayWeightedRows("cm", SESSION_DAY_FRAME)} m
      GROUP BY m."type"
    `,
      userId,
      now,
    ),
    passes.withLatests(readLatestCanonical(userId, priorityJson)),
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

  for (const [type, measuredAt] of lastSeenAtByType.entries()) {
    const daysAgo = Math.floor((nowMs - measuredAt.getTime()) / DAY_MS);
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
      slope7: liveTrend(win, 7),
      slope30: liveTrend(win, 30),
      avg30LastMonth: round2(win?.avg30_last_month ?? null),
      avg30LastYear: null,
    };
  }

  // Even on the live-aggregate fallback (trailing DAY coverage incomplete),
  // the year-ago DAY buckets may already exist because the boot-time
  // backfill folds the whole history once per user, so a partial-coverage
  // cold mount still surfaces `avg30LastYear`.
  const lastYear = await passes.yearAgo(typesWithData, nowMs);
  let yearOverYearTypeCount = 0;
  for (const [type, value] of lastYear.entries()) {
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
