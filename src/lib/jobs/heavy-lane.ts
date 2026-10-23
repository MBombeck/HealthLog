/**
 * One heavy job at a time per process.
 *
 * The queues in `HEAVY_QUEUES` each hold a large working set in the heap while
 * they run: an export being parsed, a whole account being restored or
 * serialised, a provider pass over every account. Web and worker share one
 * process and one heap limit, and these jobs used to run side by side when
 * their schedules or a person's upload happened to meet, so the peak was the
 * sum of whatever overlapped rather than the largest one. Under the lane a
 * heavy job runs only while no other heavy job does.
 *
 * The lane lives in the process, not the database: the heap it protects is
 * the process's own, and another process has a heap of its own.
 *
 * A job that arrives while the lane is taken does not wait in the handler. It
 * goes back to the queue (`deferLaneJobs`): its row returns to `created` with
 * `start_after` a little ahead, the claim cleared so the next fetch does not
 * count an attempt, and pg-boss's completion of the handler then finds no
 * active row and leaves it alone. Waiting in the handler instead ran the
 * job's expiry down while it stood in line, because pg-boss counts the expiry
 * from the fetch and ends the handler at it: a six-hour import let a
 * two-hour backup expire through all its retries, and an upload that waited
 * longer than its own expiry was failed, stopped counting as in use, and had
 * its staged file swept from under it. A deferred job keeps its id, its
 * retries and its staged upload, and its expiry starts when it runs.
 *
 * A deferred job also leaves word that the lane is wanted (`laneWanted`). A
 * holder that runs in slices asks it at the boundaries where it can already
 * stop and keep its place, ends its slice there, and queues the rest a little
 * later than the job that waited (`LANE_YIELD_DELAY_SECONDS`), so a long
 * import makes room for the nightly runs and for an upload instead of holding
 * them back for hours. A holder that cannot stop part-way runs to its end; a
 * job that has stood in line for `LANE_WAIT_WARN_MS` is reported at `warn`
 * (`job.heavy_lane.waiting_long`), once per holder, so a lane that is held
 * for hours shows in the alerts instead of only in `info` lines.
 *
 * A hold ends when its handler settles, and a handler that never settles
 * would hold the lane for the life of the process: pg-boss fails a job at its
 * expiry and fires its abort signal, but does not stop the handler. Every
 * heavy job would go back to the queue every minute from then on, a restore
 * an operator started among them, with nothing but one `warn` line to show for
 * it. So a hold carries the expiry of the jobs it runs. A job that finds the
 * lane held past that expiry and a grace of one deferral takes the lane, and
 * the overrun is reported at `error` (`job.heavy_lane.holder_expired`): the
 * holder has already been failed by pg-boss, so the lane is the only thing it
 * still holds.
 *
 * The container memory guard (`observability/container-memory.ts`) closes
 * the lane for a while when the cgroup's working set reaches 85 % of its
 * limit: a heavy job that arrives then goes back to the queue the same way,
 * and a holder that runs in slices gives way at its next boundary, so the
 * peak of an import does not land on top of a memory peak and end in a
 * SIGKILL. The guard holds jobs back for fifteen minutes at most.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Job } from "pg-boss";

import { prisma } from "@/lib/db";
import { jobDone, type JobOutcome } from "@/lib/jobs/job-outcome";
import { annotate } from "@/lib/logging/context";
import { memoryPressureActive } from "@/lib/observability/container-memory";
import { emitSignal } from "@/lib/logging/signal";

export interface HeavyQueue {
  /** What makes the job heavy. */
  why: string;
}

/** The queues that take the lane. */
export const HEAVY_QUEUES: Readonly<Record<string, HeavyQueue>> = {
  "apple-health-import-v2": {
    why: "Parses an export of up to several gigabytes.",
  },
  "health-connect-import": {
    why: "Reads a Health Connect export database.",
  },
  "backup-restore": {
    why: "Holds a batch of a whole account's readings per insert.",
  },
  "data-backup": { why: "Serialises every account's whole record." },
  "data-backup-offhost": {
    why: "Serialises and uploads every account's record.",
  },
  "data-restore-drill": {
    why: "Stream-parses every account's newest off-host object.",
  },
  "rollup-full-backfill": {
    why: "Folds five years of one account's readings into buckets.",
  },
  "insights-general-status": {
    why: "Builds every status snapshot for every account, a provider call each.",
  },
  "insight-pregenerate": {
    why: "The nightly walk: a comprehensive snapshot and generation per account.",
  },
  "period-narrative-warm": {
    why: "The boundary-night walk: a narrative per account and period.",
  },
  "integration-backfill-admission": {
    why: "A provider's full history for one account, page by page; the Google Health import is the largest heap in the tree.",
  },
};

/** How far ahead a deferred job is put back in the queue. */
export const LANE_DEFER_SECONDS = 60;

/**
 * How far ahead a holder that gave way queues the rest of its work: past the
 * deferred job's own return, so the job it gave way to takes the lane first.
 */
export const LANE_YIELD_DELAY_SECONDS = 2 * LANE_DEFER_SECONDS;

/** How long a job may stand in line before the wait is reported at `warn`. */
export const LANE_WAIT_WARN_MS = 2 * 60 * 60 * 1000;

/** How long past its jobs' expiry a holder keeps the lane before it is taken. */
export const LANE_HOLD_GRACE_SECONDS = LANE_DEFER_SECONDS;

/** What one trip back to the queue did. */
export interface LaneDeferral {
  /** Rows that went back. */
  deferred: number;
  /** When the oldest of them was first queued, if any went back. */
  oldestCreatedOn: Date | null;
}

/**
 * Put `jobs` of `queue` back in the queue to run `seconds` from now. The same
 * reset pg-boss's own `restore()` makes, with `start_after` moved in the same
 * statement: a restore followed by a separate update leaves a moment in which
 * another fetch could claim the row, and the completion of this handler would
 * then settle that newer claim, since a restored job's next claim keeps its
 * attempt number. Answers how many rows went back, and since when the oldest
 * of them has been waiting.
 */
export async function deferLaneJobs(
  queue: string,
  jobs: readonly Job<unknown>[],
  seconds: number = LANE_DEFER_SECONDS,
): Promise<LaneDeferral> {
  const ids = jobs.map((job) => job.id);
  const rows = await prisma.$queryRaw<Array<{ created_on: Date }>>`
    UPDATE pgboss.job
    SET state = 'created',
        started_on = NULL,
        heartbeat_on = NULL,
        upsert_by_key = NULL,
        start_after = now() + make_interval(secs => ${seconds}::int)
    WHERE name = ${queue}
      AND id = ANY(${ids}::uuid[])
      AND state = 'active'
    RETURNING created_on
  `;
  const oldest = rows.reduce<Date | null>(
    (min, row) => (min === null || row.created_on < min ? row.created_on : min),
    null,
  );
  return { deferred: rows.length, oldestCreatedOn: oldest };
}

/** The job holding the lane, and what has happened while it held it. */
interface LaneHold {
  queue: string;
  /** The first other queue that found the lane taken during this hold. */
  wantedBy: string | null;
  /** Queues whose long wait has been reported during this hold. */
  warned: Set<string>;
  /** When the hold has outlived its jobs' expiry and the grace after it. */
  expiresAt: number;
}

/**
 * When a hold of `jobs` entered at `at` has outlived them. A job without an
 * expiry (only a test stand-in has none) never forfeits the lane.
 */
function holdExpiresAt(jobs: readonly Job<unknown>[], at: number): number {
  const expiry = Math.max(...jobs.map((job) => job.expireInSeconds));
  if (!Number.isFinite(expiry)) return Number.POSITIVE_INFINITY;
  return at + (expiry + LANE_HOLD_GRACE_SECONDS) * 1000;
}

let hold: LaneHold | null = null;
const holdScope = new AsyncLocalStorage<LaneHold>();

/**
 * Whether the caller holds the lane and a job of another queue has been sent
 * back while it did. False outside the lane, so a job that runs beside the
 * lane (a light job of a heavy queue, any other queue) never gives way.
 */
export function laneWanted(): boolean {
  const current = holdScope.getStore();
  if (current === undefined || current !== hold) return false;
  return current.wantedBy !== null || memoryPressureActive();
}

function reportLongWait(
  current: LaneHold,
  queue: string,
  deferral: LaneDeferral,
  now: number,
): void {
  if (!deferral.oldestCreatedOn || current.warned.has(queue)) return;
  const waitedMs = now - deferral.oldestCreatedOn.getTime();
  if (waitedMs < LANE_WAIT_WARN_MS) return;
  current.warned.add(queue);
  emitSignal({
    action: "job.heavy_lane.waiting_long",
    level: "warn",
    meta: {
      queue,
      holder: current.queue,
      waited_minutes: Math.floor(waitedMs / 60_000),
    },
  });
}

/**
 * Wrap `handler` so the jobs of `queue` run in the lane. `inLane` picks the
 * jobs that are heavy where a queue carries light ones too (a single
 * account's warm beside the nightly walk); a batch with none of them runs at
 * once. `defer` is the way back to the queue; tests replace it, and `now`.
 */
export function heavyLane<J extends Job<unknown>>(
  queue: string,
  handler: (jobs: J[]) => Promise<JobOutcome>,
  inLane: (job: J) => boolean = () => true,
  defer: (
    queue: string,
    jobs: readonly J[],
  ) => Promise<LaneDeferral> = deferLaneJobs,
  now: () => number = Date.now,
): (jobs: J[]) => Promise<JobOutcome> {
  if (!HEAVY_QUEUES[queue]) {
    throw new Error(`heavyLane: ${queue} is not in HEAVY_QUEUES`);
  }
  return async (jobs) => {
    if (!jobs.some(inLane)) return handler(jobs);
    let current = hold;
    const at = now();
    if (current && at > current.expiresAt) {
      emitSignal({
        action: "job.heavy_lane.holder_expired",
        level: "error",
        meta: {
          holder: current.queue,
          queue,
          overran_minutes: Math.floor((at - current.expiresAt) / 60_000),
        },
      });
      hold = null;
      current = null;
    }
    if (!current && memoryPressureActive()) {
      const deferral = await defer(queue, jobs);
      annotate({
        action: { name: "job.heavy_lane.deferred" },
        meta: {
          queue,
          holder: "memory_pressure",
          jobs: jobs.length,
          deferred: deferral.deferred,
        },
      });
      return jobDone({ lane_deferred: deferral.deferred });
    }
    if (current) {
      const deferral = await defer(queue, jobs);
      if (queue !== current.queue) current.wantedBy ??= queue;
      annotate({
        action: { name: "job.heavy_lane.deferred" },
        meta: {
          queue,
          holder: current.queue,
          jobs: jobs.length,
          deferred: deferral.deferred,
        },
      });
      reportLongWait(current, queue, deferral, at);
      return jobDone({ lane_deferred: deferral.deferred });
    }
    const entered: LaneHold = {
      queue,
      wantedBy: null,
      warned: new Set(),
      expiresAt: holdExpiresAt(jobs, at),
    };
    hold = entered;
    annotate({ action: { name: "job.heavy_lane.entered" }, meta: { queue } });
    try {
      return await holdScope.run(entered, () => handler(jobs));
    } finally {
      // Only its own hold: one taken over past its expiry belongs to the job
      // that took it.
      if (hold === entered) hold = null;
    }
  };
}
