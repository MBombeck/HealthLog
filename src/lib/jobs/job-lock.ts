/**
 * A session-level advisory lock held for the length of one run, across
 * processes.
 *
 * pg-boss holds a job's "one at a time" only while the job is inside its
 * expiry. Once the expiry passes it fails the job, fires its abort signal and
 * retries it, and it does not stop the handler: measured against pg-boss 12.34
 * (`tests/integration/integration-backfill-lane-expiry.test.ts`), the retry of
 * the same job started beside the run that was still going. No queue policy
 * helps, because the policies constrain job rows and the expired row is no
 * longer active. Only something the running handler holds can, so each long
 * run holds an advisory lock keyed on its identity, and a delivery that finds
 * the lock taken does no work.
 *
 * The lock lives on a connection of its own, outside the Prisma pool, because
 * a session lock has to stay on one connection for the whole run and a pooled
 * one is handed back between statements. Ending the connection releases the
 * lock, and so does the process dying, so a crash never leaves a key locked.
 * One extra connection per running locked job.
 */
import { Client } from "pg";
import { caughtAs } from "@/lib/logging/signal";

/** What a guarded run came to. */
export type GuardedRun<T> = { ran: true; result: T } | { ran: false };

export interface JobLockOptions {
  /**
   * How long to keep asking for a lock another run holds before giving up.
   * Zero (the default) gives up at once. A caller that would rather wait out
   * a short run than drop its own work sets this; a run whose holder can take
   * hours never should.
   */
  waitMs?: number;
  /** The pause between two asks while waiting. */
  pollMs?: number;
}

const DEFAULT_LOCK_POLL_MS = 2_000;

/**
 * Run `run` while holding the advisory lock for `key`. Resolves
 * `{ ran: false }` without calling `run` when another run holds it, at once or,
 * with `waitMs`, once that long has passed without the lock coming free.
 * Rejects exactly as `run` does otherwise.
 */
export async function withJobLock<T>(
  key: string,
  run: () => Promise<T>,
  connectionString: string | undefined = process.env.DATABASE_URL,
  options: JobLockOptions = {},
): Promise<GuardedRun<T>> {
  const client = new Client({ connectionString, keepAlive: true });
  // An idle client whose server goes away emits `error`; unhandled, that
  // takes the whole worker down. The run itself notices the database is
  // gone through its own queries.
  client.on("error", () => {});
  await client.connect();
  try {
    const deadline = Date.now() + Math.max(0, options.waitMs ?? 0);
    const pollMs = Math.max(1, options.pollMs ?? DEFAULT_LOCK_POLL_MS);
    for (;;) {
      const { rows } = await client.query<{ held: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held",
        [key],
      );
      if (rows[0]?.held) break;
      if (Date.now() + pollMs > deadline) return { ran: false };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    try {
      return { ran: true, result: await run() };
    } finally {
      await client
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
        .catch(caughtAs("jobs.lock.release_failed"));
    }
  } finally {
    await client.end().catch(caughtAs("jobs.lock.release_failed"));
  }
}
