/**
 * Nightly insight status crons (general / blood pressure / weight / pulse / BMI / mood / medication compliance) plus the insight pregenerate and per-user status-generate handlers.
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
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { jobBudget } from "@/lib/jobs/job-budget";
import { withBackgroundEvent } from "@/lib/logging/background";
import { generateBloodPressureStatusForUser } from "@/lib/insights/blood-pressure-status";
import { generateWeightStatusForUser } from "@/lib/insights/weight-status";
import { generatePulseStatusForUser } from "@/lib/insights/pulse-status";
import { generateBmiStatusForUser } from "@/lib/insights/bmi-status";
import { generateMoodStatusForUser } from "@/lib/insights/mood-status";
import { generateMedicationComplianceStatusForUser } from "@/lib/insights/medication-compliance-status";
import { generateStatusBatchForUser } from "@/lib/insights/status-batch";
import { findStatusCronCandidates } from "@/lib/jobs/status-cron-candidates";
import { annotate } from "@/lib/logging/context";
import { aiCapabilityForJob } from "@/lib/ai/capabilities/gate";
import { getWorkerPrisma } from "./shared";

export interface GeneralStatusPayload {
  triggeredAt: string;
}

export interface BloodPressureStatusPayload {
  triggeredAt: string;
}

export interface WeightStatusPayload {
  triggeredAt: string;
}

export interface PulseStatusPayload {
  triggeredAt: string;
}

export interface BmiStatusPayload {
  triggeredAt: string;
}

export interface MoodStatusPayload {
  triggeredAt?: string;
}

export interface MedicationComplianceStatusPayload {
  triggeredAt: string;
}

/**
 * Shared driver for the nightly 02:xx per-metric status crons. User
 * discovery is centralised in `findStatusCronCandidates`, which applies
 * the operator's `insightStatus` switch, the person's AI analysis switch,
 * and the pregenerate-candidate skip (users with a stale comprehensive
 * cache belong to the 04:30 pre-generate pass, which re-warms every
 * per-status note anyway — see `status-cron-candidates.ts` for the full
 * division of nightly labour). Each user's `statusText` capability is then
 * resolved before a generator runs.
 * The generators normalise `locale` themselves (de stays de, everything
 * else gets English prose).
 *
 * The pass is what succeeds or fails. One user whose generation threw is that
 * user's cold card, reported as the `failed` count; failing the job would
 * re-run the whole cohort over it.
 *
 * The pass walks every candidate with a provider call each, so on a large
 * instance it can outlast its job. `shouldStop` is the job's time budget: the
 * pass stops between users once it is spent and reports `stopped_early`. The
 * users it did not reach keep yesterday's note until the next night or their
 * next visit; nothing is retried beside a pass that is still running.
 */
export async function runStatusCronGenerate(
  taskName: string,
  generate: (
    userId: string,
    options: { locale: string | null; force: boolean },
  ) => Promise<unknown>,
  shouldStop: () => boolean = () => false,
): Promise<JobOutcome> {
  return withBackgroundEvent(taskName, async (evt) => {
    const prisma = getWorkerPrisma();
    try {
      const users = await findStatusCronCandidates(prisma);

      if (users.length === 0) {
        return jobDone({ total: 0, generated: 0, failed: 0 });
      }

      let generated = 0;
      let failed = 0;
      let stoppedEarly = false;

      for (const user of users) {
        if (shouldStop()) {
          stoppedEarly = true;
          break;
        }
        // The capability before the generator builds a snapshot. The batch
        // entry below checks for itself.
        const capability = await aiCapabilityForJob(user.id, "statusText");
        if (!capability.available) {
          annotate({
            action: { name: "insights.status.cron.skipped" },
            meta: { task: taskName, reason: capability.reason },
          });
          continue;
        }
        try {
          await generate(user.id, {
            locale: await resolveJobLocale(user.locale),
            force: false,
          });
          generated++;
        } catch (error) {
          failed++;
          evt.addWarning(
            `${taskName} generation failed for user ${user.id}: ${error}`,
          );
        }
      }

      evt.setBackground({
        task_name: taskName,
        result: { generated, failed, total: users.length, stoppedEarly },
      });
      return jobDone({
        total: users.length,
        generated,
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

/**
 * v1.18.11 (P2) — nightly status batch. The 02:00 anchor cron runs
 * `generateStatusBatchForUser` for every candidate: it builds all seven
 * per-metric snapshots once and issues ONE provider call for the metrics
 * still needing the LLM (seed-pinned + grounded inside `runStatusCompletion`,
 * unchanged), fanning the response into the SAME per-metric cache rows the
 * standalone generators wrote.
 *
 * The six later per-metric crons (02:05–02:30) stay registered and keep their
 * own drivers: a card the batch wrote today resolves inside their `prepare`
 * step as a calendar-day cache hit (`served`, no provider call, no snapshot
 * rebuild), so they cost a cache read and cover the edge cases the batch
 * can't — a user discovered after 02:00, a metric the batch omitted, or a
 * batch-call failure (which falls each metric back to its single-card path
 * inside the batch itself). Net effect: the nightly ladder pays one call per
 * user instead of seven, with no queue/registry churn.
 */
async function runStatusBatchCron(
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
        // Same budget as the per-metric passes: stop between users, and
        // leave the rest to the later crons and the next night.
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
          generated += result.batched + result.fellBack;
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
      // path inside the batch, and the six later per-metric crons cover what
      // is still cold. The batch pass ran, so it reports the count.
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

export function handleBloodPressureStatusGenerate(
  jobs: Job<BloodPressureStatusPayload>[],
): Promise<JobOutcome> {
  return runStatusCronGenerate(
    "job.insights.blood_pressure",
    generateBloodPressureStatusForUser,
    jobBudget(jobs),
  );
}

export function handleWeightStatusGenerate(
  jobs: Job<WeightStatusPayload>[],
): Promise<JobOutcome> {
  return runStatusCronGenerate(
    "job.insights.weight",
    generateWeightStatusForUser,
    jobBudget(jobs),
  );
}

export function handlePulseStatusGenerate(
  jobs: Job<PulseStatusPayload>[],
): Promise<JobOutcome> {
  return runStatusCronGenerate(
    "job.insights.pulse",
    generatePulseStatusForUser,
    jobBudget(jobs),
  );
}

export function handleBmiStatusGenerate(
  jobs: Job<BmiStatusPayload>[],
): Promise<JobOutcome> {
  return runStatusCronGenerate(
    "job.insights.bmi",
    generateBmiStatusForUser,
    jobBudget(jobs),
  );
}

export function handleMoodStatusGenerate(
  jobs: Job<MoodStatusPayload>[],
): Promise<JobOutcome> {
  return runStatusCronGenerate(
    "job.insights.mood",
    generateMoodStatusForUser,
    jobBudget(jobs),
  );
}

export function handleMedicationComplianceStatusGenerate(
  jobs: Job<MedicationComplianceStatusPayload>[],
): Promise<JobOutcome> {
  return runStatusCronGenerate(
    "job.insights.medication_compliance",
    generateMedicationComplianceStatusForUser,
    jobBudget(jobs),
  );
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
