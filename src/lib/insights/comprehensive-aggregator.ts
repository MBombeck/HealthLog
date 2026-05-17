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
 *     and the `slope7 / slope30 / slope90` tuples. These don't compose
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
import { ensureUserRollupsFresh } from "@/lib/measurements/rollups";
import { aggregateBuckets } from "@/lib/measurements/rollup-read";
import {
  isFullyCovered,
  probeRollupCoverage,
} from "@/lib/measurements/rollup-coverage";

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
  slope90: number | null;
  r2_90: number | null;
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
  slope7: number | null;
  r2_7: number | null;
  slope30: number | null;
  r2_30: number | null;
  slope90: number | null;
  r2_90: number | null;
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

  // Keep the persistent rollup table current before any read fires.
  // After this returns the DAY-granularity buckets for the trailing
  // 90 days reflect every measurement that landed before this call
  // (the per-write hook is synchronous on the DAY bucket, and
  // `ensureUserRollupsFresh` covers cold-mount / process-restart).
  await ensureUserRollupsFresh(userId);

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
  const coverage = await probeRollupCoverage(userId);
  if (isFullyCovered(coverage)) {
    return buildFromRollups(userId, ninetyDaysAgo);
  }
  return buildFromLiveAggregate(userId, ninetyDaysAgo);
}

/**
 * Happy path — DAY buckets carry the composable stats; a narrow
 * `$queryRaw` carries only the windowed / regression columns the
 * buckets cannot reconstruct.
 */
async function buildFromRollups(
  userId: string,
  ninetyDaysAgo: Date,
): Promise<ComprehensiveAggregate> {
  const [narrows, latests, dayBuckets, sysRaw, diaRaw, firstRows] = await Promise.all([
    prisma.$queryRaw<NarrowAggregateRow[]>`
      WITH window_stats AS (
        SELECT
          m."type",
          AVG(m."value") AS mean_value,
          STDDEV_POP(m."value") AS stddev_value
        FROM measurements m
        WHERE m."user_id" = ${userId}
          AND m."measured_at" >= ${ninetyDaysAgo}
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
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '7 days'
        )::double precision                                           AS avg7,
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '30 days'
        )::double precision                                           AS avg30,
        -- Prior 30d window (days [30, 60) ago) used by tile delta callout.
        AVG(m."value") FILTER (
          WHERE m."measured_at" >= NOW() - INTERVAL '60 days'
            AND m."measured_at" <  NOW() - INTERVAL '30 days'
        )::double precision                                           AS avg30_last_month,
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
      JOIN window_stats ws ON ws."type" = m."type"
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${ninetyDaysAgo}
      GROUP BY m."type", ws.stddev_value
    `,
    prisma.$queryRaw<LatestRow[]>`
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${ninetyDaysAgo}
      ORDER BY m."type", m."measured_at" DESC
    `,
    // v1.4.35 — DAY rollup buckets for the trailing 90 days, every
    // type. Drives both the per-type `count / min / max / mean`
    // composition (via `aggregateBuckets`) and the `dailyByType`
    // correlation feed below. Replaces the legacy
    // `date_trunc('day', m."measured_at")` GROUP BY query and the
    // per-type AVG/MIN/MAX/COUNT columns the live aggregate kept.
    prisma.measurementRollup.findMany({
      where: {
        userId,
        granularity: "DAY",
        bucketStart: { gte: ninetyDaysAgo },
      },
      orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        type: "BLOOD_PRESSURE_SYS",
        measuredAt: { gte: ninetyDaysAgo },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        type: "BLOOD_PRESSURE_DIA",
        measuredAt: { gte: ninetyDaysAgo },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
    prisma.$queryRaw<Array<{ first_at: Date | null }>>`
      SELECT MIN(m."measured_at") AS first_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${ninetyDaysAgo}
    `,
  ]);

  const latestByType = new Map<string, { value: number; measuredAt: Date }>();
  for (const row of latests) {
    latestByType.set(row.type, {
      value: Number(row.value),
      measuredAt: new Date(row.measured_at),
    });
  }

  const bucketsByType = partitionBucketsByType(dayBuckets);
  const narrowByType = new Map<string, NarrowAggregateRow>();
  for (const row of narrows) {
    narrowByType.set(row.type, row);
  }

  const summaries: Record<string, DataSummary> = {};
  let totalMeasurements = 0;

  // Seed every type that has buckets — the bucket set is the source of
  // truth on this path. The narrow aggregate provides the non-composable
  // windowed columns alongside.
  for (const [type, buckets] of bucketsByType.entries()) {
    const composed = aggregateBuckets(buckets);
    if (composed.count === 0) continue;
    totalMeasurements += composed.count;
    const latest = latestByType.get(type);
    const narrow = narrowByType.get(type);
    summaries[type] = {
      count: composed.count,
      latest: latest?.value ?? null,
      min: round2(composed.min),
      max: round2(composed.max),
      mean: round2(composed.mean),
      avg7: round2(narrow?.avg7 ?? null),
      avg30: round2(narrow?.avg30 ?? null),
      slope7: buildSlope(narrow?.slope7 ?? null, narrow?.r2_7 ?? null),
      slope30: buildSlope(narrow?.slope30 ?? null, narrow?.r2_30 ?? null),
      slope90: buildSlope(narrow?.slope90 ?? null, narrow?.r2_90 ?? null),
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

  return {
    summaries,
    bpRawRows: {
      sys: sysRaw.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
      dia: diaRaw.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
    },
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
): Promise<ComprehensiveAggregate> {
  const [aggregates, latests, dayBuckets, sysRaw, diaRaw] = await Promise.all([
    prisma.$queryRaw<HeavyAggregateRow[]>`
      WITH window_stats AS (
        SELECT
          m."type",
          AVG(m."value") AS mean_value,
          STDDEV_POP(m."value") AS stddev_value
        FROM measurements m
        WHERE m."user_id" = ${userId}
          AND m."measured_at" >= ${ninetyDaysAgo}
        GROUP BY m."type"
      )
      SELECT
        m."type"::text                                                AS type,
        COUNT(*)                                                      AS count,
        MIN(m."value")::double precision                              AS min_value,
        MAX(m."value")::double precision                              AS max_value,
        AVG(m."value")::double precision                              AS mean_value,
        ws.stddev_value::double precision                             AS stddev_value,
        COUNT(*) FILTER (
          WHERE ws.stddev_value IS NOT NULL
            AND ws.stddev_value > 0
            AND ABS(
              (ROUND(((m."value" - ws.mean_value) / ws.stddev_value)::numeric, 2))
            ) > 2
        )                                                             AS anomaly_count,
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
      JOIN window_stats ws ON ws."type" = m."type"
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${ninetyDaysAgo}
      GROUP BY m."type", ws.stddev_value
    `,
    prisma.$queryRaw<LatestRow[]>`
      SELECT DISTINCT ON (m."type")
        m."type"::text AS type,
        m."value"::double precision AS value,
        m."measured_at" AS measured_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${ninetyDaysAgo}
      ORDER BY m."type", m."measured_at" DESC
    `,
    // Buckets may exist for some types even when the COUNT probe came
    // back zero (race window between the probe and a sibling
    // populator); the cold-path read still honours them for the
    // `dailyByType` feed.
    prisma.measurementRollup.findMany({
      where: {
        userId,
        granularity: "DAY",
        bucketStart: { gte: ninetyDaysAgo },
      },
      orderBy: [{ type: "asc" }, { bucketStart: "asc" }],
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        type: "BLOOD_PRESSURE_SYS",
        measuredAt: { gte: ninetyDaysAgo },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
    prisma.measurement.findMany({
      where: {
        userId,
        type: "BLOOD_PRESSURE_DIA",
        measuredAt: { gte: ninetyDaysAgo },
      },
      orderBy: { measuredAt: "asc" },
      select: { measuredAt: true, value: true },
    }),
  ]);

  const latestByType = new Map<string, { value: number; measuredAt: Date }>();
  for (const row of latests) {
    latestByType.set(row.type, {
      value: Number(row.value),
      measuredAt: new Date(row.measured_at),
    });
  }

  const bucketsByType = partitionBucketsByType(dayBuckets);

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
      avg7: round2(row.avg7),
      avg30: round2(row.avg30),
      slope7: buildSlope(row.slope7, row.r2_7),
      slope30: buildSlope(row.slope30, row.r2_30),
      slope90: buildSlope(row.slope90, row.r2_90),
      anomalyCount: Number(row.anomaly_count),
      avg30LastMonth: round2(row.avg30_last_month),
      avg30LastYear: null,
    };
  }

  if (totalMeasurements > 0) {
    const firstRows = await prisma.$queryRaw<Array<{ first_at: Date | null }>>`
      SELECT MIN(m."measured_at") AS first_at
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${ninetyDaysAgo}
    `;
    firstMeasurementAt = firstRows[0]?.first_at
      ? new Date(firstRows[0].first_at)
      : null;
  }

  return {
    summaries,
    bpRawRows: {
      sys: sysRaw.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
      dia: diaRaw.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
    },
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
function partitionBucketsByType(
  rows: ReadonlyArray<{
    type: string;
    bucketStart: Date;
    count: number;
    mean: number;
    minValue: number;
    maxValue: number;
  }>,
): Map<
  string,
  Array<{
    day: Date;
    count: number;
    mean: number;
    minValue: number;
    maxValue: number;
  }>
> {
  const map = new Map<
    string,
    Array<{
      day: Date;
      count: number;
      mean: number;
      minValue: number;
      maxValue: number;
    }>
  >();
  for (const b of rows) {
    const list = map.get(b.type) ?? [];
    list.push({
      day: b.bucketStart,
      count: b.count,
      mean: b.mean,
      minValue: b.minValue,
      maxValue: b.maxValue,
    });
    map.set(b.type, list);
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
      day: b.day.toISOString().slice(0, 10),
      // Match the legacy `ROUND(AVG, 2)::double precision` semantics
      // so correlation thresholds tuned against the v1.4.34 output
      // don't drift on the third decimal.
      value: round2(b.mean) ?? 0,
    }));
  }
  return dailyByType;
}

