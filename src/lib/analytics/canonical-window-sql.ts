/**
 * The statements behind the 90-day canonical window aggregate
 * (`canonical-window.ts`): the 7- and 30-day means, the mean of the month
 * before, and the 90-day median per type, each over the ladder-canonical
 * source of every (type, UTC day).
 *
 * Neither statement ranks raw readings. Each folds the readings first into
 * cells, one per (type, source, UTC hour, value) and, where a window edge
 * cuts an hour, per side of the edge (a hash aggregate: a dense pulse day of
 * 35 000 readings is a few hundred cells), and picks the canonical source
 * per (type, day) over the cells. The pick sees the same set of sources per
 * day as a pick over the rows, so it names the same source; the order is
 * the one `canonicalMeasurementsCte` uses (ladder rank, then source name).
 *
 * The user id is bound as `$1`, every instant is a bound parameter, and the
 * rank CASE is the closed-enum splice from `buildSourceRankCase` over
 * unqualified `"type"` / `"source"` columns.
 */
import { boundInstantSql } from "@/lib/analytics/request-clock-sql";

/** One cell of readings: a value, how often it occurs, in one source's hour. */
export interface CanonicalCellRow {
  type: string;
  source: string;
  /** The UTC hour the readings fall in. */
  at: Date;
  value: number;
  n: number;
}

/** A closed-block row: an hour, a value of the window median, or a pick. */
export interface ClosedWindowRow {
  kind: "hour" | "value" | "pick";
  type: string;
  /** The hour (`hour`) or the UTC day (`pick`). */
  at: Date | null;
  value: number | null;
  n: number | null;
  /** The sum of the hour's readings (`hour`). */
  total: number | null;
  source: string | null;
}

/** An edge cell, with the side of each window edge it lies on. */
export interface EdgeCellRow extends CanonicalCellRow {
  in7: boolean;
  in30: boolean;
  in60: boolean;
  /**
   * The canonical source of its (type, day) for a cell on a day the edge
   * read holds whole within the window (the window's first day, today and
   * after), `null` for a cell of a cut hour, whose day the block picks.
   */
  pick: string | null;
}

function assertRank(rankUnqualified: string): string {
  // The CASE is built from closed enum literals; anything that could end the
  // expression early (a statement separator, a comment) is refused.
  if (/;|--|\/\*/.test(rankUnqualified)) {
    throw new Error("unsafe rank expression for SQL splice");
  }
  return rankUnqualified;
}

/**
 * The closed block: every reading in `[$2, $3)` (whole UTC days), folded to
 * the canonical source's hours (count and sum), the window median's value
 * counts, and the pick per (type, day).
 */
export function closedWindowSql(rankUnqualified: string): string {
  const rank = assertRank(rankUnqualified);
  return `
      WITH cells AS (
        SELECT mm."type", mm."source",
          date_trunc('hour', mm."measured_at") AS h,
          mm."value",
          COUNT(*)::int AS n
        FROM measurements mm
        WHERE mm."user_id" = $1
          AND mm."deleted_at" IS NULL
          AND mm."measured_at" >= ${boundInstantSql(2)}
          AND mm."measured_at" < ${boundInstantSql(3)}
        GROUP BY 1, 2, 3, 4
      ),
      canon AS (
        SELECT r.*
        FROM (
          SELECT c.*,
            FIRST_VALUE(c."source") OVER (
              PARTITION BY c."type", date_trunc('day', c.h)
              ORDER BY (${rank}), c."source"::text
            ) AS pick
          FROM cells c
        ) r
        WHERE r."source" = r.pick
      )
      SELECT 'hour' AS kind, k."type"::text AS type, k.h AS at,
        NULL::double precision AS value, SUM(k.n)::int AS n,
        SUM(k."value" * k.n)::double precision AS total, NULL::text AS source
      FROM canon k
      GROUP BY k."type", k.h
      UNION ALL
      SELECT 'value', k."type"::text, NULL, k."value"::double precision,
        SUM(k.n)::int, NULL, NULL
      FROM canon k
      GROUP BY k."type", k."value"
      UNION ALL
      SELECT DISTINCT 'pick', k."type"::text, date_trunc('day', k.h), NULL::double precision,
        NULL::int, NULL::double precision, k."source"::text
      FROM canon k`;
}

/**
 * The edge read: the readings the closed block does not hold or cannot
 * split. `$2` is the request's `now`; the window's first day from
 * `now - 90 days` to `$3`, today from `$4` on (later days too, as the
 * window has no upper bound), and the three hours `$5`, `$6`, `$7` that the
 * 7-, 30- and 60-day edges cut. The days held whole carry their pick.
 */
export function edgeWindowSql(rankUnqualified: string): string {
  const rank = assertRank(rankUnqualified);
  const now = boundInstantSql(2);
  const b90End = boundInstantSql(3);
  const today = boundInstantSql(4);
  const cutHour = (param: number) =>
    `(mm."measured_at" >= ${boundInstantSql(param)} AND mm."measured_at" < ${boundInstantSql(param)} + INTERVAL '1 hour')`;
  return `
      WITH cells AS (
        SELECT mm."type", mm."source",
          date_trunc('hour', mm."measured_at") AS h,
          mm."value",
          (mm."measured_at" >= ${now} - INTERVAL '7 days') AS in7,
          (mm."measured_at" >= ${now} - INTERVAL '30 days') AS in30,
          (mm."measured_at" >= ${now} - INTERVAL '60 days') AS in60,
          COUNT(*)::int AS n
        FROM measurements mm
        WHERE mm."user_id" = $1
          AND mm."deleted_at" IS NULL
          AND mm."measured_at" >= ${now} - INTERVAL '90 days'
          AND (
            mm."measured_at" < ${b90End}
            OR mm."measured_at" >= ${today}
            OR ${cutHour(5)} OR ${cutHour(6)} OR ${cutHour(7)}
          )
        GROUP BY 1, 2, 3, 4, 5, 6, 7
      )
      SELECT c."type"::text AS type, c."source"::text AS source, c.h AS at,
        c."value"::double precision AS value, c.n, c.in7, c.in30, c.in60,
        (CASE WHEN c.h < ${b90End} OR c.h >= ${today} THEN
          FIRST_VALUE(c."source") OVER (
            PARTITION BY c."type", date_trunc('day', c.h), (c.h < ${b90End} OR c.h >= ${today})
            ORDER BY (${rank}), c."source"::text
          )::text
        END) AS pick
      FROM cells c`;
}
