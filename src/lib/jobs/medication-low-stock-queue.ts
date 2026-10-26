/**
 * The queue facts of `medication-low-stock.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
/** Pg-boss queue + cron — imported by the reminder worker's bootstrap. */
export const MEDICATION_LOW_STOCK_QUEUE = "medication-low-stock";

/**
 * 09:00 Europe/Berlin — a supply alert is an errand prompt ("order a
 * refill"), not a night signal; it fires once daily at a time the user
 * can act on it.
 */
export const MEDICATION_LOW_STOCK_CRON = "0 9 * * *";
