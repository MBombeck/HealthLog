/**
 * The queue facts of the Fitbit jobs: names and concurrency. They live apart
 * from the handlers so the worker registry and every sender can read them
 * without loading the Fitbit sync.
 */
export const FITBIT_SLEEP_REPAIR_QUEUE = "fitbit-sleep-repair";

/**
 * Serial concurrency — a repair walks a year of sleep history for one account
 * in 30-day requests against the tight per-user budget; concurrency-1 keeps it
 * from crowding the request pool, matching `FITBIT_BACKFILL_CONCURRENCY`.
 */
export const FITBIT_SLEEP_REPAIR_CONCURRENCY = 1;

export const FITBIT_BACKFILL_QUEUE = "fitbit-backfill";

/**
 * Serial concurrency — a backfill walks years of history for one account and is
 * rate-bounded by Google's per-app quota; concurrency-1 keeps it from crowding
 * the request pool, matching `WHOOP_BACKFILL_CONCURRENCY`.
 */
export const FITBIT_BACKFILL_CONCURRENCY = 1;

/** Hourly Fitbit poll (no webhook). */
export const FITBIT_SYNC_QUEUE = "fitbit-sync";
export const FITBIT_SYNC_CRON = "8 * * * *";

/** Daily sweep of the Fitbit OAuth state ledger. */
export const FITBIT_OAUTH_STATE_CLEANUP_QUEUE = "fitbit-oauth-state-cleanup";
export const FITBIT_OAUTH_STATE_CLEANUP_CRON = "24 3 * * *";
