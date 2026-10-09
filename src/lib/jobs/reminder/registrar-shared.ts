/**
 * Shared plumbing for the domain-grouped queue registrars.
 *
 * v1.18.1 — `startReminderWorker()` was a 2143-LOC monolith that declared
 * every pg-boss queue name, listed them in one `allQueues` array, scheduled
 * every cron, and bound every `boss.work` handler inline. It is now decomposed
 * into domain registrars (integration-sync, status, rollup, reminders,
 * maintenance) under `src/lib/jobs/reminder/`. Each registrar owns the four
 * facts the v1.4.37 dead-queue guards pin — the queue-name constant, its
 * `allQueues` membership, its `[QUEUE, CRON]` schedule tuple, and its
 * `boss.work(QUEUE, …, handler)` binding — so a queue can never be declared
 * without being provisioned, scheduled, and drained. The boot file composes
 * the registrars; the guards follow the wiring into each registrar module.
 *
 * Every registrar returns the queue names it created so the boot file can
 * assert a single aggregate `allQueues` (defence in depth: the per-registrar
 * arrays AND the boot-level union both have to agree).
 */
import { PgBoss, type WorkOptions } from "pg-boss";

import { prisma } from "@/lib/db";

import { workerLog } from "./shared";
import { withBackgroundEvent } from "@/lib/logging/background";
import { annotate } from "@/lib/logging/context";
import {
  runJob,
  type JobHandler,
  type JobWithMetadataHandler,
} from "@/lib/jobs/run-job";
import { DEFAULT_TIMEZONE } from "@/lib/tz/format";

/**
 * Cron schedule tuple: `[queueName, cronExpression, sendOptions?]`. The
 * optional third element carries per-queue send options (e.g. the LLM-bound
 * insight retry policy) merged into the `boss.schedule` call.
 */
export type ScheduleEntry = [string, string, Record<string, unknown>?];

/**
 * The pg-boss queue policies this codebase names explicitly. `standard` —
 * pg-boss's default — is deliberately absent: under `standard` NO partial
 * unique index covers `singleton_key` at all, so a bare `singletonKey` on a
 * `send()` is inert and de-duplicates nothing. A queue that wants
 * de-duplication has to name one of the two policies below.
 *
 * From the partial unique indexes pg-boss 12.26 creates on the shared
 * `job_common` table:
 *
 *   - `short`     → UNIQUE (name, COALESCE(singleton_key,'')) WHERE state = 'created'
 *                   Collapses duplicate sends only while a job is still QUEUED.
 *                   Once it goes active, a fresh send is admitted again.
 *   - `exclusive` → UNIQUE (name, COALESCE(singleton_key,'')) WHERE state <= 'active'
 *                   Collapses duplicate sends while a job is queued OR active
 *                   OR waiting out a retry backoff.
 *
 * Picking between them is a correctness question, not a taste question:
 *
 *   - `short` when the handler re-reads current state at run time. Suppressing
 *     a send while an identical job is still QUEUED is then provably safe —
 *     that job has read nothing yet and will observe the newer write when it
 *     starts. Suppressing a send after the reader already STARTED would strand
 *     the newer write, which is why these queues must not be `exclusive`.
 *   - `exclusive` when a second concurrent run is pure duplicated work AND the
 *     enqueue side is self-converging — a discovery pass that re-enqueues on
 *     the next boot or cron tick while the work is still outstanding.
 *
 * On a conflict pg-boss inserts with `ON CONFLICT DO NOTHING ... RETURNING`, so
 * `boss.send()` resolves to `null` instead of throwing. Every enqueue helper in
 * this tree already counts a null id as `skipped`.
 */
export type QueuePolicy = "short" | "exclusive";

/**
 * A per-queue policy decision plus the reason behind it. The reason is not
 * decoration: the policy encodes a claim about whether the handler re-reads
 * state at run time and whether the enqueue side re-converges. Anyone changing
 * a handler needs that claim written down rather than re-derived from the call
 * sites.
 */
export type QueuePolicyDecision = {
  policy: QueuePolicy;
  reason: string;
};

/** Queue name → decision. Queues absent from a table keep pg-boss's `standard`. */
export type QueuePolicyTable = Readonly<Record<string, QueuePolicyDecision>>;

/**
 * Bring the policy of ALREADY-EXISTING queues in line with the tables below.
 *
 * Why this is needed at all: pg-boss's `create_queue()` SQL function ends in
 * `ON CONFLICT DO NOTHING`, so passing `{ policy }` to `boss.createQueue()`
 * only takes effect the first time a queue is provisioned. Every queue on an
 * already-running instance was created under the default `standard` policy, and
 * `boss.updateQueue()` rejects a policy change outright ("queue policy cannot be
 * changed after creation"). Without this reconcile the policy tables would be
 * correct on a fresh database and completely inert on every existing
 * deployment — a change that tests green and fixes nothing.
 *
 * Why writing the column directly is sound here: the partial unique indexes for
 * every policy are created once on the shared `job_common` table at schema
 * setup (this deployment does not use per-queue table partitioning), so the
 * index a newly-claimed policy needs already exists. A job row's own `policy`
 * value is resolved by joining `pgboss.queue` at insert time, so a changed
 * column takes effect on the next `send()` without a worker restart and without
 * depending on pg-boss's in-process queue cache. Jobs already in flight keep
 * the policy they were inserted under and simply do not participate in the new
 * index, which is the correct transitional behaviour.
 *
 * Scope is deliberately narrow: only queue names this codebase decided on, only
 * where the stored policy actually differs, parameter-bound, and never a change
 * to a queue absent from the tables.
 */
async function reconcileQueuePolicies(
  policies: QueuePolicyTable,
): Promise<void> {
  const reconciled: string[] = [];
  const failed: string[] = [];

  for (const [name, { policy }] of Object.entries(policies)) {
    try {
      const changed = await prisma.$executeRaw`
        UPDATE pgboss.queue
        SET policy = ${policy}, updated_on = now()
        WHERE name = ${name} AND policy IS DISTINCT FROM ${policy}
      `;
      if (changed > 0) reconciled.push(`${name}=${policy}`);
    } catch (err) {
      // Never fail worker boot on a reconcile miss: the queue still works, it
      // just keeps whatever de-duplication semantics it already had.
      failed.push(name);
      workerLog("error", `[queue-policy] failed to reconcile ${name}`, err);
    }
  }

  // The reconcile is the ONLY thing that carries a policy onto a queue that
  // already exists — `createQueue` cannot, because `create_queue()` ends in
  // ON CONFLICT DO NOTHING. So whether it ran is the difference between this
  // fix working and doing nothing at all on an upgraded instance, and that has
  // to be observable. `workerLog("info", …)` is deliberately silent, which
  // made the intended signal impossible to see; a wide event reaches stdout
  // and the log store like every other boot task.
  //
  // Emitted on EVERY boot, including the no-op one: "reconciled 0" on a second
  // boot is the confirmation that the first boot already migrated everything.
  // Silence would be indistinguishable from the reconcile never running.
  await withBackgroundEvent("worker.boot.queue_policy_reconcile", async () => {
    annotate({
      meta: {
        queue_policy_reconciled_count: reconciled.length,
        queue_policy_reconciled: reconciled.join(",") || "none",
        queue_policy_failed_count: failed.length,
      },
    });
  });
}

/**
 * Shared retry policy for the LLM-bound insight queues. A transient failure
 * (provider hiccup, pool exhaustion) used to fail the nightly tick silently
 * until the NEXT night; three backed-off retries match the backfill queues'
 * established shape (see e.g. whoop-backfill.ts).
 */
export const insightRetryOptions = {
  retryLimit: 3,
  retryDelay: 60,
  retryBackoff: true,
} as const;

/**
 * Send options for a nightly AI pass over every account (the status crons).
 *
 * The retries of `insightRetryOptions`, plus a two-hour expiry. Each pass
 * makes a provider call per account, and on a large instance that outlasted
 * pg-boss's fifteen-minute default: the job was declared dead and retried
 * beside the pass still running. The pass now stops itself at three quarters
 * of this (`jobBudget`) and holds a lock (`lockedPass`). The options ride on
 * the schedule because the cron is the only sender.
 */
export const NIGHTLY_INSIGHT_PASS_EXPIRE_SECONDS = 2 * 60 * 60;
export const nightlyInsightPassOptions = {
  ...insightRetryOptions,
  expireInSeconds: NIGHTLY_INSIGHT_PASS_EXPIRE_SECONDS,
} as const;

/**
 * Retry policy for a cron-driven pass whose failure mode is deterministic.
 *
 * Handlers now return a `JobOutcome`, and the retention cleanups that used to
 * warn-and-return fail their job instead. That is the point — but it walks
 * into pg-boss's queue default of `retryLimit: 2` with no delay and no
 * backoff, so a bulk DELETE that timed out against a large trailing edge
 * would run twice more, immediately, against the same rows. Three doomed
 * sequential scans a night is a worse outcome than the silence it replaced.
 *
 * For this class the next cron tick IS the retry, and it arrives with the
 * whole gap as backoff. So the schedule declares zero retries: the failure is
 * recorded once, reaches the operator once, and the pass tries again on its
 * own cadence.
 *
 * It rides on the SCHEDULE rather than on `createQueue`, deliberately.
 * pg-boss's `create_queue()` ends in ON CONFLICT DO NOTHING, so a queue-level
 * default would be inert on every already-running instance — the same trap
 * `reconcileQueuePolicies` above exists to work around. Send options apply to
 * every job the cron mints, new database or old.
 *
 * Use it only where the failure genuinely repeats. A transient failure (a TLS
 * probe, an S3 fetch, a provider call) wants the default retries, not this.
 */
export const cronIsTheRetry = { retryLimit: 0 } as const;

/**
 * pg-boss's internal queue the cron timekeeper sends through: one job per
 * schedule tick, for every schedule.
 */
const PG_BOSS_SEND_IT_QUEUE = "__pgboss__send-it";

/**
 * The shortest retention a queue may be given: the 72-hour failure window
 * `job-failures.ts` reads back from pg-boss's terminal rows, plus a day. A
 * failed job stays in `pgboss.job` until `completed_on + deletion_seconds`,
 * so a queue kept for less than the window would make its failures vanish
 * from the admin status before they were ever shown.
 */
export const QUEUE_RETENTION_FLOOR_SECONDS = 96 * 60 * 60;

/**
 * v1.42 — pure volume queues and their terminal-row retention
 * (`deleteAfterSeconds`). pg-boss keeps every completed and failed job for
 * seven days by default; these queues mint a job every few minutes, or one
 * per write, and nothing reads their history beyond the failure window, so
 * their rows were most of `pgboss.job` and of its sequential scans. Every
 * other queue keeps the default. Each value is held at or above
 * {@link QUEUE_RETENTION_FLOOR_SECONDS} by `queue-retention.test.ts`.
 */
export const VOLUME_QUEUE_DELETE_AFTER_SECONDS: Readonly<
  Record<string, number>
> = {
  // Every five minutes, all day.
  "host-metric-sample": QUEUE_RETENTION_FLOOR_SECONDS,
  // One job per (user, type, day) a write touched.
  "rollup-recompute": QUEUE_RETENTION_FLOOR_SECONDS,
  // One job per write that dirties a status card.
  "insight-status-generate": QUEUE_RETENTION_FLOOR_SECONDS,
  // One job per schedule tick, for every cron in the tree.
  [PG_BOSS_SEND_IT_QUEUE]: QUEUE_RETENTION_FLOOR_SECONDS,
};

/**
 * Bring the retention of already-existing volume queues in line with the
 * table above. `createQueue` only applies its options when it creates the
 * queue, so an upgraded instance needs the update; `updateQueue` may change
 * `deleteAfterSeconds` (unlike the policy). A job copies the value when it is
 * inserted, so rows already in the table keep theirs and age out as before.
 * Never fails a boot.
 */
async function reconcileVolumeQueueRetention(
  boss: PgBoss,
  queues: readonly string[],
): Promise<void> {
  const reconciled: string[] = [];
  const failed: string[] = [];
  for (const name of queues) {
    const deleteAfterSeconds = VOLUME_QUEUE_DELETE_AFTER_SECONDS[name];
    if (deleteAfterSeconds === undefined) continue;
    try {
      await boss.updateQueue(name, { deleteAfterSeconds });
      reconciled.push(name);
    } catch (err) {
      failed.push(name);
      workerLog("error", `[queue-retention] failed to update ${name}`, err);
    }
  }
  if (reconciled.length === 0 && failed.length === 0) return;
  await withBackgroundEvent(
    "worker.boot.queue_retention_reconcile",
    async () => {
      annotate({
        meta: {
          queue_retention_reconciled: reconciled.join(",") || "none",
          queue_retention_failed_count: failed.length,
        },
      });
    },
  );
}

/**
 * Create every queue in `queues`, then schedule every cron in `schedules`.
 * Centralised so each registrar provisions before it schedules in the exact
 * order the monolith did, and the `Europe/Berlin` tz default stays in one
 * place.
 *
 * `policies` carries the registrar's per-queue de-duplication decisions. It is
 * applied on both legs — as the creation policy for a queue that does not exist
 * yet, and through `reconcileQueuePolicies` for one that does. A queue absent
 * from the table keeps pg-boss's `standard` policy, which means no
 * de-duplication at all; that is a valid choice, but it must be a deliberate
 * one, so the tables document the omissions too.
 */
export async function createAndSchedule(
  boss: PgBoss,
  queues: readonly string[],
  schedules: readonly ScheduleEntry[],
  policies: QueuePolicyTable = {},
): Promise<void> {
  for (const q of queues) {
    const decision = policies[q];
    const deleteAfterSeconds = VOLUME_QUEUE_DELETE_AFTER_SECONDS[q];
    await boss.createQueue(q, {
      ...(decision ? { policy: decision.policy } : {}),
      ...(deleteAfterSeconds !== undefined ? { deleteAfterSeconds } : {}),
    });
  }
  await reconcileQueuePolicies(policies);
  // The cron timekeeper's own queue exists once pg-boss has started, and only
  // a registrar that schedules something sends through it.
  await reconcileVolumeQueueRetention(boss, [
    ...queues,
    ...(schedules.length > 0 ? [PG_BOSS_SEND_IT_QUEUE] : []),
  ]);
  for (const [name, cron, sendOptions] of schedules) {
    await boss.schedule(
      name,
      cron,
      {},
      {
        tz: DEFAULT_TIMEZONE,
        ...(sendOptions ?? {}),
      },
    );
  }
}

/**
 * Bind a handler to a queue. The one legal way to reach `boss.work` in this
 * tree — the `healthlog/job-handler-outcome` lint rule refuses a bare
 * `boss.work(` anywhere else.
 *
 * The point of routing every binding through here is the handler type:
 * `JobHandler<T>` resolves to `Promise<JobOutcome>`, so a handler cannot be
 * bound unless it returns a value declaring what it did. `runJob` then fails
 * the pg-boss job on `ok: false` instead of completing it. Falling off the
 * end of a handler, which used to read as success, is now a type error.
 *
 * Argument order matches `boss.work(queue, options, handler)` so a binding
 * reads the same as it did before, with `boss` moved to the front.
 */
export async function createAndWork<T>(
  boss: PgBoss,
  queue: string,
  options: WorkOptions & { includeMetadata: true },
  handler: JobWithMetadataHandler<T>,
): Promise<void>;
export async function createAndWork<T>(
  boss: PgBoss,
  queue: string,
  options: WorkOptions,
  handler: JobHandler<T>,
): Promise<void>;
export async function createAndWork<T>(
  boss: PgBoss,
  queue: string,
  options: WorkOptions,
  handler: JobHandler<T> | JobWithMetadataHandler<T>,
): Promise<void> {
  // `JobWithMetadata<T>` extends `Job<T>`, so the metadata handler accepts
  // everything the plain one does; the overloads above are what keeps the
  // call sites honest about which shape they asked pg-boss for.
  await boss.work<T>(queue, options, runJob(queue, handler as JobHandler<T>));
}
