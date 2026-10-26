/**
 * Handlers of the maintenance queues that are not a module's own export: the
 * Apple Health and medication-intake imports, the duplicate dose-slot dedup,
 * and the boss-bound environment and Dawarich passes. The registry binds them
 * (`registry/maintenance.ts`) and loads this module on the first job.
 */
import type { Job, JobWithMetadata, PgBoss } from "pg-boss";

import {
  handleAppleHealthImport,
  migrateLegacyAppleHealthImport,
  type AppleHealthImportPayload,
} from "@/lib/jobs/apple-health-import-worker";
import {
  handleDawarichSync,
  type DawarichSyncPayload,
} from "@/lib/jobs/dawarich-sync";
import {
  handleEnvironmentAqHistory,
  type EnvironmentAqHistoryPayload,
} from "@/lib/jobs/environment-air-quality-history";
import {
  handleEnvironmentFetch,
  type EnvironmentFetchPayload,
} from "@/lib/jobs/environment-fetch";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import {
  handleMedicationIntakeImport,
  type MedicationIntakeImportQueuePayload,
} from "@/lib/jobs/medication-intake-import";
import { recordError } from "@/lib/jobs/worker-status";
import {
  dedupeUserIntakeSlots,
  enqueueBootTimeIntakeSlotDedup,
  type IntakeSlotDedupPayload,
} from "@/lib/medications/intake-slot-dedup";

import { workerLog } from "./shared";

/**
 * The Apple Health export ingest. Each import is independent work, so a
 * failed one does not abort the rest of the batch; the first failure is what
 * the job reports.
 */
export async function handleAppleHealthImportJobs(
  jobs: Job<AppleHealthImportPayload>[],
): Promise<JobOutcome> {
  let failure: JobOutcome | null = null;
  for (const job of jobs) {
    const outcome = await handleAppleHealthImport(job);
    if (!outcome.ok && failure === null) failure = outcome;
  }
  return failure ?? jobDone({ jobs: jobs.length });
}

/**
 * Drains the pre-revision-2 backlog by moving each claimed legacy job onto
 * the current queue, keeping the import's status row, so the current parser
 * never runs under a revision-1 mirror.
 */
export async function handleLegacyAppleHealthImportJobs(
  jobs: Job<AppleHealthImportPayload>[],
): Promise<JobOutcome> {
  for (const job of jobs) {
    await migrateLegacyAppleHealthImport(job);
  }
  return jobDone({ jobs: jobs.length });
}

/**
 * Independent per-delivery medication-intake imports: run them all and report
 * the first failure rather than losing it behind a later success. Bound with
 * metadata, so a retry resumes from the job's creation time.
 */
export async function handleMedicationIntakeImportJobs(
  jobs: JobWithMetadata<MedicationIntakeImportQueuePayload>[],
): Promise<JobOutcome> {
  let failure: JobOutcome | null = null;
  for (const job of jobs) {
    const outcome = await handleMedicationIntakeImport(job);
    if (!outcome.ok && failure === null) failure = outcome;
  }
  return failure ?? jobDone({ jobs: jobs.length });
}

/**
 * The duplicate dose-slot cleanup. A job with a `userId` keeps one account's
 * winner per slot, soft-deletes the losers and recomputes the affected
 * compliance days; the daily tick (no `userId`) runs the same discovery
 * fan-out as the boot pass, so slots duplicated between deploys collapse
 * within a day.
 */
export async function handleIntakeSlotDedup(
  jobs: Job<Partial<IntakeSlotDedupPayload>>[],
): Promise<JobOutcome> {
  let users = 0;
  let discoveryEnqueued = 0;
  let discoverySkipped = 0;
  // The discovery helper returns its error instead of throwing, so a failed
  // fan-out would otherwise leave no trace on the job at all.
  let discoveryFailed = 0;
  let slotsCollapsed = 0;
  let rowsSoftDeleted = 0;
  let rowsNormalised = 0;
  let daysRecomputed = 0;
  for (const job of jobs) {
    const { userId } = job.data;
    if (!userId) {
      const result = await enqueueBootTimeIntakeSlotDedup();
      discoveryEnqueued += result.enqueued;
      discoverySkipped += result.skipped;
      if (result.error) discoveryFailed++;
      workerLog(
        "info",
        `[intake-slot-dedup] daily discovery enqueued=${result.enqueued} skipped=${result.skipped}${result.error ? ` error=${result.error}` : ""}`,
      );
      continue;
    }
    try {
      const summary = await dedupeUserIntakeSlots(userId);
      users++;
      slotsCollapsed += summary.slotsCollapsed;
      rowsSoftDeleted += summary.rowsSoftDeleted;
      rowsNormalised += summary.rowsNormalised;
      daysRecomputed += summary.daysRecomputed;
      workerLog(
        "info",
        `[intake-slot-dedup] user=${userId} slotsCollapsed=${summary.slotsCollapsed} rowsSoftDeleted=${summary.rowsSoftDeleted} rowsNormalised=${summary.rowsNormalised} daysRecomputed=${summary.daysRecomputed}`,
      );
    } catch (err) {
      recordError();
      workerLog("error", `[intake-slot-dedup] user=${userId} failed`, err);
      throw err;
    }
  }
  return jobDone({
    jobs: jobs.length,
    users,
    discovery_enqueued: discoveryEnqueued,
    discovery_skipped: discoverySkipped,
    discovery_failed: discoveryFailed,
    slots_collapsed: slotsCollapsed,
    rows_soft_deleted: rowsSoftDeleted,
    rows_normalised: rowsNormalised,
    days_recomputed: daysRecomputed,
  });
}

/** The air-quality history backfill; the first failure is what the job reports. */
export function environmentAqHistoryHandler(
  boss: PgBoss,
): (jobs: Job<EnvironmentAqHistoryPayload>[]) => Promise<JobOutcome> {
  return async (jobs) => {
    let failure: JobOutcome | null = null;
    for (const job of jobs) {
      const outcome = await handleEnvironmentAqHistory(boss, job.data);
      if (!outcome.ok && failure === null) failure = outcome;
    }
    return failure ?? jobDone({ jobs: jobs.length });
  };
}

/**
 * The environment fetch. A discovery tick and a per-user backfill share the
 * queue and are independent, so the pass runs to the end and reports the
 * first failure it saw.
 */
export function environmentFetchHandler(
  boss: PgBoss,
): (jobs: Job<EnvironmentFetchPayload>[]) => Promise<JobOutcome> {
  return async (jobs) => {
    let failure: JobOutcome | null = null;
    for (const job of jobs) {
      const outcome = await handleEnvironmentFetch(boss, job.data);
      if (!outcome.ok && failure === null) failure = outcome;
    }
    return failure ?? jobDone({ jobs: jobs.length });
  };
}

/** The Dawarich movement context, one account at a time. */
export function dawarichSyncHandler(
  boss: PgBoss,
): (jobs: Job<DawarichSyncPayload>[]) => Promise<JobOutcome> {
  return (jobs) => handleDawarichSync(boss, jobs);
}
