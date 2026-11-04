/**
 * Garmin's menstrual-cycle summary → HealthLog's cycle tracker, as an
 * ADDITIONAL, SUBORDINATE source, with the same write rule as Oura's cycle
 * import (`src/lib/oura/cycle-sync.ts`): a day is only ever CREATED when no
 * `CycleDayLog` row exists for it at all (any source), and never updated, so
 * a person's own entry always wins and an hourly poll can never demote it.
 * No `MenstrualCycle` span is created; cycle spans stay an explicit action.
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
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import { isCycleAvailableForUser } from "@/lib/cycle/gate";

import { GARMIN_PATHS, shiftGarminDay, type GarminSession } from "./client";
import type { GarminCycleDate, GarminCycleSummary } from "./wire-types";

const GARMIN_PERIOD_FLOW = "LIGHT" as const;

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
  if (n < 1 || n > MAX_PERIOD_DAYS) return { start, days: [] };
  const days: string[] = [];
  for (let i = 0; i < n; i++) {
    const day = shiftGarminDay(start, i);
    if (day > today) break;
    days.push(day);
  }
  return { start, days };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/** Create the period days no row covers yet. Returns how many were created. */
export async function writeGarminPeriodDays(
  userId: string,
  days: readonly string[],
): Promise<number> {
  if (days.length === 0) return 0;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = user?.timezone ?? null;
  let created = 0;
  for (const day of days) {
    try {
      await prisma.cycleDayLog.create({
        data: {
          userId,
          date: day,
          tz,
          source: "GARMIN",
          flow: GARMIN_PERIOD_FLOW,
        },
      });
      created += 1;
    } catch (err) {
      // A row already exists: the person's own, an import's, or this
      // module's earlier write. Garmin never overwrites.
      if (isUniqueViolation(err)) continue;
      getEvent()?.addWarning(
        `garmin: cycle day-log create failed for ${userId} ${day}: ${err}`,
      );
    }
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
  return writeGarminPeriodDays(userId, period.days);
}
