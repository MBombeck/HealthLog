/**
 * S4 — generator-free contract for the `morning-digest-refresh` queue.
 *
 * The sleep-arrival trigger (`@/lib/daily/morning-refresh-trigger`) — reached
 * from the Withings, WHOOP, and Apple-Health sleep-write seams — enqueues a
 * debounced morning refresh here WITHOUT importing the comprehensive generator
 * (which would drag the whole insight tree into every sleep-sync bundle and
 * risk an import cycle through the transports). The worker-only pipeline
 * (`runMorningDigestRefresh`) lives in `morning-digest-refresh.ts`, which
 * re-exports the queue name from here so there is a single source of truth.
 *
 * Mirrors the `insight-pregenerate-shared.ts` split exactly: queue name +
 * payload type + enqueue helper in the generator-free module, the concrete
 * dispatch in the worker module.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";

export const MORNING_DIGEST_REFRESH_QUEUE = "morning-digest-refresh";

export interface MorningDigestRefreshPayload {
  userId: string;
  /**
   * The user-local YYYY-MM-DD (their profile timezone) this refresh finalises.
   * Doubles as the debounce key and the value the handler stamps onto
   * `User.morningDigestRefreshedOn` so the digest reads `final` for the day.
   */
  localDate: string;
}

/**
 * Fire-and-forget enqueue for the sleep-arrival trigger. The `singletonKey`
 * carries the user AND the local date, so the many sleep samples of one night
 * collapse into ONE queued job: while a refresh for this morning is
 * created/active no duplicate can be inserted. Once it completes, the durable
 * `User.morningDigestRefreshedOn` marker (re-checked in the handler AND
 * pre-checked in the trigger) stops any later sample from re-running it — the
 * pair is at-most-once per user per local morning.
 *
 * The key alone does NOT buy that: pg-boss only constrains `singleton_key`
 * when the queue carries a policy that indexes it, and under the default
 * `standard` policy no such index exists, so this key coalesced nothing at all
 * until the queue was given `exclusive` in `reminder/register-status.ts`. If
 * that entry is ever removed, this debounce silently disappears again — the two
 * belong together.
 *
 * No `singletonSeconds`: a time-slot throttle would let a second morning's
 * refresh be swallowed if it fell inside the window, and its wall-clock
 * `floor()` bucketing cannot express a user's local date anyway; the
 * local-date-scoped key plus the `exclusive` policy is exactly the debounce we
 * want. No-ops cleanly when no global boss instance is
 * available (a web process without an embedded worker) — the next sleep
 * landing, and the nightly cron, remain the catch-net.
 */
export async function enqueueMorningDigestRefresh(
  payload: MorningDigestRefreshPayload,
): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) {
    annotate({
      action: { name: "daily.morning_refresh.no_boss" },
      meta: { local_date: payload.localDate },
    });
    return;
  }
  try {
    await boss.send(MORNING_DIGEST_REFRESH_QUEUE, payload, {
      singletonKey: `morning-refresh:${payload.userId}:${payload.localDate}`,
      // A transient provider / pool failure retries with backoff rather than
      // leaving the day provisional until the next sleep sample lands.
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
    });
    annotate({
      action: { name: "daily.morning_refresh.enqueued" },
      meta: { local_date: payload.localDate },
    });
  } catch (err) {
    logCaught("daily.morning_refresh.enqueue_failed", err);
    // Best-effort: a failed enqueue leaves the next sleep landing + the nightly
    // cron as the catch-net; the digest stays honestly provisional meanwhile.
  }
}
