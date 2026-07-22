import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SendOptions } from "pg-boss";
import {
  INTEGRATION_BACKFILL_ADMISSION_GROUP,
  INTEGRATION_BACKFILL_ADMISSION_QUEUE,
  INTEGRATION_BACKFILL_BOOT_ORDER,
  INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY,
  INTEGRATION_BACKFILL_STAGGER_SECONDS,
  bootStaggerSecondsFor,
  enqueueIntegrationBackfillAdmission,
  integrationBackfillSourceOptions,
} from "../integration-backfill-admission";

const registrarSource = readFileSync(
  join(__dirname, "../reminder/register-integration-sync.ts"),
  "utf8",
);

const providerSources = [
  "whoop-backfill.ts",
  "fitbit-backfill.ts",
  "google-health-backfill.ts",
  "google-health-sleep-repair.ts",
  "sleep-timeline-backfill.ts",
  "lab-biomarker-backfill.ts",
  "strava-backfill.ts",
].map((file) => readFileSync(join(__dirname, "..", file), "utf8"));

describe("shared full-history backfill admission", () => {
  it("assigns every integration backfill a deterministic durable boot stagger", () => {
    expect(INTEGRATION_BACKFILL_BOOT_ORDER).toEqual([
      "whoop-backfill",
      "fitbit-backfill",
      "google-health-backfill",
      "google-health-sleep-repair",
      "sleep-timeline-backfill",
      "lab-biomarker-backfill",
      "strava-backfill",
    ]);
    expect(INTEGRATION_BACKFILL_BOOT_ORDER.map(bootStaggerSecondsFor)).toEqual([
      30, 60, 90, 120, 150, 180, 210,
    ]);
    expect(INTEGRATION_BACKFILL_STAGGER_SECONDS).toBe(30);

    for (const source of providerSources) {
      expect(source).toContain("integrationBackfillSourceOptions(");
      expect(source).toMatch(/startAfterSeconds:\s*number\s*=\s*0/);
    }

    const discoveryCalls = {
      "whoop-backfill": "enqueueBootTimeWhoopBackfill",
      "fitbit-backfill": "enqueueBootTimeFitbitBackfill",
      "google-health-backfill": "enqueueBootTimeGoogleHealthBackfill",
      "google-health-sleep-repair": "enqueueBootTimeGoogleHealthSleepRepair",
      "sleep-timeline-backfill": "enqueueBootTimeSleepTimelineBackfill",
      "lab-biomarker-backfill": "enqueueBootTimeLabBiomarkerBackfill",
      "strava-backfill": "enqueueBootTimeStravaBackfill",
    } as const;
    for (const kind of INTEGRATION_BACKFILL_BOOT_ORDER) {
      expect(registrarSource).toMatch(
        new RegExp(
          `${discoveryCalls[kind]}\\(\\s*bootStaggerSecondsFor\\("${kind}"\\)`,
        ),
      );
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
      }),
    );
    expect(first).toBe("job-1");
    expect(duplicate).toBeNull();
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

  it("registers one shared globally bounded drain and leaves incremental workers outside it", () => {
    expect(registrarSource).toMatch(
      /INTEGRATION_BACKFILL_ADMISSION_QUEUE[\s\S]{0,220}localConcurrency:\s*INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY[\s\S]{0,120}groupConcurrency:\s*INTEGRATION_BACKFILL_GLOBAL_CONCURRENCY/,
    );
    expect(registrarSource).toMatch(
      /\[INTEGRATION_BACKFILL_ADMISSION_QUEUE\]:\s*\{[\s\S]{0,100}policy:\s*"exclusive"/,
    );

    for (const queue of [
      "WHOOP_BACKFILL_QUEUE",
      "FITBIT_BACKFILL_QUEUE",
      "GOOGLE_HEALTH_BACKFILL_QUEUE",
      "GOOGLE_HEALTH_SLEEP_REPAIR_QUEUE",
      "SLEEP_TIMELINE_BACKFILL_QUEUE",
      "LAB_BIOMARKER_BACKFILL_QUEUE",
      "STRAVA_BACKFILL_QUEUE",
    ]) {
      expect(registrarSource).toMatch(
        new RegExp(
          `${queue}[\\s\\S]{0,500}enqueueIntegrationBackfillAdmission`,
        ),
      );
    }

    for (const queue of [
      "FITBIT_SYNC_QUEUE",
      "GOOGLE_HEALTH_SYNC_QUEUE",
      "STRAVA_SYNC_QUEUE",
    ]) {
      expect(registrarSource).toMatch(
        new RegExp(`${queue}[\\s\\S]{0,100}localConcurrency:\\s*1`),
      );
    }
  });
});
