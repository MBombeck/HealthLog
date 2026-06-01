/**
 * v1.8.3 — shared contract for the on-demand per-metric status generation
 * queue, free of any generator import.
 *
 * The status generators import `enqueueStatusGeneration` from here (via
 * `status-cache.ts`). Keeping the enqueue + the queue name + the metric
 * vocabulary in a generator-free module breaks the import cycle that would
 * otherwise form: generator → status-cache → (enqueue) → generator. The
 * worker-only dispatch (`runInsightStatusGenerate`, which references the
 * concrete generators) lives in `insight-status-generate.ts` and is
 * imported solely by the worker boot file.
 */
import { getGlobalBoss } from "@/lib/jobs/boss-instance";
import { annotate } from "@/lib/logging/context";

export const INSIGHT_STATUS_GENERATE_QUEUE = "insight-status-generate";

/**
 * Low concurrency keeps the on-demand warm pass from saturating the
 * Prisma pool or fanning out an unbounded number of concurrent provider
 * calls when several cards request generation on the same first visit.
 */
export const INSIGHT_STATUS_GENERATE_CONCURRENCY = 2;

/**
 * The seven per-metric status scopes the queue can generate. Mirrors the
 * `cacheAction` slug each generator uses (`insights.<metric>-status.<locale>`)
 * so the queue payload, the route, and the client all speak one vocabulary.
 */
export type InsightStatusMetric =
  | "general"
  | "blood-pressure"
  | "weight"
  | "pulse"
  | "bmi"
  | "mood"
  | "medication-compliance";

export const INSIGHT_STATUS_METRICS: ReadonlyArray<InsightStatusMetric> = [
  "general",
  "blood-pressure",
  "weight",
  "pulse",
  "bmi",
  "mood",
  "medication-compliance",
];

export interface InsightStatusGeneratePayload {
  userId: string;
  metric: InsightStatusMetric;
  /** Resolved client locale — the cache key the route reads against. */
  locale: "de" | "en";
}

/**
 * Fire-and-forget enqueue used by the read-only status route on a cache
 * miss. A `singletonKey` per `(user, metric, locale)` collapses repeated
 * polls into one queued job, so a client polling every few seconds while
 * the provider works can't pile up duplicate generations. No-ops cleanly
 * when the global boss instance is not available (e.g. the web process
 * runs without an embedded worker) — the nightly pre-generate cron and
 * the daily status crons remain the catch-net.
 */
export async function enqueueStatusGeneration(
  payload: InsightStatusGeneratePayload,
): Promise<void> {
  const boss = getGlobalBoss();
  if (!boss) {
    annotate({
      action: { name: "insights.status.generate.no_boss" },
      meta: { metric: payload.metric },
    });
    return;
  }
  try {
    await boss.send(INSIGHT_STATUS_GENERATE_QUEUE, payload, {
      singletonKey: `${payload.userId}:${payload.metric}:${payload.locale}`,
      // De-dupe within a short window so a polling client doesn't enqueue
      // a fresh job on every tick while a generation is already running.
      singletonSeconds: 120,
    });
    annotate({
      action: { name: "insights.status.generate.enqueued" },
      meta: { metric: payload.metric },
    });
  } catch {
    // Enqueue is best-effort; a failure here just means the card stays
    // in `preparing` until the next poll / nightly cron warms the cache.
  }
}
