/**
 * v1.8.3 — on-demand per-metric status generation queue (worker dispatch).
 *
 * Before this, every `/insights/<metric>` sub-page fetched its status
 * card from `GET /api/insights/<metric>-status`, and that GET ran the
 * full SQL gather + a blocking LLM round-trip inline. The provider call
 * was capped server-side at 60 s, so a cold cache on a slow provider
 * pinned the navigation request — and, because the timeout fallback is
 * deliberately not persisted, every subsequent visit re-blocked.
 *
 * This queue moves the heavy gather+LLM off the request path. The route
 * now reads the cache only; on a miss it fire-and-forget enqueues a job
 * (via `enqueueStatusGeneration` in the generator-free shared module) and
 * returns a `preparing` envelope. The worker runs the matching generator
 * with `force: true`, which persists the assessment cache row; the client
 * polls the read-only GET until it lands.
 *
 * Recurring/event pg-boss task — never runs inside an HTTP request and
 * never shells out to `tsx` (CLAUDE.md DO-NOTs). Registered in the
 * reminder-worker `allQueues` loop + a `boss.work` handler; a queue built
 * but never registered silently never drains (the v1.4.37 W10 incident),
 * so a guard test pins the registration.
 *
 * The queue name, payload type, metric vocabulary, and the enqueue helper
 * live in `insight-status-generate-shared.ts` so the status generators can
 * import the enqueue without pulling the concrete generators back in (an
 * import cycle). This module re-exports them for the worker's convenience.
 */
import { annotate } from "@/lib/logging/context";
import { generateGeneralStatusForUser } from "@/lib/insights/general-status";
import { generateBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import { generateWeightStatusForUser } from "@/lib/insights/weight-status";
import { generatePulseStatusForUser } from "@/lib/insights/pulse-status";
import { generateBmiStatusForUser } from "@/lib/insights/bmi-status";
import { generateMoodStatusForUser } from "@/lib/insights/mood-status";
import { generateMedicationComplianceStatusForUser } from "@/lib/insights/medication-compliance-status";
import {
  INSIGHT_STATUS_GENERATE_QUEUE,
  INSIGHT_STATUS_GENERATE_CONCURRENCY,
  INSIGHT_STATUS_METRICS,
  enqueueStatusGeneration,
  type InsightStatusMetric,
  type InsightStatusGeneratePayload,
} from "@/lib/jobs/insight-status-generate-shared";

export {
  INSIGHT_STATUS_GENERATE_QUEUE,
  INSIGHT_STATUS_GENERATE_CONCURRENCY,
  INSIGHT_STATUS_METRICS,
  enqueueStatusGeneration,
};
export type { InsightStatusMetric, InsightStatusGeneratePayload };

/**
 * Narrow generator shape: the queue only forces a fresh generation and
 * discards the payload (the generator persists the cache row itself).
 */
type StatusGenerator = (
  userId: string,
  options: { locale: "de" | "en"; force: boolean },
) => Promise<unknown>;

const GENERATORS: Record<InsightStatusMetric, StatusGenerator> = {
  general: generateGeneralStatusForUser,
  "blood-pressure": generateBloodPressureStatusForUser,
  weight: generateWeightStatusForUser,
  pulse: generatePulseStatusForUser,
  bmi: generateBmiStatusForUser,
  mood: generateMoodStatusForUser,
  "medication-compliance": generateMedicationComplianceStatusForUser,
};

/**
 * Run one on-demand status generation. Pure of pg-boss so the unit test
 * can drive it directly. Forces a fresh generation so the cache row the
 * route's read-only path missed gets written; an unknown metric is
 * annotated and skipped rather than thrown.
 */
export async function runInsightStatusGenerate(
  payload: InsightStatusGeneratePayload,
  generators: Record<InsightStatusMetric, StatusGenerator> = GENERATORS,
): Promise<void> {
  const generate = generators[payload.metric];
  if (!generate) {
    annotate({
      action: { name: "insights.status.generate.unknown_metric" },
      meta: { metric: payload.metric },
    });
    return;
  }
  await generate(payload.userId, { locale: payload.locale, force: true });
}
