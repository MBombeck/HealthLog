/**
 * Unit tests for the job-outcome spine.
 *
 * The whole point of `runJob` is that an `ok: false` outcome reaches pg-boss
 * as a failed job. That is a behaviour claim, not a typing one, and it is the
 * claim the retention cleanups now depend on — so it is pinned here: the
 * failure is reported once with the handler's own facts, it rethrows, and a
 * handler that throws on its own is passed through untouched rather than
 * rewrapped into a stack that points at this file.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Job } from "pg-boss";

const reportWorkerError = vi.fn();

vi.mock("../report-worker-error", () => ({
  reportWorkerError: (...a: unknown[]) => reportWorkerError(...a),
}));

import { jobDone, jobFailed } from "../job-outcome";
import { JobFailure, runJob } from "../run-job";

const noJobs: Job<object>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  reportWorkerError.mockResolvedValue(undefined);
});

describe("runJob", () => {
  it("returns a bounded useful result and reports nothing on success", async () => {
    const wrapped = runJob("rate-limit-cleanup", async () =>
      jobDone({ outcome: "useful", deleted: 12 }),
    );

    await expect(wrapped(noJobs)).resolves.toEqual({
      ok: true,
      did: { outcome: "useful", deleted: 12 },
    });
    expect(reportWorkerError).not.toHaveBeenCalled();
  });

  it("returns a durable clean-zero result when there was nothing to do", async () => {
    const wrapped = runJob("mood-reminder-cleanup", async () =>
      jobDone({ outcome: "clean_zero", deleted: 0 }),
    );

    await expect(wrapped(noJobs)).resolves.toEqual({
      ok: true,
      did: { outcome: "clean_zero", deleted: 0 },
    });
    expect(reportWorkerError).not.toHaveBeenCalled();
  });

  it("preserves an honest bounded partial outcome", async () => {
    const wrapped = runJob("google-health-sync", async () =>
      jobDone({
        outcome: "partial",
        users_complete: 2,
        users_partial: 1,
        users_failed: 1,
      }),
    );

    await expect(wrapped(noJobs)).resolves.toEqual({
      ok: true,
      did: {
        outcome: "partial",
        users_complete: 2,
        users_partial: 1,
        users_failed: 1,
      },
    });
    expect(reportWorkerError).not.toHaveBeenCalled();
  });

  it("refuses to persist credentials or unbounded facts on success", async () => {
    const wrapped = runJob("google-health-sync", async () =>
      jobDone({
        refresh_token: "private-token",
      } as unknown as Record<string, string>),
    );

    await expect(wrapped(noJobs)).rejects.toThrow(/fact key is not allowed/i);
    expect(reportWorkerError).not.toHaveBeenCalled();
  });

  it("rethrows a failed outcome so pg-boss records a failed job", async () => {
    const cause = new Error("statement timeout");
    const wrapped = runJob("push-attempt-cleanup", async () =>
      jobFailed("push-attempt cleanup failed", cause, { deleted: 0 }),
    );

    await expect(wrapped(noJobs)).rejects.toBeInstanceOf(JobFailure);
    await expect(wrapped(noJobs)).rejects.toThrow(
      "push-attempt-cleanup: push-attempt cleanup failed",
    );
  });

  it("reports the failure with the handler's own facts and the cause", async () => {
    const cause = new Error("statement timeout");
    const wrapped = runJob("push-attempt-cleanup", async () =>
      jobFailed("push-attempt cleanup failed", cause, { deleted: 0 }),
    );

    await expect(wrapped(noJobs)).rejects.toThrow();

    expect(reportWorkerError).toHaveBeenCalledTimes(1);
    const [queue, error, meta] = reportWorkerError.mock.calls[0];
    expect(queue).toBe("push-attempt-cleanup");
    expect(error).toBeInstanceOf(JobFailure);
    expect(meta).toEqual({ deleted: 0, cause: "statement timeout" });
  });

  it("carries the thrown error's stack instead of its own frame", async () => {
    const cause = new Error("statement timeout");
    cause.stack = "Error: statement timeout\n    at deleteMany (prisma.ts:1:1)";
    const wrapped = runJob("mcp-token-cleanup", async () =>
      jobFailed("mcp-token cleanup failed", cause),
    );

    const failure = await wrapped(noJobs).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(JobFailure);
    expect((failure as JobFailure).stack).toContain("at deleteMany");
    expect((failure as JobFailure).cause).toBe(cause);
  });

  it("passes a throwing handler through untouched", async () => {
    const thrown = new Error("cohort discovery failed");
    const wrapped = runJob("withings-sync", async () => {
      throw thrown;
    });

    await expect(wrapped(noJobs)).rejects.toBe(thrown);
    // The throw already fails the job. Reporting it here would double every
    // handler that reports for itself, and rewrapping would bury the stack.
    expect(reportWorkerError).not.toHaveBeenCalled();
  });

  it("hands the batch to the handler unchanged", async () => {
    const handler = vi.fn(async () => jobDone({ jobs: 2 }));
    const jobs = [
      { id: "a", data: { userId: "u1" } },
      { id: "b", data: { userId: "u2" } },
    ] as unknown as Job<{ userId: string }>[];

    await runJob("data-arrival", handler)(jobs);

    expect(handler).toHaveBeenCalledWith(jobs);
  });
});

describe("runJob observation (#1031)", () => {
  it("runs every handler inside the job observer, so a long or expired job leaves a log line", async () => {
    const observer = await import("../job-observer");
    const observe = vi.spyOn(observer, "observeJob");
    const jobs = [
      { id: "j-1", expireInSeconds: 900 },
    ] as unknown as Job<object>[];
    const wrapped = runJob("dense-intraday-retention", async () =>
      jobDone({ days_consolidated: 1 }),
    );

    await wrapped(jobs);

    expect(observe).toHaveBeenCalledWith(
      "dense-intraday-retention",
      jobs,
      expect.any(Function),
    );
    observe.mockRestore();
  });
});
