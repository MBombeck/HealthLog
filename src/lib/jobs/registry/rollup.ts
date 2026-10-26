/**
 * The pre-aggregation and consolidation queues: the measurement and mood
 * rollup folds with their boot backfills, the legacy step consolidation and
 * its repair, the cumulative-record re-derivation, the daily-mean
 * consolidation, the dense intra-day retention and hourly rebuild, the
 * supplement nutrient recompute, and the nightly drain.
 *
 * The two recompute queues and the supplement recompute are `short`: the
 * handler reads the bucket's live rows when it starts, so sends that pile up
 * while an identical job is still queued may collapse, while a send issued
 * after the job started reading must still queue the next one. The per-user
 * backfills are `exclusive`: a second run is duplicated work and discovery
 * re-offers whatever is outstanding. The drain is a keyless cron tick.
 *
 * Boot discovery is staggered: each backfill starts a multiple of
 * `BOOT_BACKFILL_STAGGER_SECONDS` later, so a heavy account's full-history
 * loads do not all land on the first poll. The dense passes defer themselves
 * further, past the boot window.
 */
import type { Job } from "pg-boss";

import {
  DENSE_INTRADAY_HOURLY_REBUILD_CONCURRENCY,
  DENSE_INTRADAY_HOURLY_REBUILD_QUEUE,
} from "@/lib/jobs/dense-intraday-hourly-rebuild-queue";
import {
  DENSE_INTRADAY_RETENTION_CONCURRENCY,
  DENSE_INTRADAY_RETENTION_QUEUE,
} from "@/lib/jobs/dense-intraday-retention-queue";
import {
  DRAIN_CUMULATIVE_CRON,
  DRAIN_CUMULATIVE_QUEUE,
} from "@/lib/jobs/drain-cumulative-queue";
import {
  MEAN_CONSOLIDATION_CONCURRENCY,
  MEAN_CONSOLIDATION_QUEUE,
} from "@/lib/jobs/mean-consolidation";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import { BOOT_BACKFILL_STAGGER_SECONDS } from "@/lib/jobs/reminder/shared";
import {
  STEP_CONSOLIDATION_CONCURRENCY,
  STEP_CONSOLIDATION_QUEUE,
} from "@/lib/jobs/step-consolidation";
import {
  STEP_CONSOLIDATION_REPAIR_CONCURRENCY,
  STEP_CONSOLIDATION_REPAIR_QUEUE,
} from "@/lib/jobs/step-consolidation-repair";
import {
  SUPPLEMENT_NUTRIENT_RECOMPUTE_CONCURRENCY,
  SUPPLEMENT_NUTRIENT_RECOMPUTE_QUEUE,
} from "@/lib/medications/ingredients/recompute-job";
import {
  CUMULATIVE_PR_REDERIVE_CONCURRENCY,
  CUMULATIVE_PR_REDERIVE_QUEUE,
} from "@/lib/personal-records/cumulative-pr-rederivation";
import {
  ROLLUP_FULL_BACKFILL_CONCURRENCY,
  ROLLUP_FULL_BACKFILL_QUEUE,
  ROLLUP_RECOMPUTE_CONCURRENCY,
  ROLLUP_RECOMPUTE_QUEUE,
  type RollupFullBackfillPayload,
} from "@/lib/rollups/measurement-rollups";
import {
  MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY,
  MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
  MOOD_ROLLUP_RECOMPUTE_CONCURRENCY,
  MOOD_ROLLUP_RECOMPUTE_QUEUE,
} from "@/lib/rollups/mood-rollups";

import {
  defineJob,
  type BootDiscovery,
  type JobDefinition,
  type JobGroup,
} from "./define-job";

/**
 * The boot backfill of the per-day medication-compliance rollup, whose table
 * had no reader left and was dropped. Its queue is removed where it exists.
 */
const RETIRED_ROLLUP_QUEUES = ["medication-compliance-full-backfill"] as const;

const handlers = () => import("@/lib/jobs/reminder/rollup-handlers");

const jobs: readonly JobDefinition[] = [
  defineJob({
    queue: ROLLUP_RECOMPUTE_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Burst coalescing for the write-path fan-out. The handler re-reads the bucket at run time, so collapsing queued duplicates cannot strand a write; exclusive could.",
    },
    work: { localConcurrency: ROLLUP_RECOMPUTE_CONCURRENCY },
    load: async () => (await handlers()).handleRollupRecompute,
  }),
  // The lock sits outside the lane: a retry pg-boss starts after the expiry
  // while the first fold still runs finds the account's lock and settles,
  // instead of waiting in the lane and folding the account again.
  defineJob({
    queue: ROLLUP_FULL_BACKFILL_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user full-history backfill; long-running. Boot discovery re-enqueues while coverage is still missing, so suppressing a duplicate of an ACTIVE pass is safe.",
    },
    work: { localConcurrency: ROLLUP_FULL_BACKFILL_CONCURRENCY },
    lock: (job: Job<RollupFullBackfillPayload>) => job.data.userId,
    lane: true,
    load: async () => (await handlers()).handleRollupFullBackfill,
  }),
  defineJob({
    queue: MOOD_ROLLUP_RECOMPUTE_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Same shape as the measurement recompute: re-reads the bucket at run time, so only queued duplicates may be collapsed.",
    },
    work: { localConcurrency: MOOD_ROLLUP_RECOMPUTE_CONCURRENCY },
    load: async () => (await handlers()).handleMoodRollupRecompute,
  }),
  defineJob({
    queue: MOOD_ROLLUP_FULL_BACKFILL_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user mood backfill; boot-discovery driven and self-converging on rollup coverage.",
    },
    work: { localConcurrency: MOOD_ROLLUP_FULL_BACKFILL_CONCURRENCY },
    load: async () => (await handlers()).handleMoodRollupFullBackfill,
  }),
  defineJob({
    queue: STEP_CONSOLIDATION_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user legacy step consolidation; discovery drops the user once no live granular rows remain.",
    },
    work: { localConcurrency: STEP_CONSOLIDATION_CONCURRENCY },
    load: async () => (await handlers()).handleStepConsolidation,
  }),
  defineJob({
    queue: STEP_CONSOLIDATION_REPAIR_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user one-shot repair; discovery drops the user once the affected provider rows are repaired.",
    },
    work: { localConcurrency: STEP_CONSOLIDATION_REPAIR_CONCURRENCY },
    load: async () => (await handlers()).handleStepConsolidationRepair,
  }),
  defineJob({
    queue: CUMULATIVE_PR_REDERIVE_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user one-shot re-derivation; discovery drops the user once the inflated records are rewritten.",
    },
    work: { localConcurrency: CUMULATIVE_PR_REDERIVE_CONCURRENCY },
    load: async () => (await handlers()).handleCumulativePrRederive,
  }),
  defineJob({
    queue: MEAN_CONSOLIDATION_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user daily-mean consolidation; discovery drops the user once the spot rows are folded.",
    },
    work: { localConcurrency: MEAN_CONSOLIDATION_CONCURRENCY },
    load: async () => (await handlers()).handleMeanConsolidation,
  }),
  defineJob({
    queue: DENSE_INTRADAY_RETENTION_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user dense-tier drain; the multi-hour pass on a heavy account is exactly the case where a restart used to append a duplicate full-history job.",
    },
    work: { localConcurrency: DENSE_INTRADAY_RETENTION_CONCURRENCY },
    load: async () => (await handlers()).handleDenseIntradayRetention,
  }),
  defineJob({
    queue: DENSE_INTRADAY_HOURLY_REBUILD_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-user one-shot hourly rebuild; discovery drops the day once its retired daily row is gone.",
    },
    work: { localConcurrency: DENSE_INTRADAY_HOURLY_REBUILD_CONCURRENCY },
    load: async () => (await handlers()).handleDenseIntradayHourlyRebuild,
  }),
  // One sequential walk, so it never crowds the dashboard request pool.
  defineJob({
    queue: DRAIN_CUMULATIVE_QUEUE,
    cron: DRAIN_CUMULATIVE_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async ({ boss }) => (await handlers()).drainCumulativeHandler(boss),
  }),
  defineJob({
    queue: SUPPLEMENT_NUTRIENT_RECOMPUTE_QUEUE,
    policy: {
      policy: "short",
      reason:
        "Per-account recompute of supplement nutrient rows; the pass reads the live doses and composition when it starts, so a queued duplicate may be collapsed, while a send during a running pass must still queue the next one.",
    },
    work: { localConcurrency: SUPPLEMENT_NUTRIENT_RECOMPUTE_CONCURRENCY },
    load: async () => (await handlers()).handleSupplementNutrientRecompute,
  }),
];

const discovery: readonly BootDiscovery[] = [
  {
    name: "rollup-full-backfill",
    run: async () =>
      (
        await import("@/lib/rollups/measurement-rollups")
      ).enqueueBootTimeRollupBackfill(BOOT_BACKFILL_STAGGER_SECONDS * 0),
  },
  {
    name: "step-consolidation",
    run: async () =>
      (
        await import("@/lib/jobs/step-consolidation")
      ).enqueueBootTimeStepConsolidation(BOOT_BACKFILL_STAGGER_SECONDS * 1),
  },
  {
    name: "mean-consolidation",
    run: async () =>
      (
        await import("@/lib/jobs/mean-consolidation")
      ).enqueueBootTimeMeanConsolidation(BOOT_BACKFILL_STAGGER_SECONDS * 2),
  },
  // Defers itself past the boot window (the pool-exhaustion fix).
  {
    name: "dense-intraday-retention",
    run: async () =>
      (
        await import("@/lib/jobs/dense-intraday-retention")
      ).enqueueBootTimeDenseIntradayRetention(),
  },
  // Defers past the boot window and the retention drain's own stage.
  {
    name: "dense-intraday-hourly-rebuild",
    run: async () =>
      (
        await import("@/lib/jobs/dense-intraday-hourly-rebuild")
      ).enqueueBootTimeDenseIntradayHourlyRebuild(),
  },
  {
    name: "mood-rollup-full-backfill",
    run: async () =>
      (
        await import("@/lib/rollups/mood-rollups")
      ).enqueueBootTimeMoodRollupBackfill(BOOT_BACKFILL_STAGGER_SECONDS * 3),
  },
  {
    name: "step-consolidation-repair",
    run: async () =>
      (
        await import("@/lib/jobs/step-consolidation-repair")
      ).enqueueBootTimeStepConsolidationRepair(
        BOOT_BACKFILL_STAGGER_SECONDS * 5,
      ),
  },
  {
    name: "cumulative-pr-rederive",
    run: async () =>
      (
        await import("@/lib/personal-records/cumulative-pr-rederivation")
      ).enqueueBootTimeCumulativePrRederivation(
        BOOT_BACKFILL_STAGGER_SECONDS * 6,
      ),
  },
];

export const ROLLUP_GROUP: JobGroup = {
  name: "rollup",
  jobs,
  retired: RETIRED_ROLLUP_QUEUES,
  discovery,
};
