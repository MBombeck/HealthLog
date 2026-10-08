/**
 * v1.8.7.1 — generator-free contract for the insight-pregenerate queue.
 *
 * The on-demand warm route (`POST /api/insights/pregenerate`) enqueues a
 * forced full-warm job here without importing the concrete generators
 * (which would pull the whole `comprehensive-generate` + seven `*-status`
 * tree into the route bundle and risk an import cycle). The worker-only
 * pipeline (`runInsightPregenerate`, `forceWarmUser`) lives in
 * `insight-pregenerate.ts`, which re-exports the queue name from here so
 * there is a single source of truth.
 *
 * Mirrors the `insight-status-generate-shared.ts` split exactly: queue
 * name + payload type + enqueue helper in the generator-free module, the
 * concrete dispatch in the worker module.
 */
import type { SupportedLocale } from "@/lib/insights/status-shared";
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import { logCaught } from "@/lib/logging/signal";

export const INSIGHT_PREGENERATE_QUEUE = "insight-pregenerate";

/**
 * The job's expiry: three hours. The scheduled pass walks up to 200 accounts
 * with a comprehensive generation each, which can outlast pg-boss's fifteen
 * minute default; past it pg-boss retried the job beside the pass still
 * running. The pass now stops itself at three quarters of this (`jobBudget`)
 * and holds a lock (`lockedPass`), and every send and the schedule carry it.
 */
export const INSIGHT_PREGENERATE_EXPIRE_SECONDS = 3 * 60 * 60;

export interface InsightPregeneratePayload {
  /** Set on the nightly scheduled tick (informational; the handler keys
   * its batch behaviour off the ABSENCE of `userId`/`force`). */
  triggeredAt?: string;
  /**
   * Forced single-user warm. When `force` is set the worker runs the
   * full per-user warm for `userId` directly, bypassing the candidate
   * scan AND the per-user 20 h budget bucket.
   */
  userId?: string;
  force?: boolean;
  /**
   * Locale to warm on the forced path. Carries the reader's full UI locale
   * (one of the six); the handler validates it and defaults an absent or
   * unrecognised value to English.
   */
  locale?: SupportedLocale;
  /**
   * A briefing-for-today warm (`enqueueTodayBriefingWarm`): the day started
   * with no briefing written today, or a signal metric got its first
   * reading of the day after the briefing was written. Runs the
   * comprehensive briefing only, past the one-hour freshness gate (a
   * reading at 07:05 after a warm at 07:00 is exactly what it is for), and
   * under the same failure backoff and daily forced-warm cap.
   */
  today?: boolean;
}

/**
 * Fire-and-forget enqueue used by the on-demand warm route. A
 * `singletonKey` per user collapses repeated requests within a short
 * window into one queued job, so a client that taps the button twice
 * (or the auto-trigger races a manual tap) can't double-warm. The key
 * is deliberately locale-free: a German web session and an English
 * Accept-Language client racing each other would otherwise enqueue two
 * near-identical full warms back to back; the first job's locale wins
 * the window and the other locale warms lazily through the read-path
 * enqueue (v1.16.8). No-ops cleanly when the global boss instance is
 * not available (e.g. a web process without an embedded worker) — the
 * nightly cron remains the catch-net.
 */
export async function enqueueForceWarm(payload: {
  userId: string;
  locale: SupportedLocale;
}): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) {
    annotate({
      action: { name: "insights.pregenerate.force.no_boss" },
      meta: { locale: payload.locale },
    });
    return;
  }
  try {
    await boss.send(
      INSIGHT_PREGENERATE_QUEUE,
      {
        userId: payload.userId,
        force: true,
        locale: payload.locale,
      } satisfies InsightPregeneratePayload,
      {
        singletonKey: `force:${payload.userId}`,
        expireInSeconds: INSIGHT_PREGENERATE_EXPIRE_SECONDS,
        // De-dupe within a 6-minute window. v1.16.8 — widened from 120 s:
        // the client's revalidation poll runs up to ~250 s after a stale
        // page-open, so a 2-minute singleton let the tail of one poll
        // cycle enqueue a second (and third) full warm while the first
        // was still running. 360 s outlives the poll horizon, so a stale
        // page-open collapses to exactly one queued warm; the worker-side
        // freshness re-check in `forceWarmUser` is the second guard.
        singletonSeconds: 360,
        // Transient provider / pool failures retry with backoff instead
        // of leaving every cache cold until the nightly cron.
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
      },
    );
    annotate({
      action: { name: "insights.pregenerate.force.enqueued" },
      meta: { locale: payload.locale },
    });
  } catch (err) {
    logCaught("insights.pregenerate.enqueue_failed", err, { kind: "force" });
    // Enqueue is best-effort; a failure here just means the caches stay
    // cold until the next poll / nightly cron warms them.
  }
}

/**
 * How long a today warm waits before it runs, and the window that folds
 * every request inside it into one job. A morning weigh-in, the blood
 * pressure five minutes later and the sync that brings both arrive as one
 * burst; one warm after the burst reads all of it.
 */
export const TODAY_WARM_DELAY_SECONDS = 5 * 60;

/**
 * Enqueue the briefing-for-today warm. `immediate` is for the day's first
 * read with no briefing written today, where nobody is waiting on a burst
 * of readings; otherwise the job starts after the burst window. The
 * singleton per user folds requests in the window into one job; what runs
 * is still bounded by the warm's own gates (failure backoff, the daily
 * forced-warm cap) and the generation's content-hash gate.
 */
export async function enqueueTodayBriefingWarm(payload: {
  userId: string;
  locale: SupportedLocale;
  immediate: boolean;
}): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) {
    annotate({
      action: { name: "insights.pregenerate.today.no_boss" },
      meta: { locale: payload.locale },
    });
    return;
  }
  try {
    await boss.send(
      INSIGHT_PREGENERATE_QUEUE,
      {
        userId: payload.userId,
        force: true,
        today: true,
        locale: payload.locale,
      } satisfies InsightPregeneratePayload,
      {
        singletonKey: `today:${payload.userId}`,
        singletonSeconds: TODAY_WARM_DELAY_SECONDS,
        startAfter: payload.immediate ? 0 : TODAY_WARM_DELAY_SECONDS,
        expireInSeconds: INSIGHT_PREGENERATE_EXPIRE_SECONDS,
        retryLimit: 2,
        retryDelay: 60,
        retryBackoff: true,
      },
    );
    annotate({
      action: { name: "insights.pregenerate.today.enqueued" },
      meta: { locale: payload.locale, immediate: payload.immediate },
    });
  } catch (err) {
    logCaught("insights.pregenerate.enqueue_failed", err, { kind: "today" });
    // Best-effort, like every warm enqueue: the next read asks again.
  }
}

/**
 * Delay before the single bounded retry of a failed nightly comprehensive
 * warm. 45 minutes: far enough out that a transient 02:30–04:30 provider
 * brown-out has usually cleared, early enough that the retry lands before
 * the user's morning visit.
 */
export const PREGENERATE_RETRY_DELAY_SECONDS = 45 * 60;

/**
 * Bounded intra-day retry for a user whose NIGHTLY comprehensive warm
 * failed. Without this, a single 04:30 provider hiccup left the user's
 * briefing stale until the next night: the nightly tick is the only
 * scheduled machinery, the GET path's warm enqueue only fires once the
 * cache crosses the 24 h freshness line (often mid-evening), and the POST
 * cache short-circuit served the stale payload all day.
 *
 * Enqueues ONE delayed forced single-user warm (the same `forceWarmUser`
 * pipeline the on-demand route uses), so every existing bound still
 * applies at execution time: the job-start freshness re-check, the
 * failure backoff, and the per-user daily forced-warm cap. `singletonKey`
 * collapses repeated failures within the window into one queued retry.
 * Best-effort like `enqueueForceWarm`: no boss instance → annotated no-op,
 * the nightly tick remains the catch-net.
 */
export async function enqueuePregenerateFailureRetry(payload: {
  userId: string;
  locale: SupportedLocale;
}): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) {
    annotate({
      action: { name: "insights.pregenerate.retry.no_boss" },
      meta: { locale: payload.locale },
    });
    return;
  }
  try {
    await boss.send(
      INSIGHT_PREGENERATE_QUEUE,
      {
        userId: payload.userId,
        force: true,
        locale: payload.locale,
      } satisfies InsightPregeneratePayload,
      {
        startAfter: PREGENERATE_RETRY_DELAY_SECONDS,
        // Distinct from the on-demand `force:` key so a user's page-open
        // warm can never swallow the scheduled retry (and vice versa);
        // one retry per user per window.
        singletonKey: `retry:${payload.userId}`,
        expireInSeconds: INSIGHT_PREGENERATE_EXPIRE_SECONDS,
        singletonSeconds: 3600,
        // A worker crash mid-warm re-runs the job; a warm that completes
        // with a failed comprehensive does NOT throw, so this cannot loop.
        retryLimit: 2,
        retryDelay: 300,
        retryBackoff: true,
      },
    );
    annotate({
      action: { name: "insights.pregenerate.retry.enqueued" },
      meta: {
        locale: payload.locale,
        delay_seconds: PREGENERATE_RETRY_DELAY_SECONDS,
      },
    });
  } catch (err) {
    logCaught("insights.pregenerate.enqueue_failed", err, { kind: "retry" });
    // Best-effort: a failed enqueue leaves the nightly tick as the
    // catch-net, exactly the pre-retry behaviour.
  }
}
