/**
 * The account's health score for one local day, as last computed.
 *
 * Every surface computes the score through `computeAndRecordUserHealthScore`,
 * and that function leaves its report here. A surface that cannot compute on
 * its own read (the dashboard snapshot while the rollup tier is still folding
 * an account's history) serves this report instead of saying there is not
 * enough data, so the start page, the digest, the morning and `/api/analytics`
 * never show two answers for the same day.
 *
 * Lives in the analytics bucket under the `${userId}|` prefix, so every
 * invalidator that touches the score's inputs (a measurement write marks it
 * stale, a recipe or profile change evicts it) reaches this cell as well.
 * Keyed on the local day, so a report from yesterday is never today's.
 */
import { caches, type ServerCache } from "@/lib/cache/server-cache";
import { userDayKey } from "@/lib/tz/format";

import type { HealthScoreReport } from "./types";

function reportCellKey(userId: string, dayKey: string): string {
  return `${userId}|health-score-report|${dayKey}`;
}

const cell = () => caches.analytics as ServerCache<HealthScoreReport>;

/** Keep the report just computed for the account's local day of `now`. */
export function keepHealthScoreReport(
  userId: string,
  timezone: string,
  now: Date,
  report: HealthScoreReport,
): void {
  cell().set(reportCellKey(userId, userDayKey(now, timezone)), report);
}

/**
 * The last report computed for the account's local day of `now`, or null.
 * A stale entry (a write landed since) still counts: it is the number every
 * other surface serves until its own recompute lands, and it is the same day.
 */
export function lastHealthScoreReport(
  userId: string,
  timezone: string,
  now: Date,
): HealthScoreReport | null {
  return (
    cell().getAllowStale(reportCellKey(userId, userDayKey(now, timezone)))
      ?.value ?? null
  );
}
