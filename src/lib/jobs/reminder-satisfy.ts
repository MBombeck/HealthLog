/**
 * v1.18.1 — enqueue helper for the eventful Vorsorge-reminder satisfaction
 * queue. Mirrors `pr-detection.ts`: the Next.js ingest routes import
 * `enqueueReminderSatisfy` and never touch pg-boss directly, the worker
 * binds the handler in `reminder-worker.ts`, and the 15-min
 * measurement-reminder cron is the idempotent safety-net for any ingest
 * path that forgets to enqueue (or any job that fails to land).
 *
 * Why a queue and not an inline call on the ingest path: the batch route's
 * own comment warns against hooking the hot iOS batch-ingest path. The
 * matcher re-queries the user's measurements/labs, so keep it off the
 * request and out of the sync worker's tight loop — enqueue
 * fire-and-forget, resolve in the worker.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

export const REMINDER_SATISFY_QUEUE = "reminder-satisfy";

/** Concurrency budget for the worker process. The job is read-heavy on the
 *  user's own reminders + a single indexed measurement/lab lookup per
 *  typed reminder, so a small fleet drains an ingest spike without
 *  crowding the reminder check or the daily insights workload on the same
 *  node. */
export const REMINDER_SATISFY_CONCURRENCY = 5;

export interface ReminderSatisfyPayload {
  userId: string;
  /** ISO timestamp — handy for debugging, never used for logic. */
  triggeredAt: string;
}

/**
 * How long a send waits before it runs, in seconds. Every ingest path sends
 * one per write, so a first sync used to queue a job per batch; a send now
 * waits this long and every send for the same account while it waits joins
 * it (the queue's `short` policy on `singletonKey`). A send after the run has
 * started queues the next one, so the newest reading is always matched.
 */
export const REMINDER_SATISFY_DEBOUNCE_SECONDS = 5;

/**
 * Submit a reminder-satisfaction job for one user after a measurement /
 * lab write. Best-effort: when no boss instance is attached (the route
 * runs in a context without the worker — typically tests, scripts), the
 * call is a silent no-op and the 15-min cron reconciles the user within
 * one tick.
 */
export async function enqueueReminderSatisfy(userId: string): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) return;
  const payload: ReminderSatisfyPayload = {
    userId,
    triggeredAt: new Date().toISOString(),
  };
  await boss.send(REMINDER_SATISFY_QUEUE, payload, {
    singletonKey: `reminder-satisfy|${userId}`,
    startAfter: REMINDER_SATISFY_DEBOUNCE_SECONDS,
    // Gentle retry — the resolver is read-heavy on the user's own data; a
    // stampede of failed jobs against a briefly-flaky DB would compound the
    // problem. The cron is the ultimate backstop anyway.
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  });
}
