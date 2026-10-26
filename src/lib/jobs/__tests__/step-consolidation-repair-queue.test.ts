/**
 * Step-consolidation repair queue registration guard + `extractStatsDay`
 * unit coverage.
 *
 * Reads the worker registry: the repair queue is declared in the rollup
 * group, bound to the repair handler, and offered again by the rollup boot
 * discovery. An unregistered queue silently never drains (the dead-queue
 * class).
 */
import { describe, expect, it } from "vitest";

import { handleStepConsolidationRepair } from "@/lib/jobs/reminder/rollup-handlers";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

import {
  STEP_CONSOLIDATION_REPAIR_CONCURRENCY,
  STEP_CONSOLIDATION_REPAIR_QUEUE,
  extractStatsDay,
} from "../step-consolidation-repair";

describe("step-consolidation-repair registration", () => {
  it("declares the repair queue in the rollup group", () => {
    expect(groupOf(STEP_CONSOLIDATION_REPAIR_QUEUE).name).toBe("rollup");
    const job = jobOf(STEP_CONSOLIDATION_REPAIR_QUEUE);
    expect(job.policy?.policy).toBe("exclusive");
    expect(job.work).toEqual({
      localConcurrency: STEP_CONSOLIDATION_REPAIR_CONCURRENCY,
    });
  });

  it("binds the repair handler", async () => {
    expect(await loadedHandler(STEP_CONSOLIDATION_REPAIR_QUEUE)).toBe(
      handleStepConsolidationRepair,
    );
  });

  it("runs the boot discovery pass", () => {
    expect(discoveryOf("rollup")).toContain("step-consolidation-repair");
  });
});

describe("extractStatsDay", () => {
  it("extracts the day key from a provider stats:steps externalId", () => {
    expect(extractStatsDay("stats:steps:2026-05-16")).toBe("2026-05-16");
  });

  it("extracts the day key from the narrow Apple mint shape", () => {
    expect(
      extractStatsDay("stats:HKQuantityTypeIdentifierStepCount:2026-05-16"),
    ).toBe("2026-05-16");
  });

  it("returns null for a null externalId or a non-day-suffixed key", () => {
    expect(extractStatsDay(null)).toBeNull();
    expect(extractStatsDay("uuid-abc-123")).toBeNull();
    expect(extractStatsDay("stats:steps:not-a-date")).toBeNull();
  });
});
