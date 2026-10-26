/**
 * The queue facts of `document-summary-reaper.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the job so the worker
 * registry and every sender can read them without loading it.
 */
export const DOCUMENT_SUMMARY_REAPER_QUEUE = "document-summary-reaper";

/** Hourly at :50 — off the maintenance herd's minute marks. */
export const DOCUMENT_SUMMARY_REAPER_CRON = "50 * * * *";
