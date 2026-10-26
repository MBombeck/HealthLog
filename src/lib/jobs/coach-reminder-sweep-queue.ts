/**
 * The queue facts of `coach-reminder-sweep.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
export const COACH_REMINDER_SWEEP_QUEUE = "coach-reminder-sweep";

// Daily at 05:20 Europe/Berlin — just after the 05:15 nudge tick so both
// proactive passes run on settled overnight rows.
export const COACH_REMINDER_SWEEP_CRON = "20 5 * * *";
