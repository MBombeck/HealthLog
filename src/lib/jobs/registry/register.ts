/**
 * Turn the registry into running queues.
 *
 * For one group, in this order: create every queue (policy and retention
 * included), reconcile the policies of queues that already exist, schedule
 * every cron, remove the retired queues, then bind a handler to every queue.
 * The order is the one the hand-written registrars kept, and
 * `tests/integration/queue-registration-parity.test.ts` holds what it leaves
 * in pg-boss to the golden they produced.
 *
 * A handler is loaded on its queue's first job, not here. The wrappers that
 * shape how a job runs (the lock, the heavy lane) are applied at binding, so a
 * queue's protections do not depend on whether its module has loaded yet. A
 * module that fails to load fails the job that asked for it, with the queue's
 * name on the error, and the next job tries the import again.
 *
 * Loading lazily moved a broken module from a failed boot to a failed job: the
 * worker comes up healthy, and the queue burns its retries the first time it
 * has work, which for a one-shot job (a restore, an import tail) means the
 * job ends failed with nobody told at deploy time. `preloadHandlers` closes
 * that gap. The worker runs it once after binding, in the background, through
 * the same memoised loader the queue uses, and reports every module that does
 * not load before any job needs it.
 */
import type { Job, PgBoss } from "pg-boss";

import { heavyLane } from "@/lib/jobs/heavy-lane";
import { jobDone } from "@/lib/jobs/job-outcome";
import { dropJobsOfPendingAccounts } from "@/lib/jobs/pending-deletion-gate";
import { lockedPass } from "@/lib/jobs/long-pass";
import {
  createAndSchedule,
  createAndWork,
  retireQueues,
  type QueuePolicyTable,
  type ScheduleEntry,
} from "@/lib/jobs/reminder/registrar-shared";
import { workerLog } from "@/lib/jobs/reminder/shared";
import { reportHandlerLoadFailure } from "@/lib/jobs/run-job";

import type {
  BatchHandler,
  BootDiscovery,
  JobContext,
  JobDefinition,
  JobGroup,
} from "./define-job";

/** A queue's handler loader, memoised: one import, retried after a failure. */
export type HandlerLoader = () => Promise<BatchHandler<Job<unknown>>>;

/** One bound queue and the loader its handler goes through. */
export interface BoundLoader {
  readonly queue: string;
  readonly load: HandlerLoader;
}

/**
 * The loader a definition's binding shares: the first call imports, every
 * later call answers from the same promise, and a failed import is forgotten
 * so the next call tries again.
 */
export function handlerLoader(
  definition: JobDefinition,
  ctx: JobContext,
): HandlerLoader {
  let loading: Promise<BatchHandler<Job<unknown>>> | null = null;
  return () => {
    loading ??= definition.load(ctx).catch((err: unknown) => {
      loading = null;
      throw err;
    });
    return loading;
  };
}

/**
 * The handler a definition binds: its loaded module behind the lock and the
 * lane it declares, and behind the gate that drops a job for an account
 * pending deletion.
 */
export function bindableHandler(
  definition: JobDefinition,
  ctx: JobContext,
  load: HandlerLoader = handlerLoader(definition, ctx),
): BatchHandler<Job<unknown>> {
  // A job for an account pending deletion completes without running: it
  // was queued before the account was frozen (see `pending-deletion-gate`).
  let handler: BatchHandler<Job<unknown>> = async (jobs) => {
    if (definition.actsForPendingAccounts) return (await load())(jobs);
    const { live, dropped } = await dropJobsOfPendingAccounts(jobs);
    if (live.length === 0) {
      return jobDone({ jobs_skipped_deletion_pending: dropped });
    }
    return (await load())(live);
  };
  if (definition.lane) {
    handler = heavyLane(
      definition.queue,
      handler,
      definition.lane === true ? undefined : definition.lane,
    );
  }
  if (definition.lock) {
    handler = lockedPass(definition.queue, definition.lock, handler);
  }
  return handler;
}

/** The schedule tuples of a group, in declaration order. */
export function schedulesOf(jobs: readonly JobDefinition[]): ScheduleEntry[] {
  return jobs.flatMap((job): ScheduleEntry[] =>
    job.cron
      ? [
          job.scheduleOptions
            ? [job.queue, job.cron, { ...job.scheduleOptions }]
            : [job.queue, job.cron],
        ]
      : [],
  );
}

/** The policy table of a group. */
export function policiesOf(jobs: readonly JobDefinition[]): QueuePolicyTable {
  return Object.fromEntries(
    jobs.flatMap((job) => (job.policy ? [[job.queue, job.policy]] : [])),
  );
}

/**
 * Register one group: create, schedule, retire, bind. Returns the queue names
 * it created. `onBound` is handed each queue's loader as it is bound, so the
 * boot can preload through the very loader the queue will use.
 */
export async function registerJobGroup(
  boss: PgBoss,
  group: JobGroup,
  onBound: (bound: BoundLoader) => void = () => {},
): Promise<readonly string[]> {
  const queues = group.jobs.map((job) => job.queue);
  await createAndSchedule(
    boss,
    queues,
    schedulesOf(group.jobs),
    policiesOf(group.jobs),
  );
  if (group.retired) await retireQueues(boss, group.retired);
  const ctx: JobContext = { boss };
  for (const job of group.jobs) {
    const load = handlerLoader(job, ctx);
    await createAndWork(
      boss,
      job.queue,
      job.work,
      bindableHandler(job, ctx, load),
    );
    onBound({ queue: job.queue, load });
  }
  if (group.afterBind) await group.afterBind(ctx);
  return queues;
}

/**
 * Run one group's boot discovery. A pass that fails is logged and the next
 * one runs: a discovery miss never fails the boot, and the next boot or cron
 * tick offers the work again.
 */
export async function runBootDiscovery(
  passes: readonly BootDiscovery[],
): Promise<void> {
  for (const pass of passes) {
    try {
      const result = await pass.run();
      if (!result) continue;
      if (result.error) {
        workerLog(
          "error",
          `[${pass.name}] boot discovery failed: ${result.error}`,
        );
      } else {
        const skipped =
          result.skipped === undefined ? "" : ` skipped=${result.skipped}`;
        workerLog(
          "info",
          `[${pass.name}] boot discovery: enqueued=${result.enqueued}${skipped}`,
        );
      }
    } catch (err) {
      workerLog(
        "error",
        `[${pass.name}] boot discovery threw an unexpected error`,
        err,
      );
    }
  }
}

/**
 * Load every bound handler once, in declaration order, and report each one
 * that fails: `job.run.failed` at error with the queue's name and the reason
 * `handler_load_failed`, the line the repeated-failure alert already keys on,
 * plus the worker error report (stderr and GlitchTip). Never throws, and the
 * caller does not wait for it, so a broken module costs the boot nothing but
 * the report. A module that loads stays loaded, and the queue's first job
 * finds it in the loader's memo. Returns the queues that failed.
 */
export async function preloadHandlers(
  bound: readonly BoundLoader[],
  report: (
    queue: string,
    error: unknown,
  ) => Promise<void> = reportHandlerLoadFailure,
): Promise<string[]> {
  const failed: string[] = [];
  for (const { queue, load } of bound) {
    try {
      await load();
    } catch (error) {
      failed.push(queue);
      try {
        await report(queue, error);
      } catch (reportError) {
        // The report failing must not stop the sweep; say so on stderr.
        workerLog(
          "error",
          `[registry] reporting the load failure of ${queue} failed`,
          reportError,
        );
      }
    }
  }
  workerLog(
    failed.length === 0 ? "info" : "error",
    `[registry] preloaded ${bound.length - failed.length}/${bound.length} job handlers` +
      (failed.length === 0 ? "" : `; failed to load: ${failed.join(", ")}`),
  );
  return failed;
}
