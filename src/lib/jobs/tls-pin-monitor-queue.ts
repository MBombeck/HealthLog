/**
 * The queue facts of `tls-pin-monitor.ts`: its name and, where it has them, its
 * schedule and concurrency. They live apart from the handler so the worker
 * registry and every sender can read them without loading the job.
 */
/**
 * pg-boss queue name + cron. Every 6 hours at :07 (offset off the :00 / :05
 * / :08 hourly sync crons so the probe doesn't pile onto a busy boss poll).
 * GTS leaves renew roughly every ~90 days; a 6-hour cadence surfaces a
 * change well inside the ≥11-day re-pin window the runbook targets while
 * costing one short outbound TLS handshake per tick.
 */
export const TLS_PIN_MONITOR_QUEUE = "tls-pin-monitor";

export const TLS_PIN_MONITOR_CRON = "7 */6 * * *";
