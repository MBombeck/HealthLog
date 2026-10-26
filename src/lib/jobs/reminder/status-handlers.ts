/**
 * Handlers of the status, score and Coach queues that are not a module's own
 * export: the morning digest refresh, the nightly computed scores, the Coach
 * ticks, the low-stock pass, the daily-briefing fallback, the period-narrative
 * warm and the Coach memory refresh. The registry binds them
 * (`registry/status.ts`) and loads this module on the first job.
 */
import type { Job } from "pg-boss";

import type { CoachMemoryRefreshPayload } from "@/lib/ai/coach/coach-memory-shared";
import { runCoachMemoryRefresh } from "@/lib/ai/coach/coach-memory-refresh-worker";
import { maybeDispatchDailyBriefing } from "@/lib/daily/daily-briefing-push";
import { runCoachNudgeTick } from "@/lib/jobs/coach-nudge";
import { runCoachPlanReviewTick } from "@/lib/jobs/coach-plan-review";
import { runCoachReminderSweep } from "@/lib/jobs/coach-reminder-sweep";
import { runDailyBriefingTick } from "@/lib/jobs/daily-briefing";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { runMedicationLowStockTick } from "@/lib/jobs/medication-low-stock";
import {
  runMorningDigestRefresh,
  type MorningDigestRefreshPayload,
} from "@/lib/jobs/morning-digest-refresh";
import {
  runPeriodNarrativeWarm,
  warmOneNarrative,
  type PeriodNarrativePayload,
} from "@/lib/jobs/period-narrative-warm";
import { PERIOD_NARRATIVE_QUEUE } from "@/lib/jobs/period-narrative-queue";
import { runRecoveryScore } from "@/lib/jobs/recovery-score";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { runStrainScore } from "@/lib/jobs/strain-score";
import { runStressScore } from "@/lib/jobs/stress-score";
import { recordError } from "@/lib/jobs/worker-status";
import { withBackgroundEvent } from "@/lib/logging/background";

import { getWorkerPrisma, workerLog } from "./shared";

/**
 * One forced comprehensive regeneration per user per local morning, enqueued
 * by the sleep-arrival trigger. A finalised day is the event-driven moment for
 * the morning push carrying the final digest; the push seam owns its own
 * opt-in, window and once-per-day gates, and the fallback cron covers the
 * mornings no sleep arrives.
 */
export async function handleMorningDigestRefresh(
  jobs: Job<MorningDigestRefreshPayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.morning_digest_refresh", async (evt) => {
    // The counts the batch already decides on: one refresh per job, and
    // the finalised subset that reaches the morning push seam.
    let refreshed = 0;
    let finalised = 0;
    for (const job of jobs) {
      try {
        const result = await runMorningDigestRefresh(
          getWorkerPrisma(),
          job.data,
        );
        refreshed++;
        evt.addMeta(
          "morning_refresh",
          `${result.status}:${result.comprehensive ?? "none"}`,
        );
        if (result.status === "finalised") {
          finalised++;
          const pushResult = await maybeDispatchDailyBriefing(
            getWorkerPrisma(),
            job.data.userId,
            new Date(),
          );
          evt.addMeta("daily_briefing_push", pushResult);
        }
      } catch (err) {
        recordError();
        workerLog("error", "[morning-digest-refresh] pass failed", err);
        // Rethrow so the queue's retry policy re-runs the refresh; the
        // marker re-check keeps a retry idempotent.
        throw err;
      }
    }
    return jobDone({ refreshed, finalised });
  });
}

interface ScoreSummary {
  considered: number;
  stored: number;
  insufficient: number;
  errored: number;
}

/**
 * A nightly computed-score pass: the cron tick carries an empty payload and
 * the runner walks every eligible user, upserting one `COMPUTED` row per
 * scored day (a re-fire overwrites in place).
 */
function scorePass(
  name: string,
  run: () => Promise<ScoreSummary>,
): () => Promise<JobOutcome> {
  return async () => {
    try {
      const summary = await run();
      workerLog(
        "info",
        `[${name}] considered=${summary.considered} stored=${summary.stored} insufficient=${summary.insufficient} errored=${summary.errored}`,
      );
      return jobDone({
        considered: summary.considered,
        stored: summary.stored,
        insufficient: summary.insufficient,
        errored: summary.errored,
      });
    } catch (err) {
      recordError();
      workerLog("error", `[${name}] pass failed`, err);
      throw err;
    }
  };
}

export const handleRecoveryScore = scorePass("recovery-score", () =>
  runRecoveryScore(getWorkerPrisma()),
);
export const handleStressScore = scorePass("stress-score", () =>
  runStressScore(getWorkerPrisma()),
);
export const handleStrainScore = scorePass("strain-score", () =>
  runStrainScore(getWorkerPrisma()),
);

/**
 * The proactive Coach nudge. Deterministic triggers, no AI call; a per-user
 * failure never fails the pass, it rides out as the `failed` count.
 */
export async function handleCoachNudge(): Promise<JobOutcome> {
  return withBackgroundEvent("job.coach_nudge", async (evt) => {
    try {
      const summary = await runCoachNudgeTick(getWorkerPrisma(), new Date());
      evt.setBackground({
        task_name: "job.coach_nudge",
        result: {
          candidates_scanned: summary.candidatesScanned,
          dispatched: summary.dispatched,
          persisted: summary.persisted,
          skipped_opted_out: summary.skippedOptedOut,
          skipped_no_provider: summary.skippedNoProvider,
          skipped_unavailable: summary.skippedUnavailable,
          skipped_recent_nudge: summary.skippedRecentNudge,
          skipped_recent_engagement: summary.skippedRecentEngagement,
          skipped_no_trigger: summary.skippedNoTrigger,
          skipped_no_channel: summary.skippedNoChannel,
          failed: summary.failed,
        },
      });
      return jobDone({
        candidates_scanned: summary.candidatesScanned,
        dispatched: summary.dispatched,
        persisted: summary.persisted,
        failed: summary.failed,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * The medication low-stock pass. The per-medication stamp makes a re-fire
 * idempotent; a per-medication failure rides out as the `failed` count.
 */
export async function handleMedicationLowStock(): Promise<JobOutcome> {
  return withBackgroundEvent("job.medication_low_stock", async (evt) => {
    try {
      const summary = await runMedicationLowStockTick(
        getWorkerPrisma(),
        new Date(),
      );
      evt.setBackground({
        task_name: "job.medication_low_stock",
        result: {
          users_scanned: summary.usersScanned,
          skipped_threshold_off: summary.skippedThresholdOff,
          medications_evaluated: summary.medicationsEvaluated,
          notified: summary.notified,
          rearmed: summary.rearmed,
          skipped_already_notified: summary.skippedAlreadyNotified,
          skipped_above_threshold: summary.skippedAboveThreshold,
          skipped_no_runway: summary.skippedNoRunway,
          skipped_no_channel: summary.skippedNoChannel,
          failed: summary.failed,
        },
      });
      return jobDone({
        users_scanned: summary.usersScanned,
        medications_evaluated: summary.medicationsEvaluated,
        notified: summary.notified,
        rearmed: summary.rearmed,
        failed: summary.failed,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * The daily-briefing fallback slot. Most ticks land outside every user's
 * slot; that is the tick doing its job, so a zero `sent` is a success.
 */
export async function handleDailyBriefing(): Promise<JobOutcome> {
  return withBackgroundEvent("job.daily_briefing", async (evt) => {
    try {
      const summary = await runDailyBriefingTick(getWorkerPrisma(), new Date());
      evt.setBackground({
        task_name: "job.daily_briefing",
        result: {
          candidates_scanned: summary.candidatesScanned,
          in_slot: summary.inSlot,
          sent: summary.sent,
          suppressed_frequency: summary.suppressedFrequency,
          no_digest: summary.noDigest,
          opted_out: summary.optedOut,
          no_channel: summary.noChannel,
          outside_window: summary.outsideWindow,
          failed: summary.failed,
        },
      });
      return jobDone({
        candidates_scanned: summary.candidatesScanned,
        in_slot: summary.inSlot,
        sent: summary.sent,
        failed: summary.failed,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * The period-narrative warm: a scheduled tick (no `userId`) runs the
 * boundary-gated nightly fan-out, a `userId` payload warms one account for
 * the read-only GET. Two modes on one queue, so the outcome counts them
 * apart: a non-boundary night generates nothing and is still a success.
 */
export async function handlePeriodNarrative(
  jobs: Job<PeriodNarrativePayload>[],
): Promise<JobOutcome> {
  let singleUser = 0;
  let scheduled = 0;
  let generated = 0;
  let failed = 0;
  let stoppedEarly = false;
  for (const job of jobs) {
    try {
      if (job.data?.userId) {
        await warmOneNarrative(job.data);
        singleUser++;
      } else {
        const summary = await runPeriodNarrativeWarm(getWorkerPrisma(), {
          shouldStop: jobBudget(jobs),
        });
        scheduled++;
        generated += summary.generated;
        failed += summary.failed;
        stoppedEarly ||= summary.stoppedEarly;
        workerLog(
          "info",
          `[period-narrative] periods=${summary.periods.join(",") || "none"} total=${summary.total} generated=${summary.generated} cached=${summary.cached} skipped=${summary.skipped} insufficient=${summary.insufficient} failed=${summary.failed} budget=${summary.budgetBlocked}`,
        );
      }
    } catch (err) {
      recordError();
      await reportWorkerError(PERIOD_NARRATIVE_QUEUE, err, {
        mode: job.data?.userId ? "single-user" : "scheduled",
      });
      throw err;
    }
  }
  return jobDone({
    single_user: singleUser,
    scheduled,
    generated,
    failed,
    stopped_early: stoppedEarly,
  });
}

/**
 * The Coach memory refresh for one long conversation. An incomplete payload
 * is skipped rather than failed, and counted, so a queue full of them does
 * not read as a clean run.
 */
export async function handleCoachMemoryRefresh(
  jobs: Job<CoachMemoryRefreshPayload>[],
): Promise<JobOutcome> {
  let refreshed = 0;
  let skippedIncomplete = 0;
  for (const job of jobs) {
    if (!job.data?.conversationId || !job.data?.userId) {
      skippedIncomplete++;
      continue;
    }
    try {
      await runCoachMemoryRefresh(job.data);
      refreshed++;
    } catch (err) {
      recordError();
      workerLog("error", "[coach-memory-refresh] failed", err);
      throw err;
    }
  }
  return jobDone({
    refreshed,
    skipped_incomplete: skippedIncomplete,
  });
}

/**
 * The daily Coach-reminder sweep. Surfacing an overdue reminder and minting
 * plan-review reminders are both idempotent across re-fires; no provider call,
 * no push.
 */
export async function handleCoachReminderSweep(): Promise<JobOutcome> {
  return withBackgroundEvent("job.coach_reminder_sweep", async (evt) => {
    try {
      const summary = await runCoachReminderSweep(
        getWorkerPrisma(),
        new Date(),
      );
      evt.setBackground({
        task_name: "job.coach_reminder_sweep",
        result: {
          reminders_due: summary.remindersDue,
          plan_reviews_minted: summary.planReviewsMinted,
          context_surfaced: summary.contextSurfaced,
          nag_dismissed: summary.nagDismissed,
          errored: summary.errored,
        },
      });
      return jobDone({
        reminders_due: summary.remindersDue,
        plan_reviews_minted: summary.planReviewsMinted,
        context_surfaced: summary.contextSurfaced,
        nag_dismissed: summary.nagDismissed,
        errored: summary.errored,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}

/**
 * The n-of-1 experiment review: writes the grounded before/after read-back
 * into the plan's encrypted outcome. A reviewed plan is not re-processed.
 */
export async function handleCoachPlanReview(): Promise<JobOutcome> {
  return withBackgroundEvent("job.coach_plan_review", async (evt) => {
    try {
      const summary = await runCoachPlanReviewTick(
        getWorkerPrisma(),
        new Date(),
      );
      evt.setBackground({
        task_name: "job.coach_plan_review",
        result: {
          reviewed: summary.reviewed,
          insufficient: summary.insufficient,
          errored: summary.errored,
        },
      });
      return jobDone({
        reviewed: summary.reviewed,
        insufficient: summary.insufficient,
        errored: summary.errored,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      throw err;
    }
  });
}
