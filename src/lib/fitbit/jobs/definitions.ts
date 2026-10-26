/**
 * Every queue the Fitbit integration runs, as one block of the worker
 * registry.
 *
 * Google turns the classic Fitbit Web API off on 2026-10-30
 * (`lib/fitbit/retirement.ts`). Until the integration is removed it keeps
 * syncing; removing it then is this folder plus the one line in
 * `jobs/registry/integration-sync.ts` that spreads these definitions in.
 */
import { bootStaggerSecondsFor } from "@/lib/jobs/integration-backfill-admission";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  defineJob,
  type BootDiscovery,
  type JobDefinition,
} from "@/lib/jobs/registry/define-job";

import {
  FITBIT_BACKFILL_CONCURRENCY,
  FITBIT_BACKFILL_QUEUE,
  FITBIT_OAUTH_STATE_CLEANUP_CRON,
  FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
  FITBIT_SLEEP_REPAIR_CONCURRENCY,
  FITBIT_SLEEP_REPAIR_QUEUE,
  FITBIT_SYNC_CRON,
  FITBIT_SYNC_QUEUE,
} from "./queues";

export const FITBIT_JOBS: readonly JobDefinition[] = [
  // The cron walks every connection; serial so a backfill-heavy tick never
  // crowds the request pool.
  defineJob({
    queue: FITBIT_SYNC_QUEUE,
    cron: FITBIT_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await import("./sync-handlers")).handleFitbitSync,
  }),
  // The source queue keeps the per-connection singleton and forwards
  // admitted work to the shared drain.
  defineJob({
    queue: FITBIT_BACKFILL_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-connection full-history backfill; boot-discovery driven and self-converging.",
    },
    work: { localConcurrency: FITBIT_BACKFILL_CONCURRENCY },
    load: async ({ boss }) =>
      (
        await import("@/lib/jobs/integration-backfill-forward")
      ).forwardToBackfillAdmission(boss, "fitbit-backfill"),
  }),
  // One-shot sleep duplicate repair: a bounded sleep re-read per connection,
  // forwarded to the shared drain.
  defineJob({
    queue: FITBIT_SLEEP_REPAIR_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Per-connection one-shot sleep re-read; discovery drops the connection once it is marked repaired.",
    },
    work: { localConcurrency: FITBIT_SLEEP_REPAIR_CONCURRENCY },
    load: async ({ boss }) =>
      (
        await import("@/lib/jobs/integration-backfill-forward")
      ).forwardToBackfillAdmission(boss, "fitbit-sleep-repair"),
  }),
  defineJob({
    queue: FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
    cron: FITBIT_OAUTH_STATE_CLEANUP_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("./sync-handlers")).handleFitbitOAuthStateCleanup,
  }),
];

/** The Fitbit backfill and sleep repair, offered again at every boot. */
export const FITBIT_BOOT_DISCOVERY: readonly BootDiscovery[] = [
  {
    name: "fitbit-backfill",
    run: async () =>
      (await import("./backfill")).enqueueBootTimeFitbitBackfill(
        bootStaggerSecondsFor("fitbit-backfill"),
      ),
  },
  {
    name: "fitbit-sleep-repair",
    run: async () =>
      (await import("./sleep-repair")).enqueueBootTimeFitbitSleepRepair(
        bootStaggerSecondsFor("fitbit-sleep-repair"),
      ),
  },
];
