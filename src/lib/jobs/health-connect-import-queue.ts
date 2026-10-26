/**
 * The queue facts of `health-connect-import-worker.ts`: its queue names and
 * concurrency. They live apart from the worker so the registry and the upload
 * routes can name the queue without loading the parser.
 */
export const HEALTH_CONNECT_IMPORT_QUEUE = "health-connect-import";

/** One import at a time per worker: the SQLite read and the writes are heavy. */
export const HEALTH_CONNECT_IMPORT_CONCURRENCY = 1;
