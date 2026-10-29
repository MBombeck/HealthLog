/**
 * Push to every admin when a background job of the instance keeps failing:
 * once when a queue has failed `SYSTEM_JOB_FAILURE_STREAK` runs in a row, a
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
 * The streak is read from pg-boss's own ledger, newest terminal run first: a
 * run that failed (or completed and said every candidate failed,
 * `did.all_failed`) adds its attempts, retries included, and the first run
 * that succeeded ends the streak. A queue with no terminal run left in the
 * ledger is not judged at all.
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

/** Failed runs in a row, retries included, before the admins are told. */
export const SYSTEM_JOB_FAILURE_STREAK = 3;

/** Newest terminal runs read per queue. */
const LOOKBACK_ROWS = 50;

/** Where the notice takes the admin: the page with the failing-jobs card. */
const ADMIN_STATUS_PATH = "/admin/system-status";

/** One terminal run as the ledger holds it, newest first. */
export interface TerminalRun {
  state: "completed" | "failed";
  /** Retries pg-boss ran before this run settled. */
  retryCount: number;
  /** The run completed but reported that every candidate failed. */
  allFailed: boolean;
  completedOn: Date;
  error: string | null;
  expireSeconds: number | null;
}

/** What the ledger says about one queue. */
export interface QueueVerdict {
  /**
   * `failing`: the streak reached the threshold. `ok`: the newest run, or a
   * run after the last failures, succeeded. `pending`: fewer failures than
   * the threshold and no success to judge by. `inactive`: no run left.
   */
  state: "failing" | "ok" | "pending" | "inactive";
  /** Failed attempts in a row, newest first. */
  failures: number;
  /** The newest failure's message, redacted and truncated. */
  lastError: string;
}

/** Pure: judge one queue's newest terminal runs. */
export function judgeQueueRuns(runs: readonly TerminalRun[]): QueueVerdict {
  if (runs.length === 0)
    return { state: "inactive", failures: 0, lastError: "" };
  let failures = 0;
  let lastError: string | null = null;
  let succeeded = false;
  for (const run of runs) {
    if (run.state === "completed" && !run.allFailed) {
      succeeded = true;
      break;
    }
    failures += run.retryCount + 1;
    lastError ??= presentError(run.error, run.expireSeconds);
  }
  const state =
    failures >= SYSTEM_JOB_FAILURE_STREAK
      ? "failing"
      : succeeded
        ? "ok"
        : "pending";
  return { state, failures, lastError: lastError ?? "" };
}

/** The queues this alert watches: every one whose failure has no other surface. */
export function watchedQueues(): string[] {
  return Object.entries(SUBSYSTEM_SURFACE)
    .filter(([, surface]) => surface.audience === "system")
    .map(([queue]) => queue);
}

/**
 * The newest terminal runs of each queue, newest first, one statement over
 * pg-boss's `(name, completed_on)` index. `null` when the queue schema is not
 * there (a web-only deployment): no queue to ask is not a healthy queue.
 */
export async function readTerminalRuns(
  queues: readonly string[],
): Promise<Map<string, TerminalRun[]> | null> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        name: string;
        state: string;
        retry_count: number;
        all_failed: string | null;
        completed_on: Date;
        error: string | null;
        expire_seconds: number | null;
      }>
    >`
      SELECT q.name, j.state, j.retry_count, j.all_failed, j.completed_on,
             j.error, j.expire_seconds
      FROM unnest(${queues as string[]}::text[]) AS q(name)
      CROSS JOIN LATERAL (
        SELECT state, retry_count, completed_on, expire_seconds,
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
      ORDER BY q.name, j.completed_on DESC
    `;
    const byQueue = new Map<string, TerminalRun[]>();
    for (const row of rows) {
      const runs = byQueue.get(row.name) ?? [];
      runs.push({
        state: row.state === "failed" ? "failed" : "completed",
        retryCount: Number(row.retry_count ?? 0),
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
