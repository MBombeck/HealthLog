/**
 * The request's clock inside a live aggregate.
 *
 * A summary read cuts some of its windows in JS (`startOfUtcDay(now - 7 d)`
 * for the rollup slope, the `bucketStart` bound of the DAY buckets, the
 * staleness of `lastSeenAt`) and others in SQL (the 7- and 30-day means, the
 * 90-day canonical pick, the median). Those used to read `NOW()`, the
 * database's clock, so one response mixed two clocks: a reading on a window's
 * edge fell in or out with whichever host answered, and a process whose clock
 * is pinned (a test, a replayed request) saw its SQL windows cut hours or
 * days away from its JS ones. Every window is now cut against the one `now`
 * the request took, bound as a parameter.
 *
 * `measured_at` is a naive UTC timestamp. The driver sends a `Date` parameter
 * as an offset-free UTC string, so `$N::timestamp` keeps it as written,
 * whatever the session time zone; `::timestamptz` would read it in the
 * session zone and shift every bound outside UTC.
 */
import { windowMeanSql } from "@/lib/measurements/day-mean";

const BOUND_INSTANT_RE = /^\$[1-9][0-9]?::timestamp$/;
const INSTANT_LITERAL_RE =
  /^'\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}'::timestamp$/;

/** The `Date` bound at `$param`, as the naive UTC timestamp `measured_at` holds. */
export function boundInstantSql(param: number): string {
  if (!Number.isInteger(param) || param < 1 || param > 99) {
    throw new Error(`parameter index out of range for SQL splice: ${param}`);
  }
  return `$${param}::timestamp`;
}

/**
 * `at` as a naive UTC timestamp literal, for a fragment that several
 * statements splice at different parameter positions (`seriesRowsFrom`). It
 * is written from the `Date` itself, never from input, and checked against a
 * closed format at every splice point.
 */
export function instantLiteralSql(at: Date): string {
  if (Number.isNaN(at.getTime())) {
    throw new Error("invalid instant for SQL splice");
  }
  return `'${at.toISOString().slice(0, 23).replace("T", " ")}'::timestamp`;
}

/** Refuse anything but a `boundInstantSql` / `instantLiteralSql` expression. */
export function assertInstantSql(sql: string): string {
  if (!BOUND_INSTANT_RE.test(sql) && !INSTANT_LITERAL_RE.test(sql)) {
    throw new Error(`unsafe instant expression for SQL splice: ${sql}`);
  }
  return sql;
}

function windowedMean(filter: string): string {
  return windowMeanSql({
    typeColumn: 'm."type"',
    value: 'm."value"',
    weight: "m.day_weight",
    filter,
  });
}

/**
 * The 7-day window mean over canonical readings carrying a `day_weight` (see
 * `day-mean.ts`): the mean of the day values for an hourly-mean type (pulse),
 * the unchanged `AVG(value)` otherwise. Days are UTC days, the frame the
 * canonical-source pick and the rollup tier bucket by.
 */
export function avg7Sql(now: string): string {
  return windowedMean(
    `m."measured_at" >= ${assertInstantSql(now)} - INTERVAL '7 days'`,
  );
}

/**
 * `avg7`, `avg30` and `avg30_last_month` (days [30, 60) back, the tile's
 * delta callout) as SELECT columns over rows aliased `m`, grouped per type.
 */
export function windowMeanColumnsSql(now: string): string {
  const at = assertInstantSql(now);
  const avg30 = windowedMean(`m."measured_at" >= ${at} - INTERVAL '30 days'`);
  const lastMonth = windowedMean(
    `m."measured_at" >= ${at} - INTERVAL '60 days' AND m."measured_at" < ${at} - INTERVAL '30 days'`,
  );
  return `${avg7Sql(at)}::double precision AS avg7,
        ${avg30}::double precision AS avg30,
        ${lastMonth}::double precision AS avg30_last_month`;
}
