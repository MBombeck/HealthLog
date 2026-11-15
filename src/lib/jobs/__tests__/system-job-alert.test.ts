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
const HOUR_MS = 3_600_000;

/** The `ago`-th newest job (0 = newest), an hour apart. */
function run(ago = 0, overrides: Partial<TerminalRun> = {}): TerminalRun {
  return {
    key: "",
    state: "failed",
    allFailed: false,
    completedOn: new Date(at.getTime() - ago * HOUR_MS),
    error: "boom",
    expireSeconds: null,
    ...overrides,
  };
}

/** Jobs newest first, one hour apart, from a list of outcomes. */
function history(key: string, outcomes: Array<"fail" | "ok">, from = 0) {
  return outcomes.map((o, i) =>
    run(from + i, {
      key,
      state: o === "fail" ? "failed" : "completed",
      error: o === "fail" ? `boom ${key}` : null,
    }),
  );
}

describe("judgeQueueRuns", () => {
  it("is inactive with no run left in the ledger", () => {
    expect(judgeQueueRuns([]).state).toBe("inactive");
  });

  it("counts jobs, not attempts: one job that used up its retries is one failure", () => {
    expect(judgeQueueRuns([run(0)])).toMatchObject({
      state: "pending",
      failures: 0,
    });
  });

  it("calls the streak at the threshold, not before", () => {
    const below = Array.from(
      { length: SYSTEM_JOB_FAILURE_STREAK - 1 },
      (_, i) => run(i),
    );
    expect(judgeQueueRuns(below).state).toBe("pending");
    const verdict = judgeQueueRuns([...below, run(below.length)]);
    expect(verdict).toMatchObject({
      state: "failing",
      failures: SYSTEM_JOB_FAILURE_STREAK,
      lastError: "boom",
      lastFailureAt: at,
    });
  });

  it("does not report a recovery while the newest job failed", () => {
    expect(
      judgeQueueRuns(history("", ["fail", "ok", "fail", "fail", "fail"])),
    ).toMatchObject({ state: "pending", failures: 0 });
    expect(
      judgeQueueRuns(history("", ["ok", "fail", "fail", "fail"])).state,
    ).toBe("ok");
  });

  it("has nothing to report for a queue that never failed", () => {
    expect(judgeQueueRuns(history("", ["ok", "ok"])).state).toBe("inactive");
  });

  it("counts a completed job that says every candidate failed", () => {
    const allFailed = (ago: number) =>
      run(ago, { state: "completed", allFailed: true });
    expect(
      judgeQueueRuns([allFailed(0), allFailed(1), allFailed(2)]).state,
    ).toBe("failing");
  });

  // #1384 — the alert quoted the completed run's own outcome JSON, and the
  // operator it sent to the admin page found nothing there.
  it("says in words what an all-failed night was, with its cause and provider", () => {
    const output = JSON.stringify({
      ok: true,
      did: {
        total: 1,
        failed: 1,
        all_failed: true,
        assessments_warmed: 0,
        failure_cause: "all_providers_failed",
        failure_provider: "admin_openai",
      },
    });
    const verdict = judgeQueueRuns(
      [0, 1, 2].map((ago) =>
        run(ago, { state: "completed", allFailed: true, error: output }),
      ),
    );
    expect(verdict.state).toBe("failing");
    expect(verdict.lastError).toBe(
      "The run completed, but every account it attempted failed (1 of 1). " +
        "First cause: all_providers_failed from provider admin_openai. " +
        "Accounts without a usable provider are skipped and not counted; " +
        "job.run.failed in the app log lists each account's outcome.",
    );
  });

  it("explains a bare timeout the way the admin card does", () => {
    const verdict = judgeQueueRuns(
      [0, 1, 2].map((ago) =>
        run(ago, { error: "job timed out", expireSeconds: 3600 }),
      ),
    );
    expect(verdict.lastError).toMatch(
      /^job timed out: did not finish within its 1 h limit/,
    );
  });

  describe("per account", () => {
    it("is failing while one account fails every hour and the others succeed", () => {
      // Interleaved: the queue's newest job is always another account's
      // success, which used to read as a recovery every other hour.
      const verdict = judgeQueueRuns([
        ...history("a", ["fail", "fail", "fail"], 1),
        ...history("b", ["ok", "ok", "ok", "ok"], 0),
        ...history("c", ["ok", "ok", "ok"], 0),
      ]);
      expect(verdict).toMatchObject({
        state: "failing",
        failures: 3,
        lastError: "boom a",
      });
    });

    it("does not build a streak from three accounts failing once each", () => {
      const verdict = judgeQueueRuns([
        ...history("a", ["fail"], 0),
        ...history("b", ["fail"], 1),
        ...history("c", ["fail"], 2),
      ]);
      expect(verdict.state).toBe("pending");
    });

    it("recovers only when the failing account itself succeeds", () => {
      const others = history("b", ["ok", "ok"], 0);
      expect(
        judgeQueueRuns([
          ...history("a", ["fail", "fail", "fail"], 0),
          ...others,
        ]).state,
      ).toBe("failing");
      expect(
        judgeQueueRuns([
          ...history("a", ["ok", "fail", "fail", "fail"], 0),
          ...others,
        ]).state,
      ).toBe("ok");
    });

    it("reports the account that failed most recently", () => {
      const verdict = judgeQueueRuns([
        ...history("old", ["fail", "fail", "fail", "fail"], 5),
        ...history("new", ["fail", "fail", "fail"], 0),
      ]);
      expect(verdict).toMatchObject({ failures: 3, lastError: "boom new" });
    });
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
