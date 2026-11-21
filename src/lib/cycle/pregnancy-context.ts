/**
 * Whether a record is in a pregnancy or postpartum state today (v1.49), for
 * the surfaces outside the cycle page that frame weight: the Health Score's
 * personal weight goal and its body-shape pillar, and the weight personal
 * records. While the state holds, weight is shown as data and never measured
 * against a goal or celebrated as a low.
 *
 * One point read. A record that never set up cycle tracking, or turned it
 * off, has no state here. A database client without the cycle model (a unit
 * test's partial mock) reads as no state.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { userDayKey } from "@/lib/tz/format";

import { resolvePregnancyState } from "./pregnancy";

export async function pregnancyContextActive(
  db: Pick<PrismaClient, "cycleProfile">,
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<boolean> {
  if (typeof db.cycleProfile?.findUnique !== "function") return false;
  const profile = await db.cycleProfile.findUnique({
    where: { userId },
    select: {
      cycleTrackingEnabled: true,
      reproductiveState: true,
      pregnancyStartDate: true,
      pregnancyDueDate: true,
      deliveryDate: true,
      postpartumWeeks: true,
    },
  });
  if (!profile || profile.cycleTrackingEnabled === false) return false;
  return resolvePregnancyState(profile, userDayKey(now, timezone))
    .predictionsPaused;
}

/**
 * The same read for a Health Score run, keyed off its input. While a state
 * holds, the body-shape pillar (waist) does not count and the weight goal
 * shows no distance: the body is supposed to change, and a score that fell
 * for it would be framing it.
 */
export function pregnancyContextFor(
  db: Pick<PrismaClient, "cycleProfile">,
  input: { userId: string; now: Date; profile: { timezone: string } },
): Promise<boolean> {
  return pregnancyContextActive(
    db,
    input.userId,
    input.profile.timezone,
    input.now,
  );
}
