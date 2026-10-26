/**
 * Cumulative-PersonalRecord rederivation queue registration guard.
 *
 * Reads the worker registry: the queue is declared in the rollup group,
 * bound to the rederivation handler, and offered again by the rollup boot
 * discovery. An unregistered queue silently never drains (the dead-queue
 * class).
 */
import { describe, expect, it } from "vitest";

import { handleCumulativePrRederive } from "@/lib/jobs/reminder/rollup-handlers";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import {
  CUMULATIVE_PR_REDERIVE_CONCURRENCY,
  CUMULATIVE_PR_REDERIVE_QUEUE,
} from "@/lib/personal-records/cumulative-pr-rederivation";

describe("cumulative-pr-rederive registration", () => {
  it("declares the queue in the rollup group", () => {
    expect(groupOf(CUMULATIVE_PR_REDERIVE_QUEUE).name).toBe("rollup");
  });

  it("is a per-user exclusive one-shot at the module's concurrency", () => {
    const job = jobOf(CUMULATIVE_PR_REDERIVE_QUEUE);
    expect(job.policy?.policy).toBe("exclusive");
    expect(job.work).toEqual({
      localConcurrency: CUMULATIVE_PR_REDERIVE_CONCURRENCY,
    });
    expect(job.cron).toBeUndefined();
  });

  it("binds the rederivation handler", async () => {
    expect(await loadedHandler(CUMULATIVE_PR_REDERIVE_QUEUE)).toBe(
      handleCumulativePrRederive,
    );
  });

  it("runs the boot discovery pass", () => {
    expect(discoveryOf("rollup")).toContain("cumulative-pr-rederive");
  });
});
