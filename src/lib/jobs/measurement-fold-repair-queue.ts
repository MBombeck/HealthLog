/**
 * The queue facts of `measurement-fold-repair.ts`: its name and, where it has them, its
 * schedule, concurrency and send options. They live apart from the job so the
 * worker registry and every sender can read them without loading it.
 */
export const MEASUREMENT_FOLD_REPAIR_QUEUE = "measurement-fold-repair";
