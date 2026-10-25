/**
 * The queue facts of `account-deletion-purge.ts`, apart from the job so the
 * worker registry can read them without loading it.
 */
export const ACCOUNT_DELETION_PURGE_QUEUE = "account-deletion-purge";

/**
 * Hourly at :23, so an account is erased within the hour its grace window
 * ends, and a copy taken before a data wipe leaves within the hour its
 * window does.
 */
export const ACCOUNT_DELETION_PURGE_CRON = "23 * * * *";
