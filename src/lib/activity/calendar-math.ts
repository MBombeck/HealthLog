/**
 * Activity calendar arithmetic (D1036). Pure: no database, no clock, no zone.
 *
 * The calendar compares a week or a month of activity with the person's own
 * normal, never with a population norm. Two comparisons, each with its own
 * honest reference:
 *
 *  - A DAY is placed against the spread of the person's own days in the 84
 *    days before the period starts (`BASELINE_DAYS`): below the 10th
 *    percentile is `low`, below the 25th `below`, above the 75th `above`,
 *    above the 90th `high`, everything between `usual`. With fewer than
 *    `MIN_BASELINE_DAYS` days that carry a value the day is `unrated`:
 *    there is not enough history to say what usual is, and the calendar says
 *    so instead of guessing. TODAY is `in_progress`, never rated: a day
 *    that has not ended would read as a low day every morning.
 *  - A PERIOD total is placed against the median total of the same kind of
 *    period before it: the twelve weeks before a week, the six months before
 *    a month. A month is compared per day (months differ in length), so the
 *    usual month is the median daily rate of the earlier months times this
 *    month's length. A period still running is compared over its COMPLETED
 *    days only: the total through yesterday against the usual rate times the
 *    days completed, never a full period it cannot have reached yet, and
 *    never today's partial day (a morning would always read as a shortfall).
 *    The period total shown and the goals still count today. At least `MIN_REFERENCE_PERIODS` earlier periods with data
 *    are needed; fewer gives no usual.
 *
 * What a day's value is:
 *  - steps: the day's step total (the same canonical-source sum the steps
 *    chart draws); a day without a step reading has no value, it is not 0,
 *    because a watch left on the charger is not a day without steps.
 *  - active minutes: the larger of the day's exercise minutes and the day's
 *    workout minutes. Exercise minutes already contain the workouts a watch
 *    recorded, so adding the two would count a workout twice; taking the
 *    larger never does, and still counts a workout logged by hand on a day
 *    the watch recorded nothing. Once the account has any activity data in
 *    the window, a day without either is 0.
 *  - workouts: the number of workouts that started that day, after the
 *    cross-source duplicate collapse the workout list applies. Shown as
 *    counts, never rated: most days have none, so percentiles of a mostly-zero
 *    series say nothing.
 *  - load: the day's training-load score when a device or HealthLog computes
 *    one; no value otherwise.
 */
import {
  daysBetweenDateKeys,
  shiftDateKey,
  weekdayOfDateKey,
} from "@/lib/tz/format";

import type {
  ActivityGoalKey,
  ActivityGoals,
} from "@/lib/validations/activity-goals";
import { median } from "@/lib/stats/central";

/** Days before the period whose spread defines a usual day. */
export const BASELINE_DAYS = 84;
/** Days with a value needed before a day is rated against the baseline. */
export const MIN_BASELINE_DAYS = 14;
/** Earlier periods compared against: twelve weeks, six months. */
export const REFERENCE_WEEKS = 12;
export const REFERENCE_MONTHS = 6;
/** Earlier periods with data needed before a usual period total is given. */
export const MIN_REFERENCE_PERIODS = 3;

export type ActivityPeriod = "week" | "month";
export type RatedMetric = "steps" | "activeMinutes" | "load";
export type DayLevel =
  | "none"
  | "unrated"
  | "in_progress"
  | "low"
  | "below"
  | "usual"
  | "above"
  | "high";

/** One local day of raw signals, as the reader assembles it. */
export interface ActivityDayInput {
  /** Local calendar day, `YYYY-MM-DD`. */
  date: string;
  steps: number | null;
  exerciseMinutes: number | null;
  workoutMinutes: number;
  workoutCount: number;
  workoutsBySport: Record<string, number>;
  load: number | null;
}

export interface BaselineStats {
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  /** Days with a value the stats were computed from. */
  days: number;
}

/**
 * Linear-interpolation quantile (the R-7 / spreadsheet `PERCENTILE.INC`
 * definition) over an ascending-sorted array. `q` in [0, 1].
 */
export function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

export function baselineStats(values: readonly number[]): BaselineStats | null {
  if (values.length < MIN_BASELINE_DAYS) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    median: quantileSorted(sorted, 0.5),
    p10: quantileSorted(sorted, 0.1),
    p25: quantileSorted(sorted, 0.25),
    p75: quantileSorted(sorted, 0.75),
    p90: quantileSorted(sorted, 0.9),
    days: sorted.length,
  };
}

/** Where one day's value sits in the person's own spread. */
export function dayLevel(
  value: number | null,
  baseline: BaselineStats | null,
): DayLevel {
  if (value === null) return "none";
  if (!baseline) return "unrated";
  if (value < baseline.p10) return "low";
  if (value < baseline.p25) return "below";
  if (value > baseline.p90) return "high";
  if (value > baseline.p75) return "above";
  return "usual";
}

/** The active-minutes rule from the header: the larger, never the sum. */
export function activeMinutesOf(
  day: ActivityDayInput,
  hasActivityData: boolean,
): number | null {
  if (day.exerciseMinutes !== null) {
    return Math.max(day.exerciseMinutes, day.workoutMinutes);
  }
  if (day.workoutMinutes > 0) return day.workoutMinutes;
  return hasActivityData ? 0 : null;
}

export function metricValue(
  day: ActivityDayInput,
  metric: RatedMetric,
  hasActivityData: boolean,
): number | null {
  switch (metric) {
    case "steps":
      return day.steps;
    case "activeMinutes":
      return activeMinutesOf(day, hasActivityData);
    case "load":
      return day.load;
  }
}

/** Monday on or before `date` (the calendar's weeks run Monday to Sunday). */
export function weekStartOf(date: string): string {
  const weekday = weekdayOfDateKey(date); // 0 = Sunday
  return shiftDateKey(date, -((weekday + 6) % 7));
}

export function monthStartOf(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function daysInMonth(monthStart: string): number {
  const [y, m] = monthStart.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** First day of the month `delta` months from `monthStart`. */
export function shiftMonth(monthStart: string, delta: number): string {
  const [y, m] = monthStart.split("-").map(Number);
  const index = y * 12 + (m - 1) + delta;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-01`;
}

export interface PeriodBounds {
  period: ActivityPeriod;
  /** First and last day of the period, inclusive. */
  start: string;
  end: string;
  /** The grid the calendar draws: whole weeks around the period. */
  gridStart: string;
  gridEnd: string;
  /** The earliest day any comparison reads. */
  readStart: string;
}

export function periodBounds(
  period: ActivityPeriod,
  anchor: string,
): PeriodBounds {
  if (period === "week") {
    const start = weekStartOf(anchor);
    const end = shiftDateKey(start, 6);
    return {
      period,
      start,
      end,
      gridStart: start,
      gridEnd: end,
      readStart: shiftDateKey(
        start,
        -Math.max(BASELINE_DAYS, REFERENCE_WEEKS * 7),
      ),
    };
  }
  const start = monthStartOf(anchor);
  const end = shiftDateKey(start, daysInMonth(start) - 1);
  const gridStart = weekStartOf(start);
  const gridEnd = shiftDateKey(weekStartOf(end), 6);
  // Date keys order lexically, so the earliest is the smallest string.
  const readStart = [
    shiftMonth(start, -REFERENCE_MONTHS),
    shiftDateKey(start, -BASELINE_DAYS),
    gridStart,
  ].sort()[0];
  return { period, start, end, gridStart, gridEnd, readStart };
}

/** Every day key from `from` to `to`, inclusive. */
export function dayRange(from: string, to: string): string[] {
  const n = daysBetweenDateKeys(from, to);
  const out: string[] = [];
  for (let i = 0; i <= n; i++) out.push(shiftDateKey(from, i));
  return out;
}

export interface PeriodComparison {
  /** The period's total (steps, active minutes, workouts) or mean (load), over the days so far, today included. */
  value: number | null;
  /** Days of the period that carry a value. */
  daysWithData: number;
  /** Days of the period that have ended (today excluded). */
  completedDays: number;
  /** `value` over the completed days only: what `usualToDate` is compared with. */
  completedValue: number | null;
  /** The usual full period, or null when there is not enough history. */
  usual: number | null;
  /** The usual figure for the completed days (equals `usual` for a finished period); null before the first day has ended. */
  usualToDate: number | null;
  /** Earlier periods the usual was computed from. */
  referencePeriods: number;
  /**
   * `completedValue` against `usualToDate` as a signed fraction (0.18 = 18 %
   * above the usual); null while either is missing or the usual is zero.
   */
  change: number | null;
}

export type SummaryMetric = RatedMetric | "workouts";

function aggregate(
  values: ReadonlyArray<number | null>,
  mode: "sum" | "mean",
): { value: number | null; n: number } {
  const present = values.filter((v): v is number => v !== null);
  if (present.length === 0) return { value: null, n: 0 };
  const total = present.reduce((a, b) => a + b, 0);
  return {
    value: mode === "sum" ? total : total / present.length,
    n: present.length,
  };
}

/** The earlier periods a period is compared with, as inclusive day ranges. */
export function referencePeriods(
  bounds: Pick<PeriodBounds, "period" | "start">,
): Array<{ start: string; end: string; length: number }> {
  const out: Array<{ start: string; end: string; length: number }> = [];
  if (bounds.period === "week") {
    for (let i = 1; i <= REFERENCE_WEEKS; i++) {
      const start = shiftDateKey(bounds.start, -7 * i);
      out.push({ start, end: shiftDateKey(start, 6), length: 7 });
    }
    return out;
  }
  for (let i = 1; i <= REFERENCE_MONTHS; i++) {
    const start = shiftMonth(bounds.start, -i);
    const length = daysInMonth(start);
    out.push({ start, end: shiftDateKey(start, length - 1), length });
  }
  return out;
}

export function comparePeriod(input: {
  bounds: Pick<PeriodBounds, "period" | "start" | "end">;
  /** The last day that has happened (today in the person's zone). */
  today: string;
  valueOf: (date: string) => number | null;
  mode: "sum" | "mean";
}): PeriodComparison {
  const { bounds, today, valueOf, mode } = input;
  const lastCounted = bounds.end < today ? bounds.end : today;
  const yesterday = shiftDateKey(today, -1);
  const lastCompleted = bounds.end < yesterday ? bounds.end : yesterday;
  const length = daysBetweenDateKeys(bounds.start, bounds.end) + 1;
  const daysUpTo = (last: string) =>
    last < bounds.start ? 0 : daysBetweenDateKeys(bounds.start, last) + 1;
  const elapsed = daysUpTo(lastCounted);
  const completed = daysUpTo(lastCompleted);
  const current =
    elapsed === 0
      ? { value: null, n: 0 }
      : aggregate(dayRange(bounds.start, lastCounted).map(valueOf), mode);
  const done =
    completed === 0
      ? { value: null, n: 0 }
      : aggregate(dayRange(bounds.start, lastCompleted).map(valueOf), mode);

  // Each earlier period becomes a per-day rate (sum) or a mean (mean), so a
  // 28-day February and a 31-day March compare on the same footing.
  const rates: number[] = [];
  for (const ref of referencePeriods(bounds)) {
    const agg = aggregate(dayRange(ref.start, ref.end).map(valueOf), mode);
    if (agg.value === null) continue;
    rates.push(mode === "sum" ? agg.value / ref.length : agg.value);
  }
  const usualRate =
    rates.length >= MIN_REFERENCE_PERIODS ? median(rates) : null;
  const usual =
    usualRate === null ? null : mode === "sum" ? usualRate * length : usualRate;
  const usualToDate =
    usualRate === null
      ? null
      : mode === "sum"
        ? usualRate * completed
        : usualRate;
  return {
    value: current.value,
    daysWithData: current.n,
    completedDays: completed,
    completedValue: done.value,
    usual,
    usualToDate: completed === 0 ? null : usualToDate,
    referencePeriods: rates.length,
    change:
      completed === 0 || done.value === null || !usualToDate
        ? null
        : (done.value - usualToDate) / usualToDate,
  };
}

export interface GoalProgress {
  key: ActivityGoalKey;
  target: number;
  value: number;
  met: boolean;
}

/** Which goals apply to which period, and which figure each one reads. */
const GOALS_BY_PERIOD: Record<
  ActivityPeriod,
  Array<{ key: ActivityGoalKey; metric: SummaryMetric }>
> = {
  week: [
    { key: "workoutsPerWeek", metric: "workouts" },
    { key: "activeMinutesPerWeek", metric: "activeMinutes" },
    { key: "stepsPerWeek", metric: "steps" },
  ],
  month: [{ key: "stepsPerMonth", metric: "steps" }],
};

export function goalProgress(
  period: ActivityPeriod,
  goals: ActivityGoals,
  totals: Partial<Record<SummaryMetric, number | null>>,
): GoalProgress[] {
  const out: GoalProgress[] = [];
  for (const { key, metric } of GOALS_BY_PERIOD[period]) {
    const target = goals[key];
    if (target === null) continue;
    const value = totals[metric] ?? 0;
    out.push({ key, target, value, met: value >= target });
  }
  return out;
}

export interface CalendarDay {
  date: string;
  inPeriod: boolean;
  future: boolean;
  steps: number | null;
  activeMinutes: number | null;
  workoutCount: number;
  workoutsBySport: Record<string, number>;
  load: number | null;
  level: Record<RatedMetric, DayLevel>;
}

export interface CalendarWeekRow {
  start: string;
  end: string;
  steps: number | null;
  activeMinutes: number | null;
  workouts: number;
  /** The weekly goals, met or not, for a week that has started. */
  goals: GoalProgress[];
}

export interface ActivityCalendar {
  period: ActivityPeriod;
  start: string;
  end: string;
  gridStart: string;
  gridEnd: string;
  today: string;
  days: CalendarDay[];
  weeks: CalendarWeekRow[];
  baseline: Record<RatedMetric, BaselineStats | null>;
  summary: Record<SummaryMetric, PeriodComparison>;
  sports: Array<{ sportType: string; count: number }>;
  goals: ActivityGoals;
  goalProgress: GoalProgress[];
  available: Record<SummaryMetric, boolean>;
  previous: string;
  next: string | null;
}

/**
 * Assemble the calendar from per-day inputs covering at least
 * `bounds.readStart`..`bounds.gridEnd`. Days missing from `input` count as
 * days without any reading.
 */
export function buildActivityCalendar(args: {
  bounds: PeriodBounds;
  today: string;
  input: readonly ActivityDayInput[];
  goals: ActivityGoals;
}): ActivityCalendar {
  const { bounds, today, input, goals } = args;
  const byDate = new Map(input.map((d) => [d.date, d]));
  const empty = (date: string): ActivityDayInput => ({
    date,
    steps: null,
    exerciseMinutes: null,
    workoutMinutes: 0,
    workoutCount: 0,
    workoutsBySport: {},
    load: null,
  });
  const dayOf = (date: string) => byDate.get(date) ?? empty(date);

  // The first day with any activity signal: from there on, a day without
  // workouts or exercise minutes is a day of 0 active minutes, not a gap.
  const firstActivityDay =
    input
      .filter(
        (d) =>
          d.exerciseMinutes !== null ||
          d.workoutCount > 0 ||
          d.workoutMinutes > 0,
      )
      .map((d) => d.date)
      .sort()[0] ?? null;
  const hasActivityOn = (date: string) =>
    firstActivityDay !== null && date >= firstActivityDay && date <= today;

  const valueOf = (metric: SummaryMetric) => (date: string) => {
    if (date > today) return null;
    const day = dayOf(date);
    if (metric === "workouts")
      return hasActivityOn(date) ? day.workoutCount : null;
    return metricValue(day, metric, hasActivityOn(date));
  };

  const baselineFrom = shiftDateKey(bounds.start, -BASELINE_DAYS);
  const baselineTo = shiftDateKey(bounds.start, -1);
  const baselineDays = dayRange(baselineFrom, baselineTo);
  const ratedMetrics: RatedMetric[] = ["steps", "activeMinutes", "load"];
  const baseline = Object.fromEntries(
    ratedMetrics.map((metric) => [
      metric,
      baselineStats(
        baselineDays
          .map(valueOf(metric))
          .filter((v): v is number => v !== null),
      ),
    ]),
  ) as Record<RatedMetric, BaselineStats | null>;

  const days: CalendarDay[] = dayRange(bounds.gridStart, bounds.gridEnd).map(
    (date) => {
      const day = dayOf(date);
      const future = date > today;
      const steps = future ? null : day.steps;
      const activeMinutes = future
        ? null
        : activeMinutesOf(day, hasActivityOn(date));
      const load = future ? null : day.load;
      // Today has not ended: shown, never rated against whole days.
      const levelOf = (
        value: number | null,
        stats: BaselineStats | null,
      ): DayLevel =>
        date === today && value !== null
          ? "in_progress"
          : dayLevel(value, stats);
      return {
        date,
        inPeriod: date >= bounds.start && date <= bounds.end,
        future,
        steps,
        activeMinutes,
        workoutCount: future ? 0 : day.workoutCount,
        workoutsBySport: future ? {} : day.workoutsBySport,
        load,
        level: {
          steps: levelOf(steps, baseline.steps),
          activeMinutes: levelOf(activeMinutes, baseline.activeMinutes),
          load: levelOf(load, baseline.load),
        },
      };
    },
  );

  const summary: Record<SummaryMetric, PeriodComparison> = {
    steps: comparePeriod({
      bounds,
      today,
      valueOf: valueOf("steps"),
      mode: "sum",
    }),
    activeMinutes: comparePeriod({
      bounds,
      today,
      valueOf: valueOf("activeMinutes"),
      mode: "sum",
    }),
    workouts: comparePeriod({
      bounds,
      today,
      valueOf: valueOf("workouts"),
      mode: "sum",
    }),
    load: comparePeriod({
      bounds,
      today,
      valueOf: valueOf("load"),
      mode: "mean",
    }),
  };

  const sportCounts = new Map<string, number>();
  for (const date of dayRange(bounds.start, bounds.end)) {
    if (date > today) break;
    for (const [sport, count] of Object.entries(dayOf(date).workoutsBySport)) {
      sportCounts.set(sport, (sportCounts.get(sport) ?? 0) + count);
    }
  }
  const sports = [...sportCounts]
    .map(([sportType, count]) => ({ sportType, count }))
    .sort(
      (a, b) => b.count - a.count || a.sportType.localeCompare(b.sportType),
    );

  const weeks: CalendarWeekRow[] = [];
  for (
    let start = bounds.gridStart;
    start <= bounds.gridEnd;
    start = shiftDateKey(start, 7)
  ) {
    const end = shiftDateKey(start, 6);
    const range = dayRange(start, end);
    const sum = (metric: SummaryMetric) =>
      aggregate(range.map(valueOf(metric)), "sum").value;
    const row = {
      start,
      end,
      steps: sum("steps"),
      activeMinutes: sum("activeMinutes"),
      workouts: sum("workouts") ?? 0,
    };
    weeks.push({
      ...row,
      goals:
        start > today
          ? []
          : goalProgress("week", goals, {
              steps: row.steps,
              activeMinutes: row.activeMinutes,
              workouts: row.workouts,
            }),
    });
  }

  const progress = goalProgress(bounds.period, goals, {
    steps: summary.steps.value,
    activeMinutes: summary.activeMinutes.value,
    workouts: summary.workouts.value,
  });

  const anyIn = (pick: (d: ActivityDayInput) => boolean) => input.some(pick);
  const available: Record<SummaryMetric, boolean> = {
    steps: anyIn((d) => d.steps !== null),
    activeMinutes: firstActivityDay !== null,
    workouts: anyIn((d) => d.workoutCount > 0),
    load: anyIn((d) => d.load !== null),
  };

  const previous =
    bounds.period === "week"
      ? shiftDateKey(bounds.start, -7)
      : shiftMonth(bounds.start, -1);
  const nextStart =
    bounds.period === "week"
      ? shiftDateKey(bounds.start, 7)
      : shiftMonth(bounds.start, 1);

  return {
    period: bounds.period,
    start: bounds.start,
    end: bounds.end,
    gridStart: bounds.gridStart,
    gridEnd: bounds.gridEnd,
    today,
    days,
    weeks,
    baseline,
    summary,
    sports,
    goals,
    goalProgress: progress,
    available,
    previous,
    next: nextStart > today ? null : nextStart,
  };
}
