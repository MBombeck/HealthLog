/**
 * Enqueue work that must not be lost while the process is still booting.
 *
 * The HTTP server answers before pg-boss is bound (`instrumentation.ts` starts
 * the background role after the server is up), and a producer that lost its
 * connection rebinds in the background. A request in either window used to
 * read `getGlobalBoss()` as null and drop its enqueue: an OAuth callback
 * skipped the first sync and the history backfill, a measurement write skipped
 * its rollup recompute. Those waited for the next cron or boot discovery.
 *
 * `whenBossReady()` waits for the boss while a start is under way, bounded by
 * `BOSS_READY_TIMEOUT_MS`, and logs one line when it gives up. With no start
 * under way (a process that never runs a background role, or one whose start
 * failed) it answers null at once: nothing is coming, so nothing is waited for.
 *
 * `enqueueWhenBossReady()` is what a producer calls. With the boss bound it
 * sends at once and the caller sees the send's own result and errors, as
 * before. While a start is under way it does not hold the request: the send
 * waits in the background and runs once the boss is up.
 */
import type { PgBoss } from "pg-boss";

import { startupPhase } from "@/lib/boot/startup-state";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { trackBackgroundTask } from "@/lib/logging/background-tasks";
import { runDetached } from "@/lib/logging/detached";

/** The global slot a producer (re)start is parked in while it runs. */
export const BOSS_START_KEY = "__healthlog_pgboss_start__" as const;

/** Longest an enqueue waits for the boss before it is given up. */
export const BOSS_READY_TIMEOUT_MS = 60_000;

const POLL_MS = 250;

/** Is a boss start (boot, or a producer reconnect) under way right now? */
export function bossStartPending(): boolean {
  if ((globalThis as Record<string, unknown>)[BOSS_START_KEY]) return true;
  return startupPhase() === "starting";
}

/**
 * The bound boss, waiting for it while a start is under way. Null when no
 * start is under way or the wait ran out (logged with `label`).
 */
export async function whenBossReady(
  label: string,
  timeoutMs: number = BOSS_READY_TIMEOUT_MS,
): Promise<PgBoss | null> {
  const bound = getGlobalBoss();
  if (bound) return bound;
  if (!bossStartPending()) return null;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, Math.min(POLL_MS, deadline - Date.now())).unref?.();
    });
    const boss = getGlobalBoss();
    if (boss) return boss;
    if (!bossStartPending()) return null;
  }
  console.warn(
    `[pg-boss] not ready after ${Math.round(timeoutMs / 1000)} s; ${label} was not enqueued`,
  );
  return null;
}

/**
 * Send through the boss now when it is bound, or once it is up when a start
 * is under way. Returns whether the send ran (or was deferred) rather than
 * being skipped for want of a boss.
 */
export async function enqueueWhenBossReady(
  label: string,
  send: (boss: PgBoss) => Promise<unknown>,
): Promise<"sent" | "deferred" | "skipped"> {
  const bound = getGlobalBoss();
  if (bound) {
    await send(bound);
    return "sent";
  }
  if (!bossStartPending()) return "skipped";
  trackBackgroundTask(
    runDetached(() =>
      whenBossReady(label).then(async (boss) => {
        if (!boss) return;
        try {
          await send(boss);
        } catch (err) {
          console.warn(`[pg-boss] deferred ${label} enqueue failed:`, err);
        }
      }),
    ),
  );
  return "deferred";
}
