/**
 * pg-boss queue registration for the Fitbit sync layer.
 *
 * Reads the worker registry instead of booting the worker: every Fitbit queue
 * is declared in the integration-sync group with its cron and handler, the
 * full-history queues forward to the shared admission lane, and the boot
 * discovery offers the backfill and the sleep repair again. This is the fast
 * guard for the dead-queue class (a queue declared but never registered,
 * which silently never drains).
 *
 * Fitbit is poll-only at launch (no webhook — Pub/Sub deferred), so a single
 * hourly `fitbit-sync` queue drives the per-user `syncUserFitbit` driver across
 * every connection, alongside the backfill + the daily OAuth-state sweep.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  FITBIT_BACKFILL_QUEUE,
  FITBIT_OAUTH_STATE_CLEANUP_CRON,
  FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
  FITBIT_SLEEP_REPAIR_QUEUE,
  FITBIT_SYNC_CRON,
  FITBIT_SYNC_QUEUE,
} from "@/lib/fitbit/jobs/queues";
import { INTEGRATION_BACKFILL_ADMISSION_QUEUE } from "@/lib/jobs/integration-backfill-admission";
import {
  handleFitbitOAuthStateCleanup,
  handleFitbitSync,
} from "@/lib/fitbit/jobs/sync-handlers";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
  recordingBoss,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const handlerSource = readFileSync(
  join(__dirname, "..", "sync-handlers.ts"),
  "utf8",
);

const FITBIT_QUEUES = [
  FITBIT_SYNC_QUEUE,
  FITBIT_BACKFILL_QUEUE,
  FITBIT_SLEEP_REPAIR_QUEUE,
  FITBIT_OAUTH_STATE_CLEANUP_QUEUE,
] as const;

/** The admission sends the source queue's handler makes for one job. */
async function forwardOneJob(queue: string) {
  const { boss, sends } = recordingBoss();
  const handler = await jobOf(queue).load({ boss });
  await handler([
    {
      id: "j1",
      name: queue,
      data: { userId: "u1" },
      expireInSeconds: 60,
      heartbeatSeconds: null,
      retryCount: 0,
      signal: new AbortController().signal,
    },
  ]);
  return sends;
}

describe("Fitbit sync queues", () => {
  it("declares the Fitbit sync + oauth-state-cleanup queue constants", () => {
    expect(FITBIT_SYNC_QUEUE).toBe("fitbit-sync");
    expect(FITBIT_OAUTH_STATE_CLEANUP_QUEUE).toBe("fitbit-oauth-state-cleanup");
  });

  it("declares EVERY Fitbit queue in the integration-sync group", () => {
    for (const q of FITBIT_QUEUES) {
      expect(groupOf(q).name).toBe("integration_sync");
    }
  });

  it("schedules the hourly poll cron + the daily oauth-state sweep", () => {
    expect(jobOf(FITBIT_SYNC_QUEUE).cron).toBe(FITBIT_SYNC_CRON);
    expect(jobOf(FITBIT_SYNC_QUEUE).scheduleOptions).toBeUndefined();
    const sweep = jobOf(FITBIT_OAUTH_STATE_CLEANUP_QUEUE);
    expect(sweep.cron).toBe(FITBIT_OAUTH_STATE_CLEANUP_CRON);
    expect(sweep.scheduleOptions).toBe(cronIsTheRetry);
  });

  it("binds a handler for every Fitbit queue", async () => {
    expect(await loadedHandler(FITBIT_SYNC_QUEUE)).toBe(handleFitbitSync);
    expect(await loadedHandler(FITBIT_OAUTH_STATE_CLEANUP_QUEUE)).toBe(
      handleFitbitOAuthStateCleanup,
    );
    for (const [queue, kind] of [
      [FITBIT_BACKFILL_QUEUE, "fitbit-backfill"],
      [FITBIT_SLEEP_REPAIR_QUEUE, "fitbit-sleep-repair"],
    ] as const) {
      const sends = await forwardOneJob(queue);
      expect(sends).toHaveLength(1);
      expect(sends[0]!.queue).toBe(INTEGRATION_BACKFILL_ADMISSION_QUEUE);
      expect(sends[0]!.data).toMatchObject({ kind, data: { userId: "u1" } });
    }
  });

  it("wires the self-converging backfill and the one-shot sleep-repair boot discovery", () => {
    const passes = discoveryOf("integration_sync");
    expect(passes).toContain("fitbit-backfill");
    expect(passes).toContain("fitbit-sleep-repair");
  });

  it("imports the Fitbit sync driver into the handler module", () => {
    expect(handlerSource).toMatch(/from\s*["']@\/lib\/fitbit\/sync["']/);
  });
});
