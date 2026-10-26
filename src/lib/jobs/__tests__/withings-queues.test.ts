/**
 * pg-boss queue registration for Withings activity + sleep v2 syncs.
 *
 * Reads the worker registry instead of booting the worker (pg-boss, Prisma
 * adapter, notification dispatchers, …): the queues are declared with their
 * crons and bound to their handlers, a fast regression guard against
 * accidental deletion of the plumbing without spinning up Postgres. The
 * import-routine assertions read the handler module.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WITHINGS_ACTIVITY_CRON,
  WITHINGS_ACTIVITY_QUEUE,
  WITHINGS_ECG_SYNC_CRON,
  WITHINGS_SLEEP_CRON,
  WITHINGS_SLEEP_QUEUE,
} from "@/lib/jobs/integration-poll-queues";
import {
  handleWithingsActivitySync,
  handleWithingsSleepSync,
} from "@/lib/jobs/reminder/withings-sync";
import {
  groupOf,
  jobOf,
  loadedHandler,
} from "@/lib/jobs/registry/__tests__/registry-helpers";
import { WITHINGS_ECG_SYNC_QUEUE } from "@/lib/jobs/withings-ecg-queue";

const handlerSource = readFileSync(
  join(__dirname, "..", "reminder", "withings-sync.ts"),
  "utf8",
);

describe("Withings activity + sleep v2 queues", () => {
  it("declares the activity-sync queue at the documented cadence", () => {
    expect(WITHINGS_ACTIVITY_QUEUE).toBe("withings-activity-sync");
    expect(WITHINGS_ACTIVITY_CRON).toBe("0 * * * *");
  });

  it("declares the sleep-sync queue at the offset cadence", () => {
    expect(WITHINGS_SLEEP_QUEUE).toBe("withings-sleep-sync");
    // :15 offset keeps it out of lockstep with the measure cron at :00.
    expect(WITHINGS_SLEEP_CRON).toBe("15 * * * *");
  });

  it("binds the activity-sync handler", async () => {
    expect(groupOf(WITHINGS_ACTIVITY_QUEUE).name).toBe("integration_sync");
    expect(await loadedHandler(WITHINGS_ACTIVITY_QUEUE)).toBe(
      handleWithingsActivitySync,
    );
  });

  it("binds the sleep-sync handler", async () => {
    expect(groupOf(WITHINGS_SLEEP_QUEUE).name).toBe("integration_sync");
    expect(await loadedHandler(WITHINGS_SLEEP_QUEUE)).toBe(
      handleWithingsSleepSync,
    );
  });

  it("imports the activity / sleep sync routines", () => {
    expect(handlerSource).toMatch(
      /import\s*\{\s*syncUserActivity\s*\}\s*from\s*["']@\/lib\/withings\/sync-activity["']/,
    );
    expect(handlerSource).toMatch(
      /import\s*\{\s*syncUserSleep\s*\}\s*from\s*["']@\/lib\/withings\/sync-sleep["']/,
    );
  });

  it("schedules both crons", () => {
    expect(jobOf(WITHINGS_ACTIVITY_QUEUE).cron).toBe(WITHINGS_ACTIVITY_CRON);
    expect(jobOf(WITHINGS_SLEEP_QUEUE).cron).toBe(WITHINGS_SLEEP_CRON);
  });

  it("schedules the ECG catch-net cron at :41 so watch-only accounts pull strips", () => {
    // A payload-less cron tick walks the connection cohort.
    expect(WITHINGS_ECG_SYNC_CRON).toBe("41 * * * *");
    expect(jobOf(WITHINGS_ECG_SYNC_QUEUE).cron).toBe(WITHINGS_ECG_SYNC_CRON);
  });
});
