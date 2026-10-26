/**
 * Handlers of the rollup and consolidation queues: the measurement and mood
 * rollup folds, the consolidation and repair passes, the supplement nutrient
 * recompute, and the nightly drain that runs the cumulative, daily-mean and
 * dense-retention passes on one tick. The registry binds them
 * (`registry/rollup.ts`) and loads this module on the first job.
 */
import type { Job, PgBoss } from "pg-boss";

import {
  DRAIN_CONTINUATION_DELAY_SECONDS,
  nextDrainContinuation,
} from "@/lib/jobs/drain-continuation";
import {
  DRAIN_CUMULATIVE_QUEUE,
  type DrainCumulativePayload,
} from "@/lib/jobs/drain-cumulative-queue";
import { runDenseIntradayHourlyRebuildForUser } from "@/lib/jobs/dense-intraday-hourly-rebuild";
import type { DenseIntradayHourlyRebuildPayload } from "@/lib/jobs/dense-intraday-hourly-rebuild";
import {
  DENSE_INTRADAY_RETENTION_ENABLED,
  runDenseIntradayRetentionForUser,
  type DenseIntradayRetentionPayload,
} from "@/lib/jobs/dense-intraday-retention";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import {
  runMeanConsolidationForUser,
  type MeanConsolidationPayload,
} from "@/lib/jobs/mean-consolidation";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import {
  runStepConsolidationForUser,
  type StepConsolidationPayload,
} from "@/lib/jobs/step-consolidation";
import {
  runStepConsolidationRepairForUser,
  type StepConsolidationRepairPayload,
} from "@/lib/jobs/step-consolidation-repair";
import { recordError } from "@/lib/jobs/worker-status";
import {
  consolidateDailyMean,
  MEAN_CONSOLIDATION_CUTOFF_HOURS,
} from "@/lib/measurements/consolidate-daily-mean";
import { runDenseIntradayRetention } from "@/lib/measurements/dense-intraday-retention";
import {
  drainPerSampleCumulative,
  DRAIN_CUMULATIVE_CUTOFF_HOURS,
} from "@/lib/measurements/drain-per-sample-cumulative";
import {
  runSupplementNutrientRecompute,
  type SupplementNutrientRecomputePayload,
} from "@/lib/medications/ingredients/recompute-job";
import {
  runCumulativePrRederivationForUser,
  type CumulativePrRederivePayload,
} from "@/lib/personal-records/cumulative-pr-rederivation";
import {
  recomputeUserRollups,
  type RollupFullBackfillPayload,
  type RollupRecomputePayload,
} from "@/lib/rollups/measurement-rollups";
import {
  recomputeUserMoodRollups,
  type MoodRollupFullBackfillPayload,
  type MoodRollupRecomputePayload,
} from "@/lib/rollups/mood-rollups";

import { cronIsTheRetry } from "./registrar-shared";
import { getWorkerPrisma, workerLog } from "./shared";

/**
 * Folds the WEEK / MONTH / YEAR buckets the write-path hooks enqueue; the DAY
 * bucket is recomputed by the hook itself. No per-bucket isolation on
 * purpose: a recompute that throws fails the job, so reaching the end means
 * every bucket in the batch was folded.
 */
export async function handleRollupRecompute(
  jobs: Job<RollupRecomputePayload>[],
): Promise<JobOutcome> {
  for (const job of jobs) {
    const payload = job.data;
    await recomputeUserRollups(payload.userId, {
      types: [payload.type],
      granularities: [payload.granularity],
      from: new Date(payload.from),
      to: new Date(payload.to),
    });
  }
  return jobDone({ buckets_recomputed: jobs.length });
}

/**
 * The full fold of one uncovered account across the default window and every
 * granularity. Each granularity commits on its own, so a run stopped on its
 * budget throws and the retry folds the rest.
 */
export async function handleRollupFullBackfill(
  jobs: Job<RollupFullBackfillPayload>[],
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  let rowsUpsertedTotal = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    const { rowsUpserted, durationMs, stopped } = await recomputeUserRollups(
      userId,
      { shouldStop },
    );
    if (stopped) {
      throw new Error(
        `rollup-full-backfill for user ${userId} stopped on its job budget; the retry folds the rest`,
      );
    }
    rowsUpsertedTotal += rowsUpserted;
    workerLog(
      "info",
      `[rollup-full-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
    );
  }
  return jobDone({
    users: jobs.length,
    rows_upserted: rowsUpsertedTotal,
  });
}

/** Collapses legacy granular step rows into one daily total per day. */
export async function handleStepConsolidation(
  jobs: Job<StepConsolidationPayload>[],
): Promise<JobOutcome> {
  let daysTotal = 0;
  let legacyRowsTotal = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    const { daysConsolidated, legacyRowsSoftDeleted } =
      await runStepConsolidationForUser(userId);
    daysTotal += daysConsolidated;
    legacyRowsTotal += legacyRowsSoftDeleted;
    workerLog(
      "info",
      `[step-consolidation] user=${userId} days=${daysConsolidated} legacyRowsSoftDeleted=${legacyRowsSoftDeleted}`,
    );
  }
  return jobDone({
    users: jobs.length,
    days_consolidated: daysTotal,
    legacy_rows_soft_deleted: legacyRowsTotal,
  });
}

/**
 * Resurrects the provider daily-total step rows the earlier consolidation
 * swept and removes the shadow manual totals it minted. Per-day failures are
 * the repair's own and ride out as a count.
 */
export async function handleStepConsolidationRepair(
  jobs: Job<StepConsolidationRepairPayload>[],
): Promise<JobOutcome> {
  let rowsResurrected = 0;
  let wedgeSkipped = 0;
  let manualMintsRemoved = 0;
  let daysRecomputed = 0;
  let failures = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    const summary = await runStepConsolidationRepairForUser(userId);
    rowsResurrected += summary.rowsResurrected;
    wedgeSkipped += summary.wedgeSkipped;
    manualMintsRemoved += summary.manualMintsRemoved;
    daysRecomputed += summary.daysRecomputed;
    failures += summary.failures;
    workerLog(
      "info",
      `[step-consolidation-repair] user=${userId} resurrected=${summary.rowsResurrected} wedgeSkipped=${summary.wedgeSkipped} manualMintsRemoved=${summary.manualMintsRemoved} daysRecomputed=${summary.daysRecomputed} failures=${summary.failures}`,
    );
  }
  return jobDone({
    users: jobs.length,
    rows_resurrected: rowsResurrected,
    wedge_skipped: wedgeSkipped,
    manual_mints_removed: manualMintsRemoved,
    days_recomputed: daysRecomputed,
    failures,
  });
}

/** One account's supplement doses recomputed into the day's micronutrients. */
export async function handleSupplementNutrientRecompute(
  jobs: Job<SupplementNutrientRecomputePayload>[],
): Promise<JobOutcome> {
  let rowsWritten = 0;
  for (const job of jobs) {
    const result = await runSupplementNutrientRecompute(job.data);
    rowsWritten += result.rowsWritten;
  }
  return jobDone({ users: jobs.length, rows_written: rowsWritten });
}

/**
 * Deletes an inflated cumulative-type personal record and re-runs detection
 * silently, so the honestly derived best takes its place.
 */
export async function handleCumulativePrRederive(
  jobs: Job<CumulativePrRederivePayload>[],
): Promise<JobOutcome> {
  let rowsDeleted = 0;
  let rowsReinserted = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    const summary = await runCumulativePrRederivationForUser(userId);
    rowsDeleted += summary.rowsDeleted;
    rowsReinserted += summary.rowsReinserted;
    workerLog(
      "info",
      `[cumulative-pr-rederive] user=${userId} rowsDeleted=${summary.rowsDeleted} rowsReinserted=${summary.rowsReinserted}`,
    );
  }
  return jobDone({
    users: jobs.length,
    rows_deleted: rowsDeleted,
    rows_reinserted: rowsReinserted,
  });
}

/**
 * Collapses each completed day of per-sample high-frequency mean rows to its
 * mean. Out of budget is a completed run: the folded days are committed and
 * the nightly tick carries on from the first day this run did not reach.
 */
export async function handleMeanConsolidation(
  jobs: Job<MeanConsolidationPayload>[],
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  let daysTotal = 0;
  let perSampleRowsTotal = 0;
  let stoppedEarly = false;
  for (const job of jobs) {
    const { userId } = job.data;
    const summary = await runMeanConsolidationForUser(userId, shouldStop);
    const { daysConsolidated, perSampleRowsSoftDeleted } = summary;
    stoppedEarly ||= summary.stoppedEarly;
    daysTotal += daysConsolidated;
    perSampleRowsTotal += perSampleRowsSoftDeleted;
    workerLog(
      "info",
      `[mean-consolidation] user=${userId} days=${daysConsolidated} perSampleRowsSoftDeleted=${perSampleRowsSoftDeleted}`,
    );
  }
  return jobDone({
    users: jobs.length,
    days_consolidated: daysTotal,
    per_sample_rows_soft_deleted: perSampleRowsTotal,
    stopped_early: stoppedEarly,
  });
}

/**
 * Folds one account's dense-tier (HRV / HR / SpO2) samples older than the
 * retention window to hourly means, keeping the in-window intra-day shape the
 * Stress engine reads. Out of budget completes the job; the nightly tick
 * continues from the first day this run did not reach.
 */
export async function handleDenseIntradayRetention(
  jobs: Job<DenseIntradayRetentionPayload>[],
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  let daysTotal = 0;
  let perSampleRowsTotal = 0;
  let derivedRestingRowsTotal = 0;
  let stoppedEarly = false;
  for (const job of jobs) {
    const { userId } = job.data;
    try {
      const summary = await runDenseIntradayRetentionForUser(
        userId,
        shouldStop,
      );
      const {
        daysConsolidated,
        perSampleRowsSoftDeleted,
        derivedRestingRowsUpserted,
      } = summary;
      stoppedEarly ||= summary.stoppedEarly;
      daysTotal += daysConsolidated;
      perSampleRowsTotal += perSampleRowsSoftDeleted;
      derivedRestingRowsTotal += derivedRestingRowsUpserted;
      workerLog(
        "info",
        `[dense-intraday-retention] user=${userId} days=${daysConsolidated} perSampleRowsSoftDeleted=${perSampleRowsSoftDeleted} derivedRestingRowsUpserted=${derivedRestingRowsUpserted}`,
      );
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[dense-intraday-retention] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  return jobDone({
    users: jobs.length,
    days_consolidated: daysTotal,
    per_sample_rows_soft_deleted: perSampleRowsTotal,
    derived_resting_rows_upserted: derivedRestingRowsTotal,
    stopped_early: stoppedEarly,
  });
}

/**
 * Reconstructs hourly means from the tombstones behind a pre-hourly daily row
 * and retires the daily row. Out of budget fails the job so pg-boss retries
 * (the boot send allows three), and the retry starts at the first day not yet
 * rebuilt; the queue is `exclusive`, so it cannot hand itself on while active.
 */
export async function handleDenseIntradayHourlyRebuild(
  jobs: Job<DenseIntradayHourlyRebuildPayload>[],
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  let stoppedEarly = false;
  let daysRebuiltTotal = 0;
  let hourlyRowsTotal = 0;
  let dailyRowsRetiredTotal = 0;
  let daysSkippedTotal = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    try {
      const summary = await runDenseIntradayHourlyRebuildForUser(
        userId,
        shouldStop,
      );
      const {
        daysRebuilt,
        hourlyRowsUpserted,
        dailyRowsRetired,
        daysSkippedNoTombstones,
      } = summary;
      stoppedEarly ||= summary.stoppedEarly;
      daysRebuiltTotal += daysRebuilt;
      hourlyRowsTotal += hourlyRowsUpserted;
      dailyRowsRetiredTotal += dailyRowsRetired;
      daysSkippedTotal += daysSkippedNoTombstones;
      workerLog(
        "info",
        `[dense-intraday-hourly-rebuild] user=${userId} daysRebuilt=${daysRebuilt} hourlyRowsUpserted=${hourlyRowsUpserted} dailyRowsRetired=${dailyRowsRetired} daysSkippedNoTombstones=${daysSkippedNoTombstones}`,
      );
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[dense-intraday-hourly-rebuild] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  const did = {
    users: jobs.length,
    stopped_early: stoppedEarly,
    days_rebuilt: daysRebuiltTotal,
    hourly_rows_upserted: hourlyRowsTotal,
    daily_rows_retired: dailyRowsRetiredTotal,
    days_skipped_no_tombstones: daysSkippedTotal,
  };
  if (stoppedEarly) {
    return jobFailed(
      "stopped before every day was rebuilt; the retry resumes",
      undefined,
      did,
    );
  }
  return jobDone(did);
}

/** Folds the WEEK / MONTH / YEAR mood buckets the mood-entry hooks enqueue. */
export async function handleMoodRollupRecompute(
  jobs: Job<MoodRollupRecomputePayload>[],
): Promise<JobOutcome> {
  for (const job of jobs) {
    const payload = job.data;
    await recomputeUserMoodRollups(payload.userId, {
      granularities: [payload.granularity],
      from: new Date(payload.from),
      to: new Date(payload.to),
    });
  }
  return jobDone({ buckets_recomputed: jobs.length });
}

/**
 * The full mood fold of one account. Delete-then-refold, so the backfill
 * cleans up any row minted under an older keying; the brief empty window
 * reads correctly through the live fallback.
 */
export async function handleMoodRollupFullBackfill(
  jobs: Job<MoodRollupFullBackfillPayload>[],
): Promise<JobOutcome> {
  let rowsUpsertedTotal = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    try {
      const { rowsUpserted, durationMs } = await recomputeUserMoodRollups(
        userId,
        { replace: true },
      );
      rowsUpsertedTotal += rowsUpserted;
      workerLog(
        "info",
        `[mood-rollup-full-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
      );
    } catch (err) {
      recordError();
      workerLog(
        "error",
        `[mood-rollup-full-backfill] user=${userId} failed`,
        err,
      );
      throw err;
    }
  }
  return jobDone({
    users: jobs.length,
    rows_upserted: rowsUpsertedTotal,
  });
}

/**
 * The nightly drain: the cumulative (SUM) drain, the daily-mean drain and the
 * dense intra-day retention drain, in turn, on one budget. They are
 * independent passes, so one failing does not stop the others; the first
 * failure is reported once the tick is over and fails the job. A tick that ran
 * out of budget hands the rest to a bounded follow-up.
 */
export function drainCumulativeHandler(
  boss: PgBoss,
): (jobs: Job<DrainCumulativePayload>[]) => Promise<JobOutcome> {
  return async (jobs) => {
    const shouldStop = jobBudget(jobs);
    let stoppedEarly = false;
    let firstFailure: { reason: string; cause: unknown } | undefined;
    let passesFailed = 0;
    let bucketsCollapsed = 0;
    let perSampleRowsDeleted = 0;
    let meanDaysConsolidated = 0;
    let meanRowsSoftDeleted = 0;
    let denseDaysConsolidated = 0;
    let denseRowsSoftDeleted = 0;
    let denseSkipped = false;

    for (const job of jobs) {
      try {
        const summary = await drainPerSampleCumulative(getWorkerPrisma(), {
          dryRun: false,
          cutoffHours: DRAIN_CUMULATIVE_CUTOFF_HOURS,
          shouldStop,
          log: (line) => workerLog("info", line),
        });
        stoppedEarly ||= summary.stoppedEarly;
        bucketsCollapsed += summary.totals.bucketsCollapsed;
        perSampleRowsDeleted += summary.totals.perSampleRowsDeleted;
        workerLog(
          "info",
          `[drain-cumulative] triggeredAt=${job.data.triggeredAt} usersScanned=${summary.totals.usersScanned} bucketsCollapsed=${summary.totals.bucketsCollapsed} perSampleRowsDeleted=${summary.totals.perSampleRowsDeleted} dailyRowsUpserted=${summary.totals.dailyRowsUpserted}`,
        );
      } catch (err) {
        recordError();
        await reportWorkerError("drain-cumulative", err);
        passesFailed++;
        firstFailure ??= { reason: "cumulative drain failed", cause: err };
      }

      // The daily-mean drain rides the same tick, so spot samples between
      // reboots do not accumulate raw; the 36-hour grace keeps today's
      // in-flight watch syncs raw.
      try {
        const meanSummary = await consolidateDailyMean(getWorkerPrisma(), {
          dryRun: false,
          cutoffHours: MEAN_CONSOLIDATION_CUTOFF_HOURS,
          shouldStop,
          log: (line) => workerLog("info", line),
        });
        stoppedEarly ||= meanSummary.stoppedEarly;
        meanDaysConsolidated += meanSummary.totals.daysConsolidated;
        meanRowsSoftDeleted += meanSummary.totals.perSampleRowsSoftDeleted;
        workerLog(
          "info",
          `[mean-consolidation] triggeredAt=${job.data.triggeredAt} usersScanned=${meanSummary.totals.usersScanned} daysConsolidated=${meanSummary.totals.daysConsolidated} perSampleRowsSoftDeleted=${meanSummary.totals.perSampleRowsSoftDeleted} dailyRowsUpserted=${meanSummary.totals.dailyRowsUpserted} daysFailed=${meanSummary.totals.daysFailed}`,
        );
      } catch (err) {
        recordError();
        await reportWorkerError("mean-consolidation", err, {
          tick: "nightly",
        });
        passesFailed++;
        firstFailure ??= { reason: "mean consolidation failed", cause: err };
      }

      // The dense intra-day retention drain: HRV and pulse only, keeping the
      // last DENSE_INTRADAY_RETENTION_DAYS raw for the Stress engine. These
      // types are never in the destructive daily-mean allowlist.
      try {
        if (!DENSE_INTRADAY_RETENTION_ENABLED) {
          denseSkipped = true;
          workerLog(
            "info",
            "[dense-intraday-retention] disabled via DENSE_INTRADAY_RETENTION_ENABLED — skipping the nightly walk (operator kill-switch)",
          );
        } else {
          const denseSummary = await runDenseIntradayRetention(
            getWorkerPrisma(),
            {
              dryRun: false,
              shouldStop,
              log: (line) => workerLog("info", line),
            },
          );
          stoppedEarly ||= denseSummary.stoppedEarly;
          denseDaysConsolidated += denseSummary.totals.daysConsolidated;
          denseRowsSoftDeleted += denseSummary.totals.perSampleRowsSoftDeleted;
          workerLog(
            "info",
            `[dense-intraday-retention] triggeredAt=${job.data.triggeredAt} usersScanned=${denseSummary.totals.usersScanned} daysConsolidated=${denseSummary.totals.daysConsolidated} perSampleRowsSoftDeleted=${denseSummary.totals.perSampleRowsSoftDeleted} hourlyRowsUpserted=${denseSummary.totals.hourlyRowsUpserted} dailyRowsRetired=${denseSummary.totals.dailyRowsRetired}`,
          );
        }
      } catch (err) {
        recordError();
        await reportWorkerError("dense-intraday-retention", err, {
          tick: "nightly",
        });
        passesFailed++;
        firstFailure ??= { reason: "dense retention failed", cause: err };
      }
    }

    const continuation = Math.max(
      0,
      ...jobs.map((job) => job.data.continuation ?? 0),
    );
    const next = nextDrainContinuation({
      stoppedEarly,
      daysFolded:
        bucketsCollapsed + meanDaysConsolidated + denseDaysConsolidated,
      continuation,
    });
    let continued = false;
    if (next !== null) {
      try {
        const followUp: DrainCumulativePayload = {
          triggeredAt: new Date().toISOString(),
          continuation: next,
        };
        continued =
          (await boss.send(DRAIN_CUMULATIVE_QUEUE, followUp, {
            ...cronIsTheRetry,
            startAfter: DRAIN_CONTINUATION_DELAY_SECONDS,
          })) !== null;
      } catch (err) {
        // The next nightly tick picks the work up regardless; a lost
        // follow-up only delays it.
        workerLog("error", "[drain-cumulative] follow-up send failed", err);
      }
    }

    const did = {
      stopped_early: stoppedEarly,
      continuation,
      continued,
      passes_failed: passesFailed,
      buckets_collapsed: bucketsCollapsed,
      per_sample_rows_deleted: perSampleRowsDeleted,
      mean_days_consolidated: meanDaysConsolidated,
      mean_rows_soft_deleted: meanRowsSoftDeleted,
      dense_days_consolidated: denseDaysConsolidated,
      dense_rows_soft_deleted: denseRowsSoftDeleted,
      dense_skipped: denseSkipped,
    };

    if (firstFailure) {
      return jobFailed(firstFailure.reason, firstFailure.cause, did);
    }
    return jobDone(did);
  };
}
