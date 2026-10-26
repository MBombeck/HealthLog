/**
 * Daily-mean consolidation queue registration guard.
 *
 * Reads the worker registry: the queue is declared in the rollup group,
 * bound to the consolidation handler, and offered again by the rollup boot
 * discovery. An unregistered queue silently never drains.
 */
import { describe, expect, it } from "vitest";

import {
  MEAN_CONSOLIDATION_CONCURRENCY,
  MEAN_CONSOLIDATION_QUEUE,
} from "@/lib/jobs/mean-consolidation";
import { handleMeanConsolidation } from "@/lib/jobs/reminder/rollup-handlers";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

describe("mean-consolidation registration", () => {
  it("declares the mean-consolidation queue in the rollup group", () => {
    expect(groupOf(MEAN_CONSOLIDATION_QUEUE).name).toBe("rollup");
  });

  it("is a per-user exclusive pass at the module's concurrency", () => {
    const job = jobOf(MEAN_CONSOLIDATION_QUEUE);
    expect(job.policy?.policy).toBe("exclusive");
    expect(job.work).toEqual({
      localConcurrency: MEAN_CONSOLIDATION_CONCURRENCY,
    });
  });

  it("binds the consolidation handler", async () => {
    expect(await loadedHandler(MEAN_CONSOLIDATION_QUEUE)).toBe(
      handleMeanConsolidation,
    );
  });

  it("runs the boot discovery pass", () => {
    expect(discoveryOf("rollup")).toContain("mean-consolidation");
  });
});
