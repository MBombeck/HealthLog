/**
 * v1.4.25 W16c — Enqueue helper + handler glue for the pg-boss
 * `pr-detection` queue. Lives in `src/lib/jobs/` next to the other
 * job-side helpers; the worker process binds the handler in
 * `reminder-worker.ts` via `boss.work(PR_DETECTION_QUEUE, ...)`.
 *
 * The Next.js side (ingest routes) imports `enqueuePrDetection` and
 * never touches pg-boss directly — `getGlobalBoss()` returns the
 * worker-side singleton when one is attached, and a no-op when the
 * route runs in a context without a worker (tests, scripts). The
 * 30-minute fallback cron in `reminder-worker.ts` is the safety net
 * for any ingest path that forgets to enqueue.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

export const PR_DETECTION_QUEUE = "pr-detection";

/** Concurrency budget for the worker process — five jobs in flight
 *  is enough to drain a multi-user backfill spike without crowding
 *  the reminder check or the daily insights workload that runs on the
 *  same node. */
export const PR_DETECTION_CONCURRENCY = 5;

/**
 * Cron schedule (Europe/Berlin) for the fallback rescan. Every 30
 * minutes the worker re-runs detection for every user — protects
 * against ingest paths that ship rows without enqueueing a job (a
 * future Withings sync that lands without the hook wired, a manual
 * row imported via SQL, a backfill from a future migration).
 */
export const PR_DETECTION_FALLBACK_CRON = "*/30 * * * *";

export interface PrDetectionPayload {
  userId: string;
  /**
   * When true, the worker writes records but suppresses the push
   * notification for any PR found in this run. Set by batch ingest
   * paths once they cross the historical-backfill threshold
   * (`silent = entries.length > 50`) so multi-year Apple Health
   * imports don't fire hundreds of notifications.
   */
  silent: boolean;
  /** ISO timestamp — handy for debugging, never used for logic. */
  triggeredAt: string;
}

/**
 * Submit a PR detection job for one user. Best-effort: when no boss
 * instance is attached (the route runs in a context without the
 * worker process — typically tests), the call is a silent no-op and
 * the fallback cron will pick the user up within 30 minutes.
 */
export async function enqueuePrDetection(
  userId: string,
  options: { silent?: boolean } = {},
): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) return;
  const payload: PrDetectionPayload = {
    userId,
    silent: options.silent ?? false,
    triggeredAt: new Date().toISOString(),
  };
  await boss.send(PR_DETECTION_QUEUE, payload, {
    // Stagger retries gently — the detector is purely read-heavy on
    // the user's own data, but a stampede of failed jobs against a
    // briefly-flaky DB would compound the problem.
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  });
}
