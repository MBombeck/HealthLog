/**
 * pg-boss queue registration for the one-shot sleep-timeline backfill.
 *
 * Reads the worker registry: the source queue is declared in the
 * integration-sync group, forwards each job to the shared admission queue,
 * and is offered again by the boot discovery. This is the fast guard for the
 * dead-queue class (a queue declared but never registered, which silently
 * never drains).
 */
import { describe, expect, it } from "vitest";

import { INTEGRATION_BACKFILL_ADMISSION_QUEUE } from "@/lib/jobs/integration-backfill-admission";
import {
  discoveryOf,
  groupOf,
  jobOf,
  recordingBoss,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import {
  SLEEP_TIMELINE_BACKFILL_CONCURRENCY,
  SLEEP_TIMELINE_BACKFILL_QUEUE,
} from "@/lib/jobs/sleep-timeline-backfill-queue";

describe("sleep-timeline backfill registration", () => {
  it("declares the queue in the integration-sync group", () => {
    expect(groupOf(SLEEP_TIMELINE_BACKFILL_QUEUE).name).toBe(
      "integration_sync",
    );
    const job = jobOf(SLEEP_TIMELINE_BACKFILL_QUEUE);
    expect(job.policy?.policy).toBe("exclusive");
    expect(job.work).toEqual({
      localConcurrency: SLEEP_TIMELINE_BACKFILL_CONCURRENCY,
    });
  });

  it("forwards each job through the shared admission queue", async () => {
    const { boss, sends } = recordingBoss();
    const handler = await jobOf(SLEEP_TIMELINE_BACKFILL_QUEUE).load({ boss });
    await handler([
      {
        id: "j1",
        name: SLEEP_TIMELINE_BACKFILL_QUEUE,
        data: { userId: "u1", provider: "WHOOP" },
        expireInSeconds: 60,
        heartbeatSeconds: null,
        retryCount: 0,
        signal: new AbortController().signal,
      },
    ]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.queue).toBe(INTEGRATION_BACKFILL_ADMISSION_QUEUE);
    expect(sends[0]!.data).toMatchObject({ kind: "sleep-timeline-backfill" });
  });

  it("wires the boot discovery", () => {
    expect(discoveryOf("integration_sync")).toContain(
      "sleep-timeline-backfill",
    );
  });
});
