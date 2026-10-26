/**
 * The status, insight and computed-score queues: the nightly status batch,
 * the comprehensive-insight pre-generation, the on-demand per-metric status,
 * the morning digest refresh, the data-arrival spine with its reaction line
 * and workout insight, the nightly scores, the period-narrative warm, the
 * Coach memory refresh, nudge, reminder sweep and plan review, the low-stock
 * pass and the daily-briefing fallback.
 *
 * Most queues here are keyless cron ticks, so they carry no policy. The
 * LLM-bound warm queues (pre-generate, period narrative, Coach memory) pass
 * `singletonSeconds` on every send, which pg-boss constrains whatever the
 * policy, so they are left alone. The per-metric status queue is exclusive as
 * well: its run outlasts its slot while the open card keeps sending. The three
 * that carry one key on the user's local date, which no wall-clock window can
 * express.
 */
import type { Job } from "pg-boss";

import { COACH_MEMORY_REFRESH_QUEUE } from "@/lib/ai/coach/coach-memory-shared";
import { DATA_ARRIVAL_QUEUE } from "@/lib/arrivals/emit-shared";
import { REACTION_LINE_QUEUE } from "@/lib/arrivals/reaction-line-shared";
import {
  COACH_NUDGE_CRON,
  COACH_NUDGE_QUEUE,
} from "@/lib/jobs/coach-nudge-queue";
import {
  COACH_PLAN_REVIEW_CRON,
  COACH_PLAN_REVIEW_QUEUE,
} from "@/lib/jobs/coach-plan-review";
import {
  COACH_REMINDER_SWEEP_CRON,
  COACH_REMINDER_SWEEP_QUEUE,
} from "@/lib/jobs/coach-reminder-sweep-queue";
import {
  DAILY_BRIEFING_CRON,
  DAILY_BRIEFING_QUEUE,
} from "@/lib/jobs/daily-briefing-queue";
import {
  INSIGHT_PREGENERATE_CRON,
  INSIGHT_PREGENERATE_EXPIRE_SECONDS,
  INSIGHT_PREGENERATE_QUEUE,
  type InsightPregeneratePayload,
} from "@/lib/jobs/insight-pregenerate-shared";
import {
  INSIGHT_STATUS_GENERATE_CONCURRENCY,
  INSIGHT_STATUS_GENERATE_QUEUE,
} from "@/lib/jobs/insight-status-generate-queue";
import { WHOLE_PASS } from "@/lib/jobs/long-pass";
import {
  MEDICATION_LOW_STOCK_CRON,
  MEDICATION_LOW_STOCK_QUEUE,
} from "@/lib/jobs/medication-low-stock-queue";
import { MORNING_DIGEST_REFRESH_QUEUE } from "@/lib/jobs/morning-digest-refresh-shared";
import {
  PERIOD_NARRATIVE_CRON,
  PERIOD_NARRATIVE_EXPIRE_SECONDS,
  PERIOD_NARRATIVE_QUEUE,
} from "@/lib/jobs/period-narrative-queue";
import {
  RECOVERY_SCORE_CRON,
  RECOVERY_SCORE_QUEUE,
} from "@/lib/jobs/recovery-score-queue";
import {
  insightRetryOptions,
  nightlyInsightPassOptions,
} from "@/lib/jobs/reminder/registrar-shared";
import {
  STRAIN_SCORE_CRON,
  STRAIN_SCORE_QUEUE,
} from "@/lib/jobs/strain-score-queue";
import {
  STRESS_SCORE_CRON,
  STRESS_SCORE_QUEUE,
} from "@/lib/jobs/stress-score-queue";
import {
  WORKOUT_INSIGHT_GENERATE_CONCURRENCY,
  WORKOUT_INSIGHT_GENERATE_QUEUE,
} from "@/lib/jobs/workout-insight-generate-shared";

import { defineJob, type JobDefinition, type JobGroup } from "./define-job";

const GENERAL_STATUS_QUEUE = "insights-general-status";
const GENERAL_STATUS_CRON = "0 2 * * *";

/**
 * The six per-metric status crons that followed the 02:00 batch. The batch
 * builds every card, so they only re-read cards it had just written; their
 * schedules and queues are removed where they still exist.
 */
const RETIRED_STATUS_QUEUES = [
  "insights-blood-pressure-status",
  "insights-weight-status",
  "insights-pulse-status",
  "insights-bmi-status",
  "insights-mood-status",
  "insights-medication-compliance-status",
] as const;

const insights = () => import("@/lib/jobs/reminder/insights-handlers");
const handlers = () => import("@/lib/jobs/reminder/status-handlers");

/** A pre-generation job that warms one account on a visit. */
const isForcedWarm = (job: Job<InsightPregeneratePayload>) =>
  Boolean(job.data?.force && job.data.userId);

const jobs: readonly JobDefinition[] = [
  // Every per-metric status card, one provider call per account. The options
  // ride on the schedule because the cron is the only sender.
  defineJob({
    queue: GENERAL_STATUS_QUEUE,
    cron: GENERAL_STATUS_CRON,
    scheduleOptions: nightlyInsightPassOptions,
    work: { localConcurrency: 1 },
    lock: () => WHOLE_PASS,
    lane: true,
    load: async () => (await insights()).handleGeneralStatusGenerate,
  }),
  // Two slots: the cohort walk and a visitor's forced warm. The walk is one
  // pass at a time and runs in the lane; a forced warm is one per account and
  // never waits behind the walk.
  defineJob({
    queue: INSIGHT_PREGENERATE_QUEUE,
    cron: INSIGHT_PREGENERATE_CRON,
    scheduleOptions: {
      ...insightRetryOptions,
      expireInSeconds: INSIGHT_PREGENERATE_EXPIRE_SECONDS,
    },
    work: { localConcurrency: 2 },
    lock: (job: Job<InsightPregeneratePayload>) =>
      isForcedWarm(job) ? `user:${job.data.userId}` : WHOLE_PASS,
    lane: (job: Job<InsightPregeneratePayload>) => !isForcedWarm(job),
    load: async () => (await insights()).handleInsightPregenerateJob,
  }),
  // Enqueued by the read-only status route on a cold card; low concurrency so
  // a first visit cannot fan out unbounded provider calls.
  defineJob({
    queue: INSIGHT_STATUS_GENERATE_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "The open card re-reads the route while its note is generated, and every miss sends again under the user+metric key. A run may take two calls at a ten-minute timeout, far past the 120 s singletonSeconds slot, so only exclusive keeps a second generation from queueing beside the one still running.",
    },
    work: { localConcurrency: INSIGHT_STATUS_GENERATE_CONCURRENCY },
    load: async () => (await insights()).handleInsightStatusGenerate,
  }),
  // Seven sleep-write seams enqueue the same user + local-date key.
  defineJob({
    queue: MORNING_DIGEST_REFRESH_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Seven sleep-write seams enqueue the same user+localDate key; exclusive makes the at-most-once-per-morning contract real. A wall-clock singletonSeconds window cannot express a local date.",
    },
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleMorningDigestRefresh,
  }),
  // The arrival spine claims a durable unique row, so a second slot would only
  // race the claim; it makes no provider call.
  defineJob({
    queue: DATA_ARRIVAL_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Day-scoped arrival keys carry the user's local date; under standard they coalesce nothing and a chatty ingest queues a job per batch. The worker claims a durable unique row, so a concurrent second run is pure duplicated work.",
    },
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/data-arrival")).handleDataArrival,
  }),
  // The spine's one provider call, behind the durable `generatedAt` claim.
  defineJob({
    queue: REACTION_LINE_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Day-scoped per-kind keys carry the user's local date; under standard they coalesce nothing and a retried spine job could stack a second provider call behind the first.",
    },
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/reaction-line")).handleReactionLine,
  }),
  defineJob({
    queue: WORKOUT_INSIGHT_GENERATE_QUEUE,
    work: { localConcurrency: WORKOUT_INSIGHT_GENERATE_CONCURRENCY },
    load: async () =>
      (await import("@/lib/jobs/workout-insight-generate"))
        .handleWorkoutInsightGenerate,
  }),
  // The nightly scores, in order after the consolidation and drain they read:
  // recovery 04:45, stress 04:50, strain 04:55.
  defineJob({
    queue: RECOVERY_SCORE_QUEUE,
    cron: RECOVERY_SCORE_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleRecoveryScore,
  }),
  defineJob({
    queue: STRESS_SCORE_QUEUE,
    cron: STRESS_SCORE_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleStressScore,
  }),
  defineJob({
    queue: STRAIN_SCORE_QUEUE,
    cron: STRAIN_SCORE_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleStrainScore,
  }),
  // The nightly fan-out runs on a week or month boundary, in the lane and one
  // pass at a time; a single account's warm for the GET runs beside it.
  defineJob({
    queue: PERIOD_NARRATIVE_QUEUE,
    cron: PERIOD_NARRATIVE_CRON,
    scheduleOptions: {
      ...insightRetryOptions,
      expireInSeconds: PERIOD_NARRATIVE_EXPIRE_SECONDS,
    },
    work: { localConcurrency: 1 },
    lock: (job: Job<{ userId?: string }>) =>
      job.data?.userId ? `user:${job.data.userId}` : WHOLE_PASS,
    lane: (job: Job<{ userId?: string }>) => !job.data?.userId,
    load: async () => (await handlers()).handlePeriodNarrative,
  }),
  // One slot, so a burst of long conversations cannot fan out provider calls.
  defineJob({
    queue: COACH_MEMORY_REFRESH_QUEUE,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleCoachMemoryRefresh,
  }),
  // #1279 — the nudge tick reaches a model; pg-boss's queue default retried
  // a failed tick twice at once. The same two retries now back off.
  defineJob({
    queue: COACH_NUDGE_QUEUE,
    cron: COACH_NUDGE_CRON,
    scheduleOptions: { retryLimit: 2, retryDelay: 60, retryBackoff: true },
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleCoachNudge,
  }),
  defineJob({
    queue: COACH_REMINDER_SWEEP_QUEUE,
    cron: COACH_REMINDER_SWEEP_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleCoachReminderSweep,
  }),
  defineJob({
    queue: COACH_PLAN_REVIEW_QUEUE,
    cron: COACH_PLAN_REVIEW_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleCoachPlanReview,
  }),
  defineJob({
    queue: MEDICATION_LOW_STOCK_QUEUE,
    cron: MEDICATION_LOW_STOCK_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleMedicationLowStock,
  }),
  // Every 15 minutes; the per-user local-hour gate picks each user's slot.
  defineJob({
    queue: DAILY_BRIEFING_QUEUE,
    cron: DAILY_BRIEFING_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await handlers()).handleDailyBriefing,
  }),
];

export const STATUS_GROUP: JobGroup = {
  name: "status",
  jobs,
  retired: RETIRED_STATUS_QUEUES,
};
