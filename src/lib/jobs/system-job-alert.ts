/**
 * Push to every admin when a background job of the instance keeps failing:
 * once when a queue has failed `SYSTEM_JOB_FAILURE_STREAK` jobs in a row, a
 * reminder at most once a day while it keeps failing, and once when it runs
 * successfully again. Nothing else.
 *
 * Why (#1298). A full rollup backfill that failed on every boot showed only
 * on the admin page's card of failing background jobs. From the account's
 * side the only symptom was empty dashboard cards, and nothing pointed an
 * operator at the card. The recovery readiness evaluation already pushes a
 * stopped backup; this does the same for the queues whose failure has no
 * account-facing status of its own (the `system` audience in
 * `subsystem-surface.ts`).
 *
 * The streak is read from pg-boss's own ledger, newest terminal job first,
 * and it counts jobs, not attempts: a job that used up its retries is one
 * failure. A job that failed, or completed and said every candidate failed
 * (`did.all_failed`), adds one; the first job that succeeded ends it.
 *
 * Many of these queues run one job per account (a rollup recompute, a
 * backfill, a score), so the streak is kept per job key: the account the job
 * carries (`data.userId`), or the whole queue for a job that carries none.
 * Not the `singletonKey`: it often names a bucket, a window or a single
 * workout, which makes nearly every job its own key, and a queue failing on
 * every job would then never build a streak. A queue is failing while any
 * key has failed `SYSTEM_JOB_FAILURE_STREAK` jobs in a row, and it has
 * recovered only when no key is failing and a key that had failed ran
 * successfully since; another account's success says nothing about the one
 * that fails. One account failing every hour while the rest succeed is
 * therefore one problem notice and one recovery, not a notice each hour.
 *
 * A reminder needs a failure newer than the notice before it. A queue that
 * keeps failing is reminded once a day; a one-shot job (a boot backfill) that
 * failed and does not run again is announced once and then left to the admin
 * page, instead of a reminder every day until pg-boss deletes its row. A
 * queue with nothing left in the ledger to judge is forgotten silently.
 *
 * The memory is one row per announced queue (`SystemJobAlertNotice`), claimed
 * with a compare-and-set before the notice is sent, exactly as the readiness
 * notices are (`readiness-notify.ts`, whose decision this reuses), so two
 * workers send a notice once and a crash between the claim and the send loses
 * a notice rather than repeating it. Delivery is the ordinary localised path,
 * as the other operator alerts use: a `SYSTEM_ALERT` to every admin, in their
 * locale, on the channels they enabled.
 */
import type { Job } from "pg-boss";

import { ACTIVE_ACCOUNT } from "@/lib/account-deletion/active-account";
import { prisma } from "@/lib/db";
import { presentError } from "@/lib/jobs/job-failures";
import { jobDone, jobFailed, type JobOutcome } from "@/lib/jobs/job-outcome";
import { SUBSYSTEM_SURFACE } from "@/lib/jobs/subsystem-surface";
import { withBackgroundEvent } from "@/lib/logging/background";
import { dispatchLocalisedNotification } from "@/lib/notifications/dispatch-localised";
import {
  decideNotice,
  type NoticeKind,
  type StoredNotice,
} from "@/lib/recovery/readiness-notify";

/** Failed jobs in a row, of one job key, before the admins are told. */
export const SYSTEM_JOB_FAILURE_STREAK = 3;

/** Newest terminal jobs read per queue, across every key. */
const LOOKBACK_ROWS = 5000;

/** Newest terminal jobs judged per job key. */
const LOOKBACK_ROWS_PER_KEY = 20;

/** Where the notice takes the admin: the page with the failing-jobs card. */
const ADMIN_STATUS_PATH = "/admin/system-status";

/** One terminal job as the ledger holds it. */
export interface TerminalRun {
  /** The account the job ran for (`data.userId`), or "" for the queue. */
  key: string;
  state: "completed" | "failed";
  /** The job completed but reported that every candidate failed. */
  allFailed: boolean;
  completedOn: Date;
  error: string | null;
  expireSeconds: number | null;
}

/** What the ledger says about one queue. */
export interface QueueVerdict {
  /**
   * `failing`: some key reached the streak. `ok`: no key is failing, and a
   * key that had failed has since run successfully. `pending`: a failure
   * short of the streak, and no recovery to report. `inactive`: nothing to
   * report, no job left or none that failed.
   */
  state: "failing" | "ok" | "pending" | "inactive";
  /** Failed jobs in a row of the key that failed most recently. */
  failures: number;
  /** That key's newest failure, redacted and truncated. */
  lastError: string;
  /** When the newest failure of a failing key settled, if any key is. */
  lastFailureAt: Date | null;
}

function failed(run: TerminalRun): boolean {
  return run.state === "failed" || run.allFailed;
}

/** Pure: judge one queue's terminal jobs, in any order. */
export function judgeQueueRuns(runs: readonly TerminalRun[]): QueueVerdict {
  const byKey = new Map<string, TerminalRun[]>();
  for (const run of runs) {
    const list = byKey.get(run.key) ?? [];
    list.push(run);
    byKey.set(run.key, list);
  }
  let failing: { streak: number; newest: TerminalRun } | null = null;
  let recovered = false;
  let anyFailure = false;
  for (const list of byKey.values()) {
    list.sort((a, b) => b.completedOn.getTime() - a.completedOn.getTime());
    let streak = 0;
    while (streak < list.length && failed(list[streak])) streak += 1;
    if (list.some(failed)) anyFailure = true;
    if (streak === 0) {
      // Newest job succeeded: a recovery, when this key had failed before.
      if (list.some(failed)) recovered = true;
      continue;
    }
    if (
      streak >= SYSTEM_JOB_FAILURE_STREAK &&
      (failing === null ||
        list[0].completedOn.getTime() > failing.newest.completedOn.getTime())
    ) {
      failing = { streak, newest: list[0] };
    }
  }
  if (failing) {
    return {
      state: "failing",
      failures: failing.streak,
      lastError: presentError(
        failing.newest.error,
        failing.newest.expireSeconds,
      ),
      lastFailureAt: failing.newest.completedOn,
    };
  }
  const state = recovered ? "ok" : anyFailure ? "pending" : "inactive";
  return { state, failures: 0, lastError: "", lastFailureAt: null };
}

/** The queues this alert watches: every one whose failure has no other surface. */
export function watchedQueues(): string[] {
  return Object.entries(SUBSYSTEM_SURFACE)
    .filter(([, surface]) => surface.audience === "system")
    .map(([queue]) => queue);
}

/**
 * The newest terminal jobs of each queue, keyed by account, one statement
 * over pg-boss's `(name, completed_on)` index: the newest `LOOKBACK_ROWS` of
 * the queue, and of those the newest `LOOKBACK_ROWS_PER_KEY` of each key.
 * `null` when the queue schema is not there (a web-only deployment): no
 * queue to ask is not a healthy queue.
 */
export async function readTerminalRuns(
  queues: readonly string[],
): Promise<Map<string, TerminalRun[]> | null> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        name: string;
        job_key: string;
        state: string;
        all_failed: string | null;
        completed_on: Date;
        error: string | null;
        expire_seconds: number | null;
      }>
    >`
      SELECT q.name, k.job_key, k.state, k.all_failed, k.completed_on,
             k.error, k.expire_seconds
      FROM unnest(${queues as string[]}::text[]) AS q(name)
      CROSS JOIN LATERAL (
        SELECT j.*,
               ROW_NUMBER() OVER (
                 PARTITION BY j.job_key ORDER BY j.completed_on DESC
               ) AS key_rank
        FROM (
          SELECT state, completed_on, expire_seconds,
                 COALESCE(data->>'userId', '') AS job_key,
                 output->'did'->>'all_failed' AS all_failed,
                 COALESCE(
                   output->>'message',
                   output->'value'->>'message',
                   output::text
                 ) AS error
          FROM pgboss.job
          WHERE name = q.name
            AND completed_on IS NOT NULL
            AND state IN ('completed', 'failed')
          ORDER BY completed_on DESC
          LIMIT ${LOOKBACK_ROWS}
        ) j
      ) k
      WHERE k.key_rank <= ${LOOKBACK_ROWS_PER_KEY}
      ORDER BY q.name, k.completed_on DESC
    `;
    const byQueue = new Map<string, TerminalRun[]>();
    for (const row of rows) {
      const runs = byQueue.get(row.name) ?? [];
      runs.push({
        key: row.job_key,
        state: row.state === "failed" ? "failed" : "completed",
        allFailed: row.all_failed === "true",
        completedOn: row.completed_on,
        error: row.error,
        expireSeconds: row.expire_seconds,
      });
      byQueue.set(row.name, runs);
    }
    return byQueue;
  } catch {
    return null;
  }
}

function titleKey(kind: NoticeKind): string {
  if (kind === "recovered")
    return "notifications.systemJobAlert.titleRecovered";
  if (kind === "reminder") return "notifications.systemJobAlert.titleReminder";
  return "notifications.systemJobAlert.titleFailing";
}

export interface SystemJobAlertOutcome {
  /** Queues at or past the threshold now. */
  failing: number;
  /** Notices claimed and sent, by queue. */
  sent: Array<{ queue: string; kind: NoticeKind }>;
  /** Admins each notice went to. */
  admins: number;
}

/**
 * Judge every watched queue against what the admins were last told, claim
 * every notice that is due, and send it.
 */
export async function notifySystemJobFailures(
  now: Date = new Date(),
): Promise<SystemJobAlertOutcome> {
  const outcome: SystemJobAlertOutcome = { failing: 0, sent: [], admins: 0 };
  const runs = await readTerminalRuns(watchedQueues());
  if (runs === null) return outcome;

  // account-deletion: one row per queue of the instance; no account in it.
  const rows = await prisma.systemJobAlertNotice.findMany();
  const byQueue = new Map(rows.map((row) => [row.queue, row]));
  const admins = await prisma.user.findMany({
    where: { role: "ADMIN", ...ACTIVE_ACCOUNT },
    select: { id: true },
  });
  outcome.admins = admins.length;

  for (const queue of watchedQueues()) {
    const verdict = judgeQueueRuns(runs.get(queue) ?? []);
    if (verdict.state === "failing") outcome.failing += 1;
    // Too few failures to call it a streak and no success to call it over.
    if (verdict.state === "pending") continue;

    const row = byQueue.get(queue);
    const stored: StoredNotice | null = row
      ? {
          notifiedState:
            row.notifiedState === "failing" || row.notifiedState === "ok"
              ? row.notifiedState
              : null,
          notifiedAt: row.notifiedAt,
        }
      : null;
    const decision = decideNotice(stored, verdict.state, now);
    // With no admin yet there is nobody to tell, so nothing is claimed: the
    // first admin hears about a queue that is still failing.
    if (!decision.next || admins.length === 0) continue;
    // Nothing failed since the last notice: a job that does not run again is
    // not news a second time.
    if (
      decision.send === "reminder" &&
      stored?.notifiedAt &&
      verdict.lastFailureAt &&
      verdict.lastFailureAt.getTime() <= stored.notifiedAt.getTime()
    ) {
      continue;
    }

    // Claim: only the evaluation that moves the row from what it read sends.
    const claimed = row
      ? // account-deletion: the one queue row read above; no account in it.
        (
          await prisma.systemJobAlertNotice.updateMany({
            where: {
              queue,
              notifiedState: row.notifiedState,
              notifiedAt: row.notifiedAt,
            },
            data: {
              notifiedState: decision.next.notifiedState,
              notifiedAt: decision.next.notifiedAt,
            },
          })
        ).count
      : (
          await prisma.systemJobAlertNotice.createMany({
            data: [
              {
                queue,
                notifiedState: decision.next.notifiedState,
                notifiedAt: decision.next.notifiedAt,
              },
            ],
            skipDuplicates: true,
          })
        ).count;
    if (claimed !== 1 || decision.send === null) continue;

    for (const admin of admins) {
      await dispatchLocalisedNotification({
        userId: admin.id,
        eventType: "SYSTEM_ALERT",
        titleKey: titleKey(decision.send),
        messageKey:
          decision.send === "recovered"
            ? "notifications.systemJobAlert.bodyRecovered"
            : "notifications.systemJobAlert.bodyFailing",
        params: {
          queue,
          failures: verdict.failures,
          error: verdict.lastError,
        },
        metadata: {
          source: "system-job-alert",
          url: ADMIN_STATUS_PATH,
          queue,
          kind: decision.send,
        },
      });
    }
    outcome.sent.push({ queue, kind: decision.send });
  }
  return outcome;
}

/** The hourly evaluation. Single-flight; the next tick is the retry. */
export async function handleSystemJobAlert(
  jobs: Job<object>[],
): Promise<JobOutcome> {
  void jobs;
  return withBackgroundEvent("job.system_job_alert", async (evt) => {
    try {
      const outcome = await notifySystemJobFailures();
      const did = {
        system_jobs_failing: outcome.failing,
        system_job_notices: outcome.sent.length,
        system_job_admins: outcome.admins,
      };
      for (const [key, value] of Object.entries(did)) evt.addMeta(key, value);
      return jobDone(did);
    } catch (err) {
      evt.addWarning(`system-job-alert failed: ${err}`);
      return jobFailed("system job alert evaluation failed", err);
    }
  });
}
