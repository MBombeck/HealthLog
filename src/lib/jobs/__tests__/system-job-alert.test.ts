/**
 * The system job alert's verdict on one queue's ledger (#1298). The notice
 * flow itself runs against a real pg-boss in
 * `tests/integration/system-job-alert.test.ts`.
 */
import { describe, expect, it } from "vitest";

import {
  judgeQueueRuns,
  SYSTEM_JOB_FAILURE_STREAK,
  watchedQueues,
  type TerminalRun,
} from "@/lib/jobs/system-job-alert";

const at = new Date("2026-10-29T10:00:00.000Z");

function run(overrides: Partial<TerminalRun> = {}): TerminalRun {
  return {
    state: "failed",
    retryCount: 0,
    allFailed: false,
    completedOn: at,
    error: "boom",
    expireSeconds: null,
    ...overrides,
  };
}

describe("judgeQueueRuns", () => {
  it("is inactive with no run left in the ledger", () => {
    expect(judgeQueueRuns([]).state).toBe("inactive");
  });

  it("counts every attempt of a run, so one job that used up its retries is a streak", () => {
    const verdict = judgeQueueRuns([run({ retryCount: 3 })]);
    expect(verdict).toMatchObject({ state: "failing", failures: 4 });
    expect(verdict.lastError).toBe("boom");
  });

  it("calls the streak at the threshold, not before", () => {
    const below = Array.from({ length: SYSTEM_JOB_FAILURE_STREAK - 1 }, () =>
      run(),
    );
    expect(judgeQueueRuns(below).state).toBe("pending");
    expect(judgeQueueRuns([...below, run()]).state).toBe("failing");
  });

  it("ends the streak at the newest success", () => {
    const verdict = judgeQueueRuns([
      run({ error: "newest" }),
      run({ state: "completed", error: null }),
      run(),
      run(),
      run(),
    ]);
    expect(verdict).toMatchObject({
      state: "ok",
      failures: 1,
      lastError: "newest",
    });
  });

  it("counts a completed run that says every candidate failed", () => {
    const allFailed = run({ state: "completed", allFailed: true });
    expect(judgeQueueRuns([allFailed, allFailed, allFailed]).state).toBe(
      "failing",
    );
  });

  it("explains a bare timeout the way the admin card does", () => {
    const verdict = judgeQueueRuns([
      run({ error: "job timed out", expireSeconds: 3600, retryCount: 2 }),
    ]);
    expect(verdict.lastError).toMatch(
      /^job timed out: did not finish within its 1 h limit/,
    );
  });
});

describe("watchedQueues", () => {
  it("watches the system queues and none with an account-facing surface", () => {
    const queues = watchedQueues();
    expect(queues).toContain("rollup-full-backfill");
    expect(queues).toContain("system-job-alert");
    expect(queues).not.toContain("google-health-sync");
  });
});
