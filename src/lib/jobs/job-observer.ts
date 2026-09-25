/**
 * Log lines for long-running and cut-off jobs.
 *
 * Issue #1031: on a large account three queues failed night after night with
 * `job timed out`, and the operator found not one line about any of them in
 * the app log. Nothing wrote one. Most handlers annotate a wide event that
 * nobody emits, pg-boss records an expiry only in its own table, and a worker
 * killed for memory cannot say anything at all. The admin card showed the
 * failure; the log showed nothing about what the job was doing, how far it
 * got, or why it stopped.
 *
 * `observeJob` wraps every handler (through `runJob`) and writes three kinds
 * of line, each a background wide event naming the queue:
 *
 *   - `job.progress`, every two minutes while a handler runs, with how long it
 *     has been running, the process's memory, and whatever the handler last
 *     reported through `reportJobProgress`. A job that runs for a minute never
 *     writes one; a job that is killed leaves its last one behind.
 *   - `job.expired`, at the job's expiry if the handler has not settled: the
 *     moment pg-boss declares it timed out. pg-boss does not stop the handler,
 *     so this line says it is still running and how far it has got.
 *   - `job.finished`, when a handler that ran long or past its expiry
 *     settles, with its outcome and the facts it returned.
 *
 * `reportOrphanedJobs` covers the case no running handler can: at worker boot,
 * jobs still marked active were started by a process that is gone.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import { WideEventBuilder } from "@/lib/logging/event-builder";
import { emitIfSampled } from "@/lib/logging/transports";
import { readActiveJobsStartedBefore } from "@/lib/jobs/job-failures";

/** How often a running job writes `job.progress`. */
export const JOB_PROGRESS_INTERVAL_MS = 2 * 60 * 1000;

/** A handler that ran at least this long writes `job.finished`. */
export const JOB_LONG_RUN_MS = 60 * 1000;

type ProgressFacts = Record<string, string | number | boolean>;

const progressStore = new AsyncLocalStorage<{ facts: ProgressFacts }>();

/**
 * Record how far the running job has got. Cheap: it only replaces the facts
 * the next `job.progress` / `job.expired` line carries, so a pass can call it
 * once per unit of work. A no-op outside an observed job.
 */
export function reportJobProgress(facts: ProgressFacts): void {
  const cell = progressStore.getStore();
  if (cell) cell.facts = { ...cell.facts, ...facts };
}

/** What `observeJob` reads from a pg-boss job. */
interface ObservedJob {
  id?: string;
  expireInSeconds?: number;
}

/** Injectable clock and timers, for tests. */
export interface JobObserverClock {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  clearInterval: (handle: unknown) => void;
}

const systemClock: JobObserverClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms).unref(),
  setInterval: (fn, ms) => setInterval(fn, ms).unref(),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

function megabytes(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

function emitJobLine(
  taskName: string,
  level: "info" | "warn",
  meta: Record<string, unknown>,
): void {
  try {
    const event = new WideEventBuilder("background");
    event.setBackground({ task_name: taskName });
    for (const [key, value] of Object.entries(meta)) event.addMeta(key, value);
    if (level === "warn") event.elevateLevel("warn");
    event.finish();
    emitIfSampled(event.toJSON());
  } catch {
    // A log line must never break the job it describes.
  }
}

/**
 * Run `run` for `jobs` of `queue`, writing the progress, expiry and finish
 * lines described above. Resolves or rejects exactly as `run` does.
 */
export async function observeJob<R>(
  queue: string,
  jobs: readonly ObservedJob[],
  run: () => Promise<R>,
  clock: JobObserverClock = systemClock,
): Promise<R> {
  const startedAt = clock.now();
  const cell: { facts: ProgressFacts } = { facts: {} };
  const jobIds = jobs
    .map((job) => job.id)
    .filter(Boolean)
    .join(",");
  const expireSeconds = Math.min(
    ...jobs.map((job) =>
      typeof job.expireInSeconds === "number" && job.expireInSeconds > 0
        ? job.expireInSeconds
        : Number.POSITIVE_INFINITY,
    ),
  );
  let expired = false;

  const snapshot = () => {
    const memory = process.memoryUsage();
    return {
      queue,
      job_ids: jobIds,
      elapsed_s: Math.round((clock.now() - startedAt) / 1000),
      ...(Number.isFinite(expireSeconds) ? { expire_s: expireSeconds } : {}),
      heap_used_mb: megabytes(memory.heapUsed),
      rss_mb: megabytes(memory.rss),
      ...cell.facts,
    };
  };

  const heartbeat = clock.setInterval(() => {
    emitJobLine("job.progress", "info", snapshot());
  }, JOB_PROGRESS_INTERVAL_MS);
  const expiry = Number.isFinite(expireSeconds)
    ? clock.setTimeout(() => {
        expired = true;
        emitJobLine("job.expired", "warn", {
          ...snapshot(),
          reason:
            "pg-boss has marked this job timed out; the handler is still running",
        });
      }, expireSeconds * 1000)
    : null;

  const finish = (outcome: Record<string, unknown>) => {
    clock.clearInterval(heartbeat);
    if (expiry !== null) clock.clearTimeout(expiry);
    const elapsed = clock.now() - startedAt;
    if (!expired && elapsed < JOB_LONG_RUN_MS) return;
    emitJobLine("job.finished", expired ? "warn" : "info", {
      ...snapshot(),
      ...(expired ? { finished_after_expiry: true } : {}),
      ...outcome,
    });
  };

  try {
    const result = await progressStore.run(cell, run);
    const did =
      result !== null && typeof result === "object" && "did" in result
        ? (result as { did?: unknown }).did
        : undefined;
    const ok =
      result !== null && typeof result === "object" && "ok" in result
        ? (result as { ok?: unknown }).ok !== false
        : true;
    finish({
      outcome: ok ? "completed" : "failed",
      ...(did && typeof did === "object" ? { did } : {}),
    });
    return result;
  } catch (err) {
    finish({
      outcome: "threw",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * At worker boot, write one line naming every job a previous process was
 * running when it stopped. Must run before this process takes any job.
 *
 * A worker killed for memory cannot log its own death, and pg-boss marks the
 * job `job timed out` only once the expiry has passed. This line is where a
 * restart in the middle of a job becomes visible: the queue, when the job
 * started, and its limit. Silent when nothing was cut off.
 */
export async function reportJobsCutOffAtBoot(
  bootedAt: Date = new Date(),
): Promise<void> {
  const active = await readActiveJobsStartedBefore(bootedAt);
  if (active === null || active.length === 0) return;
  emitJobLine("worker.boot.jobs_cut_off", "warn", {
    jobs_cut_off: active.length,
    queues: [...new Set(active.map((job) => job.queue))].join(","),
    jobs: active
      .map(
        (job) => `${job.queue}@${job.startedAt}(limit ${job.expireSeconds}s)`,
      )
      .join(" "),
    reason:
      "these jobs were still running when the previous worker process stopped (a restart, a deploy, or the container running out of memory); pg-boss retries or fails them once their limit passes. If another worker process shares this database, its running jobs are listed too.",
  });
}
