/**
 * The queue facts of the nightly whole-database dump: its name, its schedule
 * and its send options. Apart from the job so the worker registry can read
 * them without loading it (`job-registry-graph.test.ts`).
 */
import { BACKUP_HEARTBEAT_SECONDS } from "@/lib/jobs/data-backup-policy";
import { resolveBackupSchedule } from "@/lib/database-backup/dump-core.mjs";

export const DATABASE_BACKUP_QUEUE = "database-backup";

/**
 * `DB_BACKUP_SCHEDULE`, read once when the worker loads its registry, in the
 * zone every cron runs in (`createAndSchedule`, Europe/Berlin). Default 01:30,
 * an hour before the off-host account copies so the two uploads do not meet.
 * A value that is not a five-field cron keeps the default, and the boot
 * readiness summary says so.
 */
export const DATABASE_BACKUP_CRON = resolveBackupSchedule(process.env).cron;

/**
 * Four hours. `pg_dump` of a large instance takes minutes, the upload of the
 * dump about as long as the dump; the window is there to be impossible to hit
 * for a working run. The handler kills `pg_dump` at three quarters of it
 * (`jobDeadline`), so a hung dump ends as a failed run with a reason rather
 * than an expired job.
 */
export const DATABASE_BACKUP_EXPIRE_SECONDS = 4 * 60 * 60;

/**
 * What the nightly schedule sends with: the expiry, the backups' heartbeat,
 * and one retry. A dump that failed for a passing reason (a lock it waited
 * out, a bucket that answered 503) gets a second attempt; one that fails
 * again waits for the next night, and the failure stays on the admin page.
 */
export const DATABASE_BACKUP_SEND_OPTIONS = {
  expireInSeconds: DATABASE_BACKUP_EXPIRE_SECONDS,
  heartbeatSeconds: BACKUP_HEARTBEAT_SECONDS,
  retryLimit: 1,
  retryDelay: 15 * 60,
} as const;
