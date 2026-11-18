/**
 * The per-type input stamp the status-note gate hashes: how many live
 * readings a type holds and when its newest one was measured.
 *
 * The figures are the ones the gate always hashed, so a stored note's hash
 * still matches after the change; only the reads differ. The count used to
 * be a grouped count of every live row of the card's types, which for a
 * pulse card, or any card that folds the correlation channels, was every
 * reading of a watch's heart rate on each status read. It now comes from the
 * DAY rollup tier where the tier matches the record (`countLiveReadings`),
 * and the newest reading from one descent of the live index per type
 * (`readLatestEver`).
 */
import type { MeasurementType } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { readLatestEver } from "@/lib/dashboard/summary-reads";
import { countLiveReadings } from "@/lib/rollups/live-counts";

export interface MeasurementInputStamp {
  type: MeasurementType;
  count: number;
  newest: Date | null;
}

/** One stamp per type that holds a live reading; types without one are absent. */
export async function readMeasurementInputStamps(
  userId: string,
  types: readonly MeasurementType[],
): Promise<MeasurementInputStamp[]> {
  const [counts, latest] = await Promise.all([
    countLiveReadings(userId, types, null),
    readLatestEver(prisma, userId, types),
  ]);
  const newest = new Map(latest.map((r) => [r.type, r.measured_at]));
  return [...counts].map(([type, count]) => ({
    type,
    count,
    newest: newest.get(type) ?? null,
  }));
}
