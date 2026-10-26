/**
 * The live-SQL slope windows and their trend evidence, as SELECT columns.
 *
 * The cold-fallback summaries (`summaries-slice.ts`, the comprehensive
 * aggregator) fit `slope7` / `slope30` with `REGR_SLOPE` over the canonical
 * readings. Whether a window may publish that slope is decided in JS by
 * `toTrendSlope` from the window's distinct reading days and their span (see
 * `MIN_TREND_DAYS` in `window-confidence.ts`); the evidence columns hand it
 * exactly that, over the same rows and the same window bounds, so the live
 * path withholds a slope on the same evidence the warm rollup path does
 * (`composeWindowedTrend`).
 *
 * The windows anchor on the UTC-midnight day boundary of the request's `now`
 * (`date_trunc('day', now) - N days`, the SQL twin of `startOfUtcDay(now - N
 * days)`), not on the instant, so the cold path counts the same boundary day
 * the warm path composes from: with an instant bound the boundary day flipped
 * in and out of the slope window across a warm-to-cold coverage transition.
 * `now` is a `boundInstantSql` expression (see `request-clock-sql.ts`).
 *
 * `measured_at` is a naive UTC timestamp, so `::date` is its UTC calendar
 * day, the day the rollup tier buckets by; `date - date` is whole days. It
 * expects the row alias `m` and a `GROUP BY` per type.
 */
import { assertInstantSql } from "@/lib/analytics/request-clock-sql";
import { toTrendSlope, type TrendSlope } from "@/lib/analytics/trends";

function windowColumns(now: string, days: 7 | 30): string {
  const filter = `m."measured_at" >= (date_trunc('day', ${now}) - INTERVAL '${days} days')`;
  const x = `EXTRACT(EPOCH FROM m."measured_at") / 86400.0`;
  const r2 = days === 7 ? "r2_7" : "r2_30";
  return `REGR_SLOPE(m."value", ${x}) FILTER (WHERE ${filter})::double precision AS slope${days},
        REGR_R2(m."value", ${x}) FILTER (WHERE ${filter})::double precision AS ${r2},
        COUNT(DISTINCT m."measured_at"::date) FILTER (WHERE ${filter})::int AS days${days},
        (MAX(m."measured_at"::date) FILTER (WHERE ${filter})
          - MIN(m."measured_at"::date) FILTER (WHERE ${filter}))::int AS span${days}`;
}

/** `slope7, r2_7, days7, span7` and the 30-day four for a per-type live aggregate. */
export function liveTrendSql(now: string): string {
  const at = assertInstantSql(now);
  return `${windowColumns(at, 7)},
        ${windowColumns(at, 30)}`;
}

/** The slope, r² and evidence columns a live per-type aggregate returns. */
export interface LiveTrendColumns {
  slope7: number | null;
  r2_7: number | null;
  slope30: number | null;
  r2_30: number | null;
  /** UTC days holding a reading in each slope window, and their span. */
  days7: number | null;
  span7: number | null;
  days30: number | null;
  span30: number | null;
}

/** The published trend of one live window, gated on its evidence columns. */
export function liveTrend(
  row: LiveTrendColumns | undefined,
  windowDays: 7 | 30,
): TrendSlope | null {
  if (!row) return null;
  const [slope, r2, days, span] =
    windowDays === 7
      ? [row.slope7, row.r2_7, row.days7, row.span7]
      : [row.slope30, row.r2_30, row.days30, row.span30];
  return toTrendSlope(
    slope,
    r2,
    { days: days ?? 0, spanDays: span ?? 0 },
    windowDays,
  );
}
