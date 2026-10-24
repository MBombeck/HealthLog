/**
 * The trend evidence of the live-SQL slope windows, as SELECT columns.
 *
 * The cold-fallback summaries (`summaries-slice.ts`, the comprehensive
 * aggregator) fit `slope7` / `slope30` with `REGR_SLOPE` over the canonical
 * readings. Whether a window may publish that slope is decided in JS by
 * `toTrendSlope` from the window's distinct reading days and their span (see
 * `MIN_TREND_DAYS` in `window-confidence.ts`); these columns hand it exactly
 * that, over the same rows and the same UTC-midnight window bounds the
 * `REGR_*` FILTER clauses use, so the live path withholds a slope on the
 * same evidence the warm rollup path does (`composeWindowedTrend`).
 *
 * `measured_at` is a naive UTC timestamp, so `::date` is its UTC calendar
 * day, the day the rollup tier buckets by; `date - date` is whole days. The
 * text is a file literal with no input spliced in. It expects the row alias
 * `m` and a `GROUP BY` per type.
 */
import { toTrendSlope, type TrendSlope } from "@/lib/analytics/trends";

function windowFilter(days: 7 | 30): string {
  return `m."measured_at" >= (date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '${days} days')`;
}

function evidenceColumns(days: 7 | 30): string {
  const filter = windowFilter(days);
  return `COUNT(DISTINCT m."measured_at"::date) FILTER (WHERE ${filter})::int AS days${days},
        (MAX(m."measured_at"::date) FILTER (WHERE ${filter})
          - MIN(m."measured_at"::date) FILTER (WHERE ${filter}))::int AS span${days}`;
}

/** `days7, span7, days30, span30` for a per-type live aggregate. */
export const TREND_EVIDENCE_SQL = `${evidenceColumns(7)},
        ${evidenceColumns(30)}`;

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
