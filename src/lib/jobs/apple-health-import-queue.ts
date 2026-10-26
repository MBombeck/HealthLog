/**
 * The queue facts of `apple-health-import-worker.ts`: its queue names and
 * concurrency. They live apart from the worker so the registry and the upload
 * routes can name the queue without loading the parser.
 */
/**
 * Queue + cron for the periodic orphan-ImportJob sweep. v1.32.1
 * (issue #588) — `reconcileOrphanImportJobs()` used to run only once,
 * at worker boot. `restart: unless-stopped` in `docker-compose.yml`
 * DOES bring a crashed/OOM-killed worker back up, so the boot-time
 * pass usually catches a dead run — but only when that restart lands
 * AFTER the row's heartbeat has already gone stale (30 minutes) or
 * pg-boss no longer reports the backing job as live. A fast restart
 * lands neither condition true yet, and because the pass runs
 * exactly once per boot, a worker that then stays up and healthy
 * NEVER re-evaluates that row — it is stuck in `unpacking` /
 * `parsing` / `upserting` with "0 rows imported" forever and no
 * failure ever surfaced to the status poll. A 15-minute cron closes
 * that gap: within two ticks of the heartbeat going stale, the same
 * idempotent reconcile flips the row to `failed` with an honest
 * reason, so the UI's "Unpacking the archive…" spinner eventually
 * turns into a visible, actionable error instead of an indefinite
 * silent stall.
 */
export const IMPORT_JOB_RECONCILE_QUEUE = "apple-health-import-reconcile";

export const IMPORT_JOB_RECONCILE_CRON = "*/15 * * * *";

/** Queue name isolated from revision-1 workers during rolling deployments. */
export const APPLE_HEALTH_IMPORT_V2_QUEUE = "apple-health-import-v2";

/** Queue used by pre-revision-2 binaries; new workers only bridge its backlog. */
export const APPLE_HEALTH_IMPORT_LEGACY_QUEUE = "apple-health-import";

/** Concurrency cap per worker host. */
export const APPLE_HEALTH_IMPORT_CONCURRENCY = 1;
