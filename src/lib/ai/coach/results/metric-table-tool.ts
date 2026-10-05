/**
 * `get_metric_table` — one metric as a table of days, weeks or months, and
 * the compact summary of a table the model reads instead of its rows.
 *
 * The numbers are the app's chart numbers, read the way the charts read
 * them: `readDailySeries` cuts the user's own local days and collapses
 * overlapping sources to the ladder-canonical one. Mood is the mean score of
 * each local day (the key its entries were written under); sleep is time
 * asleep per night, the wake-day key `reconstructSleepNights` gives every
 * other sleep surface.
 *
 * A week or month means one thing per metric, whatever serves it. A total
 * (steps, energy, distance, daylight, loud-sound events: `aggregationKind`)
 * is the sum of its days, labelled as a total; a level is the mean of its
 * days, folded by `bucketTimeSeries` in the user's zone as the chart folds
 * it. All time is read as calendar months straight from the MONTH fold of
 * the rollup tier (or the same fold of the live table when the tier has no
 * rows), keyed by the UTC month the bucket starts in: the tier's buckets are
 * UTC months, and re-reading their start in a zone west of UTC named the
 * month before.
 *
 * Every period of the range gets a row. A period without a reading carries
 * `null`, never a zero, so absence stays explicit in the table and in the
 * summary.
 *
 * The model never sees the rows wholesale. `summariseTable` gives it counts,
 * mean / min / max per column, the first and last period and at most 60 row
 * values, capped at about 1 500 tokens; the person sees the full table.
 * Those summary figures, not the table, are what the reply's numbers are
 * checked against.
 */
import { COACH_ALL_TIME_TABLE_DAYS } from "@/lib/ai/coach/history-reach";
import { prisma } from "@/lib/db";
import type { MeasurementType } from "@/generated/prisma/client";
import type { Locale } from "@/lib/i18n/config";
import { getServerTranslator } from "@/lib/i18n/server-translator";
import { shiftDateKey, userDayKey, weekdayOfDateKey } from "@/lib/tz/format";
import { startOfLocalDayKey } from "@/lib/tz/local-day";
import {
  readDailySeries,
  readLiveBuckets,
} from "@/lib/measurements/daily-series-read";
import { CUMULATIVE_HK_TYPES } from "@/lib/measurements/apple-health-mapping";
import {
  loadUserSourcePriority,
  readCanonicalRollupBuckets,
} from "@/lib/rollups/measurement-read";
import { annotate } from "@/lib/logging/context";
import { bucketTimeSeries } from "@/lib/charts/bucket-time-series";
import { reconstructSleepNights } from "@/lib/analytics/sleep-night";
import { getUnitForType } from "@/lib/validations/measurement";
import {
  applyDisplayTransform,
  getReadingTransform,
  hasDisplayTransform,
  type DisplayTransform,
  type UnitPreferences,
} from "@/lib/measurements/display-transform";
import { COACH_SOURCE_MEASUREMENT_TYPES } from "@/lib/ai/coach/source-measurement-types";
import {
  COACH_RESULT_COLUMN_KEYS,
  COACH_RESULT_TITLE_KEYS,
  coachDomainLabelKey,
} from "@/lib/ai/coach/dialog-keys";
import type {
  CoachResultCell,
  CoachResultColumn,
  CoachResultGranularity,
  CoachResultPeriod,
  CoachResultTable,
  CoachScopeSource,
  CoachScopeWindow,
} from "@/lib/ai/coach/types";

import { aggregationKind } from "./chart-spec";
import { RESULT_TABLE_MAX_ROWS } from "./project";
import { dateOnlyKey } from "@/lib/tz/date-only";

/**
 * Sources the table tool leaves to their own tools: glucose needs its
 * display unit and meal context (`get_glucose_panel`), adherence is a dose
 * ledger (`get_medication_compliance`), workouts are sessions
 * (`get_workouts`). The value is the reason the model is given.
 */
export const METRIC_TABLE_EXCLUDED_SOURCES: Readonly<
  Partial<Record<CoachScopeSource, string>>
> = {
  glucose: "use_get_glucose_panel",
  compliance: "use_get_medication_compliance",
  workouts: "use_get_workouts",
};

/** The model's view of a table stays under this many characters (~1 500 tokens). */
export const TABLE_SUMMARY_MAX_CHARS = 6_000;

/** At most this many row values ride the summary. */
export const TABLE_SUMMARY_MAX_VALUES = 60;

/** The chart's "All" range: about ten years (the settings text states it). */
const ALL_TIME_DAYS = COACH_ALL_TIME_TABLE_DAYS;

const WINDOW_DAYS: Readonly<Record<CoachScopeWindow, number>> = {
  last7days: 7,
  last30days: 30,
  last90days: 90,
  lastYear: 365,
  allTime: ALL_TIME_DAYS,
};

/**
 * The granularity a window gets when the call names none: days up to 90
 * days, weeks for a year, months for all time.
 */
export function defaultGranularity(
  window: CoachScopeWindow,
): CoachResultGranularity {
  if (window === "allTime") return "month";
  if (window === "lastYear") return "week";
  return "day";
}

/**
 * The granularity a table is actually built at. All time is read from the
 * rollup tiers, whose buckets are weeks or months already, so it is never
 * cut finer than a month.
 */
export function effectiveGranularity(
  window: CoachScopeWindow,
  requested: CoachResultGranularity | undefined,
): CoachResultGranularity {
  if (window === "allTime") return "month";
  return requested ?? defaultGranularity(window);
}

/** A table's range as local day keys, both ends inclusive. */
export interface TableRange {
  fromKey: string;
  toKey: string;
  /** First instant of `fromKey`. */
  from: Date;
  /** `now` for the current period, else the last instant of `toKey`. */
  to: Date;
}

/**
 * The local days a window covers: the last `N` days up to today for the
 * current period, the `N` days before them for `previous`, and the current
 * range moved back 365 days for `yearAgo`. All time has no earlier period.
 */
export function resolveTableRange(args: {
  window: CoachScopeWindow;
  period: CoachResultPeriod;
  timeZone: string;
  now: Date;
}): TableRange {
  const { window, timeZone, now } = args;
  const period = window === "allTime" ? "current" : args.period;
  const days = WINDOW_DAYS[window];
  const todayKey = userDayKey(now, timeZone);
  const currentFrom = shiftDateKey(todayKey, -(days - 1));
  const [fromKey, toKey] =
    period === "previous"
      ? [shiftDateKey(currentFrom, -days), shiftDateKey(currentFrom, -1)]
      : period === "yearAgo"
        ? [shiftDateKey(currentFrom, -365), shiftDateKey(todayKey, -365)]
        : [currentFrom, todayKey];
  const from = startOfLocalDayKey(fromKey, timeZone);
  const to =
    period === "current"
      ? now
      : new Date(
          startOfLocalDayKey(shiftDateKey(toKey, 1), timeZone).getTime() - 1,
        );
  return { fromKey, toKey, from, to };
}

// ── Period keys ─────────────────────────────────────────────────────────

/** `YYYY-MM-DD` of a UTC-midnight bucket timestamp (a day label). */
function dayKeyOfUtc(ms: number): string {
  return dateOnlyKey(new Date(ms));
}

/** Monday (`YYYY-MM-DD`) of the ISO week `dayKey` falls in. */
function weekKeyOf(dayKey: string): string {
  return shiftDateKey(dayKey, -((weekdayOfDateKey(dayKey) + 6) % 7));
}

function monthKeyOf(dayKey: string): string {
  return dayKey.slice(0, 7);
}

function periodKeyOf(
  dayKey: string,
  granularity: CoachResultGranularity,
): string {
  if (granularity === "week") return weekKeyOf(dayKey);
  if (granularity === "month") return monthKeyOf(dayKey);
  return dayKey;
}

/** Every period key from `fromKey` to `toKey`, in order. */
export function periodKeys(
  fromKey: string,
  toKey: string,
  granularity: CoachResultGranularity,
): string[] {
  const out: string[] = [];
  let cursor = fromKey;
  while (cursor <= toKey) {
    const key = periodKeyOf(cursor, granularity);
    if (out[out.length - 1] !== key) out.push(key);
    cursor = shiftDateKey(cursor, 1);
  }
  return out;
}

// ── Series ──────────────────────────────────────────────────────────────

/** One value series of a table: its column and its values by day. */
interface DaySeries {
  column: Omit<CoachResultColumn, "label">;
  /** Local day key → the day's value, canonical. */
  byDay: Map<string, number>;
  /** How days fold into a week or month: a total sums, a level averages. */
  fold: "sum" | "mean";
  /**
   * The reader's-unit transform, applied once to each folded period value
   * (the column's unit and decimals already name it). Absent for a series
   * no preference touches.
   */
  transform?: DisplayTransform;
}

/** Per-day values and reading counts for a metric, before bucketing. */
interface MetricDays {
  series: DaySeries[];
  /** Local day key → readings (or entries, or nights) on that day. */
  counts: Map<string, number>;
}

const UNIT_TOKENS: Readonly<Record<string, string>> = {
  minutes: "min",
};

/**
 * Decimals for the types whose unit alone decides wrongly: a step length of
 * 0.72 m is not 1 m, a walking speed of 1.35 m/s is not 1.4, and a count of
 * loud-sound events has no fraction.
 */
const DECIMALS_BY_TYPE: Readonly<Partial<Record<MeasurementType, number>>> = {
  WALKING_STEP_LENGTH: 2,
  WALKING_SPEED: 2,
  AUDIO_EXPOSURE_EVENT: 0,
};

/** Decimals a value is shown with: the type's own, else by unit. */
function decimalsForType(type: MeasurementType, unit: string): number {
  return DECIMALS_BY_TYPE[type] ?? decimalsFor(unit);
}

/** Decimals a value is shown with, by unit. */
function decimalsFor(unit: string): number {
  switch (unit) {
    case "mmHg":
    case "bpm":
    case "steps":
    case "kcal":
    case "kJ":
    case "flights":
    case "min":
    case "ms":
    case "m":
    case "dBA":
    case "years":
      return 0;
    default:
      return 1;
  }
}

function unitTokenFor(type: MeasurementType): string | undefined {
  const raw = getUnitForType(type);
  if (raw === "unknown" || raw === "score") return undefined;
  return UNIT_TOKENS[raw] ?? raw;
}

/** Short names for the two estimators the HRV domain unions. */
const SERIES_SUFFIX: Readonly<Partial<Record<MeasurementType, string>>> = {
  HEART_RATE_VARIABILITY: "SDNN",
  HRV_RMSSD: "RMSSD",
};

type MeasurementColumn = DaySeries["column"] & {
  type: MeasurementType;
  suffix?: string;
  transform?: DisplayTransform;
};

/**
 * A type's value for one day (or month) from a series row. The daily reader
 * sums the cumulative types and averages every other one; a total the reader
 * averages (loud-sound events, each row one event) is its mean times its
 * readings.
 */
function totalOrLevel(
  type: MeasurementType,
  total: boolean,
  value: number,
  count: number,
): number {
  return total && !CUMULATIVE_HK_TYPES.has(type) ? value * count : value;
}

function measurementColumns(
  metric: CoachScopeSource,
  types: readonly MeasurementType[],
  granularity: CoachResultGranularity,
  units: UnitPreferences,
): MeasurementColumn[] {
  if (metric === "bp") {
    return [
      {
        key: "systolic",
        kind: "number",
        labelKey: COACH_RESULT_COLUMN_KEYS.systolic,
        unit: "mmHg",
        decimals: 0,
        type: "BLOOD_PRESSURE_SYS",
      },
      {
        key: "diastolic",
        kind: "number",
        labelKey: COACH_RESULT_COLUMN_KEYS.diastolic,
        unit: "mmHg",
        decimals: 0,
        type: "BLOOD_PRESSURE_DIA",
      },
    ];
  }
  const labelKey =
    granularity === "day"
      ? COACH_RESULT_COLUMN_KEYS.value
      : aggregationKind(metric) === "total"
        ? COACH_RESULT_COLUMN_KEYS.total
        : COACH_RESULT_COLUMN_KEYS.mean;
  return types.map((type) => {
    const suffix = types.length > 1 ? (SERIES_SUFFIX[type] ?? type) : undefined;
    // A mass, length, temperature, speed or distance is read in the
    // reader's units, at the decimals that unit is read at.
    const transform = hasDisplayTransform(type)
      ? getReadingTransform(type, units)
      : undefined;
    const unit = transform ? transform.displayUnit : unitTokenFor(type);
    return {
      key: suffix ? suffix.toLowerCase() : "value",
      kind: "number" as const,
      labelKey,
      ...(unit ? { unit } : {}),
      decimals: transform
        ? transform.decimals
        : decimalsForType(type, unit ?? ""),
      type,
      ...(suffix ? { suffix } : {}),
      ...(transform ? { transform } : {}),
    };
  });
}

/**
 * Put the series with the most readings first and count each period's
 * readings from the first series that has it. Blood pressure's two sides are
 * one reading and keep their order (systolic first); HRV's two estimators
 * are alternatives, so the one the person mostly has leads the table and
 * the chart, and a night measured by both is one night, not two.
 */
function orderAndCount(
  metric: CoachScopeSource,
  series: Array<DaySeries & { counts: Map<string, number> }>,
): { ordered: DaySeries[]; counts: Map<string, number> } {
  const total = (s: { counts: Map<string, number> }) =>
    [...s.counts.values()].reduce((sum, v) => sum + v, 0);
  const ordered =
    metric === "bp" ? series : [...series].sort((a, b) => total(b) - total(a));
  const counts = new Map<string, number>();
  for (const s of ordered) {
    for (const [key, count] of s.counts) {
      if (!counts.has(key)) counts.set(key, count);
    }
  }
  return { ordered: ordered.map(({ counts: _c, ...rest }) => rest), counts };
}

async function readMeasurementDays(args: {
  userId: string;
  metric: CoachScopeSource;
  granularity: CoachResultGranularity;
  range: TableRange;
  timeZone: string;
  units: UnitPreferences;
}): Promise<MetricDays & { suffixes: Map<string, string> }> {
  const { userId, metric, granularity, range, timeZone, units } = args;
  const types = COACH_SOURCE_MEASUREMENT_TYPES[metric];
  const columns = measurementColumns(metric, types, granularity, units);
  const priorityJson = await loadUserSourcePriority(userId);
  const rowsByType = await Promise.all(
    columns.map((column) =>
      readDailySeries({
        userId,
        type: column.type,
        from: range.from,
        to: range.to,
        priorityJson,
        timeZone,
      }),
    ),
  );
  const total = aggregationKind(metric) === "total";
  const suffixes = new Map<string, string>();
  const read = columns.map((column, index) => {
    const byDay = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const row of rowsByType[index]) {
      const day = userDayKey(new Date(row.measuredAt), timeZone);
      const count = row.count ?? 1;
      byDay.set(day, totalOrLevel(column.type, total, row.value, count));
      counts.set(day, (counts.get(day) ?? 0) + count);
    }
    if (column.suffix) suffixes.set(column.key, column.suffix);
    const { type: _type, suffix: _suffix, transform, ...rest } = column;
    return {
      column: rest,
      byDay,
      fold: total ? ("sum" as const) : ("mean" as const),
      counts,
      ...(transform ? { transform } : {}),
    };
  });
  const { ordered, counts } = orderAndCount(metric, read);
  return { series: ordered, counts, suffixes };
}

/**
 * `YYYY-MM-DD` of an instant in UTC. Only for the all-time month read: the
 * MONTH rollup tier buckets UTC months, so its range edges are UTC days.
 */
function utcDayKey(date: Date): string {
  // eslint-disable-next-line healthlog/no-utc-day-key -- UTC by design: the MONTH rollup tier buckets UTC months, so this read keys its edges on UTC days
  return date.toISOString().slice(0, 10);
}

/** Folded periods: period key → one value per series, and readings. */
interface PeriodValues {
  values: Map<string, Array<number | undefined>>;
  counts: Map<string, number>;
}

/**
 * All time for a measurement metric: one row per UTC calendar month, a total
 * summed and a level averaged over every reading of the month's canonical
 * days. The rollup tier's MONTH fold serves it; when the tier holds nothing
 * for the type (a backfill not caught up, a read that failed), the live table
 * is folded into the same UTC months the same way. Either path gives the
 * same number for the same month, so the table no longer depends on how
 * long the history is or which tier the chart would pick for it.
 */
async function readMeasurementMonths(args: {
  userId: string;
  metric: CoachScopeSource;
  range: TableRange;
  units: UnitPreferences;
}): Promise<{
  series: DaySeries[];
  periods: PeriodValues;
  suffixes: Map<string, string>;
}> {
  const { userId, metric, range, units } = args;
  const types = COACH_SOURCE_MEASUREMENT_TYPES[metric];
  const columns = measurementColumns(metric, types, "month", units);
  const total = aggregationKind(metric) === "total";
  const priorityJson = await loadUserSourcePriority(userId);
  // The first whole UTC month of the range: a bucket that starts before
  // `from` is left out of the tier's fold.
  const from = new Date(`${utcDayKey(range.from).slice(0, 7)}-01T00:00:00Z`);
  const byType = await Promise.all(
    columns.map(async (column) => {
      const months = new Map<string, { value: number; count: number }>();
      try {
        const buckets = await readCanonicalRollupBuckets({
          userId,
          type: column.type,
          granularity: "MONTH",
          from,
          to: range.to,
          toInclusive: true,
          userPriorityJson: priorityJson,
        });
        for (const b of buckets) {
          // The fold's sum is every reading's value added up, which is the
          // total for a cumulative type and for an event count alike.
          months.set(utcDayKey(b.bucketStart).slice(0, 7), {
            value: total ? (b.sumValue ?? b.mean * b.count) : b.mean,
            count: b.count,
          });
        }
      } catch (err) {
        annotate({
          meta: {
            coach_table_rollup_read_threw: true,
            type: column.type,
            error: err instanceof Error ? err.message : String(err),
          },
        });
      }
      if (months.size === 0) {
        const rows = await readLiveBuckets({
          userId,
          type: column.type,
          from,
          to: range.to,
          cap: 1_000,
          priorityJson,
          grain: "monthly",
          timeZone: "UTC",
        });
        for (const row of rows) {
          const count = row.count ?? 1;
          months.set(row.measuredAt.slice(0, 7), {
            value: totalOrLevel(column.type, total, row.value, count),
            count,
          });
        }
      }
      return months;
    }),
  );

  const suffixes = new Map<string, string>();
  const read = columns.map((column, index) => {
    if (column.suffix) suffixes.set(column.key, column.suffix);
    const { type: _type, suffix: _suffix, transform, ...rest } = column;
    const byDay = new Map<string, number>();
    const counts = new Map<string, number>();
    for (const [month, { value, count }] of byType[index]) {
      byDay.set(month, value);
      counts.set(month, count);
    }
    return {
      column: rest,
      byDay,
      fold: total ? ("sum" as const) : ("mean" as const),
      counts,
      ...(transform ? { transform } : {}),
    };
  });
  const { ordered, counts } = orderAndCount(metric, read);
  const values = new Map<string, Array<number | undefined>>();
  for (const s of ordered) {
    for (const month of s.byDay.keys()) {
      values.set(
        month,
        ordered.map((x) => x.byDay.get(month)),
      );
    }
  }
  return { series: ordered, periods: { values, counts }, suffixes };
}

async function readMoodDays(args: {
  userId: string;
  range: TableRange;
}): Promise<MetricDays> {
  const { userId, range } = args;
  // `date` is the local day each entry was written under, so the days are the
  // user's own days without re-cutting them here.
  const entries = await prisma.moodEntry.findMany({
    where: {
      userId,
      deletedAt: null,
      date: { gte: range.fromKey, lte: range.toKey },
    },
    select: { date: true, score: true },
  });
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const entry of entries) {
    sums.set(entry.date, (sums.get(entry.date) ?? 0) + entry.score);
    counts.set(entry.date, (counts.get(entry.date) ?? 0) + 1);
  }
  const byDay = new Map<string, number>();
  for (const [day, sum] of sums) byDay.set(day, sum / (counts.get(day) ?? 1));
  return {
    series: [
      {
        column: {
          key: "value",
          kind: "number",
          labelKey: COACH_RESULT_COLUMN_KEYS.mean,
          decimals: 1,
        },
        byDay,
        fold: "mean",
      },
    ],
    counts,
  };
}

async function readSleepDays(args: {
  userId: string;
  range: TableRange;
  timeZone: string;
}): Promise<MetricDays> {
  const { userId, range, timeZone } = args;
  // A night is keyed by the day it ends on, and it starts the evening
  // before: read from a day early so the first night is whole.
  const rows = await prisma.measurement.findMany({
    where: {
      userId,
      type: "SLEEP_DURATION",
      measuredAt: {
        gte: startOfLocalDayKey(shiftDateKey(range.fromKey, -1), timeZone),
        lte: range.to,
      },
      deletedAt: null,
    },
    orderBy: { measuredAt: "asc" },
    select: {
      value: true,
      measuredAt: true,
      sleepStage: true,
      source: true,
      deviceType: true,
    },
  });
  const priorityJson = await loadUserSourcePriority(userId);
  const byDay = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const night of reconstructSleepNights(rows, timeZone, priorityJson)) {
    if (night.asleepMinutes <= 0) continue;
    if (night.night < range.fromKey || night.night > range.toKey) continue;
    byDay.set(night.night, night.asleepMinutes);
    counts.set(night.night, 1);
  }
  return {
    series: [
      {
        column: {
          key: "asleep",
          kind: "number",
          labelKey: COACH_RESULT_COLUMN_KEYS.duration,
          unit: "min",
          decimals: 0,
        },
        byDay,
        fold: "mean",
      },
    ],
    counts,
  };
}

// ── Bucketing ───────────────────────────────────────────────────────────

/**
 * Fold per-day values into the table's periods. Days stay as they are. A
 * level's weeks and months go through `bucketTimeSeries` in the user's zone
 * — the chart's own fold, so a weekly mean here is the chart's weekly point;
 * a total's are the sum of its local days.
 */
function foldIntoPeriods(args: {
  days: MetricDays;
  granularity: CoachResultGranularity;
  timeZone: string;
}): PeriodValues {
  const { days, granularity, timeZone } = args;
  const values = new Map<string, Array<number | undefined>>();
  const counts = new Map<string, number>();
  for (const [day, count] of days.counts) {
    const key = periodKeyOf(day, granularity);
    counts.set(key, (counts.get(key) ?? 0) + count);
  }
  if (granularity === "day") {
    const allDays = new Set<string>();
    for (const s of days.series)
      for (const day of s.byDay.keys()) allDays.add(day);
    for (const day of allDays) {
      values.set(
        day,
        days.series.map((s) => s.byDay.get(day)),
      );
    }
    return { values, counts };
  }
  const sums = new Map<string, Map<number, number>>();
  const points = new Map<string, Record<string, number | undefined>>();
  days.series.forEach((s, index) => {
    if (s.fold === "sum") {
      for (const [day, value] of s.byDay) {
        const key = periodKeyOf(day, granularity);
        const slot = sums.get(key) ?? new Map<number, number>();
        slot.set(index, (slot.get(index) ?? 0) + value);
        sums.set(key, slot);
      }
      return;
    }
    for (const [day, value] of s.byDay) {
      const point = points.get(day) ?? {};
      point[String(index)] = value;
      points.set(day, point);
    }
  });
  const bucketed = bucketTimeSeries(
    [...points.entries()].map(([day, pointValues]) => ({
      timestamp: startOfLocalDayKey(day, timeZone),
      values: pointValues,
    })),
    { bucket: granularity, timeZone },
  );
  const levels = new Map<string, Record<string, number>>();
  for (const point of bucketed.points) {
    const dayKey = dayKeyOfUtc(point.timestamp);
    levels.set(
      granularity === "month" ? monthKeyOf(dayKey) : dayKey,
      point.values,
    );
  }
  for (const key of new Set([...levels.keys(), ...sums.keys()])) {
    values.set(
      key,
      days.series.map((s, index) =>
        s.fold === "sum"
          ? sums.get(key)?.get(index)
          : levels.get(key)?.[String(index)],
      ),
    );
  }
  return { values, counts };
}

// ── The table ───────────────────────────────────────────────────────────

const PERIOD_COLUMN_KEYS: Readonly<Record<CoachResultGranularity, string>> = {
  day: COACH_RESULT_COLUMN_KEYS.day,
  week: COACH_RESULT_COLUMN_KEYS.week,
  month: COACH_RESULT_COLUMN_KEYS.month,
};

function titleKeyFor(
  period: CoachResultPeriod,
  granularity: CoachResultGranularity,
): string {
  if (period === "previous") return COACH_RESULT_TITLE_KEYS.previousPeriod;
  if (period === "yearAgo") return COACH_RESULT_TITLE_KEYS.yearAgo;
  if (granularity === "week") return COACH_RESULT_TITLE_KEYS.byWeek;
  if (granularity === "month") return COACH_RESULT_TITLE_KEYS.byMonth;
  return COACH_RESULT_TITLE_KEYS.byDay;
}

/**
 * Read one metric as a result table, or null when the range holds no
 * reading at all (the caller reports that absence explicitly).
 */
export async function readMetricTable(args: {
  userId: string;
  metric: CoachScopeSource;
  window: CoachScopeWindow;
  period: CoachResultPeriod;
  granularity: CoachResultGranularity | undefined;
  timeZone: string;
  locale: Locale;
  ref: string;
  /**
   * The reader's units. The person sees the table and the model reads its
   * summary, so a mass, temperature, speed or distance is stated in them.
   */
  units: UnitPreferences;
  now?: Date;
}): Promise<CoachResultTable | null> {
  const { userId, metric, window, timeZone, locale, ref, units } = args;
  const now = args.now ?? new Date();
  const period = window === "allTime" ? "current" : args.period;
  const granularity = effectiveGranularity(window, args.granularity);
  const range = resolveTableRange({ window, period, timeZone, now });

  let suffixes = new Map<string, string>();
  let series: DaySeries[];
  let folded: PeriodValues;
  // All time of a measurement metric is keyed by UTC month (the tier's own
  // buckets); every other table by the user's local days.
  let keyRange: [string, string] = [range.fromKey, range.toKey];
  if (metric === "mood" || metric === "sleep") {
    const days =
      metric === "mood"
        ? await readMoodDays({ userId, range })
        : await readSleepDays({ userId, range, timeZone });
    series = days.series;
    folded = foldIntoPeriods({ days, granularity, timeZone });
  } else if (window === "allTime") {
    const read = await readMeasurementMonths({ userId, metric, range, units });
    series = read.series;
    folded = read.periods;
    suffixes = read.suffixes;
    keyRange = [utcDayKey(range.from), utcDayKey(range.to)];
  } else {
    const read = await readMeasurementDays({
      userId,
      metric,
      granularity,
      range,
      timeZone,
      units,
    });
    series = read.series;
    folded = foldIntoPeriods({ days: read, granularity, timeZone });
    suffixes = read.suffixes;
  }

  const { values, counts } = folded;
  if (values.size === 0) return null;

  // All time starts at the first period that holds a reading, not ten
  // years of empty months before it.
  const keys = periodKeys(keyRange[0], keyRange[1], granularity);
  const firstWithData =
    window === "allTime" ? keys.findIndex((key) => values.has(key)) : 0;
  const periods = keys.slice(Math.max(0, firstWithData));

  const { t } = getServerTranslator(locale);
  const periodColumnKey =
    metric === "sleep" && granularity === "day" ? "night" : granularity;
  const columns: CoachResultColumn[] = [
    {
      key: periodColumnKey,
      kind: "period",
      labelKey:
        periodColumnKey === "night"
          ? COACH_RESULT_COLUMN_KEYS.night
          : PERIOD_COLUMN_KEYS[granularity],
      label: t(
        periodColumnKey === "night"
          ? COACH_RESULT_COLUMN_KEYS.night
          : PERIOD_COLUMN_KEYS[granularity],
      ),
    },
    ...series.map((s) => {
      const base = t(s.column.labelKey);
      const suffix = suffixes.get(s.column.key);
      return { ...s.column, label: suffix ? `${base} (${suffix})` : base };
    }),
    {
      key: "readings",
      kind: "count",
      labelKey: COACH_RESULT_COLUMN_KEYS.readings,
      label: t(COACH_RESULT_COLUMN_KEYS.readings),
    },
  ];
  const rows: CoachResultCell[][] = periods.map((key) => {
    const cells = values.get(key);
    return [
      key,
      ...series.map((s, index) => {
        const value = cells?.[index];
        if (value === undefined || !Number.isFinite(value)) return null;
        return s.transform ? applyDisplayTransform(value, s.transform) : value;
      }),
      cells ? (counts.get(key) ?? 0) : null,
    ];
  });

  const titleKey = titleKeyFor(period, granularity);
  const metricName = t(coachDomainLabelKey(metric));
  const trimmed = rows.slice(-RESULT_TABLE_MAX_ROWS);
  return {
    ref,
    source: {
      tool: "get_metric_table",
      domain: metric,
      window,
      period,
      granularity,
    },
    shape: "timeSeries",
    titleKey,
    title: t(titleKey, { metric: metricName }),
    rowCount: rows.length,
    chartKind: null,
    displayed: false,
    columns,
    rows: trimmed,
    truncated: trimmed.length < rows.length,
    chart: null,
  };
}

// ── The model's view ────────────────────────────────────────────────────

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A cell as the model reads it: numbers rounded to their column's decimals. */
function modelCell(
  cell: CoachResultCell,
  column: CoachResultColumn | undefined,
): CoachResultCell {
  if (typeof cell !== "number") return cell;
  return round(cell, column?.decimals ?? 1);
}

function columnName(column: CoachResultColumn): string {
  return column.unit ? `${column.key} (${column.unit})` : column.key;
}

/**
 * The compact view of a table the model reads: counts, mean / min / max
 * per numeric column, the first and last period, and the most recent row
 * values that fit — at most 60, and the whole view under
 * `TABLE_SUMMARY_MAX_CHARS`. Periods without a reading are counted but not
 * listed; the person sees them as blanks in the table.
 */
export function summariseTable(
  table: CoachResultTable,
): Record<string, unknown> {
  const numeric = table.columns
    .map((column, index) => ({ column, index }))
    .filter(
      ({ column }) => column.kind === "number" || column.kind === "count",
    );
  const valueIndexes = numeric
    .filter(({ column }) => column.kind === "number")
    .map(({ index }) => index);
  const withValues = table.rows.filter((row) =>
    valueIndexes.length === 0
      ? true
      : valueIndexes.some((index) => typeof row[index] === "number"),
  );

  // What a week's or month's value is: a total of its days or their mean.
  // Without it a monthly figure of 240 000 steps reads as a daily count.
  const valuesAre: Record<string, string> = {};
  for (const { column } of numeric) {
    if (column.kind !== "number") continue;
    const per = table.source.granularity ?? "day";
    if (column.labelKey === COACH_RESULT_COLUMN_KEYS.total) {
      valuesAre[column.key] = `total per ${per}`;
    } else if (column.labelKey === COACH_RESULT_COLUMN_KEYS.mean) {
      valuesAre[column.key] = `average per ${per}`;
    }
  }

  const stats: Record<string, unknown> = {};
  for (const { column, index } of numeric) {
    const cells = table.rows
      .map((row) => row[index])
      .filter((cell): cell is number => typeof cell === "number");
    if (cells.length === 0) continue;
    const decimals = column.decimals ?? 1;
    if (column.kind === "count") {
      stats[column.key] = { total: cells.reduce((s, v) => s + v, 0) };
      continue;
    }
    const sum = cells.reduce((s, v) => s + v, 0);
    stats[column.key] = {
      n: cells.length,
      mean: round(sum / cells.length, decimals),
      min: round(Math.min(...cells), decimals),
      max: round(Math.max(...cells), decimals),
      // A total's periods add up to the range's total; a level's do not.
      ...(column.labelKey === COACH_RESULT_COLUMN_KEYS.total
        ? { total: round(sum, decimals) }
        : {}),
    };
  }

  const toModelRow = (row: CoachResultCell[]) =>
    row.map((cell, index) => modelCell(cell, table.columns[index]));
  const base: Record<string, unknown> = {
    source: table.source,
    shape: table.shape,
    columns: table.columns.map(columnName),
    ...(Object.keys(valuesAre).length > 0 ? { valuesAre } : {}),
    periods: table.rowCount,
    periodsWithReadings: withValues.length,
    ...(withValues.length > 0
      ? {
          first: toModelRow(withValues[0])[0],
          last: toModelRow(withValues[withValues.length - 1])[0],
        }
      : {}),
    stats,
  };

  let shown = withValues.slice(-TABLE_SUMMARY_MAX_VALUES).map(toModelRow);
  const build = () => ({
    ...base,
    rows: shown,
    ...(shown.length < withValues.length
      ? {
          rowsNote: `the latest ${shown.length} of ${withValues.length} periods with readings; the rest are in the table under the answer`,
        }
      : {}),
  });
  let view = build();
  while (
    shown.length > 0 &&
    JSON.stringify(view).length > TABLE_SUMMARY_MAX_CHARS
  ) {
    shown = shown.slice(Math.ceil(shown.length / 4));
    view = build();
  }
  return view;
}

// ── Comparison with the current window ──────────────────────────────────

function numericCells(table: CoachResultTable, key: string): number[] {
  const index = table.columns.findIndex((column) => column.key === key);
  if (index < 0) return [];
  return table.rows
    .map((row) => row[index])
    .filter(
      (cell): cell is number =>
        typeof cell === "number" && Number.isFinite(cell),
    );
}

function change(
  earlier: number,
  current: number,
  decimals: number,
): { delta: number; pctChange?: number } {
  const delta = round(current - earlier, decimals);
  return earlier === 0
    ? { delta }
    : {
        delta,
        pctChange: round(((current - earlier) / Math.abs(earlier)) * 100, 1),
      };
}

/**
 * How an earlier window (the period before, or the same window a year ago)
 * compares with the current one, for the model's summary of the earlier
 * table. The grounding ledger derives differences only between figures of
 * one payload, so a correct "down 4 mmHg from last month" drawn from two
 * separate reads was withheld as unverified; with the current figures and
 * the change computed here, beside the earlier ones, the reply's delta is a
 * figure the model was shown, and a wrong one still is not.
 *
 * `delta` is the current value minus the earlier one; `pctChange` is that
 * change relative to the earlier value, omitted when the earlier value is 0.
 */
export function compareWithCurrent(
  earlier: CoachResultTable,
  current: CoachResultTable,
): Record<string, unknown> | null {
  const currentStats: Record<string, Record<string, number>> = {};
  const changes: Record<string, Record<string, unknown>> = {};
  for (const column of earlier.columns) {
    if (column.kind !== "number") continue;
    const before = numericCells(earlier, column.key);
    const now = numericCells(current, column.key);
    if (before.length === 0 || now.length === 0) continue;
    const decimals = column.decimals ?? 1;
    const sumBefore = before.reduce((s, v) => s + v, 0);
    const sumNow = now.reduce((s, v) => s + v, 0);
    const meanBefore = sumBefore / before.length;
    const meanNow = sumNow / now.length;
    const isTotal = column.labelKey === COACH_RESULT_COLUMN_KEYS.total;
    currentStats[column.key] = {
      mean: round(meanNow, decimals),
      ...(isTotal ? { total: round(sumNow, decimals) } : {}),
    };
    changes[column.key] = {
      mean: change(meanBefore, meanNow, decimals),
      ...(isTotal ? { total: change(sumBefore, sumNow, decimals) } : {}),
    };
  }
  if (Object.keys(changes).length === 0) return null;
  const periodIndex = current.columns.findIndex((c) => c.kind === "period");
  const withValues = current.rows.filter((row) =>
    row.some(
      (cell, index) => index !== periodIndex && typeof cell === "number",
    ),
  );
  return {
    with: { window: current.source.window, period: "current" },
    current: {
      ...(withValues.length > 0
        ? {
            first: withValues[0][periodIndex],
            last: withValues[withValues.length - 1][periodIndex],
          }
        : {}),
      stats: currentStats,
    },
    change: changes,
    changeIs: "current minus this table; pctChange relative to this table",
  };
}
