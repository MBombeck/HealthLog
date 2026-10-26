/**
 * The queue facts of `coach-nudge.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
/** Pg-boss queue + cron — imported by the reminder worker's bootstrap. */
export const COACH_NUDGE_QUEUE = "coach-nudge";

/** 05:15 Europe/Berlin — after the 04:45–04:55 score crons settled. */
export const COACH_NUDGE_CRON = "15 5 * * *";
