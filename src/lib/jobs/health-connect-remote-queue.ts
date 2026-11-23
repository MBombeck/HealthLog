/**
 * The queue facts of `health-connect-remote-worker.ts`: the scheduled fetch
 * of a Health Connect export from a WebDAV or Nextcloud folder.
 */
export const HEALTH_CONNECT_REMOTE_FETCH_QUEUE = "health-connect-remote-fetch";

/**
 * Hourly at :17. Each pass fetches only the sources that are due, so a
 * source is read about every six hours, or later after a failure.
 */
export const HEALTH_CONNECT_REMOTE_FETCH_CRON = "17 * * * *";
