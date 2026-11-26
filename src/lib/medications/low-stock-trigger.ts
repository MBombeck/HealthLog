/**
 * The low-stock trigger of one medication as the wire publishes it
 * (`lowStockTriggerDays` on the list and detail answers): the runway in
 * whole days at or below which the medication counts as low on stock.
 *
 * It is the number the daily low-stock job and the GLP-1 card compare the
 * runway against, `max(lowStockRunwayDays, reorderLeadDays + one
 * dose-interval)`, with the medication's own lead over the account default.
 * Published resolved so a client compares `runwayDays` with it instead of
 * re-deriving the lead and the cadence.
 */
import {
  estimateDailyDoseCount,
  lowStockTriggerDays,
  type RunwaySchedule,
} from "@/lib/medications/supply-runway";
import {
  resolveLowStockRunwayDays,
  resolveReorderLeadDays,
} from "@/lib/validations/notification-prefs";
import { prisma } from "@/lib/db";

/**
 * Null when the account switched the low-stock alert off, or when the
 * schedules consume nothing on a cadence (as needed, intake not tracked):
 * such a medication has no runway in days to compare.
 */
export function resolvedLowStockTriggerDays(input: {
  /** The account's stored `notificationPrefs` document, raw. */
  notificationPrefs: unknown;
  /** `Medication.reorderLeadDays`, the per-medication override. */
  reorderLeadDays: number | null;
  /** The schedules the runway is computed over. */
  schedules: RunwaySchedule[];
}): number | null {
  const floor = resolveLowStockRunwayDays(input.notificationPrefs);
  if (floor === null) return null;
  if (estimateDailyDoseCount(input.schedules) <= 0) return null;
  return lowStockTriggerDays({
    lowStockRunwayDays: floor,
    leadDays: resolveReorderLeadDays(
      input.notificationPrefs,
      input.reorderLeadDays,
    ),
    schedules: input.schedules,
  });
}

/**
 * The list rows with `lowStockTriggerDays` set, read against the account's
 * stored preferences. A row's `schedules` are the live ones (empty when its
 * intake is not tracked), the same the row's `runwayDays` is computed over.
 */
export async function withLowStockTriggers(
  userId: string,
  rows: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { notificationPrefs: true },
  });
  return rows.map((row) => ({
    ...row,
    lowStockTriggerDays: resolvedLowStockTriggerDays({
      notificationPrefs: user?.notificationPrefs ?? null,
      reorderLeadDays:
        typeof row.reorderLeadDays === "number" ? row.reorderLeadDays : null,
      schedules: Array.isArray(row.schedules)
        ? (row.schedules as RunwaySchedule[])
        : [],
    }),
  }));
}
