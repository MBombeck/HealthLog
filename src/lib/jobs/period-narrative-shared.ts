/**
 * v1.11.0 W3 — generator-free contract for the period-narrative warm queue.
 *
 * The read-only GET route enqueues a single-user warm here without importing
 * the concrete generator (which would pull the provider chain + W2 context
 * assembler into the route bundle). The worker-only pipeline
 * (`runPeriodNarrativeWarm`) lives in `period-narrative-warm.ts`, which
 * re-exports the queue name from here so there is one source of truth.
 *
 * Mirrors the `insight-pregenerate-shared.ts` split exactly: queue name +
 * payload type + cron + enqueue helper here, the concrete dispatch in the
 * worker module.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";
import {
  mayEnqueueProviderWork,
  providerWorkAuthorityForRecord,
  type ProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";
import type { NarrativePeriod } from "@/lib/insights/narrative/period-narrative";
import type { Locale } from "@/lib/i18n/config";
import { logCaught } from "@/lib/logging/signal";

export const PERIOD_NARRATIVE_QUEUE = "period-narrative-warm";

/**
 * The job's expiry: three hours. On a boundary night the scheduled pass
 * writes up to two narratives for each of 200 accounts, which can outlast
 * pg-boss's fifteen-minute default. The pass stops itself at three quarters
 * of this (`jobBudget`) and holds a lock (`lockedPass`); every send and the
 * schedule carry it.
 */
export const PERIOD_NARRATIVE_EXPIRE_SECONDS = 3 * 60 * 60;

/**
 * Nightly at 05:05 Europe/Berlin — inside the existing maintenance window,
 * after the comprehensive insight pre-generation (04:30) and the computed
 * scores (04:45–04:55) so the rollup signals it reads are already folded.
 * The handler only does real work near a week/month boundary; on every other
 * night it short-circuits cheaply.
 */
export const PERIOD_NARRATIVE_CRON = "5 5 * * *";

export interface PeriodNarrativePayload {
  /** Set on the nightly scheduled tick (informational). */
  triggeredAt?: string;
  /** Single-user warm enqueued by the read-only GET on a cold/stale read. */
  userId?: string;
  /** Period to warm on the single-user path. */
  period?: NarrativePeriod;
  /** Locale to warm; defaults to the app default (`en`) when absent. */
  locale?: Locale;
  /** Present only for an on-demand record warm. */
  authority?: ProviderWorkAuthority;
}

/**
 * Fire-and-forget enqueue used by the read-only GET on a cold/stale read. A
 * `singletonKey` per `(user, period, locale)` collapses repeated reads within
 * a short window into one queued job. No-ops cleanly when the global boss is
 * unavailable (a web process without an embedded worker) — the nightly cron
 * remains the catch-net.
 */
export async function enqueueNarrativeWarm(payload: {
  userId: string;
  period: NarrativePeriod;
  locale: Locale;
}): Promise<void> {
  const authority = providerWorkAuthorityForRecord(payload.userId);
  if (!mayEnqueueProviderWork(authority)) {
    annotate({
      action: { name: "insights.narrative.warm.refused" },
      meta: { period: payload.period, reason: "provider_authority" },
    });
    return;
  }
  const boss = getGlobalBoss();
  if (!boss) return;
  try {
    await boss.send(
      PERIOD_NARRATIVE_QUEUE,
      {
        userId: payload.userId,
        period: payload.period,
        locale: payload.locale,
        authority,
      } satisfies PeriodNarrativePayload,
      {
        singletonKey: `warm:${payload.userId}:${payload.period}:${payload.locale}`,
        singletonSeconds: 120,
        expireInSeconds: PERIOD_NARRATIVE_EXPIRE_SECONDS,
        // Transient provider / pool failures retry with backoff instead
        // of leaving the narrative cold until the next boundary night.
        retryLimit: 3,
        retryDelay: 60,
        retryBackoff: true,
      },
    );
    annotate({
      action: { name: "insights.narrative.warm.enqueued" },
      meta: { period: payload.period, locale: payload.locale },
    });
  } catch (err) {
    logCaught("insights.narrative.enqueue_failed", err, {
      period: payload.period,
    });
    // Best-effort — a failure just means the narrative stays as-is until the
    // next read or the nightly cron warms it.
  }
}
