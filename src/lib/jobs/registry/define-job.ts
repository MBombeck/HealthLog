/**
 * The declaration of one pg-boss queue: everything the worker needs to
 * provision, schedule and drain it, in one object.
 *
 * Every queue the worker runs is a `defineJob(...)` entry in one of the
 * registry groups (`./integration-sync.ts`, `./status.ts`, `./rollup.ts`,
 * `./reminders.ts`, `./maintenance.ts`). `registerJobGroup` turns a group into
 * the four facts the dead-queue class keeps losing: the queue exists, its cron
 * is scheduled with the send options it carries, its de-duplication policy is
 * set, and a handler drains it. A queue cannot be declared without all four.
 *
 * The handler is not imported here. `load` names the module it lives in with
 * a dynamic import, and the worker evaluates it when the queue's first job
 * arrives, so booting the worker loads the registry and nothing of the work.
 * The facts a declaration needs at boot (names, crons, concurrency, send
 * options) therefore come from light modules (`*-queue.ts`, `*-shared.ts`),
 * never from a handler module; `job-registry-graph.test.ts` holds that.
 */
import type { Job, PgBoss, WorkOptions } from "pg-boss";

import type { JobOutcome } from "@/lib/jobs/job-outcome";
import type { QueuePolicyDecision } from "@/lib/jobs/reminder/registrar-shared";

/** The groups, in the order the worker registers them. */
export const JOB_GROUP_NAMES = [
  "integration_sync",
  "status",
  "rollup",
  "reminders",
  "maintenance",
] as const;

export type JobGroupName = (typeof JOB_GROUP_NAMES)[number];

/** What a handler loader is handed: the worker's own boss, for re-sends. */
export interface JobContext {
  readonly boss: PgBoss;
}

/** A handler as pg-boss calls it: a batch of jobs, one outcome. */
export type BatchHandler<J extends Job<unknown>> = (
  jobs: J[],
) => Promise<JobOutcome>;

export interface JobSpec<J extends Job<unknown>> {
  readonly queue: string;
  /** The cron that feeds the queue, in the default zone. */
  readonly cron?: string;
  /**
   * Send options every job the cron mints carries (retries, expiry). They ride
   * on the schedule because `createQueue` cannot change an existing queue.
   */
  readonly scheduleOptions?: Readonly<Record<string, unknown>>;
  /** De-duplication policy; absent keeps pg-boss's `standard`. */
  readonly policy?: QueuePolicyDecision;
  /** Work options of the binding (concurrency, metadata, poll). */
  readonly work: WorkOptions;
  /**
   * One run per identity at a time (`lockedPass`), held outside the lane so a
   * retry pg-boss starts after an expiry finds the run still going.
   */
  readonly lock?: (job: J) => string;
  /**
   * The job runs in the heavy lane (`heavyLane`): `true` for every job, or a
   * filter of the jobs that are heavy on a queue that also carries light ones.
   */
  readonly lane?: true | ((job: J) => boolean);
  /**
   * The queue's per-account jobs run for an account pending deletion too.
   * Without it a job whose payload names such an account is completed
   * without running (`pending-deletion-gate`). Only for work that changes
   * how rows are stored and not what the record holds (an encryption
   * backfill), which is done or erased the same either way.
   */
  readonly actsForPendingAccounts?: true;
  /** Loads the handler that drains the queue. */
  readonly load: (ctx: JobContext) => Promise<BatchHandler<J>>;
}

/** A declaration with its payload type erased, as the registry holds it. */
export type JobDefinition = JobSpec<Job<unknown>>;

export function defineJob<J extends Job<unknown>>(
  spec: JobSpec<J>,
): JobDefinition {
  // The payload type is the declaration's own business; the registry only
  // passes jobs through to the handler that declared it.
  return spec as unknown as JobDefinition;
}

/** What a boot discovery pass reports, as the backfill helpers return it. */
export interface DiscoveryResult {
  /** How many jobs it enqueued, or whether it enqueued its one job. */
  readonly enqueued: number | boolean;
  readonly skipped?: number;
  readonly error?: string | null;
}

/**
 * A self-converging pass the worker runs once at boot (after every queue is
 * bound): it finds the accounts that still need a backfill or repair and
 * enqueues one job each. `name` is the log prefix.
 */
export interface BootDiscovery {
  readonly name: string;
  readonly run: () => Promise<DiscoveryResult | void>;
}

export interface JobGroup {
  readonly name: JobGroupName;
  readonly jobs: readonly JobDefinition[];
  /** Queues an older release created and this one removes, with whatever they hold. */
  readonly retired?: readonly string[];
  /** Work that needs the group's handlers bound, before the boot discovery. */
  readonly afterBind?: (ctx: JobContext) => Promise<void>;
  readonly discovery?: readonly BootDiscovery[];
}
