/**
 * The queue facts of `backup-restore.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const BACKUP_RESTORE_QUEUE = "backup-restore";
