/**
 * Source provenance (#1204, #1108, #576): for one metric, which sources
 * delivered values on a day, which one the source-priority ladder picked and
 * why, and two sources side by side over a range.
 *
 * Read-only and computed by the SAME SQL the canonical readers use. The pick
 * is made by `ORDER BY (rank), "source"::text` over one UTC day of one type,
 * with the rank CASE from `buildSourceRankCase`: exactly the ordering inside
 * `canonicalMeasurementsCte`'s `DISTINCT ON`, which the charts, the rollups
 * and the summaries read through. The explanation is derived from the rank
 * that SQL returned, not recomputed beside it, so the page cannot say one
 * thing while the charts do another. `source-provenance.test.ts` holds the
 * TypeScript ladder reading to the CASE the SQL runs.
 *
 * Two facts the page states plainly because they follow from that rule:
 *  - the pick is per UTC day, the unit every ladder read works in;
 *  - a type without a ladder (glucose, body water, ...) is not collapsed at
 *    all: every source's readings count, so no source is "picked".
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  RANKED_TYPES,
  buildSourceRankCase,
} from "@/lib/analytics/source-rank-sql";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import { metricKeyForType } from "@/lib/measurements/cumulative-day-sum";
import { loadUserSourcePriority } from "@/lib/rollups/measurement-read";
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import { shiftDateKey } from "@/lib/tz/format";
import {
  getSourceLadder,
  parseSourcePriority,
} from "@/lib/validations/source-priority";
import { mean } from "@/lib/stats/central";

/** The rank the CASE gives a source that is not on the type's ladder. */
export const OFF_LADDER_RANK = 90;

const ENUM_RE = /^[A-Z0-9_]+$/;

/** How one day's value of a source is formed: a day total, or a mean. */
export function dayAggregation(type: MeasurementType): "sum" | "mean" {
  return type === "SLEEP_DURATION" || CUMULATIVE_HK_TYPES.has(type)
    ? "sum"
    : "mean";
}

export interface LadderReading {
  /** False for a type without a ladder: nothing is collapsed, nothing picked. */
  ranked: boolean;
  metricKey: string | null;
  /** The ladder as the person's settings resolve it, highest first. */
  ladder: string[];
}

/** The ladder a type is ranked by, read the way `buildSourceRankCase` reads it. */
export function ladderFor(
  priorityJson: unknown,
  type: MeasurementType,
): LadderReading {
  const metricKey = metricKeyForType(type);
  if (!RANKED_TYPES.includes(type) || !metricKey) {
    return { ranked: false, metricKey: metricKey ?? null, ladder: [] };
  }
  const ladder = [
    ...getSourceLadder(parseSourcePriority(priorityJson), metricKey),
  ];
  return { ranked: ladder.length > 0, metricKey, ladder };
}

/** The rank `buildSourceRankCase` assigns, computed from the ladder. */
export function ladderRank(ladder: readonly string[], source: string): number {
  const i = ladder.indexOf(source);
  return i === -1 ? OFF_LADDER_RANK : i;
}

export type PickReason =
  /** The day has one source; there was nothing to choose. */
  | "only_source"
  /** Picked because it stands highest on the ladder among the day's sources. */
  | "highest_on_ladder"
  /** None of the day's sources is on the ladder; the name decided. */
  | "name_tiebreak"
  /** No ladder for this type: every source counts. */
  | "not_ranked";

export type PassReason =
  /** Lower on the ladder than the picked source. */
  | "lower_on_ladder"
  /** Not on the ladder at all, below every source that is. */
  | "not_on_ladder"
  /** Same rank as the picked one (both off the ladder); the name decided. */
  | "name_tiebreak";

export interface SourceRow {
  source: string;
  /** The rank the SQL CASE returned; `OFF_LADDER_RANK` when not on the ladder. */
  rank: number;
  readings: number;
  /** The day's value from this source: total or mean (see `aggregation`). */
  value: number | null;
  min: number | null;
  max: number | null;
  firstAt: string;
  lastAt: string;
  unit: string | null;
  /** Device kinds the readings carry (watch, ring, ...); `unknown` when untagged. */
  devices: string[];
}

export interface DayProvenance {
  type: MeasurementType;
  /** The UTC day the pick is made for. */
  date: string;
  aggregation: "sum" | "mean";
  ranked: boolean;
  metricKey: string | null;
  ladder: string[];
  /** The source the canonical readers use for this day; null when not ranked or empty. */
  picked: string | null;
  pickReason: PickReason | null;
  sources: Array<SourceRow & { pass: PassReason | null }>;
}

interface RawSourceRow {
  source: string;
  rank: number;
  readings: number;
  total: number | null;
  asleep: number | null;
  mean: number | null;
  min: number | null;
  max: number | null;
  first_at: Date;
  last_at: Date;
  unit: string | null;
  devices: string[] | null;
}

/** UTC midnight to UTC midnight: the day the ladder pick is made for. */
function utcDayBounds(date: string): { from: Date; to: Date } {
  return {
    from: dayKeyAsUtcMidnight(date),
    to: dayKeyAsUtcMidnight(shiftDateKey(date, 1)),
  };
}

/**
 * Per (UTC day, source) aggregates for one type over `[from, to)`, ordered the
 * way the canonical pick orders them. The rank CASE and the tiebreak are
 * spliced from the same builder and in the same order as
 * `canonicalMeasurementsCte`; every request value is a bound parameter.
 */
async function readSourceDays(
  userId: string,
  priorityJson: unknown,
  type: MeasurementType,
  from: Date,
  to: Date,
): Promise<Array<RawSourceRow & { day: string }>> {
  if (!ENUM_RE.test(type)) {
    throw new Error(`unsafe enum literal for SQL splice: ${type}`);
  }
  const rank = buildSourceRankCase(priorityJson, '"type"', '"source"');
  return prisma.$queryRawUnsafe<Array<RawSourceRow & { day: string }>>(
    `
    SELECT
      to_char(date_trunc('day', "measured_at"), 'YYYY-MM-DD') AS day,
      "source"::text                                        AS source,
      (${rank})::int                                        AS rank,
      COUNT(*)::int                                         AS readings,
      SUM("value")::double precision                        AS total,
      SUM("value") FILTER (
        WHERE "sleep_stage" IS NULL
           OR "sleep_stage" NOT IN ('AWAKE'::"sleep_stage", 'IN_BED'::"sleep_stage")
      )::double precision                                   AS asleep,
      (SUM("value") / NULLIF(COUNT(*), 0))::double precision AS mean,
      MIN("value")::double precision                        AS min,
      MAX("value")::double precision                        AS max,
      MIN("measured_at")                                    AS first_at,
      MAX("measured_at")                                    AS last_at,
      MIN("unit")                                           AS unit,
      ARRAY_AGG(DISTINCT COALESCE("device_type", 'unknown')) AS devices
    FROM measurements
    WHERE "user_id" = $1
      AND "type" = '${type}'::"measurement_type"
      AND "deleted_at" IS NULL
      AND "measured_at" >= $2
      AND "measured_at" < $3
    GROUP BY date_trunc('day', "measured_at"), "type", "source"
    ORDER BY date_trunc('day', "measured_at"), (${rank}), "source"::text
    `,
    userId,
    from,
    to,
  );
}

function dayValue(type: MeasurementType, row: RawSourceRow): number | null {
  if (type === "SLEEP_DURATION") return row.asleep;
  return dayAggregation(type) === "sum" ? row.total : row.mean;
}

function toSourceRow(type: MeasurementType, row: RawSourceRow): SourceRow {
  return {
    source: row.source,
    rank: row.rank,
    readings: row.readings,
    value: dayValue(type, row),
    min: row.min,
    max: row.max,
    firstAt: row.first_at.toISOString(),
    lastAt: row.last_at.toISOString(),
    unit: row.unit,
    devices: [...(row.devices ?? [])].sort(),
  };
}

/**
 * Explain a day's pick from rows already in pick order (rank, then name).
 * Pure, so the reasoning is tested without a database.
 */
export function explainPick(
  ranked: boolean,
  rows: readonly SourceRow[],
): {
  picked: string | null;
  pickReason: PickReason | null;
  passes: Array<PassReason | null>;
} {
  if (rows.length === 0) {
    return { picked: null, pickReason: null, passes: [] };
  }
  if (!ranked) {
    return {
      picked: null,
      pickReason: "not_ranked",
      passes: rows.map(() => null),
    };
  }
  const winner = rows[0];
  const pickReason: PickReason =
    rows.length === 1
      ? "only_source"
      : winner.rank === OFF_LADDER_RANK
        ? "name_tiebreak"
        : "highest_on_ladder";
  const passes = rows.map((row, i): PassReason | null => {
    if (i === 0) return null;
    if (row.rank === winner.rank) return "name_tiebreak";
    return row.rank === OFF_LADDER_RANK ? "not_on_ladder" : "lower_on_ladder";
  });
  return { picked: winner.source, pickReason, passes };
}

export async function readDayProvenance(args: {
  userId: string;
  type: MeasurementType;
  date: string;
}): Promise<DayProvenance> {
  const { userId, type, date } = args;
  const priorityJson = await loadUserSourcePriority(userId);
  const ladder = ladderFor(priorityJson, type);
  const { from, to } = utcDayBounds(date);
  const raw = await readSourceDays(userId, priorityJson, type, from, to);
  const rows = raw.map((r) => toSourceRow(type, r));
  const { picked, pickReason, passes } = explainPick(ladder.ranked, rows);
  return {
    type,
    date,
    aggregation: dayAggregation(type),
    ranked: ladder.ranked,
    metricKey: ladder.metricKey,
    ladder: ladder.ladder,
    picked,
    pickReason,
    sources: rows.map((row, i) => ({ ...row, pass: passes[i] ?? null })),
  };
}

export interface CompareDay {
  date: string;
  a: number | null;
  b: number | null;
  /** The source the canonical readers use that day (among all its sources). */
  picked: string | null;
}

export interface SourceComparison {
  type: MeasurementType;
  from: string;
  to: string;
  aggregation: "sum" | "mean";
  ranked: boolean;
  ladder: string[];
  unit: string | null;
  /** Every source with readings in the range, by days covered. */
  sources: Array<{ source: string; days: number }>;
  a: string | null;
  b: string | null;
  days: CompareDay[];
  summary: {
    daysA: number;
    daysB: number;
    daysBoth: number;
    /** Means over the days both sources cover, so the two are comparable. */
    meanA: number | null;
    meanB: number | null;
    /** Mean of (b − a) over the days both cover. */
    meanDifference: number | null;
    meanAbsoluteDifference: number | null;
    /** Days each source was the one the ladder picked. */
    pickedA: number;
    pickedB: number;
  };
}

/** Pure assembly of a comparison from per-(day, source) rows in pick order. */
export function buildComparison(args: {
  type: MeasurementType;
  from: string;
  to: string;
  ranked: boolean;
  ladder: string[];
  rows: ReadonlyArray<SourceRow & { day: string }>;
  a?: string | null;
  b?: string | null;
}): SourceComparison {
  const { type, from, to, ranked, ladder, rows } = args;
  const byDay = new Map<string, Array<SourceRow & { day: string }>>();
  const coverage = new Map<string, number>();
  for (const row of rows) {
    const list = byDay.get(row.day) ?? [];
    list.push(row);
    byDay.set(row.day, list);
    coverage.set(row.source, (coverage.get(row.source) ?? 0) + 1);
  }
  const sources = [...coverage]
    .map(([source, days]) => ({ source, days }))
    .sort((x, y) => y.days - x.days || x.source.localeCompare(y.source));
  const a = args.a ?? sources[0]?.source ?? null;
  const b = args.b ?? sources.find((s) => s.source !== a)?.source ?? null;

  const days: CompareDay[] = [...byDay.keys()].sort().map((date) => {
    const list = byDay.get(date) ?? [];
    const pick = explainPick(ranked, list);
    return {
      date,
      a: list.find((r) => r.source === a)?.value ?? null,
      b: list.find((r) => r.source === b)?.value ?? null,
      picked: pick.picked,
    };
  });

  const both = days.filter((d) => d.a !== null && d.b !== null);
  return {
    type,
    from,
    to,
    aggregation: dayAggregation(type),
    ranked,
    ladder,
    unit: rows.find((r) => r.unit)?.unit ?? null,
    sources,
    a,
    b,
    days,
    summary: {
      daysA: days.filter((d) => d.a !== null).length,
      daysB: days.filter((d) => d.b !== null).length,
      daysBoth: both.length,
      meanA: mean(both.map((d) => d.a as number)),
      meanB: mean(both.map((d) => d.b as number)),
      meanDifference: mean(both.map((d) => (d.b as number) - (d.a as number))),
      meanAbsoluteDifference: mean(
        both.map((d) => Math.abs((d.b as number) - (d.a as number))),
      ),
      pickedA: days.filter((d) => a !== null && d.picked === a).length,
      pickedB: days.filter((d) => b !== null && d.picked === b).length,
    },
  };
}

export async function readSourceComparison(args: {
  userId: string;
  type: MeasurementType;
  /** Inclusive UTC days. */
  from: string;
  to: string;
  a?: string | null;
  b?: string | null;
}): Promise<SourceComparison> {
  const { userId, type, from, to } = args;
  const priorityJson = await loadUserSourcePriority(userId);
  const ladder = ladderFor(priorityJson, type);
  const raw = await readSourceDays(
    userId,
    priorityJson,
    type,
    utcDayBounds(from).from,
    utcDayBounds(to).to,
  );
  return buildComparison({
    type,
    from,
    to,
    ranked: ladder.ranked,
    ladder: ladder.ladder,
    rows: raw.map((r) => ({ ...toSourceRow(type, r), day: r.day })),
    a: args.a,
    b: args.b,
  });
}
