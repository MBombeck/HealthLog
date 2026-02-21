/**
 * Consistent date/time formatting for the HealthLog UI.
 * All functions use de-DE locale, Europe/Berlin timezone, 24h format.
 */

const TIMEZONE = "Europe/Berlin";
const LOCALE = "de-DE";

/** "19.02.2026, 14:30" */
export function formatDateTime(date: Date | string): string {
  return new Date(date).toLocaleString(LOCALE, {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "19.02.2026" */
export function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString(LOCALE, {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

/** "19.02." or "19.02.2026" if includeYear */
export function formatDateShort(
  date: Date | string,
  includeYear = false,
): string {
  return new Date(date).toLocaleDateString(LOCALE, {
    timeZone: TIMEZONE,
    day: "2-digit",
    month: "2-digit",
    ...(includeYear ? { year: "numeric" } : {}),
  });
}

/** "14:30" */
export function formatTime(date: Date | string): string {
  return new Date(date).toLocaleTimeString(LOCALE, {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** "Do., 19.02." */
export function formatDateWithWeekday(date: Date | string): string {
  return new Date(date).toLocaleDateString(LOCALE, {
    timeZone: TIMEZONE,
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}
