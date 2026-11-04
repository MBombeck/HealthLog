/**
 * Period days a wearable reports (Garmin, Oura), written as a SUBORDINATE
 * source.
 *
 * `CycleDayLog` holds one canonical row per `(userId, date)`, and the shared
 * upsert (`./day-log-write.ts`) partial-merges a re-post over whatever is
 * stored regardless of source. An hourly poll going through it would demote a
 * day the person logged themselves (their HEAVY re-tagged LIGHT on the next
 * tick). So a wearable day is only ever CREATED, when no row exists for that
 * date at all, and never updated.
 *
 * What the shared upsert does beyond the row itself happens here too, through
 * the same functions: a created day is attributed to the cycle it falls in,
 * and a first bleeding day opens its cycle (`ensureCycleForBleedingDay`),
 * which closes the cycle before it and takes its own end from the one after
 * it. Without that a period imported from a watch was a run of rows the
 * engine never read: no cycle start, no lengths, no forecast.
 */
import { prisma } from "@/lib/db";
import { getEvent } from "@/lib/logging/context";
import type { FlowLevel } from "@/generated/prisma/client";

import { ensureCycleForBleedingDay } from "./cycle-boundaries";
import { findOwningCycleId } from "./cycle-attribution";

/** The wearables that write period days under this rule. */
export type SubordinateCycleSource = "GARMIN" | "OURA";

/**
 * The conservative "logged, intensity unknown" level: a detected bleeding day
 * is at least light, never invented as MEDIUM or HEAVY.
 */
export const SUBORDINATE_PERIOD_FLOW: FlowLevel = "LIGHT";

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * Create the period days no row covers yet, oldest first, each attributed to
 * its cycle, and open the cycle a first bleeding day starts. Returns how many
 * rows were created.
 */
export async function createSubordinatePeriodDays(
  userId: string,
  source: SubordinateCycleSource,
  days: readonly string[],
): Promise<number> {
  if (days.length === 0) return 0;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { timezone: true },
  });
  const tz = user?.timezone ?? null;
  let created = 0;
  for (const day of [...new Set(days)].sort()) {
    try {
      await prisma.cycleDayLog.create({
        data: {
          userId,
          date: day,
          tz,
          source,
          flow: SUBORDINATE_PERIOD_FLOW,
          cycleId: await findOwningCycleId(userId, day),
        },
      });
    } catch (err) {
      // A row already exists: the person's own, an import's, or this
      // source's earlier write. A wearable never overwrites.
      if (isUniqueViolation(err)) continue;
      getEvent()?.addWarning(
        `${source.toLowerCase()}: cycle day-log create failed for ${userId} ${day}: ${err}`,
      );
      continue;
    }
    created += 1;
    // After the create, so the opened cycle claims the row just written.
    await ensureCycleForBleedingDay(userId, day, tz, {
      flow: SUBORDINATE_PERIOD_FLOW,
      intermenstrualBleeding: false,
    });
  }
  return created;
}

/**
 * Stamp the last day of a finished period on the cycle that opens at
 * `start`, when that cycle has no period end yet. A person's own end, or one
 * an earlier pass stamped, stays. Returns whether a stamp was written.
 */
export async function stampSubordinatePeriodEnd(
  userId: string,
  start: string,
  lastDay: string,
): Promise<boolean> {
  if (lastDay < start) return false;
  const stamped = await prisma.menstrualCycle.updateMany({
    where: {
      userId,
      startDate: start,
      deletedAt: null,
      periodEndDate: null,
    },
    data: { periodEndDate: lastDay, syncVersion: { increment: 1 } },
  });
  return stamped.count > 0;
}
