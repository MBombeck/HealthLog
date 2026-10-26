/**
 * The queue facts of `encryption-key-rotate.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the job so the worker
 * registry and every sender can read them without loading it.
 */
export const ENCRYPTION_KEY_ROTATE_QUEUE = "encryption-key-rotate";

export const ENCRYPTION_KEY_ROTATE_CONCURRENCY = 1;
