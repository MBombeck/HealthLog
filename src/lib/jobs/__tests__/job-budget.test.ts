import { describe, expect, it } from "vitest";

import {
  JOB_BUDGET_SHARE,
  jobBudget,
  jobDeadline,
} from "@/lib/jobs/job-budget";

// pg-boss declares a job dead at its expiry but does not stop the handler;
// the long passes stop themselves on this budget instead (issue #1031).

function job(expireInSeconds: number, signal = new AbortController().signal) {
  return { expireInSeconds, signal };
}

describe("jobBudget", () => {
  it("stops at the budget share of the job's expiry, not at the expiry", () => {
    let now = 1_000_000;
    const shouldStop = jobBudget([job(900)], () => now);

    now += 900 * 1000 * JOB_BUDGET_SHARE - 1;
    expect(shouldStop()).toBe(false);
    now += 1;
    expect(shouldStop()).toBe(true);
    expect(JOB_BUDGET_SHARE).toBeLessThan(1);
  });

  it("stops as soon as pg-boss aborts the job, whatever the clock says", () => {
    const controller = new AbortController();
    const shouldStop = jobBudget([job(900, controller.signal)], () => 0);
    expect(shouldStop()).toBe(false);
    controller.abort();
    expect(shouldStop()).toBe(true);
  });

  it("takes the tightest expiry of a batch", () => {
    let now = 0;
    const shouldStop = jobBudget([job(7200), job(60)], () => now);
    now = 60 * 1000 * JOB_BUDGET_SHARE;
    expect(shouldStop()).toBe(true);
  });

  it("never stops on the clock when there is no job to take an expiry from", () => {
    let now = 0;
    const shouldStop = jobBudget([], () => now);
    now = Number.MAX_SAFE_INTEGER;
    expect(shouldStop()).toBe(false);
  });
});

describe("jobDeadline", () => {
  it("is the same budget share of the expiry, as an instant", () => {
    expect(jobDeadline(job(7200), () => 1_000)).toBe(
      1_000 + 7200 * 1000 * JOB_BUDGET_SHARE,
    );
  });

  it("is undefined for a job with no usable expiry", () => {
    expect(jobDeadline(job(0))).toBeUndefined();
    expect(jobDeadline(job(Number.NaN))).toBeUndefined();
  });
});
