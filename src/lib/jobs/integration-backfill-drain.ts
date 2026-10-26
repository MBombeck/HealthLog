/**
 * The handler of the shared full-history admission queue.
 *
 * Every provider's backfill and repair reaches this one queue, and the worker
 * runs it one job at a time across the whole instance
 * (`register-integration-sync.ts`). Each job runs under two guards:
 *
 *   - The import lock (`withIntegrationBackfillLock`), keyed on the job's
 *     identity. A retry that pg-boss starts after the job's expiry while the
 *     first run is still going finds the lock taken and does nothing, so one
 *     account's import of one kind never runs twice at once.
 *   - The job's budget (`jobBudget`), handed to the runners that can stop
 *     part-way. A run that stops on its budget throws without stamping its
 *     completion marker, so it is retried, and after that the next boot's
 *     discovery offers it again.
 */
import type { Job } from "pg-boss";

import { runWhoopBackfillForUser } from "@/lib/jobs/whoop-backfill";
import { runFitbitBackfillForUser } from "@/lib/fitbit/jobs/backfill";
import { runGoogleHealthBackfillForUser } from "@/lib/jobs/google-health-backfill";
import { runGoogleHealthSleepRepairForUser } from "@/lib/jobs/google-health-sleep-repair";
import { runFitbitSleepRepairForUser } from "@/lib/fitbit/jobs/sleep-repair";
import { runStravaBackfillForUser } from "@/lib/jobs/strava-backfill";
import { runOuraBackfillForUser } from "@/lib/jobs/oura-backfill";
import { runSleepTimelineBackfillForUser } from "@/lib/jobs/sleep-timeline-backfill";
import { runLabBiomarkerBackfillForUser } from "@/lib/jobs/lab-biomarker-backfill";
import {
  integrationBackfillIdentity,
  type IntegrationBackfillAdmissionPayload,
} from "@/lib/jobs/integration-backfill-admission";
import { withIntegrationBackfillLock } from "@/lib/jobs/integration-backfill-lock";
import { jobBudget } from "@/lib/jobs/job-budget";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { workerLog } from "@/lib/jobs/reminder/shared";
import { withBackgroundEvent } from "@/lib/logging/background";

interface RunCounts {
  imported: number;
  /** Imports that ended a slice with progress and sent the next one. */
  continued: number;
  removed: number;
  deleted: number;
  markers: number;
  linked: number;
}

async function runAdmitted(
  payload: IntegrationBackfillAdmissionPayload,
  shouldStop: () => boolean,
  totals: RunCounts,
): Promise<void> {
  const { kind, data } = payload;
  const { userId } = data;
  switch (kind) {
    case "whoop-backfill": {
      const { imported } = await runWhoopBackfillForUser(userId);
      totals.imported += imported;
      workerLog("info", `[whoop-backfill] user=${userId} imported=${imported}`);
      return;
    }
    case "fitbit-backfill": {
      const { imported } = await runFitbitBackfillForUser(userId);
      totals.imported += imported;
      workerLog(
        "info",
        `[fitbit-backfill] user=${userId} imported=${imported}`,
      );
      return;
    }
    case "google-health-backfill": {
      const { imported, continued } = await runGoogleHealthBackfillForUser(
        userId,
        shouldStop,
        data.slice ?? 0,
      );
      totals.imported += imported;
      if (continued) totals.continued += 1;
      workerLog(
        "info",
        `[google-health-backfill] user=${userId} imported=${imported}${continued ? " continued" : ""}`,
      );
      return;
    }
    case "google-health-sleep-repair": {
      const { imported } = await runGoogleHealthSleepRepairForUser(userId);
      totals.imported += imported;
      workerLog(
        "info",
        `[google-health-sleep-repair] user=${userId} imported=${imported}`,
      );
      return;
    }
    case "fitbit-sleep-repair": {
      const { imported, removed } = await runFitbitSleepRepairForUser(userId);
      totals.imported += imported;
      totals.removed += removed;
      workerLog(
        "info",
        `[fitbit-sleep-repair] user=${userId} imported=${imported} removed=${removed}`,
      );
      return;
    }
    case "sleep-timeline-backfill": {
      if (!data.provider) {
        throw new Error(
          "sleep-timeline backfill admission requires a provider",
        );
      }
      const { deleted, imported } = await runSleepTimelineBackfillForUser(
        userId,
        data.provider,
      );
      totals.deleted += deleted;
      totals.imported += imported;
      workerLog(
        "info",
        `[sleep-timeline-backfill] user=${userId} provider=${data.provider} deleted=${deleted} imported=${imported}`,
      );
      return;
    }
    case "lab-biomarker-backfill": {
      const { markers, linked } = await runLabBiomarkerBackfillForUser(
        userId,
        shouldStop,
      );
      totals.markers += markers;
      totals.linked += linked;
      workerLog(
        "info",
        `[lab-biomarker-backfill] user=${userId} markers=${markers} linked=${linked}`,
      );
      return;
    }
    case "strava-backfill": {
      const { imported, continued } = await runStravaBackfillForUser(
        userId,
        data.slice ?? 0,
      );
      totals.imported += imported;
      if (continued) totals.continued += 1;
      workerLog(
        "info",
        `[strava-backfill] user=${userId} imported=${imported}${continued ? " continued" : ""}`,
      );
      return;
    }
    case "oura-backfill": {
      const { imported, continued } = await runOuraBackfillForUser(
        userId,
        shouldStop,
        data.slice ?? 0,
      );
      totals.imported += imported;
      if (continued) totals.continued += 1;
      workerLog(
        "info",
        `[oura-backfill] user=${userId} imported=${imported}${continued ? " continued" : ""}`,
      );
      return;
    }
  }
}

/** The task name of the event each admitted run writes. */
export const INTEGRATION_BACKFILL_RUN_TASK = "job.integration_backfill";

/**
 * Run one admitted job inside its own background event.
 *
 * The runners write what they do through the ambient event: every request a
 * provider walk makes (`addExternalCall`, with its status, duration and the
 * page it asked for), every warning, every `annotate`. Without an event in
 * scope each of those is a no-op, so a full-history import that failed left
 * nothing behind but the job's own error message: not the collection it was
 * on, not the status the provider answered, not how far it got (#1220). The
 * hourly syncs always ran inside one; the imports did not. Every kind gets
 * one here, emitted when the run settles, thrown error included.
 */
async function runObserved(
  job: Job<IntegrationBackfillAdmissionPayload>,
  identity: string,
  shouldStop: () => boolean,
  totals: RunCounts,
): Promise<void> {
  await withBackgroundEvent(INTEGRATION_BACKFILL_RUN_TASK, async (event) => {
    event.addMeta("kind", job.data.kind);
    event.addMeta("identity", identity);
    event.addMeta("job_id", job.id);
    event.addMeta("slice", job.data.data.slice ?? 0);
    const before = { ...totals };
    await runAdmitted(job.data, shouldStop, totals);
    event.setBackground({
      task_name: INTEGRATION_BACKFILL_RUN_TASK,
      result: {
        kind: job.data.kind,
        imported: totals.imported - before.imported,
        continued: totals.continued - before.continued,
        removed: totals.removed - before.removed,
        deleted: totals.deleted - before.deleted,
        markers: totals.markers - before.markers,
        linked: totals.linked - before.linked,
      },
    });
  });
}

/**
 * Drain a batch of admission jobs. There is no per-job error isolation: a
 * runner that throws fails the job and the admission retry policy applies. So
 * reaching the end means every admitted job either did its work or found its
 * import already running, and the counts each runner returns are what the
 * pass reports.
 */
export async function drainIntegrationBackfillAdmission(
  jobs: Job<IntegrationBackfillAdmissionPayload>[],
): Promise<JobOutcome> {
  const shouldStop = jobBudget(jobs);
  const totals: RunCounts = {
    imported: 0,
    continued: 0,
    removed: 0,
    deleted: 0,
    markers: 0,
    linked: 0,
  };
  let alreadyRunning = 0;
  for (const job of jobs) {
    const identity = integrationBackfillIdentity(job.data);
    const run = await withIntegrationBackfillLock(identity, () =>
      runObserved(job, identity, shouldStop, totals),
    );
    if (!run.ran) {
      alreadyRunning += 1;
      await withBackgroundEvent(
        "integration_backfill.already_running",
        async (event) => {
          event.addMeta("identity", identity);
          event.addMeta("job_id", job.id);
          event.addMeta(
            "reason",
            "an earlier delivery of this import still holds its lock; this delivery does nothing",
          );
          event.elevateLevel("warn");
        },
      );
    }
  }
  return jobDone({
    jobs: jobs.length,
    already_running: alreadyRunning,
    imported: totals.imported,
    continued: totals.continued,
    removed: totals.removed,
    deleted: totals.deleted,
    markers: totals.markers,
    linked: totals.linked,
  });
}
