/**
 * v1.4.25 W16c — Enqueue helper + handler glue for the pg-boss
 * `pr-detection` queue. Lives in `src/lib/jobs/` next to the other
 * job-side helpers; the worker process binds the handler in
 * the maintenance registrar via `createAndWork(boss, PR_DETECTION_QUEUE, …)`.
 *
 * The Next.js side (ingest routes) imports `enqueuePrDetection` and
 * never touches pg-boss directly — `getGlobalBoss()` returns the
 * worker-side singleton when one is attached, and a no-op when the
 * route runs in a context without a worker (tests, scripts). The
 * 30-minute fallback cron in `reminder-worker.ts` is the safety net
 * for any ingest path that forgets to enqueue.
 */
import type { PrismaClient } from "@/generated/prisma/client";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";

export const PR_DETECTION_QUEUE = "pr-detection";

/**
 * The job's expiry: twenty-five minutes. The fallback cron walks the whole
 * history of every account that changed, every thirty minutes (every account
 * before v1.42), which on a large instance
 * outlasts pg-boss's fifteen-minute default; past it pg-boss retried the pass
 * beside itself. The pass stops at three quarters of this (`jobBudget`) and
 * holds a lock (`lockedPass`), so it ends before the next tick and a retry or
 * a late tick never runs beside it. The ingest sends carry the same expiry.
 */
export const PR_DETECTION_EXPIRE_SECONDS = 25 * 60;

/** Concurrency budget for the worker process — five jobs in flight
 *  is enough to drain a multi-user backfill spike without crowding
 *  the reminder check or the daily insights workload that runs on the
 *  same node. */
export const PR_DETECTION_CONCURRENCY = 5;

/**
 * Cron schedule (Europe/Berlin) for the fallback rescan. Every 30
 * minutes the worker re-runs detection for every user whose data changed
 * since the last tick (v1.42; every user before) — protects against
 * ingest paths that ship rows without enqueueing a job (a future Withings
 * sync that lands without the hook wired, a backfill from a future
 * migration).
 */
export const PR_DETECTION_FALLBACK_CRON = "*/30 * * * *";

/**
 * v1.42 — how far back the fallback tick looks for accounts with changed
 * data: the thirty-minute cadence plus five minutes, so a write between two
 * ticks is always inside one of them.
 */
export const PR_DETECTION_WATERMARK_MINUTES = 35;

/**
 * The first fallback tick after a worker boot looks back a day instead: the
 * process that would have run the ticks in between was not there.
 */
export const PR_DETECTION_BOOT_LOOKBACK_HOURS = 24;

/**
 * The accounts the fallback tick re-scans (v1.42): those with a live
 * measurement or a workout changed since `since`. Until v1.42 the tick walked
 * every account's whole history every thirty minutes, though detection can
 * only find something new where something was written. No column records the
 * last run: the window is the cron's own cadence, and each probe is a range
 * scan on `measurements (user_id, updated_at, id)` per account.
 */
export async function listPrDetectionFallbackUserIds(
  prisma: Pick<PrismaClient, "$queryRaw">,
  since: Date,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT u."id"
    FROM "users" u
    WHERE EXISTS (
        SELECT 1 FROM "measurements" m
        WHERE m."user_id" = u."id"
          AND m."updated_at" > ${since}
          AND m."deleted_at" IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM "workouts" w
        WHERE w."user_id" = u."id" AND w."updated_at" > ${since}
      )
    ORDER BY u."id"
  `;
  return rows.map((row) => row.id);
}

let fallbackTicksSinceBoot = 0;

/**
 * The window start for the next fallback tick: a day back on the first tick
 * of this process, {@link PR_DETECTION_WATERMARK_MINUTES} afterwards.
 */
export function nextPrDetectionFallbackSince(now: Date = new Date()): Date {
  const first = fallbackTicksSinceBoot === 0;
  fallbackTicksSinceBoot += 1;
  const lookbackMs = first
    ? PR_DETECTION_BOOT_LOOKBACK_HOURS * 3_600_000
    : PR_DETECTION_WATERMARK_MINUTES * 60_000;
  return new Date(now.getTime() - lookbackMs);
}

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
    expireInSeconds: PR_DETECTION_EXPIRE_SECONDS,
    // Stagger retries gently — the detector is purely read-heavy on
    // the user's own data, but a stampede of failed jobs against a
    // briefly-flaky DB would compound the problem.
    retryLimit: 3,
    retryDelay: 30,
    retryBackoff: true,
  });
}
