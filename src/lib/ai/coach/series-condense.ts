/**
 * Condensing a requested series block to the prompt budget without emptying
 * it.
 *
 * The snapshot's budget pass sheds detail from a block in three steps: the
 * daily rows, then the weekly means, then the whole block for an
 * `{ omitted }` marker. For a block the read did not ask for that is right;
 * for the one it did ask for it leaves the model a block that says the
 * readings exist and holds no figure, and the model then says exactly that.
 *
 * A requested block is condensed instead. Before anything is cut it gains a
 * `summary` (first, last, min, max, mean and change over every point it held)
 * and each step after that keeps numbers:
 *
 *   1. the daily rows keep their newest `KEEP_DAILY_ROWS`;
 *   2. the weekly means fold into monthly means (count-weighted);
 *   3. the monthly means keep their newest `KEEP_MONTHLY_ROWS`, and the
 *      coarse monthly band and anomaly envelope go (the yearly band stays).
 *
 * Every step it took is named in `condensed`, so the block says what it no
 * longer carries. Pure over its input: no I/O, no clock.
 */
import { dateOnlyKey } from "@/lib/tz/date-only";

/** Daily rows a condensed block keeps, newest first in time order. */
export const KEEP_DAILY_ROWS = 7;
/** Monthly means a fully condensed block keeps. */
export const KEEP_MONTHLY_ROWS = 6;

export interface SeriesSummary {
  /** Earliest point's period: a day (`YYYY-MM-DD`) or an ISO week. */
  from: string;
  /** Newest point's period. */
  to: string;
  first: number;
  last: number;
  min: number;
  max: number;
  /** Mean of the points (daily and weekly means alike), not of readings. */
  mean: number;
  /** `last - first`. */
  change: number;
  /** How many points the figures above were taken over. */
  points: number;
}

interface WeeklyBucket {
  weekISO: string;
  mean: number;
  count: number;
}

export interface MonthlyBucket {
  month: string;
  mean: number;
  count: number;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function isWeekly(value: unknown): value is WeeklyBucket[] {
  return (
    Array.isArray(value) &&
    value.every(
      (b) =>
        isRecord(b) &&
        typeof b.weekISO === "string" &&
        typeof b.mean === "number" &&
        typeof b.count === "number",
    )
  );
}

/** ISO week `YYYY-Www` → the Monday that starts it, as `YYYY-MM-DD`. */
function isoWeekMonday(weekISO: string): string | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekISO);
  if (!match) return null;
  const jan4 = new Date(Date.UTC(Number(match[1]), 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(
    jan4.getUTCDate() -
      (jan4.getUTCDay() || 7) +
      1 +
      (Number(match[2]) - 1) * 7,
  );
  return dateOnlyKey(monday);
}

/**
 * A sortable key for a point's period. A week and a day do not compare as
 * strings ("2026-W30" sorts after "2026-09-01"), so a week sorts by its
 * Monday.
 */
function timeKey(at: string): string {
  return isoWeekMonday(at) ?? at;
}

/** Summary over points (any order), or null when there are none. */
export function summarisePoints(
  points: ReadonlyArray<{ at: string; value: number }>,
): SeriesSummary | null {
  const finite = points.filter((p) => Number.isFinite(p.value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) =>
    timeKey(a.at).localeCompare(timeKey(b.at)),
  );
  const values = sorted.map((p) => p.value);
  const first = values[0];
  const last = values[values.length - 1];
  return {
    from: sorted[0].at,
    to: sorted[sorted.length - 1].at,
    first,
    last,
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(values.reduce((s, v) => s + v, 0) / values.length),
    change: round(last - first),
    points: values.length,
  };
}

/**
 * The calendar month (`YYYY-MM`) an ISO week belongs to, by its Thursday —
 * the same day ISO 8601 uses to place a week in its year.
 */
export function isoWeekMonth(weekISO: string): string | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(weekISO);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const thursday = new Date(jan4);
  thursday.setUTCDate(jan4.getUTCDate() - jan4Day + 4 + (week - 1) * 7);
  return dateOnlyKey(thursday).slice(0, 7);
}

/** Weekly means folded into count-weighted monthly means, in time order. */
export function weeklyToMonthly(
  weekly: ReadonlyArray<WeeklyBucket>,
): MonthlyBucket[] {
  const months = new Map<string, { sum: number; count: number }>();
  for (const bucket of weekly) {
    const month = isoWeekMonth(bucket.weekISO);
    if (!month || bucket.count <= 0) continue;
    const acc = months.get(month) ?? { sum: 0, count: 0 };
    acc.sum += bucket.mean * bucket.count;
    acc.count += bucket.count;
    months.set(month, acc);
  }
  return Array.from(months.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { sum, count }]) => ({
      month,
      mean: Math.round((sum / count) * 10) / 10,
      count,
    }));
}

/**
 * The value series a timeline carries: `value` over `weekly` for a single
 * series, `sys`/`dia` over `weeklySys`/`weeklyDia` for blood pressure.
 */
const SERIES: ReadonlyArray<{
  name: string | null;
  field: string;
  weekly: string;
  monthly: string;
}> = [
  { name: null, field: "value", weekly: "weekly", monthly: "monthly" },
  { name: "sys", field: "sys", weekly: "weeklySys", monthly: "monthlySys" },
  { name: "dia", field: "dia", weekly: "weeklyDia", monthly: "monthlyDia" },
];

function blockSummary(timeline: Rec): unknown {
  const recent = Array.isArray(timeline.recent) ? timeline.recent : [];
  const out: Rec = {};
  for (const s of SERIES) {
    const points: Array<{ at: string; value: number }> = [];
    const weekly = timeline[s.weekly];
    if (isWeekly(weekly)) {
      for (const b of weekly) points.push({ at: b.weekISO, value: b.mean });
    }
    for (const row of recent) {
      if (isRecord(row) && typeof row.date === "string") {
        const value = row[s.field];
        if (typeof value === "number") points.push({ at: row.date, value });
      }
    }
    const summary = summarisePoints(points);
    if (summary) {
      if (s.name === null) return summary;
      out[s.name] = summary;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function note(block: Rec, text: string): void {
  const list = Array.isArray(block.condensed) ? block.condensed : [];
  if (!list.includes(text)) list.push(text);
  block.condensed = list;
}

/**
 * Take one condensing step on a block that carries a `timeline`. Returns
 * whether anything changed; a block without a timeline is left alone and
 * reports false.
 */
export function condenseSeriesBlock(block: unknown, step: 1 | 2 | 3): boolean {
  if (!isRecord(block) || !isRecord(block.timeline)) return false;
  const timeline = block.timeline;
  if (block.summary === undefined) {
    const summary = blockSummary(timeline);
    if (summary !== undefined) block.summary = summary;
  }
  let changed = false;
  if (step === 1) {
    if (
      Array.isArray(timeline.recent) &&
      timeline.recent.length > KEEP_DAILY_ROWS
    ) {
      timeline.recent = timeline.recent.slice(-KEEP_DAILY_ROWS);
      note(block, `daily values: newest ${KEEP_DAILY_ROWS} days kept`);
      changed = true;
    }
  } else if (step === 2) {
    for (const s of SERIES) {
      const weekly = timeline[s.weekly];
      if (!isWeekly(weekly)) continue;
      timeline[s.monthly] = weeklyToMonthly(weekly);
      delete timeline[s.weekly];
      note(block, "weekly means folded into monthly means");
      changed = true;
    }
  } else {
    for (const s of SERIES) {
      const monthly = timeline[s.monthly];
      if (Array.isArray(monthly) && monthly.length > KEEP_MONTHLY_ROWS) {
        timeline[s.monthly] = monthly.slice(-KEEP_MONTHLY_ROWS);
        note(block, `monthly means: newest ${KEEP_MONTHLY_ROWS} months kept`);
        changed = true;
      }
    }
    const coarse = timeline.coarse;
    if (isRecord(coarse) && ("monthly" in coarse || "anomalies" in coarse)) {
      delete coarse.monthly;
      delete coarse.anomalies;
      note(block, "coarse monthly band and anomalies left out");
      changed = true;
    }
  }
  return changed;
}
