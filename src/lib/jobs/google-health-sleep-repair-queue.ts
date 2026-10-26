/**
 * The queue facts of `google-health-sleep-repair.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE = "google-health-sleep-repair";

/**
 * Serial concurrency — a repair walks the full sleep history for one account
 * and is rate-bounded by Google's per-app quota; concurrency-1 keeps it from
 * crowding the request pool, matching `GOOGLE_HEALTH_BACKFILL_CONCURRENCY`.
 */
export const GOOGLE_HEALTH_SLEEP_REPAIR_CONCURRENCY = 1;
