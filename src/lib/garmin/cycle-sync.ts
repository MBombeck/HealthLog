/**
 * Garmin's menstrual-cycle summary → HealthLog's cycle tracker, as an
 * ADDITIONAL, SUBORDINATE source, with the same write rule as Oura's cycle
 * import (`src/lib/oura/cycle-sync.ts`): a day is only ever CREATED when no
 * `CycleDayLog` row exists for it at all (any source), and never updated, so
 * a person's own entry always wins and an hourly poll can never demote it.
 * The write goes through `createSubordinatePeriodDays`, which attributes each
 * created day to its cycle and opens the cycle a first bleeding day starts,
 * as every other cycle writer does. A finished period also stamps its last
 * day on that cycle, when Garmin opened it and it has no period end yet.
 *
 * `GET /periodichealth-service/menstrualcycle/summary/{date}` describes the
 * cycle a date falls in: its start and its period length. A cycle Garmin
 * only predicts, and a pregnancy, carry nothing to import. The period days of
 * a logged cycle are `start … start + periodLength − 1`, each written as the
 * conservative `flow: LIGHT` marker (logged, intensity unknown), never in the
 * future.
 *
 * Gated behind the cycle module (`isCycleAvailableForUser`), checked before
 * Garmin is asked, so an account with cycle tracking off costs no request.
 */
import { isCycleAvailableForUser } from "@/lib/cycle/gate";
import {
  createSubordinatePeriodDays,
  stampSubordinatePeriodEnd,
} from "@/lib/cycle/subordinate-period-days";

import { GARMIN_PATHS, shiftGarminDay, type GarminSession } from "./client";
import type { GarminCycleDate, GarminCycleSummary } from "./wire-types";

/** The longest period a single summary may claim before it is not believed. */
const MAX_PERIOD_DAYS = 14;

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

/** A cycle date as Garmin sends it: bare, or `{ localDate, date }`. */
export function garminCycleDay(value: GarminCycleDate): string | null {
  if (typeof value === "string") {
    const day = value.slice(0, 10);
    return DAY_KEY.test(day) ? day : null;
  }
  if (value && typeof value === "object") {
    if (typeof value.localDate === "string" && DAY_KEY.test(value.localDate)) {
      return value.localDate;
    }
    if (typeof value.date === "string") {
      const day = value.date.slice(0, 10);
      return DAY_KEY.test(day) ? day : null;
    }
  }
  return null;
}

export interface GarminCyclePeriod {
  /** First day of the cycle. */
  start: string;
  /** The period's days, oldest first, none after `today`. */
  days: string[];
  /** Every day of the period lies before `today`: its last day is known. */
  ended: boolean;
}

/** The logged period a summary describes, or null when there is none. */
export function periodFromGarminCycleSummary(
  summary: GarminCycleSummary | null,
  today: string,
): GarminCyclePeriod | null {
  if (!summary || summary.predictedCycle === true) return null;
  if (summary.pregnancyCycle === true) return null;
  const start = garminCycleDay(summary.startDate);
  if (!start || start > today) return null;
  const length = summary.periodLength;
  if (typeof length !== "number" || !Number.isFinite(length)) return null;
  const n = Math.round(length);
  if (n < 1 || n > MAX_PERIOD_DAYS) return { start, days: [], ended: false };
  const days: string[] = [];
  for (let i = 0; i < n; i++) {
    const day = shiftGarminDay(start, i);
    if (day > today) break;
    days.push(day);
  }
  const ended = days.length === n && days[n - 1]! < today;
  return { start, days, ended };
}

/**
 * Write one period: create the days no row covers yet (opening and
 * attributing its cycle), then stamp the period's end once it is over.
 * Returns how many days were created.
 */
export async function writeGarminPeriod(
  userId: string,
  period: GarminCyclePeriod,
): Promise<number> {
  const created = await createSubordinatePeriodDays(
    userId,
    "GARMIN",
    period.days,
  );
  if (period.ended) {
    await stampSubordinatePeriodEnd(
      userId,
      "GARMIN",
      period.start,
      period.days.at(-1)!,
    );
  }
  return created;
}

/** Read the cycle summary for one date (null when Garmin has none). */
export async function readGarminCycleSummary(
  session: GarminSession,
  day: string,
): Promise<GarminCycleSummary | null> {
  return session.get<GarminCycleSummary>(
    "cycleSummary",
    `${GARMIN_PATHS.cycleSummary}/${day}`,
  );
}

/**
 * The hourly leg: the cycle `today` falls in. Returns days created; throws
 * what the fetch throws, and the caller keeps it off the connection's ledger
 * (a person who does not track a cycle in Garmin Connect is the common case).
 */
export async function syncGarminCycle(
  userId: string,
  session: GarminSession,
  today: string,
): Promise<number> {
  if (!(await isCycleAvailableForUser(userId))) return 0;
  const summary = await readGarminCycleSummary(session, today);
  const period = periodFromGarminCycleSummary(summary, today);
  if (!period) return 0;
  return writeGarminPeriod(userId, period);
}
