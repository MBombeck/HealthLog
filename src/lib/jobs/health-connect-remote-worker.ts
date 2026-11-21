/**
 * The scheduled Health Connect fetch: every pass reads the due WebDAV or
 * Nextcloud folders (`src/lib/import/health-connect/remote-fetch.ts`) and
 * hands a new export to the Health Connect import queue. A "fetch now" from
 * the settings card marks the source due and sends one job to the same queue.
 *
 * The run reports counts of closed outcomes only.
 */
import type { Job } from "pg-boss";

import { fetchDueRemoteSources } from "@/lib/import/health-connect/remote-fetch";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { withBackgroundEvent } from "@/lib/logging/background";

export async function handleHealthConnectRemoteFetch(
  jobs: Job<Record<string, never>>[],
): Promise<JobOutcome> {
  return withBackgroundEvent(
    "job.health_connect_remote_fetch",
    async (event) => {
      try {
        const counts = await fetchDueRemoteSources();
        for (const [outcome, count] of Object.entries(counts)) {
          event.addMeta(`outcome_${outcome}`, count);
        }
        return jobDone({
          jobs: jobs.length,
          imported: counts.imported ?? 0,
          unchanged: counts.unchanged ?? 0,
        });
      } catch (err) {
        return jobFailed("health connect remote fetch failed", err);
      }
    },
  );
}
