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
 *     z-score loop. The Coach / insights paths still get it via the
 *     default slice.
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
import type { DataSummary } from "@/lib/analytics/trends";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { annotate } from "@/lib/logging/context";
import { ensureUserRollupsFresh } from "@/lib/rollups/measurement-rollups";
import {
  isFullyCovered,
  probeRollupCoverage,
} from "@/lib/rollups/measurement-coverage";
import { readBestGranularityRollups } from "@/lib/rollups/measurement-read-wmy";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Heavy aggregate row — used on the cold-mount fallback path where the
 * rollup table is empty and we need every per-type column out of one
 * SQL pass for the very first request.
 */
interface HeavyAggregateRow {
  type: string;
  count: bigint;
  min_value: number | null;
  max_value: number | null;
  mean_value: number | null;
  avg7: number | null;
  avg30: number | null;
  slope7: number | null;
  r2_7: number | null;
  slope30: number | null;
  r2_30: number | null;
  slope90: number | null;
  r2_90: number | null;
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
 * that materialised ~306k rows on a power-user account; the SQL now
 * does the aggregation server-side and hands back one row per type.
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
  slope7: number | null;
  r2_7: number | null;
  slope30: number | null;
  r2_30: number | null;
  slope90: number | null;
  r2_90: number | null;
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
    avg7: null,
    avg30: null,
    slope7: null,
    slope30: null,
    slope90: null,
    anomalyCount: 0,
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
}

export async function computeSummariesSlice(
  userId: string,
): Promise<SummariesSlice> {
  // v1.4.37.1 hotfix — fire-and-forget. See `src/app/api/analytics/route.ts`
  // for the full rationale: awaiting this on the read path can stall
  // the event loop for 30–60 s on power-user accounts whose iOS step
  // samples keep the 90-day window slightly stale. The downstream
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
  const coverage = await probeRollupCoverage(userId);
  if (isFullyCovered(coverage)) {
    return computeFromRollups(userId);
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
  return computeFromLiveAggregate(userId);
}

/**
 * Happy path — DAY buckets carry `count / min / max / mean`; a narrow
 * `$queryRaw` carries only the windowed avgs + regression columns the
 * buckets cannot reconstruct.
 */
async function computeFromRollups(userId: string): Promise<SummariesSlice> {
  const [narrows, latests, dayBuckets] = await Promise.all([
    prisma.$queryRaw<NarrowAggregateRow[]>`
      SELECT
        m."type"::text                                                AS type,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS avg7,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS avg30,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS slope7,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS r2_7,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS slope30,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS r2_30,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '90 days'
        )::double precision                                           AS slope90,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '90 days'
        )::double precision                                           AS r2_90
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
      GROUP BY m."type"
    `,
    prisma.$queryRaw<LatestRow[]>`
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
      ORDER BY m."type", m."measured_at" DESC
    `,
    // v1.4.37.2 hotfix — the v1.4.35 implementation read EVERY DAY
    // rollup bucket for the user (`findMany` without a `bucketStart`
    // window) and then composed `count / min / max / mean` in JS.
    // On a power-user account that materialised as a 306k-row
    // transfer + a JS loop = ~3.85 s per cache miss, even with the
    // rollup table hot. The slim slice's contract is the all-time
    // count / min / max / mean per type — exactly what a SQL
    // `GROUP BY type` returns in a single round-trip. Returns 8 rows
    // instead of 306k, brings the cache-miss cost into the < 100 ms
    // budget. The downstream `aggregateBuckets` call is bypassed
    // because the per-type aggregate is already shaped server-side.
    prisma.$queryRaw<RollupAggregateRow[]>`
      SELECT
        "type"::text                                       AS type,
        SUM("count")::int                                  AS count,
        MIN("min_value")::double precision                 AS min,
        MAX("max_value")::double precision                 AS max,
        (
          SUM("count" * "mean")::double precision
          / NULLIF(SUM("count")::double precision, 0)
        )                                                  AS mean
      FROM "measurement_rollups"
      WHERE "user_id" = ${userId}
        AND "granularity" = 'DAY'
      GROUP BY "type"
    `,
  ]);

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
  for (const row of dayBuckets) {
    if (!row.count || row.count <= 0) continue;
    typeCount += 1;
    totalRows += row.count;
    typesWithData.push(row.type);
    const narrow = narrowByType.get(row.type);
    const latest = latestByType.get(row.type) ?? null;
    summaries[row.type] = {
      count: row.count,
      latest,
      min: round2(row.min),
      max: round2(row.max),
      mean: round2(row.mean),
      avg7: round2(narrow?.avg7 ?? null),
      avg30: round2(narrow?.avg30 ?? null),
      slope7: buildSlope(narrow?.slope7 ?? null, narrow?.r2_7 ?? null),
      slope30: buildSlope(narrow?.slope30 ?? null, narrow?.r2_30 ?? null),
      slope90: buildSlope(narrow?.slope90 ?? null, narrow?.r2_90 ?? null),
      anomalyCount: 0,
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
        },
      },
    },
  });

  return { summaries, bmi: null, lastSeenByType };
}

/**
 * Cold fallback — runs the legacy heavy aggregate when the rollup
 * table is empty for this user. Subsequent reads pick up the populated
 * rollup on `computeFromRollups`.
 */
async function computeFromLiveAggregate(
  userId: string,
): Promise<SummariesSlice> {
  const [aggregates, latests] = await Promise.all([
    prisma.$queryRaw<HeavyAggregateRow[]>`
      SELECT
        m."type"::text                                                AS type,
        COUNT(*)                                                      AS count,
        MIN(m."value")::double precision                              AS min_value,
        MAX(m."value")::double precision                              AS max_value,
        AVG(m."value")::double precision                              AS mean_value,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS avg7,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS avg30,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS slope7,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS r2_7,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS slope30,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS r2_30,
        REGR_SLOPE(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '90 days'
        )::double precision                                           AS slope90,
        REGR_R2(
          m."value",
          EXTRACT(EPOCH FROM m."measured_at") / 86400.0
        ) FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '90 days'
        )::double precision                                           AS r2_90
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
      GROUP BY m."type"
    `,
    prisma.$queryRaw<LatestRow[]>`
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."deleted_at" IS NULL
      ORDER BY m."type", m."measured_at" DESC
    `,
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

  let totalRows = 0;
  const typesWithData: string[] = [];
  for (const row of aggregates) {
    const count = Number(row.count);
    totalRows += count;
    typesWithData.push(row.type);
    const latest = latestByType.get(row.type) ?? null;
    summaries[row.type] = {
      count,
      latest,
      min: round2(row.min_value),
      max: round2(row.max_value),
      mean: round2(row.mean_value),
      avg7: round2(row.avg7),
      avg30: round2(row.avg30),
      slope7: buildSlope(row.slope7, row.r2_7),
      slope30: buildSlope(row.slope30, row.r2_30),
      slope90: buildSlope(row.slope90, row.r2_90),
      anomalyCount: 0,
      avg30LastMonth: null,
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
          type_count: aggregates.length,
          path: "live",
          year_over_year_types: yearOverYearTypeCount,
        },
      },
    },
  });

  return { summaries, bmi: null, lastSeenByType };
}

/**
 * v1.4.39 W-WMY — long-window summary for a single `(userId, type)`
 * pair, served from the WEEK / MONTH / YEAR rollup tier when the
 * window justifies it.
 *
 * Why this helper exists
 * ----------------------
 * The slim `computeSummariesSlice` caps its windowed columns at 90 d
 * (`slope7 / slope30 / slope90`). The v1.5 multi-year trend feature
 * + the Coach drawer's "history" tile need linearly composable stats
 * (count / min / max / mean / sum) over much larger windows — 1 y,
 * 2 y, 3 y. Hitting the live `measurements` table for a 3-year span
 * walks every row the user has ever logged for that type, which on
 * Marc's tenant is tens of thousands of rows per type.
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
 * Returns a `type → mean | null` map; types with no coverage at any
 * granularity (or no buckets in the year-ago slice) map to `null` so
 * the caller can blanket-assign without per-type null-checking.
 */
async function computeAvg30LastYearMap(
  userId: string,
  types: ReadonlyArray<string>,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (types.length === 0) return out;
  const results = await Promise.all(
    types.map(async (type) => {
      const value = await computeAvg30LastYearForType(
        userId,
        type as MeasurementType,
      );
      return [type, value] as const;
    }),
  );
  for (const [type, value] of results) {
    out.set(type, value);
  }
  return out;
}
