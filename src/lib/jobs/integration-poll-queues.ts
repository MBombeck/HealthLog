/**
 * Names and crons of the integration sync queues.
 *
 * A light module on purpose: the worker registry declares these queues from
 * here (`registry/integration-sync.ts`), and a request-path caller (an OAuth
 * callback enqueueing the first sync, a webhook enqueueing one resource) names
 * a queue without loading the sync it feeds.
 *
 * The hourly minutes are staggered so the polls do not land on one boss poll:
 * used are :00 :05 :08 :11 :13 :15 :17 :18 :20 :35 :41 :47 :50.
 */

/** Withings measure catch-net (the webhook is primary). */
export const WITHINGS_SYNC_QUEUE = "withings-fallback-sync";
export const WITHINGS_SYNC_CRON = "0 * * * *";

/**
 * Withings activity and sleep: webhook-primary (appli 16 / 44), with an hourly
 * catch-net for the deliveries Withings drops.
 */
export const WITHINGS_ACTIVITY_QUEUE = "withings-activity-sync";
export const WITHINGS_ACTIVITY_CRON = "0 * * * *";
export const WITHINGS_SLEEP_QUEUE = "withings-sleep-sync";
export const WITHINGS_SLEEP_CRON = "15 * * * *";

/**
 * Withings ECG catch-net. The queue is webhook-primary (appli 54), but appli 54
 * is not in the subscription set and the manual sync measures only, so a
 * watch-only account would never have its strips pulled without this walk.
 */
export const WITHINGS_ECG_SYNC_CRON = "41 * * * *";

/** Daily sweep of the Withings OAuth state ledger. */
export const WITHINGS_OAUTH_STATE_CLEANUP_QUEUE =
  "withings-oauth-state-cleanup";
export const WITHINGS_OAUTH_STATE_CLEANUP_CRON = "20 3 * * *";

/**
 * WHOOP: recovery, sleep and workout are webhook-primary with an hourly
 * catch-net; cycle has no webhook, so its cron is the only driver.
 */
export const WHOOP_RECOVERY_SYNC_QUEUE = "whoop-recovery-sync";
export const WHOOP_RECOVERY_SYNC_CRON = "5 * * * *";
export const WHOOP_SLEEP_SYNC_QUEUE = "whoop-sleep-sync";
export const WHOOP_SLEEP_SYNC_CRON = "20 * * * *";
export const WHOOP_WORKOUT_SYNC_QUEUE = "whoop-workout-sync";
export const WHOOP_WORKOUT_SYNC_CRON = "35 * * * *";
export const WHOOP_CYCLE_SYNC_QUEUE = "whoop-cycle-sync";
export const WHOOP_CYCLE_SYNC_CRON = "50 * * * *";

/** Daily sweep of the WHOOP OAuth state ledger. */
export const WHOOP_OAUTH_STATE_CLEANUP_QUEUE = "whoop-oauth-state-cleanup";
export const WHOOP_OAUTH_STATE_CLEANUP_CRON = "22 3 * * *";

/** Google Health poll (no webhook). */
export const GOOGLE_HEALTH_SYNC_QUEUE = "google-health-sync";
export const GOOGLE_HEALTH_SYNC_CRON = "18 * * * *";

/** Daily sweep of the Google Health OAuth state ledger. */
export const GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE =
  "google-health-oauth-state-cleanup";
export const GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_CRON = "26 3 * * *";

/** Nightscout CGM poll. */
export const NIGHTSCOUT_SYNC_QUEUE = "nightscout-sync";
export const NIGHTSCOUT_SYNC_CRON = "11 * * * *";

/** Polar AccessLink poll. */
export const POLAR_SYNC_QUEUE = "polar-sync";
export const POLAR_SYNC_CRON = "13 * * * *";

/** Oura Cloud poll. */
export const OURA_SYNC_QUEUE = "oura-sync";
export const OURA_SYNC_CRON = "15 * * * *";

/** Strava poll (the webhook is not wired). */
export const STRAVA_SYNC_QUEUE = "strava-sync";
export const STRAVA_SYNC_CRON = "17 * * * *";

/**
 * Daily sweep of the native OIDC handoff ledger. Handoff codes are single-use
 * and expire at read, so this only reaps rows the app never came back for.
 */
export const OIDC_NATIVE_HANDOFF_CLEANUP_QUEUE = "oidc-native-handoff-cleanup";
export const OIDC_NATIVE_HANDOFF_CLEANUP_CRON = "28 3 * * *";
