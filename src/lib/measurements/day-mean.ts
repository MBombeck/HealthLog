/**
 * The one place that turns readings into a day value and a window mean for the
 * types in `HOURLY_MEAN_DAY_TYPES` (see `day-statistic.ts`).
 *
 * For such a type a day is the mean of its hours' means, each hour weighing
 * one, and a window of days is the mean of its day values, each day weighing
 * one. Count, min and max stay over every reading. Every other type keeps the
 * plain mean over its readings, computed exactly as before.
 *
 * "Day" and "hour" are the reader's own frame: a reader that buckets by the
 * user's local day passes that zone, a reader that buckets by the session's
 * (UTC) day passes `SESSION_DAY_FRAME`. The hours are always the hours of
 * that same frame, so a day never splits an hour.
 *
 * Two shapes are offered, one per kind of reader:
 *
 *   - TypeScript, for readers that hold the readings in memory:
 *     `readingsMean`, `dayValue` and `dayValueRows`.
 *   - SQL, for readers that aggregate in Postgres: `dayWeightedRows` attaches
 *     a `day_weight` to every reading (1 / (readings in its hour × hours in its
 *     day) for an hourly-mean type, 1 otherwise), so a day's weights add up to
 *     one and `SUM(value * day_weight) / SUM(day_weight)` is the mean of the
 *     day values over any window. `windowMeanSql` and `foldMeanSql` build the
 *     mean expressions, falling back to the unchanged plain mean for every
 *     other type.
 *
 * Type lists are closed code constants checked against an enum-shaped regex
 * before they are spliced; every value (user id, zone, bounds) stays a bound
 * parameter of the caller's query.
 */
import { Prisma } from "@/generated/prisma/client";
import { tzOffsetMinutes } from "@/lib/tz/format";

import { HOURLY_MEAN_DAY_TYPES, usesHourlyMeanDay } from "./day-statistic";

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
/** Zone offsets change on quarter hours at the finest, so a quarter-hour slot shares one offset. */
const OFFSET_SLOT_MS = 15 * MS_PER_MINUTE;

export interface DayReading {
  value: number;
  measuredAt: Date;
}

// ─── TypeScript ───────────────────────────────────────────

/** Local wall-clock milliseconds of an instant, with a per-call offset cache. */
function makeLocalMs(tz: string): (at: Date) => number {
  const offsets = new Map<number, number>();
  return (at: Date) => {
    const t = at.getTime();
    const slot = Math.floor(t / OFFSET_SLOT_MS);
    let offset = offsets.get(slot);
    if (offset === undefined) {
      offset = tzOffsetMinutes(at, tz);
      offsets.set(slot, offset);
    }
    return t + offset * MS_PER_MINUTE;
  };
}

function plainMean(rows: readonly DayReading[]): number | null {
  if (rows.length === 0) return null;
  return rows.reduce((s, r) => s + r.value, 0) / rows.length;
}

/** Mean of the per-hour means of readings that share one day. */
function meanOfHourMeans(
  rows: readonly DayReading[],
  localMs: (at: Date) => number,
): number {
  const hours = new Map<number, { sum: number; n: number }>();
  for (const r of rows) {
    const hour = Math.floor(localMs(r.measuredAt) / MS_PER_HOUR);
    const acc = hours.get(hour);
    if (acc) {
      acc.sum += r.value;
      acc.n += 1;
    } else {
      hours.set(hour, { sum: r.value, n: 1 });
    }
  }
  let sum = 0;
  for (const h of hours.values()) sum += h.sum / h.n;
  return sum / hours.size;
}

/** Group readings by local day (days since the epoch in `tz`). */
function groupByLocalDay<T extends DayReading>(
  rows: readonly T[],
  localMs: (at: Date) => number,
): Map<number, T[]> {
  const days = new Map<number, T[]>();
  for (const r of rows) {
    const day = Math.floor(localMs(r.measuredAt) / MS_PER_DAY);
    const list = days.get(day);
    if (list) list.push(r);
    else days.set(day, [r]);
  }
  return days;
}

/**
 * The value of ONE day's readings: the mean of its local hours' means for an
 * hourly-mean type, the plain mean otherwise. `null` for no readings.
 */
export function dayValue(
  type: string,
  rows: readonly DayReading[],
  tz: string,
): number | null {
  if (rows.length === 0) return null;
  if (!usesHourlyMeanDay(type)) return plainMean(rows);
  return meanOfHourMeans(rows, makeLocalMs(tz));
}

/**
 * The mean of a window of readings: for an hourly-mean type the mean of its
 * local days' values (each day the mean of its hours' means), otherwise the
 * plain mean over every reading, summed left to right as the readers always
 * did. `null` for no readings.
 */
export function readingsMean(
  type: string,
  rows: readonly DayReading[],
  tz: string,
): number | null {
  if (rows.length === 0) return null;
  if (!usesHourlyMeanDay(type)) return plainMean(rows);
  const localMs = makeLocalMs(tz);
  let sum = 0;
  let days = 0;
  for (const dayRows of groupByLocalDay(rows, localMs).values()) {
    sum += meanOfHourMeans(dayRows, localMs);
    days += 1;
  }
  return sum / days;
}

/**
 * Readings of an hourly-mean type replaced by one row per local hour carrying
 * the hour's mean, stamped at the hour's first reading. A reader that already
 * folds its rows into day buckets by plain mean (and a window by mean of
 * those) then yields the hourly-mean day without knowing the statistic. Every
 * other type comes back untouched (the same array).
 */
export function hourMeanRows<T extends DayReading>(
  type: string,
  rows: readonly T[],
  tz: string,
): readonly DayReading[] {
  if (!usesHourlyMeanDay(type) || rows.length === 0) return rows;
  const localMs = makeLocalMs(tz);
  const hours = new Map<number, { sum: number; n: number; at: Date }>();
  for (const r of rows) {
    const hour = Math.floor(localMs(r.measuredAt) / MS_PER_HOUR);
    const acc = hours.get(hour);
    if (acc) {
      acc.sum += r.value;
      acc.n += 1;
      if (r.measuredAt < acc.at) acc.at = r.measuredAt;
    } else {
      hours.set(hour, { sum: r.value, n: 1, at: r.measuredAt });
    }
  }
  return [...hours.values()]
    .map((h) => ({ value: h.sum / h.n, measuredAt: h.at }))
    .sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
}

/**
 * Readings of an hourly-mean type replaced by one row per local day carrying
 * the day value, stamped at the day's first reading; a reader that folds rows
 * into a window by plain mean then weighs every day once. Every other type
 * comes back untouched (the same array).
 */
export function dayValueRows<T extends DayReading>(
  type: string,
  rows: readonly T[],
  tz: string,
): readonly DayReading[] {
  if (!usesHourlyMeanDay(type) || rows.length === 0) return rows;
  const localMs = makeLocalMs(tz);
  const out: DayReading[] = [];
  for (const dayRows of groupByLocalDay(rows, localMs).values()) {
    let first = dayRows[0].measuredAt;
    for (const r of dayRows) if (r.measuredAt < first) first = r.measuredAt;
    out.push({ value: meanOfHourMeans(dayRows, localMs), measuredAt: first });
  }
  return out.sort((a, b) => a.measuredAt.getTime() - b.measuredAt.getTime());
}

// ─── SQL ──────────────────────────────────────────────────

const ENUM_RE = /^[A-Z0-9_]+$/;

/** `'PULSE'` — the hourly-mean types as a spliceable text-literal list. */
export function hourlyMeanTypeLiterals(): string {
  return [...HOURLY_MEAN_DAY_TYPES]
    .map((t) => {
      if (!ENUM_RE.test(t)) {
        throw new Error(`unsafe enum literal for SQL splice: ${t}`);
      }
      return `'${t}'`;
    })
    .join(",");
}

/** SQL predicate: the type column names an hourly-mean type. */
export function isHourlyMeanTypeSql(typeColumn: string): string {
  return `(${typeColumn})::text IN (${hourlyMeanTypeLiterals()})`;
}

/**
 * The frame a reader buckets its days in. `SESSION_DAY_FRAME` is
 * `date_trunc('day', measured_at)` on the timestamptz itself, the frame of the
 * rollup tier and of every reader that groups by that expression. A zone frame
 * names a bound parameter (`$3`) or a Prisma placeholder carrying an IANA zone.
 */
export type DayFrame = { kind: "session" } | { kind: "zone"; tzSql: string };

export const SESSION_DAY_FRAME: DayFrame = { kind: "session" };

/** A zone frame whose zone is the caller's bound parameter `tzSql` (e.g. `$3`). */
export function zoneDayFrame(tzSql: string): DayFrame {
  if (!/^\$\d+$/.test(tzSql) && tzSql !== "'UTC'") {
    throw new Error(`zone frame must be a bound parameter: ${tzSql}`);
  }
  return { kind: "zone", tzSql };
}

function frameTs(frame: DayFrame, column: string): string {
  return frame.kind === "session"
    ? column
    : `((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${frame.tzSql})`;
}

function weightedRowsSql(
  source: string,
  frame: DayFrame,
  bySource: boolean,
): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(source)) {
    throw new Error(`source must be a CTE name: ${source}`);
  }
  const hourOf = (alias: string) =>
    `date_trunc('hour', ${frameTs(frame, `${alias}."measured_at"`)})`;
  const dayOf = (alias: string) =>
    `date_trunc('day', ${frameTs(frame, `${alias}."measured_at"`)})`;
  const src = bySource ? `, t."source"` : "";
  const part = bySource ? `, x."source"` : "";
  const join = bySource ? ` AND hw."source" = s."source"` : "";
  return `(
      SELECT s.*,
        (CASE WHEN ${isHourlyMeanTypeSql('s."type"')}
              THEN 1.0 / (hw.n * hw.hours)
              ELSE 1.0 END)::double precision AS day_weight
      FROM ${source} s
      LEFT JOIN (
        SELECT x."type"${part}, x.local_hour, x.n,
               COUNT(*) OVER (PARTITION BY x."type"${part}, x.local_day) AS hours
        FROM (
          SELECT t."type"${src},
                 ${hourOf("t")} AS local_hour,
                 ${dayOf("t")} AS local_day,
                 COUNT(*) AS n
          FROM ${source} t
          WHERE ${isHourlyMeanTypeSql('t."type"')}
          GROUP BY ${bySource ? "1, 2, 3, 4" : "1, 2, 3"}
        ) x
      ) hw
        ON hw."type" = s."type"${join}
       AND hw.local_hour = ${hourOf("s")}
    )`;
}

/**
 * A subquery over the CTE `source` (which must expose `type`, `measured_at`
 * and, with `bySource`, `source`) that adds `day_weight` to every row. Alias
 * it at the call site: `FROM ${dayWeightedRows("cm", frame)} m`.
 *
 * `bySource` keys the hours per source, for a reader that folds each source's
 * days before it picks one; a reader over one canonical source per day leaves
 * it off.
 */
export function dayWeightedRows(
  source: string,
  frame: DayFrame,
  opts: { bySource?: boolean } = {},
): string {
  return weightedRowsSql(source, frame, opts.bySource === true);
}

/**
 * The Prisma tagged-template twin of `dayWeightedRows`, for readers written
 * with `prisma.$queryRaw`: the zone, when given, is a bound parameter.
 */
export function dayWeightedRowsSql(
  source: string,
  tz: string | null,
  opts: { bySource?: boolean } = {},
): Prisma.Sql {
  if (tz === null) {
    return Prisma.raw(
      weightedRowsSql(source, SESSION_DAY_FRAME, opts.bySource === true),
    );
  }
  // Split around a placeholder so the zone binds as a parameter.
  const marker = "__DAY_MEAN_TZ__";
  const pieces = weightedRowsSql(
    source,
    { kind: "zone", tzSql: marker },
    opts.bySource === true,
  ).split(marker);
  let sql = Prisma.raw(pieces[0]);
  for (const piece of pieces.slice(1)) {
    sql = Prisma.sql`${sql}${tz}${Prisma.raw(piece)}`;
  }
  return sql;
}

/**
 * Window mean over weighted rows (`dayWeightedRows`): the mean of the day
 * values for an hourly-mean type, the unchanged `AVG(value)` otherwise. The
 * query groups by the type column (or filters to one type). `filter` is an
 * optional SQL predicate applied as an aggregate FILTER.
 */
export function windowMeanSql(opts: {
  typeColumn: string;
  value: string;
  weight: string;
  filter?: string;
}): string {
  const f = opts.filter ? ` FILTER (WHERE ${opts.filter})` : "";
  return `(CASE WHEN ${isHourlyMeanTypeSql(opts.typeColumn)}
      THEN SUM(${opts.value} * ${opts.weight})${f} / NULLIF(SUM(${opts.weight})${f}, 0)
      ELSE AVG(${opts.value})${f} END)`;
}

/**
 * Fold of per-day rows into a window mean: `SUM(wsum) / SUM(wdays)` (each day
 * once) for an hourly-mean type, the unchanged `SUM(total) / SUM(cnt)`
 * otherwise. `wsum` / `wdays` are `SUM(value * day_weight)` /
 * `SUM(day_weight)` per day.
 */
export function foldMeanSql(opts: {
  typeColumn: string;
  total: string;
  count: string;
  weightedSum: string;
  weightSum: string;
}): string {
  return `(CASE WHEN ${isHourlyMeanTypeSql(opts.typeColumn)}
      THEN SUM(${opts.weightedSum}) / NULLIF(SUM(${opts.weightSum}), 0)
      ELSE SUM(${opts.total}) / SUM(${opts.count}) END)`;
}
