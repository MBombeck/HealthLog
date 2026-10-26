/**
 * The queue facts of `document-ai-run-reaper.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the job so the worker
 * registry and every sender can read them without loading it.
 */
export const DOCUMENT_AI_RUN_REAPER_QUEUE = "document-ai-run-reaper";

/** Every five minutes: a queued run fails within twenty minutes at worst. */
export const DOCUMENT_AI_RUN_REAPER_CRON = "*/5 * * * *";
