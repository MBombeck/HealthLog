/**
 * v1.11.0 — pg-boss queue registration for the WHOOP sync layer.
 *
 * The reminder-worker imports heavy infrastructure (pg-boss, Prisma adapter,
 * notification dispatchers, …) so we don't boot the whole worker here. Instead
 * we read the source as text and assert the queue constants + cron schedules +
 * handler wiring + allQueues + boot-enqueue are present — the fast guard that
 * catches the v1.4.37 dead-queue class (a queue declared but never registered
 * in `allQueues`, which silently never drains).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// v1.18.1 — the queue wiring + boot discovery moved out of the 2143-LOC
// reminder-worker boot file into domain registrars; the WHOOP queues live in
// the integration-sync registrar. The dead-queue guard follows the wiring there
// (the handler module is still concatenated for the import-routine assertions).
const REGISTRAR_PATH = join(
  __dirname,
  "..",
  "reminder",
  "register-integration-sync.ts",
);
const source =
  readFileSync(REGISTRAR_PATH, "utf8") +
  readFileSync(join(__dirname, "..", "reminder", "whoop-sync.ts"), "utf8");

const WHOOP_QUEUE_CONSTS = [
  "WHOOP_RECOVERY_SYNC_QUEUE",
  "WHOOP_SLEEP_SYNC_QUEUE",
  "WHOOP_WORKOUT_SYNC_QUEUE",
  "WHOOP_CYCLE_SYNC_QUEUE",
  "WHOOP_BACKFILL_QUEUE",
  "WHOOP_OAUTH_STATE_CLEANUP_QUEUE",
] as const;

describe("reminder-worker — WHOOP sync queues", () => {
  it("declares every WHOOP sync queue constant", () => {
    expect(source).toMatch(
      /WHOOP_RECOVERY_SYNC_QUEUE\s*=\s*["']whoop-recovery-sync["']/,
    );
    expect(source).toMatch(
      /WHOOP_SLEEP_SYNC_QUEUE\s*=\s*["']whoop-sleep-sync["']/,
    );
    expect(source).toMatch(
      /WHOOP_WORKOUT_SYNC_QUEUE\s*=\s*["']whoop-workout-sync["']/,
    );
    expect(source).toMatch(
      /WHOOP_CYCLE_SYNC_QUEUE\s*=\s*["']whoop-cycle-sync["']/,
    );
  });

  it("registers EVERY WHOOP queue in allQueues (v1.4.37 dead-queue guard)", () => {
    // Isolate the allQueues array body so the assertion can't be satisfied by
    // an incidental mention elsewhere in the file.
    const block = /const allQueues = \[([\s\S]*?)\];/.exec(source);
    expect(block).not.toBeNull();
    const body = block![1]!;
    for (const q of WHOOP_QUEUE_CONSTS) {
      expect(body).toContain(q);
    }
  });

  it("schedules the four poll crons + the daily oauth-state sweep", () => {
    expect(source).toMatch(
      /\[WHOOP_RECOVERY_SYNC_QUEUE,\s*WHOOP_RECOVERY_SYNC_CRON\]/,
    );
    expect(source).toMatch(
      /\[WHOOP_SLEEP_SYNC_QUEUE,\s*WHOOP_SLEEP_SYNC_CRON\]/,
    );
    expect(source).toMatch(
      /\[WHOOP_WORKOUT_SYNC_QUEUE,\s*WHOOP_WORKOUT_SYNC_CRON\]/,
    );
    expect(source).toMatch(
      /\[WHOOP_CYCLE_SYNC_QUEUE,\s*WHOOP_CYCLE_SYNC_CRON\]/,
    );
    expect(source).toMatch(
      /\[WHOOP_OAUTH_STATE_CLEANUP_QUEUE,\s*WHOOP_OAUTH_STATE_CLEANUP_CRON\]/,
    );
  });

  it("registers a boss.work handler for every WHOOP sync queue", () => {
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}WHOOP_RECOVERY_SYNC_QUEUE[\s\S]{0,160}handleWhoopRecoverySync/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}WHOOP_SLEEP_SYNC_QUEUE[\s\S]{0,160}handleWhoopSleepSync/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}WHOOP_WORKOUT_SYNC_QUEUE[\s\S]{0,160}handleWhoopWorkoutSync/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,160}WHOOP_CYCLE_SYNC_QUEUE[\s\S]{0,160}handleWhoopCycleSync/,
    );
    expect(source).toMatch(
      /boss\.work[\s\S]{0,200}WHOOP_BACKFILL_QUEUE[\s\S]{0,260}enqueueIntegrationBackfillAdmission/,
    );
  });

  it("wires the self-converging WHOOP backfill boot discovery", () => {
    expect(source).toMatch(
      /enqueueBootTimeWhoopBackfill\(\s*bootStaggerSecondsFor\("whoop-backfill"\)/,
    );
  });

  it("imports the WHOOP per-resource sync routines", () => {
    expect(source).toMatch(/from\s*["']@\/lib\/whoop\/sync-recovery["']/);
    expect(source).toMatch(/from\s*["']@\/lib\/whoop\/sync-cycle["']/);
    expect(source).toMatch(/from\s*["']@\/lib\/whoop\/sync-workout["']/);
  });
});
