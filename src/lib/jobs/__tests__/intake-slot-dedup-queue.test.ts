/**
 * v1.8.2 — duplicate dose-slot dedup queue registration guard.
 *
 * Same source-text-grep approach as the drain + step-consolidation +
 * mean-consolidation regression guards: assert the queue is registered
 * in `allQueues`, a `boss.work` handler is wired against it, and the
 * boot-discovery enqueue helper is called — without booting pg-boss +
 * Prisma. An unregistered queue silently never drains (the past incident
 * this guard exists to prevent).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REMINDER_WORKER_PATH = join(__dirname, "..", "reminder-worker.ts");
const source = readFileSync(REMINDER_WORKER_PATH, "utf8");

describe("reminder-worker — intake-slot-dedup wiring", () => {
  it("imports the queue symbols from the intake-slot-dedup module", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/medications\/intake-slot-dedup["']/,
    );
    expect(source).toMatch(/\bINTAKE_SLOT_DEDUP_QUEUE\b/);
    expect(source).toMatch(/\bdedupeUserIntakeSlots\b/);
    expect(source).toMatch(/\benqueueBootTimeIntakeSlotDedup\b/);
  });

  it("registers the intake-slot-dedup queue in the allQueues loop", () => {
    const allQueuesMatch = source.match(
      /const allQueues\s*=\s*\[([\s\S]*?)\];/,
    );
    expect(allQueuesMatch).not.toBeNull();
    expect(allQueuesMatch![1]).toMatch(/\bINTAKE_SLOT_DEDUP_QUEUE\b/);
  });

  it("registers a boss.work handler against the intake-slot-dedup queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}INTAKE_SLOT_DEDUP_QUEUE[\s\S]{0,400}dedupeUserIntakeSlots/,
    );
  });

  it("fires the boot-discovery enqueue helper", () => {
    expect(source).toMatch(/await enqueueBootTimeIntakeSlotDedup\(\)/);
  });
});
