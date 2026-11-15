/**
 * v1.42 — `reportJobRun`: one line per run with every candidate's outcome,
 * and a level that follows the run as a whole.
 *
 * The nightly briefing warm read as "all-failed" on seven nights because the
 * last account of each run happened to fail. These cases pin the verdict
 * (what counts as attempted, what makes a run failed versus partial) and the
 * two signals an operator and the repeated-failure alert key on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const emitSignal = vi.fn();
const annotate = vi.fn();
const readConsecutiveRunFailures = vi.fn(async (_queue: string) => 3);

vi.mock("@/lib/logging/signal", () => ({
  emitSignal: (...a: unknown[]) => emitSignal(...a),
}));
vi.mock("@/lib/logging/context", () => ({
  annotate: (...a: unknown[]) => annotate(...a),
}));
vi.mock("@/lib/jobs/job-failures", () => ({
  readConsecutiveRunFailures: (queue: string) =>
    readConsecutiveRunFailures(queue),
}));

import { judgeJobRun, reportJobRun } from "../job-run-report";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("judgeJobRun", () => {
  it("leaves skipped and deferred candidates out of the attempted set", () => {
    expect(
      judgeJobRun([
        { key: "a", outcome: "skipped" },
        { key: "b", outcome: "deferred" },
        { key: "c", outcome: "failed" },
      ]),
    ).toEqual({
      total: 3,
      attempted: 1,
      failed: 1,
      allFailed: true,
      partial: false,
    });
  });

  // #1384 — a key the issuer revoked stays saved and is refused every night.
  // Counted as a failure, it made a single-account instance's nightly pass
  // read as all-failed forever and alerted the operator about the job.
  it("does not fail a run over a refused credential of the account's own", () => {
    expect(judgeJobRun([{ key: "a", outcome: "auth_failed" }])).toEqual({
      total: 1,
      attempted: 1,
      failed: 0,
      allFailed: false,
      partial: true,
    });
  });

  it("reads a refused credential beside a real failure as partial", () => {
    const verdict = judgeJobRun([
      { key: "a", outcome: "auth_failed" },
      { key: "b", outcome: "failed" },
    ]);
    expect(verdict.allFailed).toBe(false);
    expect(verdict.partial).toBe(true);
    expect(verdict.failed).toBe(1);
  });

  it("reads one success among failures as partial, not failed", () => {
    const verdict = judgeJobRun([
      { key: "a", outcome: "ok" },
      { key: "b", outcome: "failed" },
    ]);
    expect(verdict.allFailed).toBe(false);
    expect(verdict.partial).toBe(true);
  });

  it("reads a withheld result as partial: the provider answered", () => {
    const verdict = judgeJobRun([{ key: "a", outcome: "screened" }]);
    expect(verdict.allFailed).toBe(false);
    expect(verdict.partial).toBe(true);
  });

  it("is neither failed nor partial when nothing was attempted", () => {
    const verdict = judgeJobRun([{ key: "a", outcome: "skipped" }]);
    expect(verdict.allFailed).toBe(false);
    expect(verdict.partial).toBe(false);
  });
});

describe("reportJobRun", () => {
  it("emits job.run.failed at error with the streak when every attempt failed", async () => {
    const verdict = await reportJobRun({
      queue: "insight-pregenerate",
      runId: "r1",
      candidates: [
        { key: "a", outcome: "failed", cause: "all-providers-failed" },
        { key: "b", outcome: "skipped", cause: "no-consent" },
      ],
    });
    expect(verdict.allFailed).toBe(true);
    expect(readConsecutiveRunFailures).toHaveBeenCalledWith(
      "insight-pregenerate",
    );
    expect(emitSignal).toHaveBeenCalledTimes(1);
    expect(emitSignal.mock.calls[0][0]).toMatchObject({
      action: "job.run.failed",
      level: "error",
      meta: {
        queue: "insight-pregenerate",
        consecutiveFailures: 3,
        failed: 1,
        total: 1,
        causes: ["failed:all-providers-failed"],
      },
    });
  });

  it("emits job.run.partial, never job.run.failed, for a run whose only attempt was a refused credential (#1384)", async () => {
    const verdict = await reportJobRun({
      queue: "insight-pregenerate",
      runId: "r1",
      candidates: [
        {
          key: "a",
          outcome: "auth_failed",
          cause: "all-providers-failed:openai-compatible",
        },
      ],
    });
    expect(verdict.allFailed).toBe(false);
    expect(readConsecutiveRunFailures).not.toHaveBeenCalled();
    expect(emitSignal).toHaveBeenCalledTimes(1);
    expect(emitSignal.mock.calls[0][0]).toMatchObject({
      action: "job.run.partial",
      level: "warn",
      meta: {
        causes: ["auth_failed:all-providers-failed:openai-compatible"],
      },
    });
  });

  it("emits job.run.partial at warn when only some failed", async () => {
    await reportJobRun({
      queue: "q",
      runId: "r",
      candidates: [
        { key: "a", outcome: "ok" },
        { key: "b", outcome: "failed", cause: "timeout" },
      ],
    });
    expect(readConsecutiveRunFailures).not.toHaveBeenCalled();
    expect(emitSignal.mock.calls[0][0]).toMatchObject({
      action: "job.run.partial",
      level: "warn",
      meta: { queue: "q", failed: 1, total: 2 },
    });
  });

  it("emits nothing extra for a clean run, and lists every outcome on the run line", async () => {
    await reportJobRun({
      queue: "q",
      runId: "r",
      candidates: [
        { key: "a", outcome: "ok" },
        { key: "b", outcome: "ok" },
        { key: "c", outcome: "skipped", cause: "no-provider" },
      ],
    });
    expect(emitSignal).not.toHaveBeenCalled();
    const meta = annotate.mock.calls[0][0].meta;
    expect(meta.outcomes).toEqual({ ok: 2, skipped: 1 });
    expect(meta.candidate_outcomes).toHaveLength(3);
    expect(meta.all_failed).toBe(false);
  });
});
