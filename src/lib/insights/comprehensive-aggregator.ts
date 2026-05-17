/**
 * v1.4.35 — SQL-driven aggregator for `/api/insights/comprehensive`,
 * with the partial read-swap onto `measurement_rollups` landed.
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
 * Read-swap (v1.4.35)
 * -------------------
 * Two surfaces now read from the persistent `measurement_rollups`
 * table instead of recomputing per request:
 *
 *   - **`count / min / max / mean`** per type — composed from the DAY
 *     rollup buckets via `aggregateBuckets` (sum of counts; min of
 *     mins; max of maxes; count-weighted mean). These four are
 *     linearly composable across DAY buckets, so the composed value
 *     is mathematically identical to the live `AVG` / `MIN` / `MAX`
 *     / `COUNT(*)` over the same rows. A defensive parity check
 *     against the live aggregate's `COUNT(*)` falls back to live SQL
 *     when divergence is detected — covers the cold-mount edge case
 *     where the rollup populator is mid-flight, or a sub-second race
 *     between the watermark check and the bucket read.
 *
 *   - **`dailyByType`** — read directly from the DAY rollup buckets
 *     keyed on (userId, type, granularity=DAY, bucketStart). The
 *     bucket's stored `mean` is the same `AVG(value)` per day the
 *     legacy SQL emitted via `date_trunc('day', measured_at)`, so
 *     downstream correlation pairings remain byte-shape stable.
 *
 * Everything else stays on live SQL:
 *   - `slope7 / r2_7`, `slope30 / r2_30`, `slope90 / r2_90` — slope
 *     and R² do **not** compose linearly across DAY buckets.
 *   - `stddev`, `anomalyCount` — same reason.
 *   - `avg7 / avg30 / avg30LastMonth` — these windows aren't aligned
 *     to DAY-bucket boundaries (the 7-day window slides relative to
 *     `NOW()`), so the live `FILTER (WHERE measured_at >= NOW() -
 *     INTERVAL '7 days')` clause is canonical.
 *   - `latest / latestMeasuredAt` — the `DISTINCT ON (type)` pass
 *     resolves the most recent raw row, which the bucket can't
 *     surface (it stores the day's mean, not the day's last value).
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

/**
 * Raw row from the aggregate query. Keyed on `MeasurementType`, with
 * windowed AVG/SLOPE/R2 expressions plus anomaly-detection inputs
 * (window-wide mean + stddev so we can compute the |z| > 2 count
 * client-side without a second pass over the raw rows).
 */
interface AggregateRow {
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
 * Five queries against the trailing 90 days, in parallel:
 *
 *   1. Per-type aggregate (count + min/max/mean/stddev + windowed
 *      avgs + regr_slope/r2 for the 7/30/90-day slopes). The
 *      `count / min / max / mean` columns are kept on this query as
 *      the live-SQL fallback for the v1.4.35 read-swap parity check.
 *   2. `DISTINCT ON (type)` for the most-recent raw value per type.
 *   3. DAY rollup buckets from `measurement_rollups` (v1.4.35) —
 *      composed into `count / min / max / mean` for the per-type
 *      summary and replayed as the `dailyByType` correlation feed.
 *   4. Bounded raw-row sys query for BP target pairing (sub-day
 *      timestamps, can't be replaced by a daily mean).
 *   5. Bounded raw-row dia query for BP target pairing.
 */
export async function buildComprehensiveAggregate(
  userId: string,
): Promise<ComprehensiveAggregate> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  // v1.4.35 — keep the persistent rollup table current before any
  // read fires. After this returns the DAY-granularity buckets for
  // the trailing 90 days reflect every measurement that landed before
  // this call (the per-write hook is synchronous on the DAY bucket,
  // and `ensureUserRollupsFresh` covers cold-mount / process-restart
  // cases). The bucket reads below depend on that guarantee.
  await ensureUserRollupsFresh(userId);

  const [aggregates, latests, dayBuckets, sysRaw, diaRaw] = await Promise.all([
    prisma.$queryRaw<AggregateRow[]>`
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
  ]);

  // ── avg30LastYear ─────────────────────────────────────────
  // The 90-day window guarantees this is null (no rows >= 365 days
  // old will appear) — preserves legacy semantics.

  const latestByType = new Map<string, { value: number; measuredAt: Date }>();
  for (const row of latests) {
    latestByType.set(row.type, {
      value: Number(row.value),
      measuredAt: new Date(row.measured_at),
    });
  }

  // v1.4.35 — partition DAY buckets by type so the per-type aggregate
  // loop below can compose `count / min / max / mean` from them in O(1).
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

  // Seed only types that actually have rows — the legacy route only
  // populated `summaries[t]` when `data.length > 0`.
  const summaries: Record<string, DataSummary> = {};
  let totalMeasurements = 0;
  let firstMeasurementAt: Date | null = null;

  for (const row of aggregates) {
    const liveCount = Number(row.count);
    // Compose count/min/max/mean from the DAY buckets when they agree
    // with the live `COUNT(*)`. Parity divergence (cold mount, rollup
    // populator mid-flight, watermark race) falls back to live SQL so
    // the response shape never serves a wrong value.
    const composed = aggregateBuckets(bucketsByType.get(row.type) ?? []);
    const useRollup = composed.count === liveCount;
    const count = useRollup ? composed.count : liveCount;
    totalMeasurements += count;
    const latest = latestByType.get(row.type);
    summaries[row.type] = {
      count,
      latest: latest?.value ?? null,
      min: useRollup ? round2(composed.min) : round2(row.min_value),
      max: useRollup ? round2(composed.max) : round2(row.max_value),
      mean: useRollup ? round2(composed.mean) : round2(row.mean_value),
      avg7: round2(row.avg7),
      avg30: round2(row.avg30),
      slope7: buildSlope(row.slope7, row.r2_7),
      slope30: buildSlope(row.slope30, row.r2_30),
      slope90: buildSlope(row.slope90, row.r2_90),
      anomalyCount: Number(row.anomaly_count),
      avg30LastMonth: round2(row.avg30_last_month),
      // Legacy semantics: the 90-day findMany window guarantees no
      // rows from a year ago. Always null.
      avg30LastYear: null,
    };
  }

  // ── firstMeasurementAt ───────────────────────────────────
  // Take the earliest `measuredAt` across the user's 90-day rows.
  // One extra cheap aggregate query keeps the route's `dataSpanDays`
  // truthful. Run lazily: skip when no aggregate rows came back
  // (totalMeasurements === 0).
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

  // ── daily-by-type ────────────────────────────────────────
  // v1.4.35 — sourced from the DAY rollup buckets. The legacy
  // implementation ran a dedicated `date_trunc('day', m."measured_at")`
  // GROUP BY scan and only returned the three types the correlation
  // pairings consume. We filter to the same three types here so
  // downstream consumers see a byte-identical shape, but the data
  // origin is now the persisted bucket — no extra SQL pass needed.
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

  return {
    summaries,
    bpRawRows: {
      sys: sysRaw.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
      dia: diaRaw.map((r) => ({ measuredAt: r.measuredAt, value: r.value })),
    },
    dailyByType,
    firstMeasurementAt,
    totalMeasurements,
  };
}

