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
 * two SQL passes:
 *
 *   1. **`groupBy` + windowed aggregates** — one `$queryRaw` carrying
 *      `COUNT`/`MIN`/`MAX`/`AVG`, the 7-day and 30-day `AVG` slices
 *      via `FILTER`, plus `regr_slope` + `regr_r2` for the slope
 *      tuples at 7d / 30d / 90d windows. Postgres folds all of this
 *      into one index scan over `measurements WHERE user_id = …`.
 *
 *   2. **`DISTINCT ON (type)` latest read** — one `$queryRaw`
 *      returning the most-recent `(type, value)` pair per type so the
 *      slim shape can populate `latest`. `MAX(value)` would not do —
 *      we need the value of the row at `MAX(measured_at)`, not the
 *      largest value ever recorded.
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
}

export async function computeSummariesSlice(
  userId: string,
): Promise<SummariesSlice> {
  // The two passes run in parallel — they target the same index path
  // (`measurements (user_id, type, measured_at)`) but Postgres can
  // serve them off the buffer cache concurrently.
  const [aggregates, latests] = await Promise.all([
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
        m."value"::double precision AS value
      FROM measurements m
      WHERE m."user_id" = ${userId}
      ORDER BY m."type", m."measured_at" DESC
    `,
  ]);

  const latestByType = new Map<string, number>();
  for (const row of latests) {
    latestByType.set(row.type, Number(row.value));
  }

  // Seed every enum option so consumers can read `summaries.PULSE` and
  // get a deterministic empty shape rather than `undefined`. Mirrors
  // the default route which iterates `measurementTypeEnum.options`.
  const summaries: Record<string, DataSummary> = {};
  for (const type of measurementTypeEnum.options) {
    summaries[type] = emptySummary();
  }

  let totalRows = 0;
  for (const row of aggregates) {
    const count = Number(row.count);
    totalRows += count;
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

  return { summaries, bmi: null };
}
