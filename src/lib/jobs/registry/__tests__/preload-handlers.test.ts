/**
 * The worker's boot preload of every job handler module.
 *
 * Handlers load on their queue's first job, so a module that cannot load
 * stopped failing the boot and started failing jobs instead: the queue burned
 * its retries, and a one-shot job (a restore, an import tail) ended failed
 * with nobody told at deploy time. The worker now loads every handler once in
 * the background after binding and reports each failure by queue name.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, PgBoss } from "pg-boss";

const bound = vi.hoisted(
  () => new Map<string, (jobs: unknown[]) => Promise<unknown>>(),
);

vi.mock("@/lib/jobs/reminder/registrar-shared", () => ({
  createAndSchedule: vi.fn(async () => undefined),
  retireQueues: vi.fn(async () => undefined),
  createAndWork: vi.fn(
    async (
      _boss: unknown,
      queue: string,
      _opts: unknown,
      handler: (jobs: unknown[]) => Promise<unknown>,
    ) => {
      bound.set(queue, handler);
    },
  ),
}));

vi.mock("@/lib/jobs/reminder/shared", () => ({ workerLog: vi.fn() }));

vi.mock("@/lib/logging/signal", () => ({ emitSignal: vi.fn() }));
vi.mock("@/lib/jobs/report-worker-error", () => ({
  reportWorkerError: vi.fn(async () => undefined),
}));
vi.mock("@/lib/jobs/job-failures", () => ({
  readConsecutiveRunFailures: vi.fn(async () => 0),
}));

import { workerLog } from "@/lib/jobs/reminder/shared";
import { emitSignal } from "@/lib/logging/signal";
import { reportWorkerError } from "@/lib/jobs/report-worker-error";
import { reportHandlerLoadFailure } from "@/lib/jobs/run-job";

import type { JobDefinition, JobGroup } from "../define-job";
import {
  preloadHandlers,
  registerJobGroup,
  type BoundLoader,
} from "../register";

const boss = {} as PgBoss;

function definition(
  queue: string,
  load: () => Promise<unknown>,
): JobDefinition {
  return { queue, work: { batchSize: 1 }, load } as unknown as JobDefinition;
}

beforeEach(() => {
  bound.clear();
  vi.clearAllMocks();
});

describe("preloading the job handlers at worker boot", () => {
  it("reports a module that fails to load, by queue, and loads the rest", async () => {
    const ok = vi.fn(async () => async () => ({ ok: true as const }));
    const broken = vi.fn(async () => {
      throw new Error("Cannot find module './gone'");
    });
    const group = {
      name: "maintenance",
      jobs: [
        definition("first-ok", ok),
        definition("broken-module", broken),
        definition("second-ok", ok),
      ],
    } as unknown as JobGroup;

    const loaders: BoundLoader[] = [];
    await registerJobGroup(boss, group, (b) => loaders.push(b));
    expect(loaders.map((b) => b.queue)).toEqual([
      "first-ok",
      "broken-module",
      "second-ok",
    ]);

    const report = vi.fn(async () => undefined);
    const failed = await preloadHandlers(loaders, report);

    expect(failed).toEqual(["broken-module"]);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      "broken-module",
      expect.objectContaining({ message: "Cannot find module './gone'" }),
    );
    expect(ok).toHaveBeenCalledTimes(2);
    expect(workerLog).toHaveBeenCalledWith(
      "error",
      expect.stringContaining("failed to load: broken-module"),
    );
  });

  it("preloads through the loader the queue is bound to, so the first job does not import again", async () => {
    const handler = vi.fn(async () => ({ ok: true as const }));
    const load = vi.fn(async () => handler);
    const group = {
      name: "maintenance",
      jobs: [definition("warm", load)],
    } as unknown as JobGroup;

    const loaders: BoundLoader[] = [];
    await registerJobGroup(boss, group, (b) => loaders.push(b));
    await preloadHandlers(loaders, vi.fn());
    await bound.get("warm")!([{ id: "j1", data: {} } as Job<unknown>]);

    expect(load).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not stop the sweep when a report itself fails", async () => {
    const loaders: BoundLoader[] = [
      { queue: "a", load: () => Promise.reject(new Error("a")) },
      { queue: "b", load: () => Promise.reject(new Error("b")) },
    ];
    const report = vi.fn(async () => {
      throw new Error("sink down");
    });
    await expect(preloadHandlers(loaders, report)).resolves.toEqual(["a", "b"]);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("reports a load failure on the job.run.failed line, at error, naming the queue", async () => {
    const error = new Error("SyntaxError in handler");
    await reportHandlerLoadFailure("broken-module", error);

    expect(emitSignal).toHaveBeenCalledWith({
      action: "job.run.failed",
      level: "error",
      meta: {
        queue: "broken-module",
        reason: "handler_load_failed",
        consecutiveFailures: 0,
      },
      error,
    });
    expect(reportWorkerError).toHaveBeenCalledWith("broken-module", error, {
      phase: "handler_preload",
    });
  });

  it("is started by the worker after binding, without holding up the boot", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/jobs/reminder-worker.ts"),
      "utf8",
    );
    const register = source.indexOf("registry.registerAllJobGroups(");
    const preload = source.indexOf("void registry.preloadHandlers(bound)");
    expect(register).toBeGreaterThan(-1);
    expect(preload).toBeGreaterThan(register);
  });
});
