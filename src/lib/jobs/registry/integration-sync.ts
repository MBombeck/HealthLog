/**
 * The third-party provider sync queues: Withings, WHOOP, Fitbit, Google
 * Health, Nightscout, Polar, Oura, Strava, the full-history backfills and
 * repairs that run through the shared admission lane, the integration
 * watchdog, and the OAuth-state and handoff prunes.
 *
 * The recurring polls are keyless cron ticks, so they carry no policy. The
 * one-shot backfills and repairs share one shape: one job per connection,
 * keyed per user, enqueued by a boot discovery that only stops offering the
 * job once it has completed. `exclusive` covers queued, active and
 * retry-backoff, so a worker restarting during a long pass cannot append a
 * second identical job, and since discovery re-offers outstanding work a
 * suppressed send never loses any.
 *
 * The prunes carry `cronIsTheRetry`: a DELETE that could not run will not run
 * better a second later, and the daily tick is the retry. The sync crons keep
 * the default retries; a provider outage is transient.
 */
import {
  FITBIT_BOOT_DISCOVERY,
  FITBIT_JOBS,
} from "@/lib/fitbit/jobs/definitions";
import {
  INTEGRATION_BACKFILL_ADMISSION_QUEUE,
  INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
  bootStaggerSecondsFor,
  type IntegrationBackfillKind,
} from "@/lib/jobs/integration-backfill-admission";
import {
  GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_CRON,
  GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE,
  GOOGLE_HEALTH_SYNC_CRON,
  GOOGLE_HEALTH_SYNC_QUEUE,
  NIGHTSCOUT_SYNC_CRON,
  NIGHTSCOUT_SYNC_QUEUE,
  OIDC_NATIVE_HANDOFF_CLEANUP_CRON,
  OIDC_NATIVE_HANDOFF_CLEANUP_QUEUE,
  OURA_SYNC_CRON,
  OURA_SYNC_QUEUE,
  POLAR_SYNC_CRON,
  POLAR_SYNC_QUEUE,
  STRAVA_SYNC_CRON,
  STRAVA_SYNC_QUEUE,
  WHOOP_CYCLE_SYNC_CRON,
  WHOOP_CYCLE_SYNC_QUEUE,
  WHOOP_OAUTH_STATE_CLEANUP_CRON,
  WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
  WHOOP_RECOVERY_SYNC_CRON,
  WHOOP_RECOVERY_SYNC_QUEUE,
  WHOOP_SLEEP_SYNC_CRON,
  WHOOP_SLEEP_SYNC_QUEUE,
  WHOOP_WORKOUT_SYNC_CRON,
  WHOOP_WORKOUT_SYNC_QUEUE,
  WITHINGS_ACTIVITY_CRON,
  WITHINGS_ACTIVITY_QUEUE,
  WITHINGS_ECG_SYNC_CRON,
  WITHINGS_OAUTH_STATE_CLEANUP_CRON,
  WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
  WITHINGS_SLEEP_CRON,
  WITHINGS_SLEEP_QUEUE,
  WITHINGS_SYNC_CRON,
  WITHINGS_SYNC_QUEUE,
} from "@/lib/jobs/integration-poll-queues";
import {
  INTEGRATION_WATCHDOG_DAILY_CRON,
  INTEGRATION_WATCHDOG_DAILY_QUEUE,
  INTEGRATION_WATCHDOG_HOURLY_CRON,
  INTEGRATION_WATCHDOG_HOURLY_QUEUE,
} from "@/lib/jobs/integration-watchdog-queue";
import {
  GOOGLE_HEALTH_BACKFILL_CONCURRENCY,
  GOOGLE_HEALTH_BACKFILL_QUEUE,
} from "@/lib/jobs/google-health-backfill-queue";
import {
  GOOGLE_HEALTH_SLEEP_REPAIR_CONCURRENCY,
  GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE,
} from "@/lib/jobs/google-health-sleep-repair-queue";
import {
  LAB_BIOMARKER_BACKFILL_CONCURRENCY,
  LAB_BIOMARKER_BACKFILL_QUEUE,
} from "@/lib/jobs/lab-biomarker-backfill";
import {
  OURA_BACKFILL_CONCURRENCY,
  OURA_BACKFILL_QUEUE,
} from "@/lib/jobs/oura-backfill-queue";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  SLEEP_TIMELINE_BACKFILL_CONCURRENCY,
  SLEEP_TIMELINE_BACKFILL_QUEUE,
} from "@/lib/jobs/sleep-timeline-backfill-queue";
import {
  STRAVA_BACKFILL_CONCURRENCY,
  STRAVA_BACKFILL_QUEUE,
} from "@/lib/jobs/strava-backfill-queue";
import {
  WHOOP_BACKFILL_CONCURRENCY,
  WHOOP_BACKFILL_QUEUE,
} from "@/lib/jobs/whoop-backfill-queue";
import { WITHINGS_ECG_SYNC_QUEUE } from "@/lib/jobs/withings-ecg-queue";

import {
  defineJob,
  type BootDiscovery,
  type DiscoveryResult,
  type JobDefinition,
  type JobGroup,
} from "./define-job";

const SELF_CONVERGING_BACKFILL =
  "Per-connection full-history backfill; boot-discovery driven and self-converging.";

/** A source queue that forwards each job to the shared admission lane. */
function backfillSource(
  queue: string,
  concurrency: number,
  kind: IntegrationBackfillKind,
  reason: string = SELF_CONVERGING_BACKFILL,
): JobDefinition {
  return defineJob({
    queue,
    policy: { policy: "exclusive", reason },
    work: { localConcurrency: concurrency },
    load: async ({ boss }) =>
      (
        await import("@/lib/jobs/integration-backfill-forward")
      ).forwardToBackfillAdmission(boss, kind),
  });
}

const withingsSync = () => import("@/lib/jobs/reminder/withings-sync");
const whoopSync = () => import("@/lib/jobs/reminder/whoop-sync");
const googleHealthSync = () => import("@/lib/jobs/reminder/google-health-sync");
const cleanups = () => import("@/lib/jobs/reminder/cleanup-handlers");

const jobs: readonly JobDefinition[] = [
  // pg-boss scopes groupConcurrency to one queue name, so every provider
  // reaches this shared queue before doing full-history work. The group is
  // enforced in Postgres across workers; the heavy lane keeps an import off
  // the heap while a backup, a restore or an upload is on it.
  defineJob({
    queue: INTEGRATION_BACKFILL_ADMISSION_QUEUE,
    policy: {
      policy: "exclusive",
      reason:
        "Shared full-history drain; keyed per source job so boot rediscovery cannot duplicate queued, active, or retrying work.",
    },
    work: {
      localConcurrency: INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
      groupConcurrency: INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
    },
    lane: true,
    load: async () =>
      (await import("@/lib/jobs/integration-backfill-drain"))
        .drainIntegrationBackfillAdmission,
  }),
  defineJob({
    queue: WITHINGS_SYNC_QUEUE,
    cron: WITHINGS_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await withingsSync()).handleWithingsFallbackSync,
  }),
  defineJob({
    queue: WITHINGS_ACTIVITY_QUEUE,
    cron: WITHINGS_ACTIVITY_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await withingsSync()).handleWithingsActivitySync,
  }),
  defineJob({
    queue: WITHINGS_SLEEP_QUEUE,
    cron: WITHINGS_SLEEP_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await withingsSync()).handleWithingsSleepSync,
  }),
  defineJob({
    queue: WITHINGS_ECG_SYNC_QUEUE,
    cron: WITHINGS_ECG_SYNC_CRON,
    policy: {
      policy: "short",
      reason:
        "Webhook retries share one identity while queued; once work starts, a later replay remains admissible as a rescue if the original exhausts retries.",
    },
    work: { localConcurrency: 1 },
    load: async () => (await withingsSync()).handleWithingsEcgSync,
  }),
  defineJob({
    queue: WITHINGS_OAUTH_STATE_CLEANUP_QUEUE,
    cron: WITHINGS_OAUTH_STATE_CLEANUP_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () => (await cleanups()).handleWithingsOAuthStateCleanup,
  }),
  // WHOOP per-resource syncs: a webhook job is one user, the cron walks
  // everyone. Serial, inside WHOOP's 100 requests a minute per app.
  defineJob({
    queue: WHOOP_RECOVERY_SYNC_QUEUE,
    cron: WHOOP_RECOVERY_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await whoopSync()).handleWhoopRecoverySync,
  }),
  defineJob({
    queue: WHOOP_SLEEP_SYNC_QUEUE,
    cron: WHOOP_SLEEP_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await whoopSync()).handleWhoopSleepSync,
  }),
  defineJob({
    queue: WHOOP_WORKOUT_SYNC_QUEUE,
    cron: WHOOP_WORKOUT_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await whoopSync()).handleWhoopWorkoutSync,
  }),
  defineJob({
    queue: WHOOP_CYCLE_SYNC_QUEUE,
    cron: WHOOP_CYCLE_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await whoopSync()).handleWhoopCycleSync,
  }),
  backfillSource(
    WHOOP_BACKFILL_QUEUE,
    WHOOP_BACKFILL_CONCURRENCY,
    "whoop-backfill",
    "Per-connection full-history backfill; long-running, and boot discovery re-enqueues until the connection is marked backfilled.",
  ),
  defineJob({
    queue: WHOOP_OAUTH_STATE_CLEANUP_QUEUE,
    cron: WHOOP_OAUTH_STATE_CLEANUP_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () => (await cleanups()).handleWhoopOAuthStateCleanup,
  }),
  ...FITBIT_JOBS,
  defineJob({
    queue: GOOGLE_HEALTH_SYNC_QUEUE,
    cron: GOOGLE_HEALTH_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () => (await googleHealthSync()).handleGoogleHealthSync,
  }),
  backfillSource(
    GOOGLE_HEALTH_BACKFILL_QUEUE,
    GOOGLE_HEALTH_BACKFILL_CONCURRENCY,
    "google-health-backfill",
  ),
  backfillSource(
    GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE,
    GOOGLE_HEALTH_SLEEP_REPAIR_CONCURRENCY,
    "google-health-sleep-repair",
    "Per-connection one-shot sleep re-read; discovery drops the connection once it is marked repaired.",
  ),
  defineJob({
    queue: GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE,
    cron: GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () =>
      (await googleHealthSync()).handleGoogleHealthOAuthStateCleanup,
  }),
  backfillSource(
    SLEEP_TIMELINE_BACKFILL_QUEUE,
    SLEEP_TIMELINE_BACKFILL_CONCURRENCY,
    "sleep-timeline-backfill",
    "Per-connection one-shot timeline backfill, keyed per provider+user; discovery drops the connection once its rows carry the new shape.",
  ),
  backfillSource(
    LAB_BIOMARKER_BACKFILL_QUEUE,
    LAB_BIOMARKER_BACKFILL_CONCURRENCY,
    "lab-biomarker-backfill",
    "Per-user one-shot catalog link-up; discovery drops the user once no unlinked lab readings remain.",
  ),
  // The cohort polls: the hourly tick (no `userId`) walks every connection;
  // one connection's failure is booked on its ledger, not the tick's.
  defineJob({
    queue: NIGHTSCOUT_SYNC_QUEUE,
    cron: NIGHTSCOUT_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/reminder/nightscout-sync"))
        .handleNightscoutSync,
  }),
  defineJob({
    queue: POLAR_SYNC_QUEUE,
    cron: POLAR_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/reminder/polar-sync")).handlePolarSync,
  }),
  defineJob({
    queue: OURA_SYNC_QUEUE,
    cron: OURA_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/reminder/oura-sync")).handleOuraSync,
  }),
  backfillSource(
    OURA_BACKFILL_QUEUE,
    OURA_BACKFILL_CONCURRENCY,
    "oura-backfill",
  ),
  defineJob({
    queue: STRAVA_SYNC_QUEUE,
    cron: STRAVA_SYNC_CRON,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/reminder/strava-sync")).handleStravaSync,
  }),
  backfillSource(
    STRAVA_BACKFILL_QUEUE,
    STRAVA_BACKFILL_CONCURRENCY,
    "strava-backfill",
  ),
  defineJob({
    queue: OIDC_NATIVE_HANDOFF_CLEANUP_QUEUE,
    cron: OIDC_NATIVE_HANDOFF_CLEANUP_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () => (await cleanups()).handleOidcNativeHandoffCleanup,
  }),
  // The watchdog: an hourly cheap pass and a daily one that re-reads the
  // history behind standing silence flags. Both share one advisory lock, so
  // they never run side by side on any replica; the next tick is the retry.
  defineJob({
    queue: INTEGRATION_WATCHDOG_HOURLY_QUEUE,
    cron: INTEGRATION_WATCHDOG_HOURLY_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/integration-watchdog"))
        .handleIntegrationWatchdogHourly,
  }),
  defineJob({
    queue: INTEGRATION_WATCHDOG_DAILY_QUEUE,
    cron: INTEGRATION_WATCHDOG_DAILY_CRON,
    scheduleOptions: cronIsTheRetry,
    work: { localConcurrency: 1 },
    load: async () =>
      (await import("@/lib/jobs/integration-watchdog"))
        .handleIntegrationWatchdogDaily,
  }),
];

/** A backfill discovery staggered by its kind's place in the boot order. */
function backfillDiscovery(
  kind: IntegrationBackfillKind,
  enqueue: (staggerSeconds: number) => Promise<DiscoveryResult>,
): BootDiscovery {
  return { name: kind, run: () => enqueue(bootStaggerSecondsFor(kind)) };
}

const discovery: readonly BootDiscovery[] = [
  backfillDiscovery("whoop-backfill", async (stagger) =>
    (await import("@/lib/jobs/whoop-backfill")).enqueueBootTimeWhoopBackfill(
      stagger,
    ),
  ),
  backfillDiscovery("google-health-backfill", async (stagger) =>
    (
      await import("@/lib/jobs/google-health-backfill")
    ).enqueueBootTimeGoogleHealthBackfill(stagger),
  ),
  backfillDiscovery("google-health-sleep-repair", async (stagger) =>
    (
      await import("@/lib/jobs/google-health-sleep-repair")
    ).enqueueBootTimeGoogleHealthSleepRepair(stagger),
  ),
  backfillDiscovery("sleep-timeline-backfill", async (stagger) =>
    (
      await import("@/lib/jobs/sleep-timeline-backfill")
    ).enqueueBootTimeSleepTimelineBackfill(stagger),
  ),
  backfillDiscovery("strava-backfill", async (stagger) =>
    (await import("@/lib/jobs/strava-backfill")).enqueueBootTimeStravaBackfill(
      stagger,
    ),
  ),
  backfillDiscovery("oura-backfill", async (stagger) =>
    (await import("@/lib/jobs/oura-backfill")).enqueueBootTimeOuraBackfill(
      stagger,
    ),
  ),
  backfillDiscovery("lab-biomarker-backfill", async (stagger) =>
    (
      await import("@/lib/jobs/lab-biomarker-backfill")
    ).enqueueBootTimeLabBiomarkerBackfill(stagger),
  ),
  ...FITBIT_BOOT_DISCOVERY,
];

export const INTEGRATION_SYNC_GROUP: JobGroup = {
  name: "integration_sync",
  jobs,
  discovery,
};
