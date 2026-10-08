/**
 * Day-key arithmetic for the environment module. Leaf module (no imports) so
 * the feed clients, the service and the job share one definition.
 */

const MS_PER_DAY = 86_400_000;

/** Inclusive number of days from `start` to `end` (`YYYY-MM-DD` keys). */
export function enumerateDayCount(start: string, end: string): number {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  return (
    Math.round(
      (Date.UTC(ey, em - 1, ed) - Date.UTC(sy, sm - 1, sd)) / MS_PER_DAY,
    ) + 1
  );
}
