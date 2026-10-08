/**
 * Calendar arithmetic for life-event dates (v1.42, #613). Pure, no zone: a
 * life-event date is a calendar date aligned to its precision.
 */
import { shiftDateKey } from "@/lib/tz/format";

/**
 * The last calendar day a life-event date covers at its precision: the day
 * itself, the last day of its month, or the last day of its year.
 */
export function lastDayCovered(
  date: string,
  precision: "DAY" | "MONTH" | "YEAR",
): string {
  if (precision === "DAY") return date;
  if (precision === "YEAR") return `${date.slice(0, 4)}-12-31`;
  const [y, m] = date.split("-").map(Number);
  const next =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return shiftDateKey(next, -1);
}
