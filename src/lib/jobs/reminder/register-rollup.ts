/**
 * Rollup / consolidation queue registrar.
 *
 * Owns the pre-aggregation + consolidation tier: measurement-rollup recompute
 * + boot-backfill, mood-rollup recompute + boot-backfill, medication-compliance
 * boot-backfill, legacy step consolidation, daily-mean consolidation, dense
 * intra-day retention, and the nightly per-sample cumulative drain (which also
 * folds the daily-mean + dense-retention passes onto the same tick). Includes
 * the boot-time discovery enqueues for the self-converging backfills.
 *
 * v1.4.37 dead-queue contract: every queue name appears in `allQueues`, its
 * cron (where it has one) appears as a `[QUEUE, CRON]` tuple in `schedules`,
 * and a `createAndWork(boss, QUEUE, …, handler)` binding drains it. The
 * `drain-cumulative-queue`, `mean-consolidation-queue`, and
 * `stress-strain-retention-queue` (dense-retention facet) guards read THIS
 * module.
 */
import { PgBoss } from "pg-boss";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { recordError } from "@/lib/jobs/worker-status";
import {
  ROLLUP_FULL_BACKFILL_QUEUE,
  ROLLUP_FULL_BACKFILL_CONCURRENCY,
  ROLLUP_RECOMPUTE_QUEUE,
  ROLLUP_RECOMPUTE_CONCURRENCY,
  enqueueBootTimeRollupBackfill,
  recomputeUserRollups,
  type RollupFullBackfillPayload,
  type RollupRecomputePayload,
} from "@/lib/rollups/measurement-rollups";
import {
  MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
  MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY,
  MOOD_ROLLUP_RECOMPUTE_QUEUE,
  MOOD_ROLLUP_RECOMPUTE_CONCURRENCY,
  enqueueBootTimeMoodRollupBackfill,
  recomputeUserMoodRollups,
  type MoodRollupFullBackfillPayload,
  type MoodRollupRecomputePayload,
} from "@/lib/rollups/mood-rollups";
import {
  MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
  MEDICATION_COMPLIANCE_BACKFILL_CONCURRENCY,
  recomputeUserMedicationCompliance,
  enqueueBootTimeMedicationComplianceBackfill,
  type MedicationComplianceBackfillPayload,
} from "@/lib/rollups/medication-compliance-rollups";
import {
  drainPerSampleCumulative,
  DRAIN_CUMULATIVE_CUTOFF_HOURS,
} from "@/lib/measurements/drain-per-sample-cumulative";
import {
  consolidateDailyMean,
  MEAN_CONSOLIDATION_CUTOFF_HOURS,
} from "@/lib/measurements/consolidate-daily-mean";
import {
  STEP_CONSOLIDATION_QUEUE,
  STEP_CONSOLIDATION_CONCURRENCY,
  runStepConsolidationForUser,
  enqueueBootTimeStepConsolidation,
  type StepConsolidationPayload,
} from "@/lib/jobs/step-consolidation";
import {
  STEP_CONSOLIDATION_REPAIR_QUEUE,
  STEP_CONSOLIDATION_REPAIR_CONCURRENCY,
  runStepConsolidationRepairForUser,
  enqueueBootTimeStepConsolidationRepair,
  type StepConsolidationRepairPayload,
} from "@/lib/jobs/step-consolidation-repair";
import {
  CUMULATIVE_PR_REDERIVE_QUEUE,
  CUMULATIVE_PR_REDERIVE_CONCURRENCY,
  runCumulativePrRederivationForUser,
  enqueueBootTimeCumulativePrRederivation,
  type CumulativePrRederivePayload,
} from "@/lib/personal-records/cumulative-pr-rederivation";
import {
  MEAN_CONSOLIDATION_QUEUE,
  MEAN_CONSOLIDATION_CONCURRENCY,
  runMeanConsolidationForUser,
  enqueueBootTimeMeanConsolidation,
  type MeanConsolidationPayload,
} from "@/lib/jobs/mean-consolidation";
import {
  DENSE_INTRADAY_RETENTION_QUEUE,
  DENSE_INTRADAY_RETENTION_CONCURRENCY,
  runDenseIntradayRetentionForUser,
  enqueueBootTimeDenseIntradayRetention,
  DENSE_INTRADAY_RETENTION_ENABLED,
  type DenseIntradayRetentionPayload,
} from "@/lib/jobs/dense-intraday-retention";
import { runDenseIntradayRetention } from "@/lib/measurements/dense-intraday-retention";
import {
  DENSE_INTRADAY_HOURLY_REBUILD_QUEUE,
  DENSE_INTRADAY_HOURLY_REBUILD_CONCURRENCY,
  runDenseIntradayHourlyRebuildForUser,
  enqueueBootTimeDenseIntradayHourlyRebuild,
  type DenseIntradayHourlyRebuildPayload,
} from "@/lib/jobs/dense-intraday-hourly-rebuild";
import {
  getWorkerPrisma,
  workerLog,
  BOOT_BACKFILL_STAGGER_SECONDS,
} from "./shared";
import {
  createAndSchedule,
  createAndWork,
  cronIsTheRetry,
  type QueuePolicyTable,
  type ScheduleEntry,
} from "./registrar-shared";
import { jobDone, jobFailed } from "@/lib/jobs/job-outcome";
import { jobBudget } from "@/lib/jobs/job-budget";
import {
  DRAIN_CONTINUATION_DELAY_SECONDS,
  nextDrainContinuation,
} from "@/lib/jobs/drain-continuation";
// v1.4.37 W7c — nightly drain of per-sample APPLE_HEALTH cumulative rows.
// Collapses each user × cumulative-type × calendar-day bucket into one
// `stats:…` row so the list view stops painting hundreds of step chunks per
// day. 03:45 Europe/Berlin slots in between the 03:15 audit-log cleanup and
// the 04:00 feedback aggregator. The 36-hour grace window keeps today + the
// trailing watch-sync window intact for real-time visibility; only
// completed-and-stable days fall to the drain.

const DRAIN_CUMULATIVE_QUEUE = "drain-per-sample-cumulative";

const DRAIN_CUMULATIVE_CRON = "45 3 * * *";

interface DrainCumulativePayload {
  triggeredAt?: string;
  /**
   * How many times this tick has already handed itself on. Absent on the
   * cron's own job. See `nextDrainContinuation`.
   */
  continuation?: number;
}

const allQueues = [
  ROLLUP_RECOMPUTE_QUEUE,
  ROLLUP_FULL_BACKFILL_QUEUE,
  // v1.4.39 W-MOOD — per-bucket WEEK/MONTH/YEAR fold queue for the
  // mood rollup tier. The DAY pass runs inline in the write hook;
  // these enqueue paths cover the cross-granularity buckets the
  // worker materialises off the request path.
  MOOD_ROLLUP_RECOMPUTE_QUEUE,
  // v1.4.39 W-MOOD — boot-time fold queue for the mood rollup tier.
  MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
  // v1.4.39 W-MED — boot-time fold for the medication-compliance
  // rollup tier. Discovery enqueues one job per user with intake
  // events but no rollup coverage; idempotent across reboots.
  MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
  // v1.5.6 — boot-time legacy step consolidation. Discovery enqueues
  // one job per user still holding live pre-v1.5.0 granular step rows.
  STEP_CONSOLIDATION_QUEUE,
  // v1.28.37 — one-shot repair for the provider step rows the pre-fix
  // consolidation swept. Boot-discovery driven, self-converging.
  STEP_CONSOLIDATION_REPAIR_QUEUE,
  // v1.30.3 — one-shot repair for the cumulative-type PersonalRecord rows
  // the pre-fix multi-source SUM inflated. Boot-discovery driven,
  // self-converging (QA F4).
  CUMULATIVE_PR_REDERIVE_QUEUE,
  // v1.7.0 — daily-mean consolidation for high-frequency spot HealthKit
  // metrics (walking speed/step length, respiratory rate, audio exposure).
  MEAN_CONSOLIDATION_QUEUE,
  // v1.10.0 — computed scores (WX-E). Dense intra-day retention drain of
  // daytime HRV / HR samples (per-user backfill queue, boot-discovery
  // driven like mean-consolidation; the steady-state nightly walk folds
  // onto the drain-cumulative tick).
  DENSE_INTRADAY_RETENTION_QUEUE,
  // v1.28.31 — one-shot hourly history rebuild for pre-hourly folded
  // dense-tier days. Boot-discovery driven and self-converging (a rebuilt
  // day's retired daily row drops it from the discovery pairing).
  DENSE_INTRADAY_HOURLY_REBUILD_QUEUE,
  // v1.4.37 W7c — explicit createQueue is required before the nightly
  // schedule below registers (pg-boss v12 contract). Without this entry the
  // drain schedule silently no-ops and the per-sample APPLE_HEALTH rows
  // never collapse.
  DRAIN_CUMULATIVE_QUEUE,
];

const schedules: ScheduleEntry[] = [
  // v1.4.37 W7c — nightly fold of per-sample APPLE_HEALTH cumulative
  // rows into one row per day per type. Slots between the
  // audit-log cleanup (03:15) and the feedback aggregator (04:00).
  [DRAIN_CUMULATIVE_QUEUE, DRAIN_CUMULATIVE_CRON, cronIsTheRetry],
];

/**
 * De-duplication policy per rollup queue. Until this table existed every queue
 * here ran under pg-boss's `standard` policy, under which no unique index
 * constrains `singleton_key` — so the `singletonKey` each enqueue site passes
 * was inert and de-duplicated nothing.
 *
 * The split below is deliberate and the two halves are NOT interchangeable.
 */
const queuePolicies: QueuePolicyTable = {
  // `short`, not `exclusive`. A recompute reads the bucket's live rows when it
  // STARTS, so collapsing sends that pile up while an identical job is still
  // queued is safe — the queued job will observe every write that landed in the
  // meantime. This is what kills the storm: a sync posting a few hundred batch
  // requests fanned out three jobs per type-day per request, thousands of jobs
  // re-deriving byte-identical rows. Under `short` they collapse to one queued
  // job per bucket. `exclusive` would be wrong here: it would also suppress a
  // send issued after the recompute had already started reading, stranding the
  // newer measurement in a stale bucket until the nightly pass.
  [ROLLUP_RECOMPUTE_QUEUE]: {
    policy: "short",
    reason:
      "Burst coalescing for the write-path fan-out. The handler re-reads the bucket at run time, so collapsing queued duplicates cannot strand a write; exclusive could.",
  },
  [MOOD_ROLLUP_RECOMPUTE_QUEUE]: {
    policy: "short",
    reason:
      "Same shape as the measurement recompute: re-reads the bucket at run time, so only queued duplicates may be collapsed.",
  },

  // The rest are per-user, self-converging boot/discovery backfills. A second
  // concurrent run is pure duplicated work, and the discovery predicate
  // re-enqueues on the next boot or cron tick while work remains outstanding —
  // so `exclusive` (queued OR active OR awaiting retry) can never lose work it
  // does not re-offer. `short` would be too weak: these passes run for minutes
  // to hours, and the observed failure was precisely a worker restarting
  // mid-pass and appending another identical full-history job per restart.
  [ROLLUP_FULL_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user full-history backfill; long-running. Boot discovery re-enqueues while coverage is still missing, so suppressing a duplicate of an ACTIVE pass is safe.",
  },
  [MOOD_ROLLUP_FULL_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user mood backfill; boot-discovery driven and self-converging on rollup coverage.",
  },
  [MEDICATION_COMPLIANCE_BACKFILL_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user compliance backfill; boot-discovery driven and self-converging on rollup coverage.",
  },
  [STEP_CONSOLIDATION_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user legacy step consolidation; discovery drops the user once no live granular rows remain.",
  },
  [STEP_CONSOLIDATION_REPAIR_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user one-shot repair; discovery drops the user once the affected provider rows are repaired.",
  },
  [CUMULATIVE_PR_REDERIVE_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user one-shot re-derivation; discovery drops the user once the inflated records are rewritten.",
  },
  [MEAN_CONSOLIDATION_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user daily-mean consolidation; discovery drops the user once the spot rows are folded.",
  },
  [DENSE_INTRADAY_RETENTION_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user dense-tier drain; the multi-hour pass on a heavy account is exactly the case where a restart used to append a duplicate full-history job.",
  },
  [DENSE_INTRADAY_HOURLY_REBUILD_QUEUE]: {
    policy: "exclusive",
    reason:
      "Per-user one-shot hourly rebuild; discovery drops the day once its retired daily row is gone.",
  },

  // DRAIN_CUMULATIVE_QUEUE is deliberately absent: it is a keyless nightly cron
  // tick with no singletonKey on any send, so a policy would only constrain the
  // empty key and buy nothing.
};

/**
 * Register every rollup / consolidation queue. Returns the queue names created
 * (for the boot-level aggregate assertion).
 */
export async function registerRollupQueues(
  boss: PgBoss,
): Promise<readonly string[]> {
  await createAndSchedule(boss, allQueues, schedules, queuePolicies);

  // v1.5.0 — persistent measurement rollup worker. Folds the
  // WEEK / MONTH / YEAR buckets that the write-path hooks enqueue;
  // the DAY bucket is already recomputed synchronously by the hook
  // itself. Concurrency-2 keeps two recomputes in flight without
  // crowding the dashboard request pool.
  await createAndWork<RollupRecomputePayload>(
    boss,
    ROLLUP_RECOMPUTE_QUEUE,
    { localConcurrency: ROLLUP_RECOMPUTE_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const payload = job.data;
        await recomputeUserRollups(payload.userId, {
          types: [payload.type],
          granularities: [payload.granularity],
          from: new Date(payload.from),
          to: new Date(payload.to),
        });
      }
      // No per-bucket isolation here on purpose: a recompute that throws
      // fails the job, so reaching this line means every bucket in the batch
      // was folded.
      return jobDone({ buckets_recomputed: jobs.length });
    },
  );

  // v1.4.35.1 — boot-time full-fold worker. The boot enqueue helper
  // below sends one job per uncovered user; this handler runs the
  // full `recomputeUserRollups` against the default 5-year window
  // across every granularity. Serial concurrency so the populator
  // never crowds the dashboard request pool.
  await createAndWork<RollupFullBackfillPayload>(
    boss,
    ROLLUP_FULL_BACKFILL_QUEUE,
    { localConcurrency: ROLLUP_FULL_BACKFILL_CONCURRENCY },
    async (jobs) => {
      let rowsUpsertedTotal = 0;
      for (const job of jobs) {
        const { userId } = job.data;
        const { rowsUpserted, durationMs } = await recomputeUserRollups(userId);
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
    },
  );

  // v1.5.6 — legacy step consolidation worker. The boot enqueue helper
  // below sends one job per user still holding live pre-v1.5.0 granular
  // step rows; this handler collapses them into one daily-total row per
  // calendar day and soft-deletes the originals. Serial concurrency so
  // the populator never crowds the dashboard request pool.
  await createAndWork<StepConsolidationPayload>(
    boss,
    STEP_CONSOLIDATION_QUEUE,
    { localConcurrency: STEP_CONSOLIDATION_CONCURRENCY },
    async (jobs) => {
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
    },
  );

  // v1.28.37 — step-consolidation repair worker. Resurrects the
  // GOOGLE_HEALTH / FITBIT daily-total step rows the pre-fix consolidation
  // swept and removes the shadow MANUAL totals it minted. Serial
  // concurrency so the repair never crowds the dashboard request pool.
  await createAndWork<StepConsolidationRepairPayload>(
    boss,
    STEP_CONSOLIDATION_REPAIR_QUEUE,
    { localConcurrency: STEP_CONSOLIDATION_REPAIR_CONCURRENCY },
    async (jobs) => {
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
        // The repair isolates its own per-day failures and reports them as a
        // count, so they ride out as a fact rather than failing the job.
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
    },
  );

  // v1.30.3 — cumulative-PersonalRecord rederivation worker (QA F4). The
  // boot enqueue helper below sends one job per user still holding a
  // suspect pre-fix inflated cumulative-type record; this handler deletes
  // it and re-runs detection silently so the honest re-derived best takes
  // its place. Serial concurrency so the repair never crowds the
  // dashboard request pool.
  await createAndWork<CumulativePrRederivePayload>(
    boss,
    CUMULATIVE_PR_REDERIVE_QUEUE,
    { localConcurrency: CUMULATIVE_PR_REDERIVE_CONCURRENCY },
    async (jobs) => {
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
    },
  );

  // v1.7.0 — daily-mean consolidation worker. The boot enqueue helper
  // below sends one job per user holding live per-sample high-frequency
  // mean-type rows; this handler collapses each completed day to its
  // mean and soft-deletes the originals. Serial concurrency so the
  // populator never crowds the dashboard request pool.
  await createAndWork<MeanConsolidationPayload>(
    boss,
    MEAN_CONSOLIDATION_QUEUE,
    { localConcurrency: MEAN_CONSOLIDATION_CONCURRENCY },
    async (jobs) => {
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
      // Out of budget is a completed run, not a failed one: the folded days
      // are committed, and the nightly tick carries on from the first day
      // this run did not reach.
      return jobDone({
        users: jobs.length,
        days_consolidated: daysTotal,
        per_sample_rows_soft_deleted: perSampleRowsTotal,
        stopped_early: stoppedEarly,
      });
    },
  );

  // v1.10.0 WX-E — dense intra-day retention per-user backfill worker. The
  // boot enqueue helper below sends one job per user holding live per-sample
  // dense-tier (HRV / HR / SpO2) rows older than the retention window; this
  // handler folds those out-of-window samples to hourly means (v1.28.31) and
  // soft-deletes the originals, keeping the in-window intra-day shape intact
  // for the Stress engine. Serial concurrency so the backfill never crowds
  // the request pool.
  await createAndWork<DenseIntradayRetentionPayload>(
    boss,
    DENSE_INTRADAY_RETENTION_QUEUE,
    { localConcurrency: DENSE_INTRADAY_RETENTION_CONCURRENCY },
    async (jobs) => {
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
        // Out of budget completes the job: the folded days are committed and
        // the nightly tick, which hands itself on while work remains,
        // continues from the first day this run did not reach.
        stopped_early: stoppedEarly,
      });
    },
  );

  // v1.28.31 — one-shot hourly history rebuild worker. The boot enqueue
  // helper below sends one job per user still holding a pre-hourly daily
  // `stats:` row paired with tombstoned raw rows; this handler reconstructs
  // hourly means from the tombstones and retires the daily row atomically.
  // Self-converging: a rebuilt day drops out of the discovery pairing, so
  // the pass runs once per install. Serial concurrency so the rebuild never
  // crowds the request pool.
  await createAndWork<DenseIntradayHourlyRebuildPayload>(
    boss,
    DENSE_INTRADAY_HOURLY_REBUILD_QUEUE,
    { localConcurrency: DENSE_INTRADAY_HOURLY_REBUILD_CONCURRENCY },
    async (jobs) => {
      let daysRebuiltTotal = 0;
      let hourlyRowsTotal = 0;
      let dailyRowsRetiredTotal = 0;
      let daysSkippedTotal = 0;
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          const {
            daysRebuilt,
            hourlyRowsUpserted,
            dailyRowsRetired,
            daysSkippedNoTombstones,
          } = await runDenseIntradayHourlyRebuildForUser(userId);
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
      return jobDone({
        users: jobs.length,
        days_rebuilt: daysRebuiltTotal,
        hourly_rows_upserted: hourlyRowsTotal,
        daily_rows_retired: dailyRowsRetiredTotal,
        days_skipped_no_tombstones: daysSkippedTotal,
      });
    },
  );

  // v1.4.39 W-MOOD — mood-rollup per-bucket worker. Folds the
  // WEEK / MONTH / YEAR buckets that the mood-entry write hooks
  // enqueue; the DAY bucket runs synchronously in the hook itself.
  // No current read path consumes these buckets — they exist so a
  // future cross-granularity reader can ship without a backfill
  // step. Concurrency-2 mirrors the measurement-rollup worker.
  await createAndWork<MoodRollupRecomputePayload>(
    boss,
    MOOD_ROLLUP_RECOMPUTE_QUEUE,
    { localConcurrency: MOOD_ROLLUP_RECOMPUTE_CONCURRENCY },
    async (jobs) => {
      for (const job of jobs) {
        const payload = job.data;
        await recomputeUserMoodRollups(payload.userId, {
          granularities: [payload.granularity],
          from: new Date(payload.from),
          to: new Date(payload.to),
        });
      }
      return jobDone({ buckets_recomputed: jobs.length });
    },
  );

  // v1.4.39 W-MOOD — mood-rollup boot-time fold worker. The boot
  // discovery helper below sends one job per user with mood entries
  // but zero rollup rows; this handler folds the full 5-year window
  // across every granularity. Concurrency-1 so the populator never
  // crowds the request pool.
  await createAndWork<MoodRollupFullBackfillPayload>(
    boss,
    MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
    { localConcurrency: MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY },
    async (jobs) => {
      let rowsUpsertedTotal = 0;
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          // v1.32.12 — delete-then-refold. Empties the user's rollup
          // rows before refolding so the boot backfill is self-cleaning
          // against any row minted under an older keying (e.g. a
          // rolling-deploy old-container write during the swap window).
          // The brief empty window serves correct data via the live
          // `entry.date` fallback.
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
    },
  );

  // v1.4.39 W-MED — medication-compliance boot-backfill worker. The
  // discovery helper below sends one job per user with intake events
  // but zero rollup coverage; this handler folds the trailing 90-day
  // window per account. Concurrency-1 so the populator never crowds
  // the request pool.
  await createAndWork<MedicationComplianceBackfillPayload>(
    boss,
    MEDICATION_COMPLIANCE_BACKFILL_QUEUE,
    { localConcurrency: MEDICATION_COMPLIANCE_BACKFILL_CONCURRENCY },
    async (jobs) => {
      let rowsUpsertedTotal = 0;
      for (const job of jobs) {
        const { userId } = job.data;
        try {
          const { rowsUpserted, durationMs } =
            await recomputeUserMedicationCompliance(userId);
          rowsUpsertedTotal += rowsUpserted;
          workerLog(
            "info",
            `[medication-compliance-backfill] user=${userId} rows=${rowsUpserted} duration=${durationMs}ms`,
          );
        } catch (err) {
          recordError();
          workerLog(
            "error",
            `[medication-compliance-backfill] user=${userId} failed`,
            err,
          );
          throw err;
        }
      }
      return jobDone({
        users: jobs.length,
        rows_upserted: rowsUpsertedTotal,
      });
    },
  );

  // v1.4.37 W7c — nightly drain worker. Walks every user × cumulative
  // type and folds per-sample APPLE_HEALTH rows older than the cutoff
  // into one `stats:…` row per calendar day. Idempotent — a second run
  // collapses zero buckets once every day is in the `stats:` shape.
  // Concurrency-1 so the drain never crowds the dashboard request pool
  // and a long backfill on the maintainer's account (300 k+ measurement rows)
  // stays a single sequential walk.
  await createAndWork<DrainCumulativePayload>(
    boss,
    DRAIN_CUMULATIVE_QUEUE,
    { localConcurrency: 1 },
    async (jobs) => {
      // One budget shared by all three passes, run in turn.
      const shouldStop = jobBudget(jobs);
      let stoppedEarly = false;
      // The three drains below are independent passes sharing one nightly
      // tick, so one failing pass must not stop the other two from running.
      // The first failure is held back and reported once the tick is over —
      // that keeps the existing order and still fails the job, which is what
      // the swallowed errors never did.
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

        // v1.8.5 — fold the daily-MEAN drain onto the same nightly tick as
        // the cumulative (SUM) drain. The mean drain was previously
        // boot-discovery only, so between worker reboots new high-frequency
        // spot samples (walking speed, respiratory rate, gait/mobility,
        // audio exposure) accumulated raw. Running both passes on one
        // concurrency-1 cron keeps the maintenance window a single
        // sequential walk and never crowds the request pool. The global
        // (no `userId`) signature drains every user; the 36-hour grace
        // cutoff keeps today's in-flight watch syncs raw. Boot discovery
        // stays as the back-fill for accounts that accumulated raw rows
        // before this cron shipped.
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

        // v1.10.0 WX-E — fold the dense intra-day retention drain onto the
        // same nightly tick. Unlike the daily-mean drain, this scopes to the
        // dense-tier types (HEART_RATE_VARIABILITY, PULSE) and keeps the last
        // DENSE_INTRADAY_RETENTION_DAYS of raw per-sample rows so the Stress
        // engine still sees the intra-day SDNN shape; only out-of-window
        // samples fold to a daily mean. These two types are NEVER in the
        // destructive HIGH_FREQUENCY_MEAN_TYPES allowlist — the drain
        // exemption the intra-day shape depends on. The global (no `userId`)
        // signature drains every user. Boot discovery (below) back-fills
        // accounts that accumulated out-of-window raw rows before this
        // shipped.
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
            denseRowsSoftDeleted +=
              denseSummary.totals.perSampleRowsSoftDeleted;
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

      // Hand the remaining work to a follow-up job when this one ran out of
      // budget (bounded; see `nextDrainContinuation`).
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
    },
  );

  return allQueues;
}

/**
 * Fire-and-forget boot discovery for the self-converging rollup / consolidation
 * backfills. Each pass is idempotent across reboots and never fails worker boot
 * on a miss (errors come back through the helper's result value).
 *
 * Each backfill is `localConcurrency: 1` on its own, but every one of them used
 * to drain from the first pg-boss poll at boot — on a heavy tenant that meant
 * several full-history loads contending for the connection pool at once (a boot
 * storm / crash-loop risk). Each type now gets an increasing
 * `BOOT_BACKFILL_STAGGER_SECONDS` multiple as a `startAfter` delay so their
 * loads spread across a window instead of all landing on the same poll. Dense
 * intra-day retention keeps its own larger boot defer (the established P2028
 * pool-exhaustion fix) and stays the furthest-out stage.
 */
export async function enqueueRollupBootDiscovery(): Promise<void> {
  // v1.4.35.1 — measurement-rollup backfill. Finds every user with
  // measurements but no rollup coverage and enqueues a full-fold per account.
  // The discovery query only matches accounts with zero rollup rows, so once
  // a fold completes the user drops off the list.
  try {
    // Stage 0 — first off the line; no stagger delay.
    const { enqueued, skipped, error } = await enqueueBootTimeRollupBackfill(
      BOOT_BACKFILL_STAGGER_SECONDS * 0,
    );
    if (error) {
      workerLog(
        "error",
        `[rollup-full-backfill] boot discovery failed: ${error}`,
      );
    } else {
      // v1.4.38.7 — log the discovery result on every boot, including
      // the silent `enqueued=0 skipped=0` case. Without this, an
      // operator chasing "analytics is slow" cannot tell whether the
      // discovery query ran successfully (and found nothing to fold)
      // vs. silently no-op'd. The line is one row per worker boot, so
      // the log cost is negligible.
      workerLog(
        "info",
        `[rollup-full-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[rollup-full-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.5.6 — legacy step consolidation. Finds every user still holding live
  // pre-v1.5.0 granular step rows and enqueues one consolidation job per
  // account. Consolidated legacy rows are soft-deleted, so the
  // `deleted_at IS NULL` discovery predicate drops them.
  try {
    // Stage 1.
    const { enqueued, skipped, error } = await enqueueBootTimeStepConsolidation(
      BOOT_BACKFILL_STAGGER_SECONDS * 1,
    );
    if (error) {
      workerLog(
        "error",
        `[step-consolidation] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[step-consolidation] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[step-consolidation] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.7.0 — daily-mean consolidation. Finds every user holding live
  // per-sample high-frequency mean-type rows and enqueues one job per account.
  // Consolidated rows are soft-deleted, so the discovery predicate drops them.
  try {
    // Stage 2.
    const { enqueued, skipped, error } = await enqueueBootTimeMeanConsolidation(
      BOOT_BACKFILL_STAGGER_SECONDS * 2,
    );
    if (error) {
      workerLog(
        "error",
        `[mean-consolidation] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[mean-consolidation] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[mean-consolidation] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.10.0 WX-E — dense intra-day retention drain. Finds every user holding
  // live per-sample dense-tier (HRV / HR) rows OLDER than the retention window
  // and enqueues one job per account. Folded rows are soft-deleted, so the
  // discovery predicate drops them.
  try {
    // Furthest-out stage — the helper self-defers past the boot window via its
    // own larger constant (the P2028 pool-exhaustion fix), so no stagger
    // argument is threaded here.
    const { enqueued, skipped, error } =
      await enqueueBootTimeDenseIntradayRetention();
    if (error) {
      workerLog(
        "error",
        `[dense-intraday-retention] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[dense-intraday-retention] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[dense-intraday-retention] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.28.31 — one-shot hourly history rebuild. Finds every user still
  // holding a pre-hourly daily dense-tier `stats:` row paired with tombstoned
  // raw rows and enqueues one rebuild job per account. Rebuilt days retire
  // their daily row, so the pairing predicate converges to zero across
  // boots — the retired row is the durable once-per-install marker.
  try {
    // Self-defers past both the boot window and the retention drain's own
    // 600 s stage via its larger constant; no stagger argument threaded.
    const { enqueued, skipped, error } =
      await enqueueBootTimeDenseIntradayHourlyRebuild();
    if (error) {
      workerLog(
        "error",
        `[dense-intraday-hourly-rebuild] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[dense-intraday-hourly-rebuild] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[dense-intraday-hourly-rebuild] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.4.39 W-MOOD — mood rollup tier. Mirrors the v1.4.35.1
  // measurement-rollup pattern: one job per user with mood entries but no
  // rollup coverage. Idempotent across reboots and singleton-keyed inside
  // pg-boss so a fast restart while a backfill is queued doesn't double up.
  try {
    // Stage 3.
    const { enqueued, skipped, error } =
      await enqueueBootTimeMoodRollupBackfill(
        BOOT_BACKFILL_STAGGER_SECONDS * 3,
      );
    if (error) {
      workerLog(
        "error",
        `[mood-rollup-full-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[mood-rollup-full-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[mood-rollup-full-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.4.39 W-MED — medication compliance rollup tier. Mirrors the v1.4.35.1
  // pattern: one job per user with intake events but no rollup coverage.
  // Idempotent across reboots and singleton-keyed inside pg-boss.
  try {
    // Stage 4.
    const { enqueued, skipped, error } =
      await enqueueBootTimeMedicationComplianceBackfill(
        BOOT_BACKFILL_STAGGER_SECONDS * 4,
      );
    if (error) {
      workerLog(
        "error",
        `[medication-compliance-backfill] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[medication-compliance-backfill] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[medication-compliance-backfill] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.28.37 — step-consolidation repair. Finds every account still holding
  // a resurrectable tombstoned GOOGLE_HEALTH / FITBIT daily-total step row
  // (swept by the pre-fix consolidation) and enqueues one repair job per
  // account. Self-converging: a resurrected row goes live and drops out of
  // the discovery predicate.
  try {
    // Stage 5.
    const { enqueued, skipped, error } =
      await enqueueBootTimeStepConsolidationRepair(
        BOOT_BACKFILL_STAGGER_SECONDS * 5,
      );
    if (error) {
      workerLog(
        "error",
        `[step-consolidation-repair] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[step-consolidation-repair] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[step-consolidation-repair] boot discovery threw an unexpected error",
      err,
    );
  }

  // v1.30.3 (QA F4) — cumulative-PersonalRecord rederivation. Finds every
  // account still holding a suspect measurement-driven cumulative-type
  // record created before the source-collapse fix landed and enqueues one
  // repair job per account. Self-converging: a deleted-and-redetected
  // record's `createdAt` sits after the fix cutoff, so the account drops
  // out of the discovery predicate for good.
  try {
    // Stage 6.
    const { enqueued, skipped, error } =
      await enqueueBootTimeCumulativePrRederivation(
        BOOT_BACKFILL_STAGGER_SECONDS * 6,
      );
    if (error) {
      workerLog(
        "error",
        `[cumulative-pr-rederive] boot discovery failed: ${error}`,
      );
    } else {
      workerLog(
        "info",
        `[cumulative-pr-rederive] boot discovery: enqueued=${enqueued} skipped=${skipped}`,
      );
    }
  } catch (err) {
    workerLog(
      "error",
      "[cumulative-pr-rederive] boot discovery threw an unexpected error",
      err,
    );
  }
}
