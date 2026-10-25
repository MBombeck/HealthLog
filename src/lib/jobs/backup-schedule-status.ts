/**
 * Whether the weekly backup is actually still happening, in two facts.
 *
 * The pass stopped producing a new copy and nothing said so for a month and a
 * half. Everything that could have told the operator was either invisible or
 * short-lived: the handler's own error never ran (the job was killed, not
 * thrown), `recordError()` increments an unnamed counter, and the admin status
 * page's failing-queue panel only looks back 72 hours — which for a weekly
 * queue means a permanent failure is on screen three days in seven. The backups
 * page itself showed a perfectly ordinary row with a perfectly ordinary
 * timestamp, because a 46-day-old copy looks exactly like a fresh one until you
 * read the date.
 *
 * So the surface carries both legs, and neither is derived from the other:
 *
 *   - the AGE of the newest scheduled copy, which never ages out of any
 *     retention window and would have caught this on the second missed Sunday;
 *   - the terminal state of the last scheduled RUN, which is the only place the
 *     reason ("job timed out") is written down at all.
 *
 * Manual uploads are excluded by the shape of the input: the caller passes only
 * the scheduled rows, so an admin's ad-hoc upload cannot make a dead cron look
 * alive.
 */
import type { LastQueueRun } from "@/lib/jobs/job-failures";
import { WEEKLY_COPY_ATTENTION_AFTER_DAYS } from "@/lib/recovery/readiness-model";

/**
 * How old the newest scheduled copy may get before the page says so. The cron
 * is weekly, so seven days is normal and eight is a long week; past nine at
 * least one Sunday produced nothing. The recovery readiness model draws its
 * attention line at the same instant, so this page and the push agree.
 */
export const BACKUP_STALE_AFTER_DAYS = WEEKLY_COPY_ATTENTION_AFTER_DAYS;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BackupScheduleStatus {
  /** ISO instant of the newest scheduled copy, or null when there is none. */
  lastSuccessAt: string | null;
  /** Whole days since that copy was written. */
  lastSuccessAgeDays: number | null;
  /** The threshold behind `stale`, so the UI can name it. */
  staleAfterDays: number;
  /** A scheduled copy exists and is older than the threshold. */
  stale: boolean;
  /** The last scheduled run pg-boss still remembers. */
  lastRun: LastQueueRun | null;
  /** That run ended `failed` or `cancelled`. */
  lastRunFailed: boolean;
}

export function summariseBackupSchedule(args: {
  /** `createdAt` of every SCHEDULED backup row; manual uploads excluded. */
  scheduledCreatedAt: readonly Date[];
  lastRun: LastQueueRun | null;
  now: Date;
}): BackupScheduleStatus {
  const newest = args.scheduledCreatedAt.reduce<Date | null>(
    (best, at) => (best === null || at > best ? at : best),
    null,
  );
  const ageDays =
    newest === null
      ? null
      : Math.floor((args.now.getTime() - newest.getTime()) / DAY_MS);

  return {
    lastSuccessAt: newest?.toISOString() ?? null,
    lastSuccessAgeDays: ageDays,
    staleAfterDays: BACKUP_STALE_AFTER_DAYS,
    // An instance that has never produced a scheduled copy is not stale, it is
    // new — the page's empty state already says there is nothing there, and
    // calling a fresh install "overdue" would train the operator to ignore the
    // warning that matters.
    stale:
      newest !== null &&
      args.now.getTime() - newest.getTime() > BACKUP_STALE_AFTER_DAYS * DAY_MS,
    lastRun: args.lastRun,
    lastRunFailed: args.lastRun !== null && args.lastRun.state !== "completed",
  };
}
