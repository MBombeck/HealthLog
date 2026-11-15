/**
 * The nightly status batch plus the insight pregenerate and per-user
 * status-generate handlers.
 *
 * Extracted from reminder-worker.ts, which owns the queue names, cron
 * schedules, and boss.work registrations.
 */
import { type Job } from "pg-boss";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { normalizeLocale } from "@/lib/insights/status-shared";
import { resolveJobLocale } from "@/lib/i18n/job-locale";
import { recordError, recordInsightsRun } from "@/lib/jobs/worker-status";
import {
  INSIGHT_PREGENERATE_QUEUE,
  type InsightPregeneratePayload,
  runInsightPregenerate,
  forceWarmUser,
} from "@/lib/jobs/insight-pregenerate";
import {
  INSIGHT_STATUS_GENERATE_QUEUE,
  type InsightStatusGeneratePayload,
  runInsightStatusGenerate,
} from "@/lib/jobs/insight-status-generate";
import { codeFact, jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { jobBudget } from "@/lib/jobs/job-budget";
import { withBackgroundEvent } from "@/lib/logging/background";
import { generateStatusBatchForUser } from "@/lib/insights/status-batch";
import { findStatusCronCandidates } from "@/lib/jobs/status-cron-candidates";
import { annotate } from "@/lib/logging/context";
import { getWorkerPrisma } from "./shared";

export interface GeneralStatusPayload {
  triggeredAt: string;
}

/**
 * The nightly status batch. The 02:00 cron runs `generateStatusBatchForUser`
 * for every candidate (`findStatusCronCandidates`): it builds every
 * per-metric snapshot once, issues ONE provider call for the metrics still
 * needing the model, and fans the answer into the per-metric cache rows. A
 * metric the batch omits, or every metric when the call fails, falls back to
 * that card's own path inside the batch, so the pass covers every card on its
 * own. Each user's `statusText` capability is resolved inside the batch before
 * a snapshot is built.
 *
 * The pass is what succeeds or fails. One user whose batch threw is that
 * user's cold cards, reported as the `failed` count; failing the job would
 * re-run the whole cohort over it. `shouldStop` is the job's time budget: the
 * pass stops between users once it is spent and reports `stopped_early`, and
 * the users it did not reach are warmed by their next visit or night.
 */
export async function runStatusBatchCron(
  taskName: string,
  shouldStop: () => boolean,
): Promise<JobOutcome> {
  return withBackgroundEvent(taskName, async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      recordInsightsRun();
      const users = await findStatusCronCandidates(prisma);
      if (users.length === 0) {
        return jobDone({ total: 0, generated: 0, served: 0, failed: 0 });
      }

      let generated = 0;
      let served = 0;
      let failed = 0;
      let stoppedEarly = false;
      for (const user of users) {
        // Stop between users; the rest are warmed by a visit or the next
        // night.
        if (shouldStop()) {
          stoppedEarly = true;
          break;
        }
        try {
          const result = await generateStatusBatchForUser(user.id, {
            // The stored locale, then the operator default — the prompt names
            // the reader's own language from this value.
            locale: await resolveJobLocale(user.locale),
            force: false,
          });
          generated += result.batched + result.fellBackAnswered;
          served += result.served;
        } catch (error) {
          failed++;
          evt.addWarning(
            `${taskName} batch failed for user ${user.id}: ${error}`,
          );
        }
      }

      annotate({
        action: { name: "insights.status.batch.cron" },
        meta: {
          generated,
          served,
          failed,
          total: users.length,
          stopped_early: stoppedEarly,
        },
      });
      evt.setBackground({
        task_name: taskName,
        result: {
          generated,
          served,
          failed,
          total: users.length,
          stoppedEarly,
        },
      });
      // A user whose batch call threw already fell back to the single-card
      // path inside the batch. The pass ran, so it reports the count.
      return jobDone({
        total: users.length,
        generated,
        served,
        failed,
        stopped_early: stoppedEarly,
      });
    } catch (err) {
      evt.setError(err);
      recordError();
      await reportWorkerError(taskName, err);
      throw err;
    }
  });
}

export function handleGeneralStatusGenerate(
  jobs: Job<GeneralStatusPayload>[],
): Promise<JobOutcome> {
  return runStatusBatchCron("job.insights.batch", jobBudget(jobs));
}

export async function handleInsightPregenerateJob(
  jobs: Job<InsightPregeneratePayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.insight_pregenerate", async (evt) => {
    // v1.8.7.1 — a forced single-user warm carries `{ userId, force }`;
    // the scheduled tick carries neither. Route each job individually so a
    // batch that mixes a cron tick with on-demand warms (it never does in
    // practice, but the contract is per-job) stays correct.
    const forced = jobs.filter((j) => j.data?.force && j.data?.userId);
    const scheduled = jobs.filter((j) => !(j.data?.force && j.data?.userId));

    for (const job of forced) {
      const userId = job.data.userId as string;
      // The former `=== "en" ? "en" : "de"` defaulted a fr/es/it/pl payload to
      // GERMAN, so a forced warm produced German prose for a French reader.
      const locale = normalizeLocale(job.data.locale);
      try {
        const summary = await forceWarmUser(getWorkerPrisma(), userId, locale, {
          today: job.data.today === true,
        });
        evt.addMeta(
          "force_warm",
          `${summary.comprehensive}:${summary.assessmentsWarmed}+${summary.metricAssessmentsWarmed}`,
        );
      } catch (err) {
        evt.addWarning(
          `insight-pregenerate force-warm failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Surface the failure centrally and rethrow so the queue's retry
        // policy (retryLimit 3 + backoff) re-runs the warm — swallowing it
        // here left the user's caches cold with zero operator signal.
        await reportWorkerError(INSIGHT_PREGENERATE_QUEUE, err, {
          mode: "force-warm",
        });
        throw err;
      }
    }

    // A batch of forced warms only is a complete run: every warm either landed
    // or threw out of the loop above.
    if (scheduled.length === 0) {
      return jobDone({ forced: forced.length, scheduled: 0 });
    }
    try {
      const summary = await runInsightPregenerate(getWorkerPrisma(), {
        shouldStop: jobBudget(jobs),
      });
      evt.setBackground({
        task_name: "job.insight_pregenerate",
        result: { ...summary },
      });
      return jobDone({
        forced: forced.length,
        scheduled: scheduled.length,
        total: summary.total,
        generated: summary.generated,
        cached: summary.cached,
        unchanged: summary.unchanged,
        skipped: summary.skipped,
        failed: summary.failed,
        budget_blocked: summary.budgetBlocked,
        stopped_early: summary.stoppedEarly,
        // v1.42 — read back by `readConsecutiveRunFailures`, so a night that
        // completed with nothing generated counts toward the failure streak.
        all_failed: summary.allFailed,
        assessments_warmed: summary.assessmentsWarmed,
        metric_assessments_warmed: summary.metricAssessmentsWarmed,
        // #1384 — what failed, for the admin page and the alert ("none"
        // when nothing did, or the generator could not say).
        failure_cause: codeFact(summary.firstFailure?.reason) ?? "none",
        failure_provider: codeFact(summary.firstFailure?.provider) ?? "none",
      });
    } catch (err) {
      evt.addWarning(
        `insight-pregenerate failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Same contract as the force path: report + rethrow so the nightly
      // tick retries instead of silently waiting for the next night.
      await reportWorkerError(INSIGHT_PREGENERATE_QUEUE, err, {
        mode: "scheduled",
      });
      throw err;
    }
  });
}

/**
 * v1.8.3 — on-demand per-metric status generation. The read-only status
 * route enqueues one job per cold card; this handler runs the matching
 * generator with `force: true` so the assessment cache row lands and the
 * polling client picks it up. Each job carries `{ userId, metric, locale }`.
 */
export async function handleInsightStatusGenerate(
  jobs: Job<InsightStatusGeneratePayload>[],
): Promise<JobOutcome> {
  return withBackgroundEvent("job.insight_status_generate", async (evt) => {
    let generated = 0;
    let malformed = 0;
    for (const job of jobs) {
      if (!job.data?.userId || !job.data?.metric) {
        malformed++;
        continue;
      }
      try {
        await runInsightStatusGenerate(job.data);
        generated++;
        evt.addMeta(
          "status_generated",
          `${job.data.metric}:${job.data.locale}`,
        );
      } catch (err) {
        evt.addWarning(
          `insight-status-generate failed for ${job.data.metric}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Report centrally + rethrow so the enqueue's retry policy
        // (retryLimit 3 + backoff) re-runs the generation; the polling
        // client otherwise sits on "preparing" with zero operator signal.
        await reportWorkerError(INSIGHT_STATUS_GENERATE_QUEUE, err, {
          metric: job.data.metric,
        });
        throw err;
      }
    }
    // Every job in the batch either generated a card or carried no metric to
    // generate; a generation that failed left through the rethrow above.
    return jobDone({ generated, malformed });
  });
}
