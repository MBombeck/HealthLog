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
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  PROFILE_HOURS,
  readCumulativeDayProfiles,
  type CumulativeDayProfile,
} from "@/lib/measurements/intraday-cumulative-profile";
import { hourOfDayForUserTz } from "@/lib/measurements/consolidation-tz";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

import { buildBaselineBand, type BaselineProfile } from "./baseline";
import { buildInsufficient, buildOk, deriveCoverage } from "./coverage";
import {
  SAME_TIME_BASELINE_MIN_HISTORY_DAYS,
  SAME_TIME_BASELINE_WINDOW_DAYS,
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

/** The successful `value` payload for a same-time baseline. */
export interface SameTimeBaselineValue {
  /** The cumulative metric this compares. */
  type: MeasurementType;
  /** Canonical unit of every figure below. */
  unit: string;
  /** IANA zone every "hour" here is expressed in. */
  timezone: string;
  /** Local calendar day the comparison is for. */
  dateKey: string;
  /**
   * The last COMPLETED local hour (0–23). Both curves are `asOfHour + 1`
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

export interface SameTimeBaselineOpts {
  /** The cumulative metric to compare. */
  type: MeasurementType;
  /** Trailing window override (days). */
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
 */
export async function computeSameTimeBaseline(
  userId: string,
  _profile: BaselineProfile | null,
  opts: SameTimeBaselineOpts,
): Promise<Derived<SameTimeBaselineValue>> {
  const now = opts.now ?? new Date();
  const type = opts.type;
  const windowDays = opts.windowDays ?? SAME_TIME_BASELINE_WINDOW_DAYS;
  const computedAt = now.toISOString();

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const timezone = user?.timezone || DEFAULT_TIMEZONE;
  const dateKey = userDayKey(now, timezone);

  const gate = (reason: string, historyDays: number) =>
    buildInsufficient<SameTimeBaselineValue>({
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

  // No sub-daily rows for today at all. This is the permanent state for every
  // account whose activity arrives as a daily total — Fitbit, Withings, Polar
  // all write one row per day and never had an intraday stream. It is honest
  // absence and must never render as a failure.
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

  return buildOk<SameTimeBaselineValue>({
    value: {
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
