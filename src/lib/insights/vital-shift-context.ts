/**
 * A known state that explains a shift in weight and vitals.
 *
 * A resting heart rate that rises with a flu is expected, and the person
 * knows they are ill. The same holds through a pregnancy and after a birth:
 * the resting pulse rises by 10 to 20 beats, the weight rises week by week
 * and falls again after the delivery, and the blood pressure moves. A notice
 * that calls any of that a lasting change would arrive every week for months
 * and tell the person something they know better.
 *
 * One read for every surface that tells a person about such a shift on its
 * own initiative (the lasting-change notice today). The structural test
 * `vital-shift-context-guard.test.ts` holds every dispatcher of
 * `MEASUREMENT_ANOMALY` to it, so a new state added here reaches them all.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { pregnancyContextActive } from "@/lib/cycle/pregnancy-context";

export type VitalShiftContext = "illness" | "pregnancy";

export async function vitalShiftContext(
  db: Pick<PrismaClient, "illnessEpisode" | "cycleProfile">,
  userId: string,
  timezone: string,
  now: Date,
): Promise<VitalShiftContext | null> {
  const ill = await db.illnessEpisode.findFirst({
    where: { userId, deletedAt: null, resolvedAt: null },
    select: { id: true },
  });
  if (ill) return "illness";
  if (await pregnancyContextActive(db, userId, timezone, now)) {
    return "pregnancy";
  }
  return null;
}
