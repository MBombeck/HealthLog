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

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
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

/** A monthly bucket: the month, the weighted value, the summed weight. */
export type MonthlyBucket = { month: string } & Record<string, number | string>;

/**
 * Weekly buckets folded into monthly ones, in time order. Each month's value
 * is the weekly values weighted by `weightField` (readings for a mean, doses
 * for an adherence rate), and the month carries the summed weight.
 */
export function weeklyToMonthly(
  weekly: ReadonlyArray<unknown>,
  valueField = "mean",
  weightField = "count",
): MonthlyBucket[] {
  const months = new Map<string, { sum: number; weight: number }>();
  for (const bucket of weekly) {
    if (!isRecord(bucket) || typeof bucket.weekISO !== "string") continue;
    const value = bucket[valueField];
    const weight = bucket[weightField];
    if (typeof value !== "number" || typeof weight !== "number") continue;
    const month = isoWeekMonth(bucket.weekISO);
    if (!month || weight <= 0) continue;
    const acc = months.get(month) ?? { sum: 0, weight: 0 };
    acc.sum += value * weight;
    acc.weight += weight;
    months.set(month, acc);
  }
  const places = valueField === "rate" ? 100 : 10;
  return Array.from(months.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { sum, weight }]) => ({
      month,
      [valueField]: Math.round((sum / weight) * places) / places,
      [weightField]: weight,
    }));
}

/**
 * One value series inside a block: where its rows live (`container`), which
 * field of a daily row holds the value, and which weekly field holds the
 * period value and its weight. The blocks name these differently: sleep
 * nights carry `minutes`, adherence days and weeks a `rate` over `total`
 * doses, blood pressure `sys`/`dia` beside separate weekly lists, glucose
 * one series per measurement context.
 */
interface Track {
  /** The summary key; null for a block with a single series. */
  name: string | null;
  container: Rec;
  field: string;
  weekly: string;
  monthly: string;
  weeklyValue: string;
  weight: string;
}

/** Which shape a snapshot block has, by its key. */
export type SeriesBlockKind =
  "value" | "bloodPressure" | "sleep" | "compliance" | "glucose" | "workouts";

export function seriesBlockKind(key: string): SeriesBlockKind {
  switch (key) {
    case "bloodPressure":
    case "sleep":
    case "compliance":
    case "glucose":
    case "workouts":
      return key;
    default:
      return "value";
  }
}

function tracksOf(kind: SeriesBlockKind, block: Rec): Track[] {
  const single = (container: unknown, field: string, name: string | null) =>
    isRecord(container)
      ? [
          {
            name,
            container,
            field,
            weekly: "weekly",
            monthly: "monthly",
            weeklyValue: field === "rate" ? "rate" : "mean",
            weight: field === "rate" ? "total" : "count",
          },
        ]
      : [];
  switch (kind) {
    case "value":
      return single(block.timeline, "value", null);
    case "sleep":
      return single(block.timeline, "minutes", null);
    case "compliance":
      return single(block.timeline, "rate", null);
    case "bloodPressure":
      if (!isRecord(block.timeline)) return [];
      return (["sys", "dia"] as const).map((name) => ({
        name,
        container: block.timeline as Rec,
        field: name,
        weekly: name === "sys" ? "weeklySys" : "weeklyDia",
        monthly: name === "sys" ? "monthlySys" : "monthlyDia",
        weeklyValue: "mean",
        weight: "count",
      }));
    case "glucose": {
      const byContext = block.byContext;
      if (!isRecord(byContext)) return [];
      return Object.keys(byContext).flatMap((ctx) =>
        single(byContext[ctx], "value", ctx),
      );
    }
    case "workouts":
      return [];
  }
}

/** Whether `condenseSeriesBlock` knows how to condense this block. */
export function isCondensable(key: string, block: unknown): boolean {
  if (!isRecord(block)) return false;
  const kind = seriesBlockKind(key);
  if (kind === "workouts") return Array.isArray(block.recent);
  return tracksOf(kind, block).length > 0;
}

function trackSummary(track: Track): SeriesSummary | null {
  const points: Array<{ at: string; value: number }> = [];
  const weekly = track.container[track.weekly];
  if (Array.isArray(weekly)) {
    for (const b of weekly) {
      if (!isRecord(b) || typeof b.weekISO !== "string") continue;
      const value = b[track.weeklyValue];
      if (typeof value === "number") points.push({ at: b.weekISO, value });
    }
  }
  const recent = track.container.recent;
  if (Array.isArray(recent)) {
    for (const row of recent) {
      if (!isRecord(row) || typeof row.date !== "string") continue;
      const value = row[track.field];
      if (typeof value === "number") points.push({ at: row.date, value });
    }
  }
  return summarisePoints(points);
}

function blockSummary(tracks: ReadonlyArray<Track>): unknown {
  const out: Rec = {};
  for (const track of tracks) {
    const summary = trackSummary(track);
    if (!summary) continue;
    if (track.name === null) return summary;
    out[track.name] = summary;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function note(block: Rec, text: string): void {
  const list = Array.isArray(block.condensed) ? block.condensed : [];
  if (!list.includes(text)) list.push(text);
  block.condensed = list;
}

/** Workout sessions a condensed block keeps (the list is newest first). */
export const KEEP_SESSIONS = 5;

/**
 * Take one condensing step on the block stored under `key`. Returns whether
 * anything changed; a block of a shape this module does not know is left
 * alone and reports false.
 */
export function condenseSeriesBlock(
  block: unknown,
  step: 1 | 2 | 3,
  key: string,
): boolean {
  if (!isRecord(block)) return false;
  const kind = seriesBlockKind(key);
  if (kind === "workouts") {
    // The sessions list is newest first; the per-sport rollup and the window
    // total already cover every session, so they stay whole.
    if (
      step === 1 &&
      Array.isArray(block.recent) &&
      block.recent.length > KEEP_SESSIONS
    ) {
      block.recent = block.recent.slice(0, KEEP_SESSIONS);
      note(
        block,
        `sessions: newest ${KEEP_SESSIONS} kept; perSport and totalInWindow cover the whole window`,
      );
      return true;
    }
    return false;
  }
  const tracks = tracksOf(kind, block);
  if (tracks.length === 0) return false;
  if (block.summary === undefined) {
    const summary = blockSummary(tracks);
    if (summary !== undefined) block.summary = summary;
  }
  const containers = new Set(tracks.map((t) => t.container));
  let changed = false;
  if (step === 1) {
    for (const container of containers) {
      if (
        Array.isArray(container.recent) &&
        container.recent.length > KEEP_DAILY_ROWS
      ) {
        container.recent = container.recent.slice(-KEEP_DAILY_ROWS);
        note(block, `daily values: newest ${KEEP_DAILY_ROWS} days kept`);
        changed = true;
      }
    }
  } else if (step === 2) {
    for (const track of tracks) {
      const weekly = track.container[track.weekly];
      if (!Array.isArray(weekly)) continue;
      track.container[track.monthly] = weeklyToMonthly(
        weekly,
        track.weeklyValue,
        track.weight,
      );
      delete track.container[track.weekly];
      note(block, "weekly values folded into monthly values");
      changed = true;
    }
  } else {
    for (const track of tracks) {
      const monthly = track.container[track.monthly];
      if (Array.isArray(monthly) && monthly.length > KEEP_MONTHLY_ROWS) {
        track.container[track.monthly] = monthly.slice(-KEEP_MONTHLY_ROWS);
        note(block, `monthly values: newest ${KEEP_MONTHLY_ROWS} months kept`);
        changed = true;
      }
    }
    const coarse = isRecord(block.timeline) ? block.timeline.coarse : undefined;
    if (isRecord(coarse) && ("monthly" in coarse || "anomalies" in coarse)) {
      delete coarse.monthly;
      delete coarse.anomalies;
      note(block, "coarse monthly band and anomalies left out");
      changed = true;
    }
  }
  return changed;
}
