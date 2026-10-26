/**
 * The shared full-history backfill admission: every provider backfill and
 * repair forwards into one database-coordinated drain. The boot discovery,
 * the drain's binding and the source queues' forwarding are read off the
 * worker registry; the boot discovery runs against stubbed enqueue helpers
 * that record the stagger each pass hands them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SendOptions } from "pg-boss";

const staggers = vi.hoisted(() => new Map<string, number>());
const recordStagger = vi.hoisted(() => (kind: string, stagger: number) => {
  staggers.set(kind, stagger);
  return { enqueued: 0, skipped: 0, error: null };
});
vi.mock("@/lib/jobs/whoop-backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/whoop-backfill")>()),
  enqueueBootTimeWhoopBackfill: async (stagger: number) =>
    recordStagger("whoop-backfill", stagger),
}));
vi.mock("@/lib/fitbit/jobs/backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fitbit/jobs/backfill")>()),
  enqueueBootTimeFitbitBackfill: async (stagger: number) =>
    recordStagger("fitbit-backfill", stagger),
}));
vi.mock("@/lib/jobs/google-health-backfill", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/google-health-backfill")
  >()),
  enqueueBootTimeGoogleHealthBackfill: async (stagger: number) =>
    recordStagger("google-health-backfill", stagger),
}));
vi.mock("@/lib/jobs/google-health-sleep-repair", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/google-health-sleep-repair")
  >()),
  enqueueBootTimeGoogleHealthSleepRepair: async (stagger: number) =>
    recordStagger("google-health-sleep-repair", stagger),
}));
vi.mock("@/lib/jobs/sleep-timeline-backfill", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/sleep-timeline-backfill")
  >()),
  enqueueBootTimeSleepTimelineBackfill: async (stagger: number) =>
    recordStagger("sleep-timeline-backfill", stagger),
}));
vi.mock("@/lib/jobs/lab-biomarker-backfill", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/jobs/lab-biomarker-backfill")
  >()),
  enqueueBootTimeLabBiomarkerBackfill: async (stagger: number) =>
    recordStagger("lab-biomarker-backfill", stagger),
}));
vi.mock("@/lib/jobs/strava-backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/strava-backfill")>()),
  enqueueBootTimeStravaBackfill: async (stagger: number) =>
    recordStagger("strava-backfill", stagger),
}));
vi.mock("@/lib/fitbit/jobs/sleep-repair", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/fitbit/jobs/sleep-repair")>()),
  enqueueBootTimeFitbitSleepRepair: async (stagger: number) =>
    recordStagger("fitbit-sleep-repair", stagger),
}));
vi.mock("@/lib/jobs/oura-backfill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/oura-backfill")>()),
  enqueueBootTimeOuraBackfill: async (stagger: number) =>
    recordStagger("oura-backfill", stagger),
}));

import {
  INTEGRATION_BACKFILL_ADMISSION_GROUP,
  INTEGRATION_BACKFILL_ADMISSION_QUEUE,
  INTEGRATION_BACKFILL_BOOT_ORDER,
  INTEGRATION_BACKFILL_EXPIRE_SECONDS,
  INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
  INTEGRATION_BACKFILL_STAGGER_SECONDS,
  bootStaggerSecondsFor,
  enqueueIntegrationBackfillAdmission,
  integrationBackfillSourceOptions,
  type IntegrationBackfillKind,
} from "../integration-backfill-admission";
import {
  FITBIT_BACKFILL_QUEUE,
  FITBIT_SLEEP_REPAIR_QUEUE,
  FITBIT_SYNC_QUEUE,
} from "@/lib/fitbit/jobs/queues";
import { GOOGLE_HEALTH_BACKFILL_QUEUE } from "../google-health-backfill-queue";
import { GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE } from "../google-health-sleep-repair-queue";
import {
  GOOGLE_HEALTH_SYNC_QUEUE,
  STRAVA_SYNC_QUEUE,
} from "../integration-poll-queues";
import { LAB_BIOMARKER_BACKFILL_QUEUE } from "../lab-biomarker-backfill";
import { OURA_BACKFILL_QUEUE } from "../oura-backfill-queue";
import {
  groupNamed,
  jobOf,
  recordingBoss,
} from "../registry/__tests__/registry-helpers";
import { SLEEP_TIMELINE_BACKFILL_QUEUE } from "../sleep-timeline-backfill-queue";
import { STRAVA_BACKFILL_QUEUE } from "../strava-backfill-queue";
import { WHOOP_BACKFILL_QUEUE } from "../whoop-backfill-queue";

const providerSources = [
  "whoop-backfill.ts",
  "../fitbit/jobs/backfill.ts",
  "google-health-backfill.ts",
  "google-health-sleep-repair.ts",
  "sleep-timeline-backfill.ts",
  "lab-biomarker-backfill.ts",
  "strava-backfill.ts",
  "../fitbit/jobs/sleep-repair.ts",
  "oura-backfill.ts",
].map((file) => readFileSync(join(__dirname, "..", file), "utf8"));

describe("shared full-history backfill admission", () => {
  it("assigns every integration backfill a deterministic durable boot stagger", async () => {
    expect(INTEGRATION_BACKFILL_BOOT_ORDER).toEqual([
      "whoop-backfill",
      "fitbit-backfill",
      "google-health-backfill",
      "google-health-sleep-repair",
      "sleep-timeline-backfill",
      "lab-biomarker-backfill",
      "strava-backfill",
      "fitbit-sleep-repair",
      "oura-backfill",
    ]);
    expect(INTEGRATION_BACKFILL_BOOT_ORDER.map(bootStaggerSecondsFor)).toEqual([
      30, 60, 90, 120, 150, 180, 210, 240, 270,
    ]);
    expect(INTEGRATION_BACKFILL_STAGGER_SECONDS).toBe(30);

    for (const source of providerSources) {
      expect(source).toContain("integrationBackfillSourceOptions(");
      expect(source).toMatch(/startAfterSeconds:\s*number\s*=\s*0/);
    }

    // Every kind has a boot discovery pass, and each pass hands its helper
    // the kind's own stagger.
    const passes = groupNamed("integration_sync").discovery ?? [];
    for (const kind of INTEGRATION_BACKFILL_BOOT_ORDER) {
      const pass = passes.find((p) => p.name === kind);
      expect(pass, kind).toBeDefined();
      await pass!.run();
      expect(staggers.get(kind), kind).toBe(bootStaggerSecondsFor(kind));
    }
  });

  it("uses one database-coordinated admission group without replacing per-job singleton identity", async () => {
    expect(INTEGRATION_BACKFILL_ADMISSION_QUEUE).toBe(
      "integration-backfill-admission",
    );
    expect(INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY).toBe(1);
    expect(INTEGRATION_BACKFILL_ADMISSION_GROUP).toEqual({
      id: "integration-full-history-backfill",
    });

    const seenSingletons = new Set<string>();
    const send = vi.fn(
      async (_name: string, _data: object, options?: SendOptions) => {
        const key = options?.singletonKey;
        if (!key || seenSingletons.has(key)) return null;
        seenSingletons.add(key);
        return "job-1";
      },
    );
    const payload = {
      kind: "sleep-timeline-backfill" as const,
      data: {
        userId: "u1",
        provider: "WHOOP" as const,
        enqueuedAt: "2026-07-21T00:00:00.000Z",
      },
    };

    const first = await enqueueIntegrationBackfillAdmission({ send }, payload);
    const duplicate = await enqueueIntegrationBackfillAdmission(
      { send },
      payload,
    );

    expect(send).toHaveBeenCalledWith(
      INTEGRATION_BACKFILL_ADMISSION_QUEUE,
      payload,
      expect.objectContaining({
        singletonKey: "sleep-timeline-backfill|WHOOP|u1",
        group: INTEGRATION_BACKFILL_ADMISSION_GROUP,
        expireInSeconds: INTEGRATION_BACKFILL_EXPIRE_SECONDS,
      }),
    );
    expect(first).toBe("job-1");
    expect(duplicate).toBeNull();
  });

  it("gives the admission job an expiry sized for a long import, under pg-boss's 24-hour ceiling", () => {
    // pg-boss's default is 900 s; a full-history heart-rate import runs for
    // hours, and past the expiry pg-boss retries the job beside the run.
    expect(INTEGRATION_BACKFILL_EXPIRE_SECONDS).toBe(16 * 60 * 60);
    expect(INTEGRATION_BACKFILL_EXPIRE_SECONDS).toBeLessThan(24 * 60 * 60);
  });

  it("keeps source enqueue singleton keys while applying stagger only to boot discovery", () => {
    expect(integrationBackfillSourceOptions("whoop-backfill|u1", 60)).toEqual(
      expect.objectContaining({
        singletonKey: "whoop-backfill|u1",
        startAfter: 60,
      }),
    );
    expect(
      integrationBackfillSourceOptions("whoop-backfill|u1"),
    ).not.toHaveProperty("startAfter");
  });

  it("registers one shared globally bounded drain and leaves incremental workers outside it", async () => {
    const drain = jobOf(INTEGRATION_BACKFILL_ADMISSION_QUEUE);
    expect(drain.work).toEqual({
      localConcurrency: INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
      groupConcurrency: INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
    });
    expect(drain.policy?.policy).toBe("exclusive");

    const sources: ReadonlyArray<[string, IntegrationBackfillKind]> = [
      [WHOOP_BACKFILL_QUEUE, "whoop-backfill"],
      [FITBIT_BACKFILL_QUEUE, "fitbit-backfill"],
      [GOOGLE_HEALTH_BACKFILL_QUEUE, "google-health-backfill"],
      [GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE, "google-health-sleep-repair"],
      [SLEEP_TIMELINE_BACKFILL_QUEUE, "sleep-timeline-backfill"],
      [LAB_BIOMARKER_BACKFILL_QUEUE, "lab-biomarker-backfill"],
      [STRAVA_BACKFILL_QUEUE, "strava-backfill"],
      [FITBIT_SLEEP_REPAIR_QUEUE, "fitbit-sleep-repair"],
      [OURA_BACKFILL_QUEUE, "oura-backfill"],
    ];
    for (const [queue, kind] of sources) {
      const { boss, sends } = recordingBoss();
      const handler = await jobOf(queue).load({ boss });
      await handler([
        {
          id: "j1",
          name: queue,
          data: { userId: "u1", provider: "WHOOP" },
          expireInSeconds: 60,
          heartbeatSeconds: null,
          retryCount: 0,
          signal: new AbortController().signal,
        },
      ]);
      expect(sends, queue).toHaveLength(1);
      expect(sends[0]!.queue).toBe(INTEGRATION_BACKFILL_ADMISSION_QUEUE);
      expect(sends[0]!.data).toMatchObject({ kind });
    }

    for (const queue of [
      FITBIT_SYNC_QUEUE,
      GOOGLE_HEALTH_SYNC_QUEUE,
      STRAVA_SYNC_QUEUE,
    ]) {
      expect(jobOf(queue).work, queue).toEqual({ localConcurrency: 1 });
      expect(jobOf(queue).lane, queue).toBeUndefined();
    }
  });
});
