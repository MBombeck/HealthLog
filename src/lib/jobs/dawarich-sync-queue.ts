/**
 * The queue facts of `dawarich-sync.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const DAWARICH_SYNC_QUEUE = "dawarich-sync";

/** Daily 03:20 Europe/Berlin, after the night's environment fetch. */
export const DAWARICH_SYNC_CRON = "20 3 * * *";
