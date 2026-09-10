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
 * Five states, because the run is nightly and one missed night is not the same
 * event as four — and because "we have not looked yet" is not a verdict:
 *
 *   unknown — no nightly run has recorded this account. The ledger starts
 *           empty, so this is what every account on a perfectly healthy host
 *           reads between the upgrade that adds the table and the first run
 *           after it. Saying "never" there would assert something the host
 *           cannot know.
 *   never — a run walked this account and put no object there, and no earlier
 *           run ever did either.
 *   fresh — inside one schedule period plus the grace below. This is what
 *           every account looks like on a host where the cron is doing its
 *           job.
 *   due   — past one period, inside two. One night produced nothing: a retry, a
 *           long run, a restart during the window. Worth showing, not worth
 *           alarming about.
 *   stale — past two periods. Two consecutive nights produced nothing for this
 *           account, which no ordinary hiccup explains.
 */

/**
 * Hours between two scheduled off-host runs. Tracks `OFFHOST_BACKUP_CRON`
 * (`30 2 * * *`) in `src/lib/jobs/reminder/register-maintenance.ts`, which
 * every schedule runs in `Europe/Berlin` (`tz` in `registrar-shared.ts`).
 * This is the number the card quotes — the schedule's own period, not the
 * threshold a verdict is measured against.
 */
export const OFFHOST_BACKUP_PERIOD_HOURS = 24;

/**
 * Slack on top of one period, before a verdict moves.
 *
 * Two things make a healthy host miss a bare 24 hours. The schedule is
 * Berlin-local, so on the DST fall-back night the gap between two 02:30 runs
 * is 25 hours and every account on every host would cross one period on the
 * same morning. And the ledger instant is when THAT account's object landed,
 * deliberately: on a cohort walked one account at a time, an account reached
 * at 05:30 one night and 06:30 the next is 25 hours old with two entirely
 * successful runs behind it.
 *
 * Six hours is the budget for both. A card whose argument is that a count
 * trains an operator to stop reading it cannot afford an annual cohort-wide
 * false `due`.
 */
export const OFFHOST_BACKUP_GRACE_HOURS = 6;

export type OffhostBackupFreshness =
  "unknown" | "never" | "fresh" | "due" | "stale";

export interface OffhostBackupVerdict {
  freshness: OffhostBackupFreshness;
  /** Whole hours since the newest object landed; null when there is none. */
  ageHours: number | null;
}

export function classifyOffhostBackup(args: {
  /**
   * When a run last walked this account, or null when none has. Null is the
   * only thing that separates `unknown` from `never`.
   */
  lastAttemptAt: Date | null;
  lastSuccessAt: Date | null;
  now: Date;
  /** Defaults to the nightly schedule. Tests pass their own. */
  periodHours?: number;
  /** Defaults to `OFFHOST_BACKUP_GRACE_HOURS`. Tests pass their own. */
  graceHours?: number;
}): OffhostBackupVerdict {
  const { lastAttemptAt, lastSuccessAt, now } = args;
  if (lastAttemptAt === null) return { freshness: "unknown", ageHours: null };
  if (lastSuccessAt === null) return { freshness: "never", ageHours: null };

  const periodMs =
    (args.periodHours ?? OFFHOST_BACKUP_PERIOD_HOURS) * 3_600_000;
  const graceMs = (args.graceHours ?? OFFHOST_BACKUP_GRACE_HOURS) * 3_600_000;
  const ageMs = now.getTime() - lastSuccessAt.getTime();
  // A clock that ran backwards between the upload and this read reports a
  // negative age. That is a host-clock problem, not a backup problem, and
  // calling the copy stale over it would point the operator at the wrong
  // thing.
  const ageHours = Math.max(0, Math.floor(ageMs / 3_600_000));

  // The grace rides on each threshold rather than on the period, so `due`
  // still means "one scheduled run produced nothing" and `stale` still means
  // two — the slack only keeps a long night from being read as a missed one.
  if (ageMs <= periodMs + graceMs) return { freshness: "fresh", ageHours };
  if (ageMs <= periodMs * 2 + graceMs) return { freshness: "due", ageHours };
  return { freshness: "stale", ageHours };
}
