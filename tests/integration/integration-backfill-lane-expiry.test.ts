/**
 * The full-history admission lane against a real pg-boss on a real Postgres:
 * what happens to an import that runs past its job's expiry.
 *
 * Up to 12.37, measured with the lane's worker shape (localConcurrency 1,
 * groupConcurrency 1, exclusive policy, retries with backoff), a two-second
 * expiry, a one-second retry delay and a handler that ignores the abort
 * signal and runs for eight seconds, pg-boss failed the job at the expiry,
 * fired the signal, freed the worker and group slots, and started the retry
 * in the same worker BESIDE the run it had given up on: two runs of one job
 * at once, which the lane's lock existed to absorb.
 *
 * 12.38 changed that. At the expiry it still fails the job and fires the
 * signal, but the worker fetches nothing more until the handler returns (and
 * records a `handler_overrun` warning). The retry starts after the overrun
 * ends, in the same worker, so the lane's one-at-a-time now holds without the
 * lock's help; the lock stays as the guard for a second worker or instance.
 * The first test keeps that as an executable statement about pg-boss; the
 * second runs the lane's own handler under the same conditions.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PgBoss, type Job } from "pg-boss";

const runner = vi.hoisted(() => ({
  running: 0,
  maxRunning: 0,
  calls: 0,
  holdMs: 8_000,
}));

vi.mock("@/lib/jobs/google-health-backfill", () => ({
  // Ignores the budget and the signal on purpose: the case the lock covers
  // is a run that does not stop when pg-boss gives up on it.
  runGoogleHealthBackfillForUser: async () => {
    runner.calls += 1;
    runner.running += 1;
    runner.maxRunning = Math.max(runner.maxRunning, runner.running);
    await new Promise((resolve) => setTimeout(resolve, runner.holdMs));
    runner.running -= 1;
    return { imported: 1 };
  },
}));

import {
  integrationBackfillAdmissionSendOptions,
  type IntegrationBackfillAdmissionPayload,
} from "@/lib/jobs/integration-backfill-admission";
import { drainIntegrationBackfillAdmission } from "@/lib/jobs/integration-backfill-drain";
import { withIntegrationBackfillLock } from "@/lib/jobs/integration-backfill-lock";
import { runJob } from "@/lib/jobs/run-job";

let boss: PgBoss;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

/** Short enough to cross in a test, the lane's shape otherwise. */
const EXPIRY_OVERRIDE = { expireInSeconds: 2, retryDelay: 1 } as const;

const WORK_OPTIONS = {
  localConcurrency: 1,
  groupConcurrency: 1,
  pollingIntervalSeconds: 0.5,
} as const;

const payload: IntegrationBackfillAdmissionPayload = {
  kind: "google-health-backfill",
  data: { userId: `lane-user-${suffix}`, enqueuedAt: new Date().toISOString() },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a state rather than a fixed time: the retry is fetched about a
 * second and a half after the overrun ends, later on a loaded machine, and a
 * fixed window turned that lateness into a red run. The deadline only bounds
 * a run that never gets there.
 */
async function until(done: () => boolean, deadlineMs = 40_000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!done() && Date.now() < end) await sleep(100);
}

beforeAll(async () => {
  boss = new PgBoss({ connectionString: process.env.DATABASE_URL });
  await boss.start();
}, 120_000);

afterAll(async () => {
  await boss?.stop({ graceful: false });
});

describe("an import that outlives its expiry", () => {
  it("pg-boss retries the expired job only once the run it gave up on returns", async () => {
    const queue = `lane-expiry-raw-${suffix}`;
    await boss.createQueue(queue, { policy: "exclusive" });
    const runs: Array<{ id: string; start: number; end?: number }> = [];
    let running = 0;
    let maxRunning = 0;
    await boss.work(queue, WORK_OPTIONS, async ([job]: Job<object>[]) => {
      const run: { id: string; start: number; end?: number } = {
        id: job!.id,
        start: Date.now(),
      };
      runs.push(run);
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await sleep(8_000);
      running -= 1;
      run.end = Date.now();
    });
    await boss.send(queue, payload, {
      ...integrationBackfillAdmissionSendOptions(payload),
      ...EXPIRY_OVERRIDE,
    });

    await until(() => runs.length >= 2);
    await boss.offWork(queue);

    expect(runs.length).toBeGreaterThanOrEqual(2);
    expect(new Set(runs.map((r) => r.id)).size).toBe(1);
    expect(maxRunning).toBe(1);
    expect(runs[1]!.start).toBeGreaterThanOrEqual(runs[0]!.end!);
  }, 90_000);

  it("the lane's handler runs one import at a time while the expired run overruns", async () => {
    const queue = `lane-expiry-drain-${suffix}`;
    await boss.createQueue(queue, { policy: "exclusive" });
    const handler = runJob(queue, drainIntegrationBackfillAdmission);
    const deliveries: string[] = [];
    await boss.work(
      queue,
      WORK_OPTIONS,
      async (jobs: Job<IntegrationBackfillAdmissionPayload>[]) => {
        deliveries.push(jobs[0]!.id);
        return handler(jobs);
      },
    );
    await boss.send(queue, payload, {
      ...integrationBackfillAdmissionSendOptions(payload),
      ...EXPIRY_OVERRIDE,
    });

    // The run holds for eight seconds, past its two-second expiry; the retry
    // waits for it and starts after. The retry's own run is let finish so the
    // call count is read at rest.
    await until(() => deliveries.length >= 2);
    await boss.offWork(queue);
    await until(
      () => runner.running === 0 && runner.calls >= deliveries.length,
    );

    expect(deliveries.length).toBeGreaterThanOrEqual(2);
    expect(new Set(deliveries).size).toBe(1);
    expect(runner.maxRunning).toBe(1);
    expect(runner.calls).toBe(deliveries.length);
  }, 100_000);
});

describe("withIntegrationBackfillLock", () => {
  it("admits one run per identity, others alongside, and the next once it ends", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const first = withIntegrationBackfillLock("kind|a", () => held);
    await sleep(300);

    const same = await withIntegrationBackfillLock("kind|a", async () => 1);
    const other = await withIntegrationBackfillLock("kind|b", async () => 2);
    expect(same).toEqual({ ran: false });
    expect(other).toEqual({ ran: true, result: 2 });

    release();
    await first;
    const after = await withIntegrationBackfillLock("kind|a", async () => 3);
    expect(after).toEqual({ ran: true, result: 3 });
  });

  it("releases the lock when the run throws", async () => {
    await expect(
      withIntegrationBackfillLock("kind|c", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const after = await withIntegrationBackfillLock("kind|c", async () => 4);
    expect(after).toEqual({ ran: true, result: 4 });
  });
});
