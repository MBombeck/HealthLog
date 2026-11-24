/**
 * The demo deploy's own queue, kept beside `maintenance.ts`. It is declared
 * only when `DEMO_MODE=true`: the refresh wipes the database it runs against,
 * so on any other deploy the queue, its cron and its handler do not exist.
 */
import {
  DEMO_REFRESH_CRON,
  DEMO_REFRESH_QUEUE,
  demoRefreshEnabled,
} from "@/lib/jobs/demo-refresh-queue";

import { defineJob, type JobDefinition } from "./define-job";

export function maintenanceDemoJobs(): readonly JobDefinition[] {
  if (!demoRefreshEnabled()) return [];
  return [
    // The daily rewrite of the demo from the seed, after the morning doses.
    defineJob({
      queue: DEMO_REFRESH_QUEUE,
      cron: DEMO_REFRESH_CRON,
      scheduleOptions: { retryLimit: 2 },
      policy: {
        policy: "short",
        reason:
          "Fixed singleton key; collapse queued duplicates only, so a boot during a run can queue the next one.",
      },
      work: { localConcurrency: 1 },
      load: async () =>
        (await import("@/lib/jobs/demo-refresh")).handleDemoRefresh,
    }),
  ];
}
