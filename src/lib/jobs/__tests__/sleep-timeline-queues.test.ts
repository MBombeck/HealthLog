/**
 * v1.17.1 — pg-boss queue registration for the one-shot sleep-timeline backfill.
 *
 * The reminder-worker imports heavy infrastructure, so we read the source as
 * text and assert the queue constant is declared, registered in `allQueues`,
 * wired to a `boss.work` handler, and enqueued at boot — the fast guard that
 * catches the v1.4.37 dead-queue class (a queue declared but never registered,
 * which silently never drains).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the queue wiring + boot discovery moved out of the 2143-LOC
// reminder-worker boot file into domain registrars; the sleep-timeline backfill
// lives in the integration-sync registrar. The dead-queue guard follows it.
const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-integration-sync.ts",
);
const source = readFileSync(REGISTRAR_PATH, "utf8");

describe("reminder-worker — sleep-timeline backfill queue", () => {
  it("registers the queue in allQueues (v1.4.37 dead-queue guard)", () => {
    const block = /const allQueues = \[([\s\S]*?)\];/.exec(source);
    expect(block).not.toBeNull();
    expect(block![1]!).toContain("SLEEP_TIMELINE_BACKFILL_QUEUE");
  });

  it("wires a boss.work handler through the shared admission queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,260}SLEEP_TIMELINE_BACKFILL_QUEUE[\s\S]{0,300}enqueueIntegrationBackfillAdmission/,
    );
  });

  it("wires the boot discovery", () => {
    expect(source).toMatch(
      /enqueueBootTimeSleepTimelineBackfill\(\s*bootStaggerSecondsFor\("sleep-timeline-backfill"\)/,
    );
  });

  it("imports the backfill exports", () => {
    expect(source).toMatch(
      /from\s*["']@\/lib\/jobs\/sleep-timeline-backfill["']/,
    );
  });
});
