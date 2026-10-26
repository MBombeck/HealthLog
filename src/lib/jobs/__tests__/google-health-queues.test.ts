/**
 * pg-boss queue registration for the Google Health sync layer.
 *
 * Reads the worker registry instead of booting the worker: every Google
 * Health queue is declared in the integration-sync group with its cron and
 * handler, the backfill forwards to the shared admission lane, and the boot
 * discovery offers it again. This is the fast guard for the dead-queue class
 * (a queue declared but never registered, which silently never drains).
 *
 * Google Health is poll-only at launch (no webhook — Pub/Sub deferred), so a
 * single hourly `google-health-sync` queue drives the per-user
 * `syncUserGoogleHealth` driver across every connection, alongside the backfill
 * + the daily OAuth-state sweep.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { GOOGLE_HEALTH_BACKFILL_QUEUE } from "@/lib/jobs/google-health-backfill-queue";
import { INTEGRATION_BACKFILL_ADMISSION_QUEUE } from "@/lib/jobs/integration-backfill-admission";
import {
  GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_CRON,
  GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE,
  GOOGLE_HEALTH_SYNC_CRON,
  GOOGLE_HEALTH_SYNC_QUEUE,
} from "@/lib/jobs/integration-poll-queues";
import {
  handleGoogleHealthOAuthStateCleanup,
  handleGoogleHealthSync,
} from "@/lib/jobs/reminder/google-health-sync";
import { cronIsTheRetry } from "@/lib/jobs/reminder/registrar-shared";
import {
  discoveryOf,
  groupOf,
  jobOf,
  loadedHandler,
  recordingBoss,
} from "@/lib/jobs/registry/__tests__/registry-helpers";

const handlerSource = readFileSync(
  join(__dirname, "..", "reminder", "google-health-sync.ts"),
  "utf8",
);

const GOOGLE_HEALTH_QUEUES = [
  GOOGLE_HEALTH_SYNC_QUEUE,
  GOOGLE_HEALTH_BACKFILL_QUEUE,
  GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE,
] as const;

describe("Google Health sync queues", () => {
  it("declares the Google Health sync + oauth-state-cleanup queue constants", () => {
    expect(GOOGLE_HEALTH_SYNC_QUEUE).toBe("google-health-sync");
    expect(GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE).toBe(
      "google-health-oauth-state-cleanup",
    );
  });

  it("declares EVERY Google Health queue in the integration-sync group", () => {
    for (const q of GOOGLE_HEALTH_QUEUES) {
      expect(groupOf(q).name).toBe("integration_sync");
    }
  });

  it("schedules the hourly poll cron + the daily oauth-state sweep", () => {
    expect(jobOf(GOOGLE_HEALTH_SYNC_QUEUE).cron).toBe(GOOGLE_HEALTH_SYNC_CRON);
    expect(jobOf(GOOGLE_HEALTH_SYNC_QUEUE).scheduleOptions).toBeUndefined();
    const sweep = jobOf(GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE);
    expect(sweep.cron).toBe(GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_CRON);
    expect(sweep.scheduleOptions).toBe(cronIsTheRetry);
  });

  it("binds a handler for every Google Health queue", async () => {
    expect(await loadedHandler(GOOGLE_HEALTH_SYNC_QUEUE)).toBe(
      handleGoogleHealthSync,
    );
    expect(await loadedHandler(GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE)).toBe(
      handleGoogleHealthOAuthStateCleanup,
    );
    const { boss, sends } = recordingBoss();
    const backfill = await jobOf(GOOGLE_HEALTH_BACKFILL_QUEUE).load({ boss });
    await backfill([
      {
        id: "j1",
        name: GOOGLE_HEALTH_BACKFILL_QUEUE,
        data: { userId: "u1" },
        expireInSeconds: 60,
        heartbeatSeconds: null,
        retryCount: 0,
        signal: new AbortController().signal,
      },
    ]);
    expect(sends).toHaveLength(1);
    expect(sends[0]!.queue).toBe(INTEGRATION_BACKFILL_ADMISSION_QUEUE);
    expect(sends[0]!.data).toMatchObject({ kind: "google-health-backfill" });
  });

  it("wires the self-converging Google Health backfill boot discovery", () => {
    expect(discoveryOf("integration_sync")).toContain("google-health-backfill");
  });

  it("imports the Google Health sync driver into the handler module", () => {
    expect(handlerSource).toMatch(/from\s*["']@\/lib\/google-health\/sync["']/);
  });
});
