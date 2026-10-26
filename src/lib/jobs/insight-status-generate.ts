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
import type { SupportedLocale } from "@/lib/insights/status-shared";
import { generateGeneralStatusForUser } from "@/lib/insights/general-status";
import { generateBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import { generateWeightStatusForUser } from "@/lib/insights/weight-status";
import { generatePulseStatusForUser } from "@/lib/insights/pulse-status";
import { generateBmiStatusForUser } from "@/lib/insights/bmi-status";
import { generateMoodStatusForUser } from "@/lib/insights/mood-status";
import { generateMedicationComplianceStatusForUser } from "@/lib/insights/medication-compliance-status";
import { generateMetricStatus } from "@/lib/insights/metric-status";
import { generateBiomarkerStatus } from "@/lib/insights/biomarker-status";
import { isMetricStatusId } from "@/lib/insights/metric-status-registry";
import { prisma } from "@/lib/db";
import {
  computeDerivedMetric,
  loadBaselineProfile,
} from "@/lib/insights/derived";
import {
  generateDerivedScoreAssessment,
  parseDerivedScoreScope,
} from "@/lib/insights/derived/derived-assessment-ai";
import { isDerivedMetricId } from "@/lib/insights/derived/registry";
import {
  INSIGHT_STATUS_METRICS,
  enqueueStatusGeneration,
  type InsightStatusMetric,
  type InsightStatusGeneratePayload,
} from "@/lib/jobs/insight-status-generate-shared";
import {
  INSIGHT_STATUS_GENERATE_QUEUE,
  INSIGHT_STATUS_GENERATE_CONCURRENCY,
} from "@/lib/jobs/insight-status-generate-queue";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import {
  mayDispatchProviderWork,
  withProviderWorkAuthority,
} from "@/lib/sharing/provider-work-authority";

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
  options: { locale: SupportedLocale; force: boolean },
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
  const authority = payload.authority;
  if (!authority || !(await mayDispatchProviderWork(authority))) {
    annotate({
      action: { name: "insights.status.generate.refused" },
      meta: { metric: payload.metric, reason: "provider_authority" },
    });
    return;
  }
  await withProviderWorkAuthority(authority, () =>
    dispatchInsightStatusGenerate(payload, generators),
  );
}

async function dispatchInsightStatusGenerate(
  payload: InsightStatusGeneratePayload,
  generators: Record<InsightStatusMetric, StatusGenerator> = GENERATORS,
): Promise<void> {
  // The capability, under the job's own authority, before any generator
  // builds a snapshot. The route that enqueued this checked it too, but a
  // switch, the AI analysis opt-out or a consent can change while the job
  // waits in the queue.
  const capability = await aiCapabilityForJob(payload.userId, "statusText");
  if (!capability.available) {
    annotate({
      action: { name: "insights.status.generate.skipped" },
      meta: { metric: payload.metric, reason: capability.reason },
    });
    return;
  }

  // v1.8.7.1 — a `metric:<METRIC_ID>` scope routes to the generic
  // HealthKit-metric generator rather than one of the seven specialised
  // ones. The generic generator applies its own empty-data guard, so a
  // job enqueued for a metric that has since lost its data costs only a
  // cheap count, not an LLM call.
  if (payload.metric.startsWith("metric:")) {
    const metricId = payload.metric.slice("metric:".length);
    if (!isMetricStatusId(metricId)) {
      annotate({
        action: { name: "insights.status.generate.unknown_metric" },
        meta: { metric: payload.metric },
      });
      return;
    }
    await generateMetricStatus({
      metric: metricId,
      userId: payload.userId,
      locale: payload.locale,
      force: true,
    });
    return;
  }

  // A `biomarker:<id>` scope routes to the per-biomarker generator, which
  // reads `LabResult` rows for the marker. Its own empty-data + input-hash
  // gates keep a job for an unchanged marker cheap (no LLM call).
  if (payload.metric.startsWith("biomarker:")) {
    const biomarkerId = payload.metric.slice("biomarker:".length);
    if (!biomarkerId) {
      annotate({
        action: { name: "insights.status.generate.unknown_metric" },
        meta: { metric: payload.metric },
      });
      return;
    }
    await generateBiomarkerStatus({
      biomarkerId,
      userId: payload.userId,
      locale: payload.locale,
      force: true,
    });
    return;
  }

  // v1.13.2 — a `derived-score:<ID>` scope warms the per-score assessment AI
  // prose. The route already filled the deterministic text synchronously; this
  // recomputes the derived value and persists the warmer prose so the next
  // read upgrades. A score that lost its data resolves to insufficient and the
  // generator no-ops without an LLM call.
  if (payload.metric.startsWith("derived-score:")) {
    const metricId = parseDerivedScoreScope(payload.metric);
    if (!metricId || !isDerivedMetricId(metricId)) {
      annotate({
        action: { name: "insights.status.generate.unknown_metric" },
        meta: { metric: payload.metric },
      });
      return;
    }
    const profile = await loadBaselineProfile(prisma, payload.userId);
    const derived = await computeDerivedMetric({
      metric: metricId,
      userId: payload.userId,
      profile,
      type: null,
    });
    await generateDerivedScoreAssessment({
      metric: metricId,
      userId: payload.userId,
      derived,
      locale: payload.locale,
    });
    return;
  }

  const generate = generators[payload.metric as InsightStatusMetric];
  if (!generate) {
    annotate({
      action: { name: "insights.status.generate.unknown_metric" },
      meta: { metric: payload.metric },
    });
    return;
  }
  await generate(payload.userId, { locale: payload.locale, force: true });
}
