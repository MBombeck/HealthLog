/**
 * v1.4.25 W17b/c — pg-boss queue registration for Withings activity +
 * sleep v2 syncs.
 *
 * The reminder-worker imports heavy infrastructure (pg-boss, Prisma
 * adapter, notification dispatchers, …) so we don't boot the whole
 * worker in this test. Instead we read the source file as text and
 * assert the queue constants + cron schedules + handler wiring are
 * present — a fast regression guard that catches accidental deletion
 * of the W17b/c plumbing without spinning up Postgres.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const REMINDER_WORKER_PATH = join(
  __dirname,
  "..",
  "reminder-worker.ts",
);

const source = readFileSync(REMINDER_WORKER_PATH, "utf8");

describe("reminder-worker — Withings activity + sleep v2 queues", () => {
  it("declares the activity-sync queue at the documented cadence", () => {
    expect(source).toMatch(
      /WITHINGS_ACTIVITY_QUEUE\s*=\s*["']withings-activity-sync["']/,
    );
    expect(source).toMatch(/WITHINGS_ACTIVITY_CRON\s*=\s*["']0 \* \* \* \*["']/);
  });

  it("declares the sleep-sync queue at the offset cadence", () => {
    expect(source).toMatch(
      /WITHINGS_SLEEP_QUEUE\s*=\s*["']withings-sleep-sync["']/,
    );
    // :15 offset keeps it out of lockstep with the measure cron at :00.
    expect(source).toMatch(/WITHINGS_SLEEP_CRON\s*=\s*["']15 \* \* \* \*["']/);
  });

  it("registers the activity-sync handler against pg-boss", () => {
    expect(source).toMatch(/handleWithingsActivitySync\b/);
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}WITHINGS_ACTIVITY_QUEUE[\s\S]{0,200}handleWithingsActivitySync/,
    );
  });

  it("registers the sleep-sync handler against pg-boss", () => {
    expect(source).toMatch(/handleWithingsSleepSync\b/);
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}WITHINGS_SLEEP_QUEUE[\s\S]{0,200}handleWithingsSleepSync/,
    );
  });

  it("imports the new activity / sleep sync routines", () => {
    expect(source).toMatch(
      /import\s*\{\s*syncUserActivity\s*\}\s*from\s*["']@\/lib\/withings\/sync-activity["']/,
    );
    expect(source).toMatch(
      /import\s*\{\s*syncUserSleep\s*\}\s*from\s*["']@\/lib\/withings\/sync-sleep["']/,
    );
  });

  it("schedules both crons via boss.schedule (allQueues + schedules tables)", () => {
    expect(source).toMatch(
      /\[WITHINGS_ACTIVITY_QUEUE,\s*WITHINGS_ACTIVITY_CRON\]/,
    );
    expect(source).toMatch(/\[WITHINGS_SLEEP_QUEUE,\s*WITHINGS_SLEEP_CRON\]/);
  });
});
