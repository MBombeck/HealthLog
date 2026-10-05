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
 * `summary` per series, taken from the series' daily values over the whole
 * read (not from the block's mix of daily and weekly means, where fourteen
 * days would weigh as much as fourteen weeks): the first and last day, the
 * lowest and highest day, the mean of the days, and the change from the
 * first week to the latest week. Each step after that keeps numbers:
 *
 *   1. the daily rows keep their newest `KEEP_DAILY_ROWS`;
 *   2. the weekly means fold into monthly means (count-weighted);
 *   3. the monthly means keep their newest `KEEP_MONTHLY_ROWS`, and the
 *      coarse monthly band and anomaly envelope go (the yearly band stays).
 *
 * Every step it took is named in `condensed`, so the block says what it no
 * longer carries. Pure over its input: no I/O, no clock.
 */
import { dateOnlyKey, dayKeyAsUtcMidnight } from "@/lib/tz/date-only";
import type { CoachScopeSource } from "./types";

/** Daily rows a condensed block keeps, newest first in time order. */
export const KEEP_DAILY_ROWS = 7;
/** Monthly means a fully condensed block keeps. */
export const KEEP_MONTHLY_ROWS = 6;

/** One day's value of a series, in the reader's unit. */
export interface DailyPoint {
  /** `YYYY-MM-DD`, the person's local day. */
  date: string;
  value: number;
}

/**
 * A block's daily values per series: `value` for a block with one series,
 * else keyed like the summary (`sys`/`dia`, a glucose context).
 */
export type DailySeries = Readonly<Record<string, ReadonlyArray<DailyPoint>>>;

/**
 * How a block builder registers its block with the budget pass, and, for a
 * series block, how to read its daily values should the block be condensed.
 * The values are only computed then.
 */
export type RegisterBlock = (
  key: string,
  source: CoachScopeSource,
  daily?: () => DailySeries,
) => void;

/** Days the first-week and latest-week means each span. */
export const COMPARE_DAYS = 7;

export interface SeriesSummary {
  /** First and last day with a value. */
  from: string;
  to: string;
  /** Days with a value; every figure below is over these days. */
  days: number;
  /** The first day's and the last day's value. */
  first: number;
  last: number;
  /** The lowest and highest daily value. */
  min: number;
  max: number;
  /** Mean of the daily values. */
  mean: number;
  /** Mean of the days in the first `COMPARE_DAYS` calendar days. */
  firstWeekMean: number;
  /** Mean of the days in the latest `COMPARE_DAYS` calendar days. */
  latestWeekMean: number;
  /** `latestWeekMean - firstWeekMean`. */
  change: number;
}

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The day `days` after a `YYYY-MM-DD` key, as a key. */
function shiftDay(key: string, days: number): string {
  const at = dayKeyAsUtcMidnight(key);
  at.setUTCDate(at.getUTCDate() + days);
  return dateOnlyKey(at);
}

/** Summary over a series' daily values (any order), or null when empty. */
export function summariseDaily(
  points: ReadonlyArray<DailyPoint>,
): SeriesSummary | null {
  const days = points
    .filter((p) => Number.isFinite(p.value))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (days.length === 0) return null;
  const values = days.map((d) => d.value);
  const mean = (list: number[]) =>
    list.reduce((s, v) => s + v, 0) / list.length;
  const from = days[0].date;
  const to = days[days.length - 1].date;
  const firstEnd = shiftDay(from, COMPARE_DAYS - 1);
  const latestStart = shiftDay(to, -(COMPARE_DAYS - 1));
  const firstWeek = mean(
    days.filter((d) => d.date <= firstEnd).map((d) => d.value),
  );
  const latestWeek = mean(
    days.filter((d) => d.date >= latestStart).map((d) => d.value),
  );
  return {
    from,
    to,
    days: days.length,
    first: values[0],
    last: values[values.length - 1],
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(mean(values)),
    firstWeekMean: round(firstWeek),
    latestWeekMean: round(latestWeek),
    change: round(latestWeek - firstWeek),
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

function blockSummary(
  tracks: ReadonlyArray<Track>,
  daily: DailySeries,
): unknown {
  const out: Rec = {};
  for (const track of tracks) {
    const summary = summariseDaily(daily[track.name ?? "value"] ?? []);
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
  /**
   * The block's daily values over the whole read, for its summary. Without
   * them the block gets no summary: a summary of what is left would not be
   * a summary of the series.
   */
  daily?: DailySeries,
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
  if (block.summary === undefined && daily) {
    const summary = blockSummary(tracks, daily);
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
