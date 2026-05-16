/**
 * v1.4.35 — SQL-driven aggregator for `/api/insights/comprehensive`.
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
 * The new shape mirrors the `summaries-slice` aggregator
 * (`src/lib/analytics/summaries-slice.ts`) the v1.4.33 C1 dashboard
 * tile strip already proved out: a single `$queryRaw` per surface,
 * grouped by `type`, with Postgres-side `AVG` / `MIN` / `MAX` /
 * `REGR_SLOPE` / `REGR_R2` against the index path
 * `measurements (user_id, type, measured_at)`. Difference vs. the
 * slim slice: the comprehensive endpoint also needs `anomalyCount`,
 * `avg30LastMonth`, `avg30LastYear`, and the 90-day window cap.
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

/** Daily-mean per (type, day) for correlation pairings. */
export interface DailyAggregateRow {
  type: string;
  day: string;
  mean_value: number;
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
 * Three SQL passes against the same `(user_id, type, measured_at)`
 * index, all targeting the trailing 90 days:
 *
 *   1. Per-type aggregate (count + min/max/mean/stddev + windowed
 *      avgs + regr_slope/r2 for the 7/30/90-day slopes).
 *   2. `DISTINCT ON (type)` for the most-recent raw value per type.
 *   3. Per-type-per-day mean (`date_trunc('day', measured_at)`) for the
 *      correlation pairings and the daily-bucket consumers.
 *
 * Plus two bounded raw-row queries for sys / dia (BP target pairing
 * needs sub-day timestamps, can't be replaced by a daily mean).
 */
export async function buildComprehensiveAggregate(
  userId: string,
): Promise<ComprehensiveAggregate> {
  const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const [aggregates, latests, dailyRows, sysRaw, diaRaw] = await Promise.all([
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
    prisma.$queryRaw<DailyAggregateRow[]>`
      SELECT
        m."type"::text AS type,
        TO_CHAR(date_trunc('day', m."measured_at"), 'YYYY-MM-DD') AS day,
        (ROUND((AVG(m."value"))::numeric, 2))::double precision AS mean_value
      FROM measurements m
      WHERE m."user_id" = ${userId}
        AND m."measured_at" >= ${ninetyDaysAgo}
        AND m."type" IN ('WEIGHT', 'BLOOD_PRESSURE_SYS', 'PULSE')
      GROUP BY m."type", date_trunc('day', m."measured_at")
      ORDER BY m."type", day ASC
    `,
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

  // Seed only types that actually have rows — the legacy route only
  // populated `summaries[t]` when `data.length > 0`.
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
  const dailyByType: Record<string, Array<{ day: string; value: number }>> = {};
  for (const row of dailyRows) {
    const list = dailyByType[row.type] ?? [];
    list.push({ day: row.day, value: Number(row.mean_value) });
    dailyByType[row.type] = list;
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

