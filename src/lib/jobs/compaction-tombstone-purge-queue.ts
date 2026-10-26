/**
 * The queue facts of `compaction-tombstone-purge.ts`: its name and, where it has them, its
 * schedule, concurrency and send options. They live apart from the job so the
 * worker registry and every sender can read them without loading it.
 */
export const COMPACTION_TOMBSTONE_PURGE_QUEUE = "compaction-tombstone-purge";
