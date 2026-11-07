/**
 * The queue facts of `wearable-cycle-repair.ts`: its name and its one
 * singleton key. They live apart from the job so the worker registry and the
 * boot discovery can read them without loading it.
 */
export const WEARABLE_CYCLE_REPAIR_QUEUE = "wearable-cycle-repair";

/** One pass covers every account, so there is only ever one job. */
export const WEARABLE_CYCLE_REPAIR_SINGLETON_KEY = "wearable-cycle-repair";
