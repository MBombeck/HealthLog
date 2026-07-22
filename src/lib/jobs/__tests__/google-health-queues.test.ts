/**
 * v1.26.0 — pg-boss queue registration for the Google Health sync layer.
 *
 * The reminder-worker imports heavy infrastructure (pg-boss, Prisma adapter,
 * notification dispatchers, …) so we don't boot the whole worker here. Instead
 * we read the source as text and assert the queue constants + cron schedules +
 * handler wiring + allQueues + boot-enqueue are present — the fast guard that
 * catches the v1.4.37 dead-queue class (a queue declared but never registered
 * in `allQueues`, which silently never drains).
 *
 * Google Health is poll-only at launch (no webhook — Pub/Sub deferred), so a
 * single hourly `google-health-sync` queue drives the per-user
 * `syncUserGoogleHealth` driver across every connection, alongside the backfill
 * + the daily OAuth-state sweep.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-integration-sync.ts",
);
const source =
  readFileSync(REGISTRAR_PATH, "utf8") +
  readFileSync(
    join(__dirname, "..", "reminder", "google-health-sync.ts"),
    "utf8",
  );

const GOOGLE_HEALTH_QUEUE_CONSTS = [
  "GOOGLE_HEALTH_SYNC_QUEUE",
  "GOOGLE_HEALTH_BACKFILL_QUEUE",
  "GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE",
] as const;

describe("reminder-worker — Google Health sync queues", () => {
  it("declares the Google Health sync + oauth-state-cleanup queue constants", () => {
    expect(source).toMatch(
      /GOOGLE_HEALTH_SYNC_QUEUE\s*=\s*["']google-health-sync["']/,
    );
    expect(source).toMatch(
      /GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE\s*=\s*["']google-health-oauth-state-cleanup["']/,
    );
  });

  it("registers EVERY Google Health queue in allQueues (v1.4.37 dead-queue guard)", () => {
    const block = /const allQueues = \[([\s\S]*?)\];/.exec(source);
    expect(block).not.toBeNull();
    const body = block![1]!;
    for (const q of GOOGLE_HEALTH_QUEUE_CONSTS) {
      expect(body).toContain(q);
    }
  });

  it("schedules the hourly poll cron + the daily oauth-state sweep", () => {
    expect(source).toMatch(
      /\[GOOGLE_HEALTH_SYNC_QUEUE,\s*GOOGLE_HEALTH_SYNC_CRON\]/,
    );
    expect(source).toMatch(
      /\[\s*GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE,\s*GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_CRON,?\s*\]/,
    );
  });

  it("registers a boss.work handler for every Google Health queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}GOOGLE_HEALTH_SYNC_QUEUE[\s\S]{0,200}handleGoogleHealthSync/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,320}GOOGLE_HEALTH_BACKFILL_QUEUE[\s\S]{0,320}enqueueIntegrationBackfillAdmission/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}GOOGLE_HEALTH_OAUTH_STATE_CLEANUP_QUEUE[\s\S]{0,200}handleGoogleHealthOAuthStateCleanup/,
    );
  });

  it("wires the self-converging Google Health backfill boot discovery", () => {
    expect(source).toMatch(
      /enqueueBootTimeGoogleHealthBackfill\(\s*bootStaggerSecondsFor\("google-health-backfill"\)/,
    );
  });

  it("imports the Google Health sync driver + backfill exports", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/google-health\/sync["']/);
    expect(source).toMatch(
      /from\s*["']@\/lib\/jobs\/google-health-backfill["']/,
    );
  });
});
