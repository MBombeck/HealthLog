/**
 * v1.7.0 — daily-mean consolidation queue registration guard.
 *
 * Same source-text-grep approach as the drain + step-consolidation
 * regression guards: assert the queue is registered in `allQueues`, a
 * `boss.work` handler is wired against it, and the boot-discovery
 * enqueue helper is called — without booting pg-boss + Prisma. An
 * unregistered queue silently never drains.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REMINDER_WORKER_PATH = join(__dirname, "..", "reminder-worker.ts");
const source = readFileSync(REMINDER_WORKER_PATH, "utf8");

describe("reminder-worker — mean-consolidation wiring", () => {
  it("imports the queue symbols from the mean-consolidation module", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/jobs\/mean-consolidation["']/,
    );
    expect(source).toMatch(/\bMEAN_CONSOLIDATION_QUEUE\b/);
    expect(source).toMatch(/\brunMeanConsolidationForUser\b/);
    expect(source).toMatch(/\benqueueBootTimeMeanConsolidation\b/);
  });

  it("registers the mean-consolidation queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bMEAN_CONSOLIDATION_QUEUE\b/);
  });

  it("registers a boss.work handler against the mean-consolidation queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}MEAN_CONSOLIDATION_QUEUE[\s\S]{0,400}runMeanConsolidationForUser/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    expect(source).toMatch(/await enqueueBootTimeMeanConsolidation\(\)/);
  });
});
