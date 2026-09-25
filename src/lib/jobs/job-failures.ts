/**
 * What the queue already knows about its own broken jobs, read back out.
 *
 * The `environment-fetch` job threw on every single run for the whole life of
 * the environmental-context module. It was handled correctly at the call site —
 * `recordError()`, a `workerLog("error", …)`, a rethrow so pg-boss retries —
 * and none of that reached a screen. `recordError()` increments one unnamed
 * counter, so `/api/admin/status` could say "errors: 41" and not which queue.
 * The worker log only exists where someone is tailing the container. The user
 * saw "0 days recorded" and had no way to tell an empty module from a broken
 * one.
 *
 * pg-boss has held the answer the whole time: a job that exhausts its retries
 * lands in `pgboss.job` with `state = 'failed'`, its queue name, the thrown
 * error in `output`, and the instant it gave up. Reading that back is a
 * complete signal for every queue at once, and it needs nothing from the ~30
 * `recordError()` call sites — which is the point, because a visibility fix
 * that has to be remembered at each call site is the same failure mode one
 * level up.
 *
 * Both readers fail soft to `null`. The `pgboss` schema is created by the
 * worker, so a web-only deployment legitimately has no such table, and the
 * admin status page must not 500 because the queue is absent. `null` means "no
 * queue to ask", which is not the same fact as an empty array ("asked, nothing
 * broken") — the callers keep the two apart.
 */
import { prisma } from "@/lib/db";
import { redactSecrets } from "@/lib/logging/redact";

/**
 * pg-boss 12.26.0 stores terminal rows until
 * `completed_on + deletion_seconds` (`dist/plans.js`). Its queue default is
 * 604800 seconds, while `retention_seconds` defaults to 1209600 seconds; job
 * insertion copies those queue values and maintenance applies the terminal-row
 * deletion clock. The deployed queue-table audit found those same values on
 * every queue, and no job submitter overrides either option.
 *
 * Seven days is therefore the verified availability floor for failed rows.
 * The reader stays at 72 hours, safely inside that floor, and pg-boss remains
 * the single failure ledger.
 */
export const PG_BOSS_FAILED_ROW_AVAILABILITY_HOURS = 7 * 24;

/** How far back a failure still counts as news. */
export const JOB_FAILURE_WINDOW_HOURS = 72;

/** Queues named in one report — enough to see a pattern, bounded for the wire. */
const MAX_QUEUES = 20;

/** The error text is for a human reading a status page, not for a stack trace. */
const MAX_ERROR_CHARS = 300;

export interface FailingQueue {
  /** The pg-boss queue name, e.g. `environment-fetch`. */
  queue: string;
  /** Jobs that exhausted their retries inside the window. */
  failures: number;
  /** ISO instant of the newest failure. */
  lastFailedAt: string;
  /** The newest failure's message, redacted and truncated. */
  lastError: string;
}

interface FailingQueueRow {
  name: string;
  failures: number;
  last_failed_at: Date | null;
  last_error: string | null;
  last_expire_seconds: number | null;
}

/**
 * The two texts pg-boss writes when a job ran out of time: the supervisor's,
 * for a job still `active` past its expiry, and the worker's own, for a
 * handler that did not settle inside it.
 */
const TIMEOUT_MESSAGE = /^(job timed out|handler execution exceeded \d+s)$/;

/**
 * Say what a bare timeout means. "job timed out" alone sent an operator
 * nowhere: pg-boss writes the same words for a pass that was too slow for its
 * limit and for a job whose process died under it (a restart, or a container
 * killed for memory), in which case the job sits `active` until the limit runs
 * out. The limit and the two causes are what the operator can check.
 */
function explainTimeout(message: string, expireSeconds: number | null): string {
  const limit =
    expireSeconds !== null && expireSeconds > 0
      ? expireSeconds >= 3600 && expireSeconds % 3600 === 0
        ? `${expireSeconds / 3600} h`
        : `${Math.round(expireSeconds / 60)} min`
      : null;
  return (
    `${message}: did not finish within its ${limit ?? "time"} limit. ` +
    `Either the run was too slow for the limit, or the app restarted while it ` +
    `ran; a restart shows in the container's restart count and log.`
  );
}

/**
 * Turn whatever pg-boss stored in `output` into one line. A thrown `Error`
 * serialises to `{ message, stack, … }`; a thrown non-Error can be any JSON at
 * all, so the raw text is the fallback rather than an invented placeholder.
 */
function presentError(
  raw: string | null,
  expireSeconds: number | null = null,
): string {
  if (raw === null) return "";
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";
  if (TIMEOUT_MESSAGE.test(trimmed))
    return explainTimeout(trimmed, expireSeconds);
  const redacted = redactSecrets(trimmed);
  return redacted.length > MAX_ERROR_CHARS
    ? `${redacted.slice(0, MAX_ERROR_CHARS)}…`
    : redacted;
}

/**
 * Every queue with at least one exhausted-retry failure in the window, newest
 * first. `null` when the queue schema is not present at all.
 */
export async function readFailingQueues(
  withinHours: number = JOB_FAILURE_WINDOW_HOURS,
): Promise<FailingQueue[] | null> {
  try {
    const rows = await prisma.$queryRaw<FailingQueueRow[]>`
      SELECT
        name,
        count(*)::int AS failures,
        max(completed_on) AS last_failed_at,
        (
          array_agg(
            COALESCE(
              output->>'message',
              output->'value'->>'message',
              output::text
            )
            ORDER BY completed_on DESC NULLS LAST
          )
        )[1] AS last_error,
        (
          array_agg(expire_seconds ORDER BY completed_on DESC NULLS LAST)
        )[1] AS last_expire_seconds
      FROM pgboss.job
      WHERE state = 'failed'
        AND completed_on > now() - make_interval(hours => ${withinHours}::int)
      GROUP BY name
      ORDER BY max(completed_on) DESC
      LIMIT ${MAX_QUEUES}
    `;
    return rows
      .filter((row) => row.last_failed_at !== null)
      .map((row) => ({
        queue: row.name,
        failures: row.failures,
        lastFailedAt: row.last_failed_at!.toISOString(),
        lastError: presentError(row.last_error, row.last_expire_seconds),
      }));
  } catch {
    // No `pgboss` schema (web-only deployment) or no permission to read it.
    // Absence of a queue is not a failing queue, and it is not zero either.
    return null;
  }
}

/** The terminal state pg-boss recorded for the newest run of one queue. */
export interface LastQueueRun {
  /** ISO instant the run reached its terminal state. */
  at: string;
  /** `failed` covers both a thrown handler and an expired (killed) job. */
  state: "completed" | "failed" | "cancelled";
  /** The failure text, redacted and truncated. Null when the run succeeded. */
  error: string | null;
}

/**
 * The newest terminal run of one queue, whatever its outcome.
 *
 * `readFailingQueues` answers "what broke recently" and is deliberately scoped
 * to a 72-hour window, which is the right shape for a status page watching
 * thirty queues that tick by the minute. It is the wrong shape for a WEEKLY
 * pass: a Sunday-night failure has fallen out of the window by Wednesday, so a
 * job that fails every single week is visible for three days in seven and
 * invisible for four. This reader takes the newest run instead of a window, so
 * a weekly queue's last outcome is readable right up until the next one.
 *
 * Bounded by pg-boss's own retention: terminal rows live `deletion_seconds`
 * (seven days by default) past completion, so `null` here means "no run row
 * survives", which is not the same as "the pass never ran". Callers pair it
 * with a fact that does not age out — for backups, the age of the newest
 * stored copy.
 */
export async function readLastQueueRun(
  queue: string,
): Promise<LastQueueRun | null> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        state: string;
        completed_on: Date | null;
        output: string | null;
        expire_seconds: number | null;
      }>
    >`
      SELECT
        state,
        completed_on,
        expire_seconds,
        -- pg-boss wraps a thrown value: an expired job's row reads
        -- {"value":{"message":"job timed out"}}, so a plain ->>'message'
        -- misses it and the operator gets raw JSON instead of the sentence.
        COALESCE(
          output->>'message',
          output->'value'->>'message',
          output::text
        ) AS output
      FROM pgboss.job
      WHERE name = ${queue}
        AND state IN ('completed', 'failed', 'cancelled')
        AND completed_on IS NOT NULL
      ORDER BY completed_on DESC
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.completed_on === null) return null;
    const state =
      row.state === "failed" || row.state === "cancelled"
        ? row.state
        : "completed";
    return {
      at: row.completed_on.toISOString(),
      state,
      error:
        state === "completed"
          ? null
          : presentError(row.output, row.expire_seconds),
    };
  } catch {
    // No `pgboss` schema (web-only deployment) or no permission to read it.
    return null;
  }
}

export interface QueueFailureForUser {
  /** ISO instant the user's newest job on this queue gave up. */
  lastFailedAt: string;
  /** Failures for this user on this queue inside the window. */
  failures: number;
}

/**
 * The newest exhausted-retry failure of `queue` for one account, matched on the
 * `userId` the job payload carries. Used by a user-facing surface to say "the
 * last background run failed" instead of rendering a zero as if it were a
 * measurement. Deliberately carries no error text: the message is written for
 * an operator and can name internals, so a non-admin reader gets the fact and
 * the time only.
 */
export async function readQueueFailureForUser(
  queue: string,
  userId: string,
  withinHours: number = JOB_FAILURE_WINDOW_HOURS,
): Promise<QueueFailureForUser | null> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{ failures: number; last_failed_at: Date | null }>
    >`
      SELECT count(*)::int AS failures, max(completed_on) AS last_failed_at
      FROM pgboss.job
      WHERE name = ${queue}
        AND state = 'failed'
        AND data->>'userId' = ${userId}
        AND completed_on > now() - make_interval(hours => ${withinHours}::int)
    `;
    const row = rows[0];
    if (!row || row.last_failed_at === null || row.failures === 0) return null;
    return {
      lastFailedAt: row.last_failed_at.toISOString(),
      failures: row.failures,
    };
  } catch {
    return null;
  }
}

/** A job pg-boss still has as running, from `readActiveJobsStartedBefore`. */
export interface ActiveJob {
  queue: string;
  id: string;
  /** ISO instant the job was picked up. */
  startedAt: string;
  /** The job's expiry, in seconds, as pg-boss holds it. */
  expireSeconds: number;
}

/**
 * Jobs still marked active that were picked up before `before` — at worker
 * boot, before this process has taken any job, that is every job a previous
 * process was running when it stopped.
 *
 * Why it matters (#1031): a worker killed for memory writes nothing, and
 * pg-boss only marks its job `job timed out` once the expiry has passed,
 * which for the backup is two hours later. Reading these rows at boot turns
 * a silent restart into a line naming what was cut off. With more than one
 * worker process on the same database, a job another live worker is running
 * would show up here too, which the boot line says.
 *
 * `null` when the queue schema is absent, like the readers above.
 */
export async function readActiveJobsStartedBefore(
  before: Date,
): Promise<ActiveJob[] | null> {
  try {
    const rows = await prisma.$queryRaw<
      Array<{
        name: string;
        id: string;
        started_on: Date | null;
        expire_seconds: number;
      }>
    >`
      SELECT name, id::text AS id, started_on, expire_seconds
      FROM pgboss.job
      WHERE state = 'active' AND started_on < ${before}
      ORDER BY started_on
      LIMIT ${MAX_QUEUES}
    `;
    return rows
      .filter((row) => row.started_on !== null)
      .map((row) => ({
        queue: row.name,
        id: row.id,
        startedAt: row.started_on!.toISOString(),
        expireSeconds: row.expire_seconds,
      }));
  } catch {
    return null;
  }
}
