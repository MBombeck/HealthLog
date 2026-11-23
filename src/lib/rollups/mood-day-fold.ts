/**
 * Raw mood entries folded into the DAY rows the mood-rollup writer
 * (`mood-rollups.ts`) persists. A module of its own, free of the database,
 * so every reader's coverage fallback can share it without a mock of the
 * writer standing in its way.
 */
import { dayKeyAsUtcMidnight } from "@/lib/tz/date-only";

/** One mood day in the shape every reader consumes from the DAY tier. */
export interface MoodDayRow {
  bucketStart: Date;
  count: number;
  mean: number;
}

/**
 * Fold raw mood entries into DAY rows exactly as the rollup writer does:
 * keyed on the entry's own `date` label, `bucketStart` the label's
 * UTC-midnight instant, `mean` the day's average score. Sorted ascending.
 *
 * Every reader's coverage fallback goes through this, so a read served
 * by the live walk (the tier is still warming) and the same read served
 * by the tier hand the downstream code identical points. The two once
 * placed the same day twelve hours apart (noon against midnight), and a
 * trailing window anchored on `now` then held a different set of days
 * depending on which path answered.
 */
export function foldMoodEntriesToDays(
  entries: ReadonlyArray<{ date: string; score: number }>,
): MoodDayRow[] {
  const byDay = new Map<string, { sum: number; count: number }>();
  for (const entry of entries) {
    const current = byDay.get(entry.date) ?? { sum: 0, count: 0 };
    current.sum += entry.score;
    current.count += 1;
    byDay.set(entry.date, current);
  }
  return Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, stats]) => ({
      bucketStart: dayKeyAsUtcMidnight(day),
      count: stats.count,
      mean: stats.sum / stats.count,
    }));
}
