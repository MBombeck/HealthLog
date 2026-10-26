/**
 * The queue facts of `restore-drill.ts`: its name and, where it has them, its
 * schedule, concurrency and send options. They live apart from the job so the
 * worker registry and every sender can read them without loading it.
 */
export const RESTORE_DRILL_QUEUE = "data-restore-drill";

export const RESTORE_DRILL_CRON = "11 4 1 * *";

/**
 * Four hours, the off-host upload's own window: the drill downloads and
 * stream-parses every object that upload wrote in one night.
 */
export const RESTORE_DRILL_EXPIRE_SECONDS = 4 * 60 * 60;

/**
 * What the monthly schedule sends with: the expiry above and no retry
 * (`retryLimit: 0`, the maintenance schedules' `cronIsTheRetry`).
 */
export const RESTORE_DRILL_SEND_OPTIONS = {
  expireInSeconds: RESTORE_DRILL_EXPIRE_SECONDS,
  retryLimit: 0,
} as const;
