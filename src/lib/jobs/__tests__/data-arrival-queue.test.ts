/**
 * Dead-queue guard for the `data-arrival` queue.
 *
 * Four facts have to hold together or the spine is silently inert: the queue
 * name is provisioned, a handler drains it, the queue carries a policy that
 * actually indexes `singleton_key`, and the retention job that prunes its rows
 * is itself registered. Any one of them missing fails open in the worst way —
 * the emits succeed, the jobs vanish, and nothing anywhere reports a problem.
 *
 * Reads the worker registry for the queue facts; the retention handler's body
 * is read as text.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DATA_ARRIVAL_QUEUE } from "@/lib/arrivals/emit-shared";
import { handleDataArrival } from "@/lib/jobs/data-arrival";
import { handleArrivalReactionCleanup } from "@/lib/jobs/reminder/cleanup-handlers";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const ARRIVAL_REACTION_CLEANUP_QUEUE = "arrival-reaction-cleanup";

const cleanupHandlers = readFileSync(
  join(__dirname, "..", "reminder", "cleanup-handlers.ts"),
  "utf8",
);

describe("data-arrival queue wiring", () => {
  it("provisions the queue in the status group", () => {
    expect(groupOf(DATA_ARRIVAL_QUEUE).name).toBe("status");
  });

  it("binds the handler that drains it", async () => {
    expect(await loadedHandler(DATA_ARRIVAL_QUEUE)).toBe(handleDataArrival);
  });

  it("carries the exclusive policy its singleton keys depend on", () => {
    // Under pg-boss's default `standard` policy NO index covers
    // `singleton_key`, so the day-scoped keys would coalesce nothing at all and
    // a chatty ingest would queue one job per batch.
    expect(jobOf(DATA_ARRIVAL_QUEUE).policy?.policy).toBe("exclusive");
  });

  it("has no cron schedule — it is send-only, driven by ingest", () => {
    const job = jobOf(DATA_ARRIVAL_QUEUE);
    expect(job.cron).toBeUndefined();
    expect(job.scheduleOptions).toBeUndefined();
  });

  it("registers the retention job that prunes the markers", async () => {
    expect(groupOf(ARRIVAL_REACTION_CLEANUP_QUEUE).name).toBe("maintenance");
    const job = jobOf(ARRIVAL_REACTION_CLEANUP_QUEUE);
    expect(job.cron).toBe("10 4 * * *");
    expect(job.scheduleOptions).toBe(cronIsTheRetry);
    expect(await loadedHandler(ARRIVAL_REACTION_CLEANUP_QUEUE)).toBe(
      handleArrivalReactionCleanup,
    );
  });

  it("the retention handler actually deletes arrival reactions by age", () => {
    expect(cleanupHandlers).toMatch(
      /handleArrivalReactionCleanup[\s\S]{0,600}arrivalReaction\.deleteMany/,
    );
  });
});
