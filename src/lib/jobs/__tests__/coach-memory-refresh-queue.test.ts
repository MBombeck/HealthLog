/**
 * Queue-registration guard for the combined Coach memory-refresh job
 * (rolling conversation summary + durable fact extraction).
 *
 * Reads the worker registry: the queue is declared in the status group and
 * its loader resolves to the handler that runs the refresh pipeline. An
 * unregistered queue silently never runs (the dead-queue class).
 */
import { describe, expect, it } from "vitest";

import { COACH_MEMORY_REFRESH_QUEUE } from "@/lib/ai/coach/coach-memory-shared";
import { handleCoachMemoryRefresh } from "@/lib/jobs/reminder/status-handlers";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

describe("coach-memory-refresh registration", () => {
  it("declares the coach-memory-refresh queue in the status group", () => {
    expect(groupOf(COACH_MEMORY_REFRESH_QUEUE).name).toBe("status");
  });

  it("runs one refresh at a time and has no cron", () => {
    const job = jobOf(COACH_MEMORY_REFRESH_QUEUE);
    expect(job.work).toEqual({ localConcurrency: 1 });
    expect(job.cron).toBeUndefined();
  });

  it("binds the handler that runs the refresh pipeline", async () => {
    expect(await loadedHandler(COACH_MEMORY_REFRESH_QUEUE)).toBe(
      handleCoachMemoryRefresh,
    );
  });
});
