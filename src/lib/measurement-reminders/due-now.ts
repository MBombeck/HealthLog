/**
 * Whether a check-up is due now: the rule the daily digest's rail and the
 * navigation's count share.
 *
 * A reminder on a cycle longer than a week (a yearly check-up) is due for its
 * whole due day; a short-cycle one (a daily weigh-in) only once its time has
 * come. An overdue one stays due until it is satisfied, skipped or snoozed.
 * The caller reads the rows due before the end of the person's local day.
 */
import {
  hasLongCycle,
  type HoldOpenInput,
} from "@/lib/measurement-reminders/holds-open";

export function isCheckupDueNow(
  row: HoldOpenInput & { nextDueAt: Date | null },
  timezone: string,
  now: Date,
): boolean {
  if (row.nextDueAt === null) return false;
  if (hasLongCycle(row, timezone, row.nextDueAt)) return true;
  return row.nextDueAt.getTime() <= now.getTime();
}
