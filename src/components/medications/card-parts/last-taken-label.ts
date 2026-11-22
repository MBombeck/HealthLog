import { formatDateTime, formatTime } from "@/lib/format";
import { shiftDateKey, userDayKey } from "@/lib/tz/format";

/**
 * "Today, 08:12", "Yesterday, 08:12" or the full date and time of a card's
 * last intake. Today and yesterday are calendar days of the profile zone
 * `tz`: the browser's own day can differ from it (a trip abroad), and a
 * dose taken just after midnight at home is still today's.
 */
export function lastTakenLabel(
  value: string,
  tz: string,
  t: (key: string) => string,
  now: Date = new Date(),
): string {
  const intakeDay = userDayKey(new Date(value), tz);
  const today = userDayKey(now, tz);
  const time = formatTime(value);
  if (intakeDay === today) return `${t("medications.today")}, ${time}`;
  if (intakeDay === shiftDateKey(today, -1)) {
    return `${t("medications.yesterday")}, ${time}`;
  }
  return formatDateTime(value);
}
