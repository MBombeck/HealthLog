/**
 * The queue facts of `document-ai-run.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const DOCUMENT_AI_RUN_QUEUE = "document-ai-run";

/** Two reads at a time: provider calls, kept off the request pool. */
export const DOCUMENT_AI_RUN_CONCURRENCY = 2;
