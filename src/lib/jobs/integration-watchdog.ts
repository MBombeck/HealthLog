/**
 * Queues, schedules and handler for the integration watchdog
 * (`src/lib/integrations/watchdog.ts`).
 *
 * Two queues rather than one queue with two payloads, so each schedule shows
 * up under its own name in the job ledger. Both passes take the same advisory
 * lock: the daily pass is a superset of the hourly one, and two passes side by
 * side could each open the same incident and page twice.
 */
import type { Job } from "pg-boss";
import { withJobLock } from "@/lib/jobs/job-lock";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";
import {
  runIntegrationWatchdog,
  type WatchdogMode,
} from "@/lib/integrations/watchdog";

const LOCK_KEY = "job:integration-watchdog:pass";

export interface IntegrationWatchdogPayload {
  triggeredAt?: string;
}

function handlerFor(mode: WatchdogMode) {
  return async (
    jobs: Job<IntegrationWatchdogPayload>[],
  ): Promise<JobOutcome> => {
    void jobs;
    return withBackgroundEvent(
      `job.integration_watchdog.${mode}`,
      async (evt) => {
        try {
          const run = await withJobLock(LOCK_KEY, () =>
            runIntegrationWatchdog({ mode }),
          );
          if (!run.ran) return jobDone({ already_running: 1 });
          const s = run.result;
          evt.addMeta("integration_watchdog", s);
          return jobDone({
            users_scanned: s.usersScanned,
            users_failed: s.usersFailed,
            considered: s.connectionsConsidered,
            silences_flagged: s.silencesFlagged,
            incidents_opened: s.incidentsOpened,
            incidents_closed: s.incidentsClosed,
            notified: s.notified,
            first_run: s.firstRun ? 1 : 0,
          });
        } catch (err) {
          evt.addWarning(`integration watchdog failed: ${err}`);
          return jobFailed("integration watchdog pass failed", err);
        }
      },
    );
  };
}

export const handleIntegrationWatchdogHourly = handlerFor("hourly");
export const handleIntegrationWatchdogDaily = handlerFor("daily");
