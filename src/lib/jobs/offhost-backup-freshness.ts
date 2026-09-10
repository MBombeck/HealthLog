/**
 * How fresh one account's newest off-host copy is.
 *
 * The nightly off-host job reports counts — uploaded, failed, total — and a
 * count is exactly the shape that hides a single account. A cohort where one
 * account's object has failed every night for a month reports "99 uploaded, 1
 * failed" every night, which reads like weather rather than like an account
 * that has no disaster-recovery copy at all. The per-account ledger the worker
 * writes (`OffhostBackupState`) turns that into a fact the console can state
 * per row, and this function is the only place that fact is judged.
 *
 * Deliberately pure and deliberately not talking to the bucket: the admin page
 * computes staleness from the timestamp the worker wrote, so the answer is the
 * same whether or not the app process holds a read grant on the bucket, and a
 * listing of somebody's backups never crosses the network to show a page.
 *
 * Four states, because the run is nightly and one missed night is not the same
 * event as four:
 *
 *   never — the worker has never put an object there for this account.
 *   fresh — inside one schedule period. This is what every account looks like
 *           on a host where the cron is doing its job.
 *   due   — past one period, inside two. One night produced nothing: a retry, a
 *           long run, a restart during the window. Worth showing, not worth
 *           alarming about.
 *   stale — past two periods. Two consecutive nights produced nothing for this
 *           account, which no ordinary hiccup explains.
 */

/**
 * Hours between two scheduled off-host runs. Tracks `OFFHOST_BACKUP_CRON`
 * (`30 2 * * *`) in `src/lib/jobs/reminder/register-maintenance.ts` — nightly.
 */
export const OFFHOST_BACKUP_PERIOD_HOURS = 24;

export type OffhostBackupFreshness = "never" | "fresh" | "due" | "stale";

export interface OffhostBackupVerdict {
  freshness: OffhostBackupFreshness;
  /** Whole hours since the newest object landed; null when there is none. */
  ageHours: number | null;
}

export function classifyOffhostBackup(args: {
  lastSuccessAt: Date | null;
  now: Date;
  /** Defaults to the nightly schedule. Tests pass their own. */
  periodHours?: number;
}): OffhostBackupVerdict {
  const { lastSuccessAt, now } = args;
  if (lastSuccessAt === null) return { freshness: "never", ageHours: null };

  const periodMs =
    (args.periodHours ?? OFFHOST_BACKUP_PERIOD_HOURS) * 3_600_000;
  const ageMs = now.getTime() - lastSuccessAt.getTime();
  // A clock that ran backwards between the upload and this read reports a
  // negative age. That is a host-clock problem, not a backup problem, and
  // calling the copy stale over it would point the operator at the wrong
  // thing.
  const ageHours = Math.max(0, Math.floor(ageMs / 3_600_000));

  if (ageMs <= periodMs) return { freshness: "fresh", ageHours };
  if (ageMs <= periodMs * 2) return { freshness: "due", ageHours };
  return { freshness: "stale", ageHours };
}
