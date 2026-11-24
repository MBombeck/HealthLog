/**
 * v1.34.0 — the same-time baseline for a cumulative metric.
 *
 * `signals-of-day` excludes steps and says why in its own comment: intraday
 * step rows arrive as many partial-day fragments, so the newest raw row is not
 * a reading. Every other derived metric in this directory compares a latest
 * value to a band, and for a quantity that accumulates through the day that
 * comparison has no meaning — four thousand steps is a good day at 09:00 and a
 * poor one at 22:00.
 *
 * So this engine compares along the other axis. It takes today's running total
 * at the last COMPLETED local hour and puts it against the same person's own
 * typical total at that same hour, drawn from a trailing four weeks of their
 * stored intraday profiles (`intraday-cumulative-profile.ts`). Same estimator
 * as the vitals baseline — median for the centre, median ± k·MAD·1.4826 for
 * the band — so a reader who understands one understands the other.
 *
 * Everything the surface renders is decided HERE: the two curves, the delta,
 * the percentage, the band edges and the verdict of where today sits. The copy
 * is a deterministic template over these numbers. Nothing downstream computes a
 * comparison, and the Coach may explain one that already exists but may never
 * produce one.
 *
 * What it deliberately does not produce: a projected day total. Extrapolating
 * a partial day is a guess, and a feature that exists to replace guesses with
 * the person's own history has no business shipping one.
 *
 * Two modes, one metric. The hourly comparison needs the day's
 * hours, and only Apple Health delivers them: Garmin's Personal API, Withings'
 * activity read and a Gadgetbridge import all store the day as one total, so
 * those accounts got nothing (#1459). For them the engine answers in the
 * `daily_total` mode: today's running total, as the source last reported it,
 * against the person's usual FULL day (median and middle half of the last
 * fourteen complete days). It says when the total last changed and makes
 * no claim about "by this hour", because nothing it holds knows the hour.
 *
 * Which mode answers follows the person's source order, the same pick the
 * "per day" chart makes: when the source that owns today's total is a
 * day-total source, the day-total mode answers and the Apple Health hours are
 * not read at all, so an account with an iPhone and a watch never compares a
 * curve from one against a total from the other, and never adds the two.
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  CUMULATIVE_SAMPLE_SOURCES,
  PROFILE_HOURS,
  readCumulativeDayProfiles,
  type CumulativeDayProfile,
} from "@/lib/measurements/intraday-cumulative-profile";
import { hourOfDayForUserTz } from "@/lib/measurements/consolidation-tz";
import {
  readCanonicalCumulativeDayTotals,
  type CumulativeDayTotal,
} from "@/lib/measurements/cumulative-day-totals";
import { quantileSorted } from "@/lib/activity/calendar-math";
import { DEFAULT_TIMEZONE, shiftDateKey, userDayKey } from "@/lib/tz/format";

import { buildBaselineBand, type BaselineProfile } from "./baseline";
import { buildInsufficient, buildOk, deriveCoverage } from "./coverage";
import {
  SAME_TIME_BASELINE_MIN_HISTORY_DAYS,
  SAME_TIME_BASELINE_WINDOW_DAYS,
  SAME_TIME_DAILY_TOTAL_MIN_HISTORY_DAYS,
  SAME_TIME_DAILY_TOTAL_WINDOW_DAYS,
} from "./registry";
import type { Derived } from "./types";
import { median } from "@/lib/stats/central";

/**
 * Raw per-sample rows a stored day must have been folded from before it counts
 * towards the typical curve.
 *
 * A day the watch contributed two readings to is not the shape of that day —
 * it is two moments — and letting it into the median would quietly claim the
 * person walked nothing for twenty-two hours. Four is a low bar that a worn
 * watch clears by two orders of magnitude and a barely-synced day does not.
 */
const MIN_PROFILE_SAMPLES = 4;

/**
 * Canonical fallback units, matching what the Apple Health mapping writes for
 * each cumulative type. Only used when the account holds no row to read the
 * unit off — which, given the profile exists, essentially never happens.
 */
const FALLBACK_UNIT: Partial<Record<MeasurementType, string>> = {
  ACTIVITY_STEPS: "steps",
  ACTIVE_ENERGY_BURNED: "kcal",
  WALKING_RUNNING_DISTANCE: "m",
  FLIGHTS_CLIMBED: "flights",
};

/** Where today's running total sits against the typical band at this hour. */
export type SameTimeBand = "below" | "within" | "above";

/** The successful `value` payload of the hourly comparison. */
export interface SameTimeBaselineHourlyValue {
  mode: "hourly";
  /** The cumulative metric this compares. */
  type: MeasurementType;
  /** Canonical unit of every figure below. */
  unit: string;
  /** IANA zone every "hour" here is expressed in. */
  timezone: string;
  /** Local calendar day the comparison is for. */
  dateKey: string;
  /**
   * The last COMPLETED local hour (0–22). Both curves are `asOfHour + 1`
   * points long and index-aligned: element `h` is the total through the end of
   * local hour `h`.
   */
  asOfHour: number;
  /** Today's running total through the end of `asOfHour`. */
  todayValue: number;
  /** The median of the window's days at that same hour. */
  typicalValue: number;
  /** Band lower edge — median − k·MAD·1.4826, floored at zero. */
  typicalLow: number;
  /** Band upper edge — median + k·MAD·1.4826. */
  typicalHigh: number;
  /** Signed difference, today − typical. */
  delta: number;
  /**
   * Today as a percentage of typical, rounded. `null` when the typical total
   * at this hour is zero — which is the normal state at 05:00 and is an
   * undefined ratio, not a hundred percent and not a failure.
   */
  percentOfTypical: number | null;
  /** The server's verdict of where today sits against the band. */
  band: SameTimeBand;
  /** Today's cumulative curve, hours 0 … `asOfHour`. */
  todayCurve: number[];
  /** The typical cumulative curve over the same hours. */
  typicalCurve: number[];
  /** Days that actually backed the typical curve. */
  baselineDays: number;
  /** Trailing window the days were drawn from. */
  windowDays: number;
}

/**
 * How far today's running total has come against the usual full day:
 * `not_yet` below its lower edge, `within` inside the middle half, `above`
 * past its upper edge. A statement about the total, not a verdict on the day:
 * a day still running is `not_yet` most of the morning, and that is no
 * shortfall.
 */
export type SameTimeDayRangeReached = "not_yet" | "within" | "above";

/**
 * The successful `value` payload of the day-total form. Carries no hour and no
 * curve, on purpose: nothing behind it knows when in the day the total grew,
 * and a client that only understands the hourly payload finds the fields it
 * needs missing rather than misread.
 */
export interface SameTimeBaselineDailyTotalValue {
  mode: "daily_total";
  type: MeasurementType;
  unit: string;
  timezone: string;
  dateKey: string;
  /** Today's running total, as the source last reported it. */
  todayValue: number;
  /** Median full-day total of the window's complete days. */
  typicalValue: number;
  /** 25th percentile of those days. */
  typicalLow: number;
  /** 75th percentile of those days. */
  typicalHigh: number;
  /**
   * Today as a percentage of the usual full day, rounded; `null` when the
   * usual full day is zero.
   */
  percentOfTypical: number | null;
  dayRangeReached: SameTimeDayRangeReached;
  /** The source that owns today's total under the person's source order. */
  source: string;
  /** When today's total last changed on the server (ISO 8601). */
  updatedAt: string;
  /** Complete days with a total behind the range. */
  baselineDays: number;
  /** Complete days the range was drawn from. */
  windowDays: number;
}

/** The successful `value` payload for a same-time baseline. */
export type SameTimeBaselineValue =
  SameTimeBaselineHourlyValue | SameTimeBaselineDailyTotalValue;

export interface SameTimeBaselineOpts {
  /** The cumulative metric to compare. */
  type: MeasurementType;
  /** Trailing window override (days) for the hourly comparison. */
  windowDays?: number;
  now?: Date;
}

/**
 * Compute the same-time baseline for one cumulative metric.
 *
 * `profile` is accepted for signature parity with every other engine in this
 * directory — the dispatcher hands each one the same once-loaded profile — but
 * a same-time comparison is purely against the person's own history and reads
 * nothing off it. It is therefore nullable, so a caller outside the dispatcher
 * (the daily digest) does not have to issue a profile read it has no use for.
 * The timezone the engine does need is read here, because a comparison whose
 * whole subject is "at this hour" cannot borrow anybody else's clock.
 *
 * The mode: the day totals are read first, one source per day as the chart
 * picks it. When the newest day's source reports day totals, the day-total
 * form answers alone. Otherwise the hourly comparison answers when it can;
 * while it cannot (still learning, or no hours today) the day-total form
 * stands in when it has a range, so a phone account with an imported history
 * is not told to wait two weeks for a number its history already has.
 */
export async function computeSameTimeBaseline(
  userId: string,
  _profile: BaselineProfile | null,
  opts: SameTimeBaselineOpts,
): Promise<Derived<SameTimeBaselineValue>> {
  const now = opts.now ?? new Date();
  const type = opts.type;
  const computedAt = now.toISOString();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true, sourcePriorityJson: true },
  });
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const dateKey = userDayKey(now, timezone);

  const totals = await readCanonicalCumulativeDayTotals({
    userId,
    type,
    timeZone: timezone,
    fromDateKey: shiftDateKey(dateKey, -SAME_TIME_DAILY_TOTAL_WINDOW_DAYS),
    toDateKey: dateKey,
    priorityJson: user?.sourcePriorityJson ?? null,
  });
  const daily = buildDailyTotalBaseline({
    type,
    timezone,
    dateKey,
    totals,
    computedAt,
  });
  const withUnit = async (
    d: Derived<SameTimeBaselineDailyTotalValue>,
  ): Promise<Derived<SameTimeBaselineValue>> =>
    d.status === "ok"
      ? { ...d, value: { ...d.value, unit: await resolveUnit(userId, type) } }
      : d;

  if (ownedByDayTotalSource(totals, dateKey)) return withUnit(daily);

  const hourly = await computeHourlyBaseline({
    userId,
    type,
    timezone,
    dateKey,
    now,
    windowDays: opts.windowDays ?? SAME_TIME_BASELINE_WINDOW_DAYS,
    computedAt,
  });
  if (hourly.status === "ok") return hourly;
  if (daily.status === "ok") return withUnit(daily);
  if (hourly.reason === "learning_usual_day") return hourly;
  if (daily.reason === "learning_usual_total") return daily;
  return hourly;
}

/**
 * Whether the newest day in the window belongs to a source that reports one
 * total per day. Today's owner decides; before today's first sync, the
 * newest earlier day stands in, so a Garmin account is not handed to the
 * hourly engine every morning only to be told it has no hours.
 */
export function ownedByDayTotalSource(
  totals: readonly CumulativeDayTotal[],
  dateKey: string,
): boolean {
  let newest: CumulativeDayTotal | null = null;
  for (const d of totals) {
    if (d.dateKey > dateKey) continue;
    if (!newest || d.dateKey > newest.dateKey) newest = d;
  }
  if (!newest) return false;
  return !CUMULATIVE_SAMPLE_SOURCES.includes(newest.source);
}

/**
 * The day-total form, pure. `totals` are the canonical day totals of the
 * window, today included; `unit` is filled in by the caller on the `ok` arm.
 */
export function buildDailyTotalBaseline(args: {
  type: MeasurementType;
  timezone: string;
  dateKey: string;
  totals: readonly CumulativeDayTotal[];
  computedAt: string;
  unit?: string;
}): Derived<SameTimeBaselineDailyTotalValue> {
  const { type, timezone, dateKey, computedAt } = args;
  const windowDays = SAME_TIME_DAILY_TOTAL_WINDOW_DAYS;
  const firstDay = shiftDateKey(dateKey, -windowDays);
  const today = args.totals.find((d) => d.dateKey === dateKey) ?? null;
  const history = args.totals.filter(
    (d) => d.dateKey >= firstDay && d.dateKey < dateKey,
  );

  const gate = (reason: string) =>
    buildInsufficient<SameTimeBaselineDailyTotalValue>({
      coverage: {
        requiredInputs: 1,
        presentInputs: history.length > 0 ? 1 : 0,
        historyDays: history.length,
        missing: history.length > 0 ? [] : [type],
      },
      provenance: {
        inputs: [type],
        source: history.length > 0 ? "live" : "none",
        windowDays,
        computedAt,
      },
      reason,
    });

  // Nothing from today yet: the source has not reported since midnight.
  // There is no running total to show, and a zero would be invented.
  if (!today) return gate("no_total_today");
  if (history.length < SAME_TIME_DAILY_TOTAL_MIN_HISTORY_DAYS) {
    return gate("learning_usual_total");
  }

  const sorted = history.map((d) => d.total).sort((a, b) => a - b);
  const typicalValue = quantileSorted(sorted, 0.5);
  const typicalLow = quantileSorted(sorted, 0.25);
  const typicalHigh = quantileSorted(sorted, 0.75);
  const todayValue = today.total;
  const dayRangeReached: SameTimeDayRangeReached =
    todayValue > typicalHigh
      ? "above"
      : todayValue >= typicalLow
        ? "within"
        : "not_yet";

  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: history.length,
    missing: [],
    fullHistoryDays: windowDays,
  });

  return buildOk<SameTimeBaselineDailyTotalValue>({
    value: {
      mode: "daily_total",
      type,
      unit: args.unit ?? FALLBACK_UNIT[type] ?? "count",
      timezone,
      dateKey,
      todayValue,
      typicalValue,
      typicalLow,
      typicalHigh,
      percentOfTypical:
        typicalValue > 0 ? Math.round((todayValue / typicalValue) * 100) : null,
      dayRangeReached,
      source: today.source,
      updatedAt: today.lastUpdatedAt.toISOString(),
      baselineDays: history.length,
      windowDays,
    },
    coverage,
    confidence,
    provenance: {
      inputs: [type],
      source: "live",
      windowDays,
      computedAt,
    },
  });
}

/** The hourly comparison: today's curve against the usual one. */
async function computeHourlyBaseline(args: {
  userId: string;
  type: MeasurementType;
  timezone: string;
  dateKey: string;
  now: Date;
  windowDays: number;
  computedAt: string;
}): Promise<Derived<SameTimeBaselineHourlyValue>> {
  const { userId, type, timezone, dateKey, now, windowDays, computedAt } = args;

  const gate = (reason: string, historyDays: number) =>
    buildInsufficient<SameTimeBaselineHourlyValue>({
      coverage: {
        requiredInputs: 1,
        presentInputs: historyDays > 0 ? 1 : 0,
        historyDays,
        missing: historyDays > 0 ? [] : [type],
      },
      provenance: {
        inputs: [type],
        source: historyDays > 0 ? "live" : "none",
        windowDays,
        computedAt,
      },
      reason,
    });

  // The comparison is anchored to the last hour that has FINISHED. Comparing
  // against an hour still in progress would put a partial hour of today
  // against a whole one of every other day and manufacture a shortfall out of
  // nothing. Before 01:00 there is no completed hour, and the honest answer is
  // that the day is too young to say anything about.
  const asOfHour = hourOfDayForUserTz(now, timezone) - 1;
  if (asOfHour < 0) return gate("day_too_young", 0);

  const profiles = await readCumulativeDayProfiles({
    userId,
    type,
    timezone,
    endDateKey: dateKey,
    windowDays,
  });

  const today = profiles.find((p) => p.dateKey === dateKey) ?? null;
  const history = profiles.filter(
    (p) => p.dateKey !== dateKey && isUsableHistoryDay(p),
  );

  // No sub-daily rows for today at all. An account whose day belongs to a
  // day-total source never gets here (the day-total form answers it); this is
  // a phone account before its first sample of the day.
  if (!today) return gate("no_intraday_today", history.length);

  if (history.length < SAME_TIME_BASELINE_MIN_HISTORY_DAYS) {
    return gate("learning_usual_day", history.length);
  }

  // Both curves run hour 0 … asOfHour, index-aligned.
  const hours = asOfHour + 1;
  const todayCurve = today.hourlyCumulative.slice(0, hours);
  const typicalCurve: number[] = [];
  for (let h = 0; h < hours; h += 1) {
    typicalCurve.push(median(history.map((p) => p.hourlyCumulative[h]))!);
  }

  const todayValue = todayCurve[asOfHour];
  const typicalValue = typicalCurve[asOfHour];

  // The band comes off the same estimator the vitals baseline uses, applied to
  // the window's totals AT THIS HOUR rather than to daily means. Passing the
  // metric is what floors the lower edge at zero: a cumulative total cannot be
  // negative, and a band edge below zero would widen the "within" verdict on
  // the low side for free. That floor used to be a local `Math.max(0, …)` here.
  // It is gone because `buildBaselineBand` now answers the question for every
  // caller from the metric's declared domain, and one question with two answers
  // in the same tree is the defect this release exists to remove.
  const atHour = history.map((p) => p.hourlyCumulative[asOfHour]);
  const spread = buildBaselineBand(atHour, type);
  const typicalLow = spread ? spread.low : typicalValue;
  const typicalHigh = spread ? spread.high : typicalValue;

  const band: SameTimeBand =
    todayValue < typicalLow
      ? "below"
      : todayValue > typicalHigh
        ? "above"
        : "within";

  const { coverage, confidence } = deriveCoverage({
    requiredInputs: 1,
    presentInputs: 1,
    historyDays: history.length,
    missing: [],
    fullHistoryDays: windowDays,
  });

  return buildOk<SameTimeBaselineHourlyValue>({
    value: {
      mode: "hourly",
      type,
      unit: await resolveUnit(userId, type),
      timezone,
      dateKey,
      asOfHour,
      todayValue,
      typicalValue,
      typicalLow,
      typicalHigh,
      delta: todayValue - typicalValue,
      percentOfTypical:
        typicalValue > 0 ? Math.round((todayValue / typicalValue) * 100) : null,
      band,
      todayCurve,
      typicalCurve,
      baselineDays: history.length,
      windowDays,
    },
    coverage,
    confidence,
    provenance: {
      inputs: [type],
      // The profiles are their own tier, neither a rollup bucket nor a live
      // measurement read, so the honest label for the dominant read is `live`.
      source: "live",
      windowDays,
      computedAt,
    },
  });
}

/** A stored day dense enough to describe the shape of that day. */
function isUsableHistoryDay(p: CumulativeDayProfile): boolean {
  return (
    p.sampleCount >= MIN_PROFILE_SAMPLES &&
    p.hourlyCumulative.length === PROFILE_HOURS
  );
}

/**
 * The unit the account's own rows for this type carry. Read rather than
 * assumed, so a source that stores distance in a different unit than Apple
 * Health does labels its own numbers correctly.
 */
async function resolveUnit(
  userId: string,
  type: MeasurementType,
): Promise<string> {
  const row = await prisma.measurement.findFirst({
    where: { userId, type, deletedAt: null },
    orderBy: { measuredAt: "desc" },
    select: { unit: true },
  });
  return row?.unit ?? FALLBACK_UNIT[type] ?? "count";
}
