/**
 * Whether a record is in a pregnancy or postpartum state, for every surface
 * outside the cycle page that frames weight: the Health Score's personal
 * weight goal and its body-shape pillar, the weight personal records, the
 * weight and BMI targets of the Insights pages and the overview, the BMI
 * status note, the doctor report's BMI category, the Coach's weight nudge
 * and the BMI achievement. While the state holds, weight is shown as data
 * and never measured against a goal or a BMI band, nudged about, or
 * celebrated (`src/__tests__/pregnancy-weight-framing-guard.test.ts`).
 *
 * One point read (`loadPregnancyFields`). A record that never set up cycle
 * tracking, or has the cycle module off (its own switch or the operator's),
 * has no state here. A database client without the cycle model (a unit
 * test's partial mock) reads as no state.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { resolveWeightTargetOverride } from "@/lib/analytics/effective-range";
import { DEFAULT_TIMEZONE, userDayKey } from "@/lib/tz/format";

import { resolvePregnancyState } from "./pregnancy";
import { loadPregnancyFields } from "./pregnancy-store";

export async function pregnancyContextActive(
  db: Pick<PrismaClient, "cycleProfile">,
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<boolean> {
  const fields = await loadPregnancyFields(db, userId);
  if (!fields) return false;
  return resolvePregnancyState(fields, userDayKey(now, timezone))
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

/**
 * The same state per calendar day, for a reader that classifies a series of
 * days (the BMI achievement's green days): true for a day key inside the
 * pregnancy or its postpartum weeks. One read, then pure.
 */
export async function pregnancyDayTest(
  db: Pick<PrismaClient, "cycleProfile">,
  userId: string,
): Promise<(dayKey: string) => boolean> {
  const fields = await loadPregnancyFields(db, userId);
  if (!fields) return () => false;
  return (dayKey) => resolvePregnancyState(fields, dayKey).predictionsPaused;
}

/** `pregnancyContextActive` for a user row: its id and its zone. */
export function weightFramingPaused(
  db: Pick<PrismaClient, "cycleProfile">,
  user: { id: string; timezone?: string | null },
  now: Date = new Date(),
): Promise<boolean> {
  return pregnancyContextActive(
    db,
    user.id,
    user.timezone ?? DEFAULT_TIMEZONE,
    now,
  );
}

/**
 * The person's own weight target, or none while a pregnancy or its
 * postpartum weeks hold, with the state beside it for a caller that judges
 * more than the target.
 */
export async function weightTargetFor(
  db: Pick<PrismaClient, "cycleProfile">,
  userId: string,
  user: { timezone?: string | null; thresholdsJson?: unknown } | null,
  now: Date = new Date(),
): Promise<{
  pregnancy: boolean;
  target: { min: number; max: number } | null;
}> {
  const pregnancy = await weightFramingPaused(
    db,
    { id: userId, timezone: user?.timezone },
    now,
  );
  return {
    pregnancy,
    target: pregnancy
      ? null
      : resolveWeightTargetOverride(user?.thresholdsJson),
  };
}
