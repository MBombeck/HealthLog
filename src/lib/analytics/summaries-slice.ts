/**
 * v1.4.33 C1 — slim `summaries` slice for `/api/analytics?slice=summaries`.
 *
 * The default `/api/analytics` path fans out 30+ `Promise.all`-wrapped
 * chunked findMany reads (one per `MeasurementType`) so it can hand
 * each series to `summarize()` for slope7/30/90 + anomaly detection +
 * lastMonth/lastYear means. The dashboard tile strip only consumes
 * `count`, `latest`, `avg7`, `avg30`, `min`, `max`, `mean`, and the
 * three slope tuples — every other field gets `null`-coalesced before
 * it ever paints — yet the user waits on the full chunked walk.
 *
 * This helper resolves the same `DataSummary` shape (per-type) with
 * three passes (two SQL + one rollup-table read):
 *
 *   1. **`groupBy` + windowed aggregates** — one `$queryRaw` carrying
 *      `COUNT`/`MIN`/`MAX`/`AVG`, the 7-day and 30-day `AVG` slices
 *      via `FILTER`, plus `regr_slope` + `regr_r2` for the slope
 *      tuples at 7d / 30d / 90d windows. Postgres folds all of this
 *      into one index scan over `measurements WHERE user_id = …`.
 *      The `COUNT / MIN / MAX / AVG` columns stay on this pass as
 *      the live-SQL fallback for the v1.4.35 rollup parity check.
 *
 *   2. **`DISTINCT ON (type)` latest read** — one `$queryRaw`
 *      returning the most-recent `(type, value)` pair per type so the
 *      slim shape can populate `latest`. `MAX(value)` would not do —
 *      we need the value of the row at `MAX(measured_at)`, not the
 *      largest value ever recorded.
 *
 *   3. **`measurement_rollups` DAY-bucket read** (v1.4.35) — folded
 *      into `count / min / max / mean` via `aggregateBuckets`. Used
 *      when the composed count agrees byte-for-byte with the live
 *      `COUNT(*)`; falls back to live for accounts that never ran
 *      the explicit backfill or that are mid-flight on the populator.
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
import { prisma } from "@/lib/db";
import type { DataSummary } from "@/lib/analytics/trends";
import { measurementTypeEnum } from "@/lib/validations/measurement";
import { annotate } from "@/lib/logging/context";
import { ensureUserRollupsFresh } from "@/lib/measurements/rollups";
import { aggregateBuckets } from "@/lib/measurements/rollup-read";

interface AggregateRow {
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
  // v1.4.35 — keep the persistent rollup table current before the
  // bucket read fires. On a warm process this is a single watermark
  // query; on a cold mount it folds the trailing 90-day window into
  // the DAY rollup so the bucket read below has something to compose.
  await ensureUserRollupsFresh(userId);

  // Three passes in parallel. The first two target the same
  // `measurements (user_id, type, measured_at)` index path; the third
  // hits the much smaller `measurement_rollups` table (one row per
  // bucket, not per row). On users with a complete backfill the
  // bucket scan dominates only marginally; on un-backfilled users it
  // returns a short list and the parity check falls back to live.
  const [aggregates, latests, dayBuckets] = await Promise.all([
    prisma.$queryRaw<AggregateRow[]>`
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
      GROUP BY m."type"
    `,
    prisma.$queryRaw<LatestRow[]>`
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
      ORDER BY m."type", m."measured_at" DESC
    `,
    // v1.4.35 — every DAY rollup bucket for the user. The slim slice's
    // `count / min / max / mean` is all-time, so we read the bucket
    // table without a `bucketStart` window. The defensive parity
    // check below uses the live aggregate's `COUNT(*)` to decide
    // whether the rollup is complete for this account (post-backfill
    // → composed) or partial (pre-backfill → falls back to live).
    prisma.measurementRollup.findMany({
      where: { userId, granularity: "DAY" },
      orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
      select: {
        type: true,
        bucketStart: true,
        count: true,
        mean: true,
        minValue: true,
        maxValue: true,
      },
    }),
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

  // v1.4.35 — partition the DAY buckets by type so the per-type loop
  // can compose `count / min / max / mean` from them in O(1).
  const bucketsByType = new Map<
    string,
    Array<{
      day: Date;
      count: number;
      mean: number;
      minValue: number;
      maxValue: number;
    }>
  >();
  for (const b of dayBuckets) {
    const list = bucketsByType.get(b.type) ?? [];
    list.push({
      day: b.bucketStart,
      count: b.count,
      mean: b.mean,
      minValue: b.minValue,
      maxValue: b.maxValue,
    });
    bucketsByType.set(b.type, list);
  }

  let totalRows = 0;
  for (const row of aggregates) {
    const liveCount = Number(row.count);
    // Compose count/min/max/mean from the DAY buckets when the
    // composed count agrees with the live `COUNT(*)`. The slim slice's
    // window is all-time, so a divergent count signals either an
    // un-backfilled account (rollup only covers the trailing 90d
    // `ensureUserRollupsFresh` warmed up) or a mid-flight populator —
    // both cases want the live SQL values, which we already have.
    const composed = aggregateBuckets(bucketsByType.get(row.type) ?? []);
    const useRollup = composed.count === liveCount;
    const count = useRollup ? composed.count : liveCount;
    totalRows += count;
    const latest = latestByType.get(row.type) ?? null;
    summaries[row.type] = {
      count,
      latest,
      min: useRollup ? round2(composed.min) : round2(row.min_value),
      max: useRollup ? round2(composed.max) : round2(row.max_value),
      mean: useRollup ? round2(composed.mean) : round2(row.mean_value),
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

  annotate({
    action: { name: "analytics.get.slim" },
    meta: {
      analytics: {
        slim_summaries: {
          row_count: totalRows,
          type_count: aggregates.length,
        },
      },
    },
  });

  return { summaries, bmi: null, lastSeenByType };
}
