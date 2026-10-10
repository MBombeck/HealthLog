/**
 * One Google Health run per account at a time, across processes.
 *
 * The hourly poll, the manual trigger, the full-history backfill and the
 * sleep repair all read the same account's collections with the same grant.
 * Run side by side they share Google's per-user, per-minute request quota:
 * a backfill deep in a dense heart-rate walk and an hourly sync starting
 * beside it pushed the account over the quota, and every request either of
 * them made in that minute answered 429. They also write the same rows, so
 * two runs racing one night's sleep segments can each move a row the other
 * is about to move.
 *
 * So every run for one account holds the same advisory lock for as long as
 * it reads and writes (`withJobLock`, a connection of its own, released when
 * the run ends or the process dies). A run that finds it taken does no work:
 * the hourly poll skips the account for this tick, the manual trigger answers
 * that a sync is already running, and the backfill and the repair wait a
 * bounded time for a short run to finish before handing their job back to
 * pg-boss to retry.
 */
import { withJobLock, type GuardedRun } from "@/lib/jobs/job-lock";

/** The lock key for one account's Google Health runs. */
export function googleHealthSyncLockKey(userId: string): string {
  return `google-health-sync:${userId}`;
}

/**
 * How long a backfill or repair waits for an hourly or manual run to finish.
 * Those runs read a day of history at most and take a minute or two, so ten
 * minutes covers one that is also sitting out a rate limit.
 */
export const GOOGLE_HEALTH_SYNC_LOCK_WAIT_MS = 10 * 60 * 1000;

/**
 * Run `run` while holding the account's Google Health lock. Resolves
 * `{ ran: false }` without calling `run` when another run holds it and does
 * not let go within `waitMs` (zero: give up at once).
 */
export function withGoogleHealthSyncLock<T>(
  userId: string,
  run: () => Promise<T>,
  options: { waitMs?: number } = {},
): Promise<GuardedRun<T>> {
  return withJobLock(googleHealthSyncLockKey(userId), run, undefined, {
    waitMs: options.waitMs ?? 0,
  });
}
