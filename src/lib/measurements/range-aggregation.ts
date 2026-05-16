/**
 * v1.4.28 R3a FB-D2 (R1.2 H0) — server-side range aggregation for the
 * health-chart pipeline.
 *
 * Before: every chart navigation issued an unbounded `while (true)`
 * paginated walk of `/api/measurements?type=…` from the client and
 * bucketed the rows daily in the browser. For Apple-Health-rich
 * accounts (pulse every minute, months of history) this was tens of
 * thousands of rows per type per page visit.
 *
 * After: the chart sends `from` / `to` derived from the active range
 * selector and an optional `aggregate` hint. For ranges that exceed
 * `DAILY_AGGREGATE_THRESHOLD_DAYS` (90 d) the API hands back one row
 * per day per type; for ranges that exceed `WEEKLY_AGGREGATE_THRESHOLD_DAYS`
 * (365 d) the row grain is weekly. The downsampling keeps the chart's
 * visual fidelity (one point per visible bucket) while bounding the
 * payload regardless of underlying density.
 *
 * The helper is exported so the GET /api/measurements handler can pick
 * the bucket grain and so unit tests can lock the boundary conditions.
 */

export const DAILY_AGGREGATE_THRESHOLD_DAYS = 90;
export const WEEKLY_AGGREGATE_THRESHOLD_DAYS = 365;
export const MONTHLY_AGGREGATE_THRESHOLD_DAYS = 730;

export type AggregateGrain = "raw" | "daily" | "weekly" | "monthly";

/**
 * Maximum bucket count per grain. Bounds the aggregated response shape
 * so a multi-year window never paints more buckets than the chart can
 * reasonably absorb. Applied after bucketising, NOT before — the SQL
 * aggregation always sees the full row set inside the window.
 */
export const BUCKET_CAP: Record<Exclude<AggregateGrain, "raw">, number> = {
  daily: 365,
  weekly: 105, // ~2 years of weeks; the monthly grain kicks in past 730 d
  monthly: 24,
};

/**
 * Pick the bucket grain for a date window. `raw` returns the
 * measurements unchanged (legacy behaviour); `daily` collapses to one
 * row per UTC day per type with avg / count; `weekly` collapses to one
 * row per ISO week per type; `monthly` collapses to one row per UTC
 * calendar month per type.
 *
 * The thresholds favour the user's perceived smoothness over absolute
 * resolution. Charts that draw 7 / 30 / 90 days of pulse stay raw —
 * the in-browser daily bucket already does the right thing. Charts
 * past 90 d switch to daily, past 365 d to weekly, past 730 d to
 * monthly (the "All time" chart on a multi-year account).
 */
export function pickAggregateGrain(
  rangeDays: number,
  explicit?: AggregateGrain,
): AggregateGrain {
  if (explicit && explicit !== "raw") return explicit;
  if (rangeDays > MONTHLY_AGGREGATE_THRESHOLD_DAYS) return "monthly";
  if (rangeDays > WEEKLY_AGGREGATE_THRESHOLD_DAYS) return "weekly";
  if (rangeDays > DAILY_AGGREGATE_THRESHOLD_DAYS) return "daily";
  return "raw";
}

/**
 * Day count between two dates (inclusive of both ends).
 */
export function rangeLengthDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.max(1, Math.ceil(ms / 86_400_000));
}

export interface AggregatedRow {
  bucketStart: Date;
  type: string;
  avg: number;
  count: number;
}

interface RawRow {
  type: string;
  value: number;
  measuredAt: Date;
}

/**
 * In-memory daily / weekly / monthly aggregation. Used by the route's
 * fallback path and by the test harness — the production path runs the
 * `aggregateRowsSql` query so the take cap never applies before
 * bucketising (v1.4.28 R4-CODE-C1).
 */
export function aggregateRows(
  rows: RawRow[],
  grain: "daily" | "weekly" | "monthly",
): AggregatedRow[] {
  const buckets = new Map<
    string,
    { bucketStart: Date; type: string; sum: number; count: number }
  >();

  for (const row of rows) {
    const bucketStart = bucketStartFor(row.measuredAt, grain);
    const key = `${row.type}@${bucketStart.getTime()}`;
    const slot = buckets.get(key);
    if (slot) {
      slot.sum += row.value;
      slot.count += 1;
    } else {
      buckets.set(key, {
        bucketStart,
        type: row.type,
        sum: row.value,
        count: 1,
      });
    }
  }

  return Array.from(buckets.values())
    .map((s) => ({
      bucketStart: s.bucketStart,
      type: s.type,
      avg: s.sum / s.count,
      count: s.count,
    }))
    .sort((a, b) => a.bucketStart.getTime() - b.bucketStart.getTime());
}

function bucketStartFor(
  d: Date,
  grain: "daily" | "weekly" | "monthly",
): Date {
  if (grain === "daily") {
    return new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
    );
  }
  if (grain === "monthly") {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  }
  // Weekly — anchor to the start of the ISO week (Monday) in UTC.
  const day = d.getUTCDay() || 7; // Sunday → 7
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  monday.setUTCDate(monday.getUTCDate() - (day - 1));
  return monday;
}
