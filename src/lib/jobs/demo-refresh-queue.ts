/**
 * The queue facts of `demo-refresh.ts`: its name, schedule and singleton key,
 * and the one switch that decides whether the queue exists at all. They live
 * apart from the job so the worker registry and the boot discovery can read
 * them without loading the seed.
 */
export const DEMO_REFRESH_QUEUE = "demo-refresh";

/** One pass rewrites the whole demo database, so there is only ever one job. */
export const DEMO_REFRESH_SINGLETON_KEY = "demo-refresh";

/**
 * The local hour the demo is rewritten, Europe/Berlin (the default zone every
 * cron runs in). The seed places today's readings between 07:00 and 10:00 and
 * marks the morning doses taken at 08:30; written from 10:00 on, nothing of
 * today lies in the future.
 */
export const DEMO_REFRESH_HOUR = 10;

export const DEMO_REFRESH_CRON = `0 ${DEMO_REFRESH_HOUR} * * *`;

/**
 * The refresh wipes the database it runs against, so it exists only on a demo
 * deploy. Read at registration and again in the handler and the boot
 * discovery, so a schedule left behind after the flag is turned off finds a
 * handler that does nothing.
 */
export function demoRefreshEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}
